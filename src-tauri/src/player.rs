//! Native audio engine.
//!
//! source (file | ranged HTTP) → symphonia demux/decode → f32 → channel map
//!   → rubato sinc resampler (only when source rate ≠ device rate) → lock-free ring → cpal (WASAPI)
//!
//! One engine thread owns the decoder and the output stream; the cpal callback only pops
//! samples, applies volume and counts frames for the position clock.

use ringbuf::{traits::*, HeapCons, HeapProd, HeapRb};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::{Time, TimeBase};

#[derive(Deserialize, Clone, Debug)]
pub struct Src {
    kind: String, // "file" | "url"
    value: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    status: &'static str, // idle | loading | playing | paused | ended | error
    seq: u64,
    position: f64,
    duration: f64,
    volume: f32,
    error: Option<String>,
    codec: Option<String>,
    sample_rate: u32,
    bit_depth: Option<u32>,
    channels: usize,
    out_rate: u32,
    device: Option<String>,
}

enum Cmd {
    Load { src: Src, autoplay: bool, seq: u64 },
    Toggle,
    Seek(f64),
}

/// State shared with the real-time callback (atomics only).
struct Cb {
    paused: AtomicBool,
    flush: AtomicBool,
    volume: AtomicU32,
    frames: AtomicU64,
    lost: AtomicBool,
}

pub struct Player {
    tx: Mutex<Sender<Cmd>>,
    info: Arc<Mutex<Info>>,
    cb: Arc<Cb>,
    base: Arc<Mutex<(f64, u32, usize)>>, // (position at last load/seek, output rate, output channels)
    seq: AtomicU64,
}

impl Player {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        let info = Arc::new(Mutex::new(Info { status: "idle", volume: 0.8, ..Default::default() }));
        let cb = Arc::new(Cb {
            paused: AtomicBool::new(true),
            flush: AtomicBool::new(false),
            volume: AtomicU32::new(0.8f32.to_bits()),
            frames: AtomicU64::new(0),
            lost: AtomicBool::new(false),
        });
        let base = Arc::new(Mutex::new((0.0, 48000, 2)));
        let (i2, c2, b2) = (info.clone(), cb.clone(), base.clone());
        std::thread::Builder::new()
            .name("miek-audio".into())
            .spawn(move || Engine::new(rx, i2, c2, b2).run())
            .expect("audio thread");
        Player { tx: Mutex::new(tx), info, cb, base, seq: AtomicU64::new(0) }
    }

    fn send(&self, c: Cmd) {
        let _ = self.tx.lock().unwrap().send(c);
    }

    pub fn state(&self) -> Info {
        let mut i = self.info.lock().unwrap().clone();
        let (pos, rate, ch) = *self.base.lock().unwrap();
        if matches!(i.status, "playing" | "paused" | "ended") && rate > 0 {
            i.position = pos + self.cb.frames.load(Ordering::Relaxed) as f64 / (rate as f64 * ch.max(1) as f64);
            if i.duration > 0.0 {
                i.position = i.position.min(i.duration);
            }
        }
        i.volume = f32::from_bits(self.cb.volume.load(Ordering::Relaxed));
        i
    }
}

// ---------------------------------------------------------------- tauri commands

#[tauri::command]
pub fn player_load(p: tauri::State<'_, Player>, src: Src, autoplay: bool) -> u64 {
    let seq = p.seq.fetch_add(1, Ordering::SeqCst) + 1;
    p.send(Cmd::Load { src, autoplay, seq });
    seq
}
#[tauri::command]
pub fn player_toggle(p: tauri::State<'_, Player>) {
    p.send(Cmd::Toggle);
}
#[tauri::command]
pub fn player_seek(p: tauri::State<'_, Player>, secs: f64) {
    p.send(Cmd::Seek(secs.max(0.0)));
}
#[tauri::command]
pub fn player_volume(p: tauri::State<'_, Player>, v: f32) {
    // perceptual curve lives in the callback; store the slider value
    p.cb.volume.store(v.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
}
#[tauri::command]
pub fn player_state(p: tauri::State<'_, Player>) -> Info {
    p.state()
}

// ---------------------------------------------------------------- output

struct Output {
    _stream: cpal::Stream,
    prod: HeapProd<f32>,
    rate: u32,
    channels: usize,
    device: String,
}

fn open_output(cb: Arc<Cb>) -> Result<Output, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::SampleFormat;
    let host = cpal::default_host();
    let dev = host.default_output_device().ok_or("No audio output device found")?;
    let device = dev.description().map(|d| d.name().to_owned()).unwrap_or_else(|_| dev.to_string());
    let sup = dev.default_output_config().map_err(|e| e.to_string())?;
    let rate = sup.sample_rate();
    let channels = sup.channels() as usize;
    // ~3 s of audio: enough to ride out network hiccups, small enough to keep seeks snappy
    let rb = HeapRb::<f32>::new(rate as usize * channels * 3);
    let (prod, cons) = rb.split();
    let stream = match sup.sample_format() {
        SampleFormat::F32 => build::<f32>(&dev, sup.config(), cons, cb),
        SampleFormat::I16 => build::<i16>(&dev, sup.config(), cons, cb),
        SampleFormat::I32 => build::<i32>(&dev, sup.config(), cons, cb),
        SampleFormat::I24 => build::<cpal::I24>(&dev, sup.config(), cons, cb),
        SampleFormat::U16 => build::<u16>(&dev, sup.config(), cons, cb),
        f => return Err(format!("Unsupported output sample format {f}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(Output { _stream: stream, prod, rate, channels, device })
}

fn build<T: cpal::SizedSample + cpal::FromSample<f32>>(
    dev: &cpal::Device,
    cfg: cpal::StreamConfig,
    mut cons: HeapCons<f32>,
    cb: Arc<Cb>,
) -> Result<cpal::Stream, String> {
    use cpal::traits::DeviceTrait;
    let mut scratch = vec![0f32; 1 << 16];
    let cb_err = cb.clone();
    dev.build_output_stream(
        cfg,
        move |out: &mut [T], _: &cpal::OutputCallbackInfo| {
            if cb.flush.load(Ordering::Acquire) {
                cons.clear();
                cb.frames.store(0, Ordering::Relaxed);
                cb.flush.store(false, Ordering::Release);
            }
            if cb.paused.load(Ordering::Relaxed) {
                for o in out.iter_mut() {
                    *o = T::EQUILIBRIUM;
                }
                return;
            }
            let v = f32::from_bits(cb.volume.load(Ordering::Relaxed));
            let gain = v * v; // perceptual volume curve
            let n = out.len().min(scratch.len());
            let got = cons.pop_slice(&mut scratch[..n]);
            for (o, s) in out.iter_mut().zip(&scratch[..got]) {
                *o = T::from_sample(*s * gain);
            }
            for o in &mut out[got..] {
                *o = T::EQUILIBRIUM;
            }
            cb.frames.fetch_add(got as u64, Ordering::Relaxed); // samples played (all channels)
        },
        move |_e: cpal::Error| cb_err.lost.store(true, Ordering::Relaxed),
        None,
    )
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- network source
//
// A background thread downloads the file over one connection into a local cache file;
// playback reads from that file as it grows (seeks inside the downloaded part are instant).
// Reads far ahead of the download (a long seek) are served by small ranged requests.
// Finished downloads stay cached, so replays start immediately and work offline.

struct Shared {
    downloaded: AtomicU64,
    len: AtomicU64,
    done: AtomicBool,
    cancel: AtomicBool,
    failed: Mutex<Option<String>>,
}

struct StreamSource {
    file: std::fs::File,
    shared: Arc<Shared>,
    client: reqwest::blocking::Client,
    url: String,
    pos: u64,
    side_start: u64,
    side: Vec<u8>,
}

const AHEAD_WAIT: u64 = 3 * 1024 * 1024; // within this distance, wait for the download instead of a ranged request
const SIDE_CHUNK: u64 = 256 * 1024;

fn cache_dir() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Miek").join("stream-cache")
}

/// Keep the stream cache under ~2 GB by deleting the least recently used files.
fn trim_cache() {
    let Ok(rd) = std::fs::read_dir(cache_dir()) else { return };
    let mut files: Vec<_> = rd
        .flatten()
        .filter_map(|e| e.metadata().ok().map(|m| (e.path(), m.len(), m.modified().ok())))
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.2);
    for (p, len, _) in files {
        if total < 2 * 1024 * 1024 * 1024 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("Miek/", env!("CARGO_PKG_VERSION"), " (open-source music player)"))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

impl StreamSource {
    fn open(url: &str) -> Result<Self, String> {
        let dir = cache_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(url, &mut h);
        let path = dir.join(format!("{:016x}", std::hash::Hasher::finish(&h)));
        let done_marker = path.with_extension("done");
        let client = http_client()?;
        let shared = Arc::new(Shared {
            downloaded: AtomicU64::new(0),
            len: AtomicU64::new(0),
            done: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            failed: Mutex::new(None),
        });

        // fully cached already: play from disk
        if done_marker.exists() {
            if let Ok(f) = std::fs::File::open(&path) {
                let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                if len > 0 {
                    // touch it so cache trimming treats it as recently used
                    let _ = std::fs::File::options().append(true).open(&path).and_then(|f| f.set_modified(std::time::SystemTime::now()));
                    shared.downloaded.store(len, Ordering::SeqCst);
                    shared.len.store(len, Ordering::SeqCst);
                    shared.done.store(true, Ordering::SeqCst);
                    return Ok(StreamSource { file: f, shared, client, url: url.to_string(), pos: 0, side_start: 0, side: vec![] });
                }
            }
        }
        trim_cache();
        let _ = std::fs::remove_file(&done_marker);
        let resp = client.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| format!("Network error: {e}"))?;
        let final_url = resp.url().to_string();
        shared.len.store(resp.content_length().unwrap_or(0), Ordering::SeqCst);
        let mut writer = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        let reader = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let sh = shared.clone();
        let c2 = client.clone();
        let u2 = final_url.clone();
        std::thread::Builder::new()
            .name("miek-download".into())
            .spawn(move || {
                use std::io::Write;
                let mut resp = resp;
                let mut buf = vec![0u8; 64 * 1024];
                let mut retries = 0u64;
                loop {
                    if sh.cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    match resp.read(&mut buf) {
                        Ok(0) => {
                            let got = sh.downloaded.load(Ordering::SeqCst);
                            let len = sh.len.load(Ordering::SeqCst);
                            if len == 0 || got >= len {
                                let _ = writer.flush();
                                sh.len.store(got, Ordering::SeqCst);
                                sh.done.store(true, Ordering::SeqCst);
                                let _ = std::fs::write(&done_marker, b"");
                                return;
                            }
                            // connection closed early: resume below
                        }
                        Ok(n) => {
                            if writer.write_all(&buf[..n]).is_err() {
                                *sh.failed.lock().unwrap() = Some("Couldn't write the stream cache".into());
                                return;
                            }
                            sh.downloaded.fetch_add(n as u64, Ordering::SeqCst);
                            retries = 0;
                            continue;
                        }
                        Err(_) => {}
                    }
                    retries += 1;
                    if retries > 4 {
                        *sh.failed.lock().unwrap() = Some("The download kept failing".into());
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500 * retries));
                    let from = sh.downloaded.load(Ordering::SeqCst);
                    if let Ok(r) = c2.get(&u2).header("Range", format!("bytes={from}-")).send() {
                        if r.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                            resp = r;
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(StreamSource { file: reader, shared, client, url: final_url, pos: 0, side_start: 0, side: vec![] })
    }

    fn len(&self) -> u64 {
        self.shared.len.load(Ordering::SeqCst)
    }

    /// Ranged request for data far ahead of the download (after a long seek).
    fn side_read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let in_side = self.pos >= self.side_start && self.pos < self.side_start + self.side.len() as u64;
        if !in_side {
            let len = self.len();
            let end = if len > 0 { (self.pos + SIDE_CHUNK).min(len) - 1 } else { self.pos + SIDE_CHUNK - 1 };
            let r = self
                .client
                .get(&self.url)
                .header("Range", format!("bytes={}-{end}", self.pos))
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(std::io::Error::other)?;
            if r.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(std::io::Error::other("server ignored range request"));
            }
            self.side = r.bytes().map_err(std::io::Error::other)?.to_vec();
            self.side_start = self.pos;
            if self.side.is_empty() {
                return Ok(0);
            }
        }
        let off = (self.pos - self.side_start) as usize;
        let n = out.len().min(self.side.len() - off);
        out[..n].copy_from_slice(&self.side[off..off + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Drop for StreamSource {
    fn drop(&mut self) {
        self.shared.cancel.store(true, Ordering::Relaxed);
    }
}

impl Read for StreamSource {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let waited = std::time::Instant::now();
        loop {
            let len = self.len();
            if len > 0 && self.pos >= len {
                return Ok(0);
            }
            let have = self.shared.downloaded.load(Ordering::SeqCst);
            if self.pos < have {
                let n = (out.len() as u64).min(have - self.pos) as usize;
                self.file.seek(SeekFrom::Start(self.pos))?;
                let n = self.file.read(&mut out[..n])?;
                self.pos += n as u64;
                return Ok(n);
            }
            if self.shared.done.load(Ordering::SeqCst) {
                return Ok(0);
            }
            if let Some(e) = self.shared.failed.lock().unwrap().clone() {
                return Err(std::io::Error::other(e));
            }
            if self.pos >= have + AHEAD_WAIT {
                return self.side_read(out);
            }
            if waited.elapsed() > Duration::from_secs(30) {
                return Err(std::io::Error::other("Stream stalled"));
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}

impl Seek for StreamSource {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let p = match to {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::Current(d) => self.pos as i64 + d,
            SeekFrom::End(d) => self.len() as i64 + d,
        };
        if p < 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = p as u64;
        Ok(self.pos)
    }
}

impl MediaSource for StreamSource {
    fn is_seekable(&self) -> bool {
        self.len() > 0
    }
    fn byte_len(&self) -> Option<u64> {
        let l = self.len();
        (l > 0).then_some(l)
    }
}

// ---------------------------------------------------------------- engine thread

struct Track {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    src_rate: u32,
    resampler: Option<Async<f32>>,
    pending: Vec<f32>, // interleaved, output channel layout, source rate
    drop_frames: u64,  // frames to discard after a coarse seek
    eof: bool,
    seq: u64,
}

struct Engine {
    rx: Receiver<Cmd>,
    info: Arc<Mutex<Info>>,
    cb: Arc<Cb>,
    base: Arc<Mutex<(f64, u32, usize)>>,
    out: Option<Output>,
    backlog: Vec<f32>, // decoded audio that didn't fit in the ring yet
    cur: Option<Track>,
    last_src: Option<Src>,
    want_play: bool,
    decoded: Vec<f32>,
    mapped: Vec<f32>,
    resampled: Vec<f32>,
}

impl Engine {
    fn new(rx: Receiver<Cmd>, info: Arc<Mutex<Info>>, cb: Arc<Cb>, base: Arc<Mutex<(f64, u32, usize)>>) -> Self {
        Engine { rx, info, cb, base, out: None, backlog: vec![], cur: None, last_src: None, want_play: false, decoded: vec![], mapped: vec![], resampled: vec![] }
    }

    fn set<F: FnOnce(&mut Info)>(&self, f: F) {
        f(&mut self.info.lock().unwrap());
    }

    fn ensure_output(&mut self) -> Result<(), String> {
        if self.cb.lost.swap(false, Ordering::Relaxed) {
            self.out = None; // device unplugged/changed: reopen on the new default device
        }
        if self.out.is_none() {
            let o = open_output(self.cb.clone())?;
            self.set(|i| {
                i.out_rate = o.rate;
                i.device = Some(o.device.clone());
            });
            self.out = Some(o);
        }
        Ok(())
    }

    /// Drop everything buffered in the device ring and restart the clock at `pos`.
    fn flush(&mut self, pos: f64) {
        self.cb.flush.store(true, Ordering::Release);
        for _ in 0..100 {
            if !self.cb.flush.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        self.cb.flush.store(false, Ordering::Release);
        self.cb.frames.store(0, Ordering::Relaxed);
        self.backlog.clear();
        let (rate, ch) = self.out.as_ref().map(|o| (o.rate, o.channels)).unwrap_or((48000, 2));
        *self.base.lock().unwrap() = (pos, rate, ch);
    }

    fn run(mut self) {
        loop {
            // block when there is nothing to decode, otherwise poll commands between packets
            let busy = self.cur.as_ref().map(|t| !t.eof).unwrap_or(false);
            let cmd = if busy {
                self.rx.try_recv().ok()
            } else {
                match self.rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(c) => Some(c),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            };
            if let Some(c) = cmd {
                self.handle(c);
                continue;
            }
            if self.cb.lost.load(Ordering::Relaxed) {
                self.recover_device();
            }
            if busy {
                if let Err(e) = self.pump() {
                    let seq = self.cur.as_ref().map(|t| t.seq).unwrap_or(0);
                    self.cur = None;
                    self.cb.paused.store(true, Ordering::Relaxed);
                    self.set(|i| {
                        if i.seq == seq {
                            i.status = "error";
                            i.error = Some(e);
                        }
                    });
                }
            } else {
                self.check_drained();
            }
        }
    }

    fn handle(&mut self, c: Cmd) {
        match c {
            Cmd::Load { src, autoplay, seq } => {
                // newest load wins: skip stale loads still queued behind it
                let mut latest = (src, autoplay, seq);
                while let Ok(next) = self.rx.try_recv() {
                    match next {
                        Cmd::Load { src, autoplay, seq } => latest = (src, autoplay, seq),
                        other => {
                            self.start(latest.0.clone(), latest.1, latest.2, 0.0);
                            return self.handle(other);
                        }
                    }
                }
                self.start(latest.0, latest.1, latest.2, 0.0);
            }
            Cmd::Toggle => {
                let st = self.info.lock().unwrap().status;
                match st {
                    "playing" | "loading" => {
                        self.want_play = false;
                        self.cb.paused.store(true, Ordering::Relaxed);
                        self.set(|i| i.status = "paused");
                    }
                    "paused" => {
                        self.want_play = true;
                        self.cb.paused.store(false, Ordering::Relaxed);
                        self.set(|i| i.status = "playing");
                    }
                    "ended" => {
                        if let Some(src) = self.last_src.clone() {
                            let seq = self.info.lock().unwrap().seq;
                            self.start(src, true, seq, 0.0);
                        }
                    }
                    _ => {}
                }
            }
            Cmd::Seek(secs) => self.seek(secs),
        }
    }

    fn start(&mut self, src: Src, autoplay: bool, seq: u64, at: f64) {
        self.cb.paused.store(true, Ordering::Relaxed);
        self.cur = None;
        self.want_play = autoplay;
        self.last_src = Some(src.clone());
        self.set(|i| {
            i.status = "loading";
            i.seq = seq;
            i.error = None;
            i.position = 0.0;
            i.duration = 0.0;
            i.codec = None;
        });
        if let Err(e) = self.ensure_output() {
            self.set(|i| {
                i.status = "error";
                i.error = Some(e);
            });
            return;
        }
        self.flush(0.0);
        match self.open(&src, seq) {
            Ok(t) => {
                self.cur = Some(t);
                if at > 0.0 {
                    self.seek(at);
                }
            }
            Err(e) => self.set(|i| {
                i.status = "error";
                i.error = Some(e);
            }),
        }
    }

    fn open(&mut self, src: &Src, seq: u64) -> Result<Track, String> {
        let mut hint = Hint::new();
        let source: Box<dyn MediaSource> = match src.kind.as_str() {
            "file" => {
                let p = std::path::Path::new(&src.value);
                if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                    hint.with_extension(ext);
                }
                Box::new(std::fs::File::open(p).map_err(|e| format!("Can't open file: {e}"))?)
            }
            "url" => {
                if !src.value.starts_with("https://") {
                    return Err("Only https streams are allowed".into());
                }
                if let Some(ext) = src.value.rsplit('.').next().filter(|e| e.len() <= 5) {
                    hint.with_extension(ext);
                }
                Box::new(StreamSource::open(&src.value)?)
            }
            _ => return Err("unknown source".into()),
        };
        let mss = MediaSourceStream::new(source, Default::default());
        let format = symphonia::default::get_probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| format!("Unsupported audio: {e}"))?;
        let track = format.default_track(TrackType::Audio).ok_or("No audio track")?;
        let track_id = track.id;
        let time_base = track.time_base;
        let duration = time_base.zip(track.duration).and_then(|(tb, d)| tb.calc_duration(d)).map(|t| t.as_secs_f64()).unwrap_or(0.0);
        let ap = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("Not an audio track")?.clone();
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&ap, &AudioDecoderOptions::default().gapless(true))
            .map_err(|e| format!("Unsupported codec: {e}"))?;
        let src_rate = ap.sample_rate.unwrap_or(44100);
        let out = self.out.as_ref().unwrap();
        let resampler = if src_rate != out.rate {
            let params = SincInterpolationParameters::new(256, WindowFunction::BlackmanHarris2)
                .oversampling_factor(256)
                .interpolation(SincInterpolationType::Cubic);
            Some(
                Async::<f32>::new_sinc(out.rate as f64 / src_rate as f64, 1.0, &params, 1024, out.channels, FixedAsync::Input)
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let codec = decoder.codec_info().short_name.to_string();
        let channels = ap.channels.as_ref().map(|c| c.count()).unwrap_or(2);
        let bits = ap.bits_per_sample.or(ap.bits_per_coded_sample);
        self.set(|i| {
            i.duration = duration;
            i.codec = Some(codec);
            i.sample_rate = src_rate;
            i.bit_depth = bits;
            i.channels = channels;
        });
        Ok(Track { format, decoder, track_id, time_base, src_rate, resampler, pending: vec![], drop_frames: 0, eof: false, seq })
    }

    fn seek(&mut self, secs: f64) {
        let Some(t) = self.cur.as_mut() else {
            // seeking after the track ended: reopen it there
            if let Some(src) = self.last_src.clone() {
                let seq = self.info.lock().unwrap().seq;
                self.start(src, self.want_play, seq, secs);
            }
            return;
        };
        let Some(time) = Time::try_from_secs_f64(secs) else { return };
        match t.format.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(t.track_id) }) {
            Ok(seeked) => {
                t.decoder.reset();
                if let Some(r) = t.resampler.as_mut() {
                    r.reset();
                }
                t.pending.clear();
                t.eof = false;
                let actual = t.time_base.and_then(|tb| tb.calc_time(seeked.actual_ts)).map(|x| x.as_secs_f64()).unwrap_or(secs);
                // land exactly on the requested time: drop the frames before it
                t.drop_frames = ((secs - actual).max(0.0) * t.src_rate as f64) as u64;
                let status = self.info.lock().unwrap().status;
                if status == "ended" {
                    self.set(|i| i.status = if self.want_play { "playing" } else { "paused" });
                }
                self.flush(secs);
            }
            Err(e) => self.set(|i| i.error = Some(format!("Seek failed: {e}"))),
        }
    }

    fn recover_device(&mut self) {
        // reopen output on the current default device and continue from the same spot
        let pos = self.info_position();
        let (src, seq, play) = (self.last_src.clone(), self.info.lock().unwrap().seq, self.want_play);
        self.out = None;
        self.cb.lost.store(false, Ordering::Relaxed);
        if let (Some(src), true) = (src, self.cur.is_some()) {
            self.start(src, play, seq, pos);
        } else {
            let _ = self.ensure_output();
        }
    }

    fn info_position(&self) -> f64 {
        let (pos, rate, ch) = *self.base.lock().unwrap();
        pos + self.cb.frames.load(Ordering::Relaxed) as f64 / (ch.max(1) as f64 * rate.max(1) as f64)
    }

    /// Decode a little and push it to the device ring. Returns Err on a fatal error.
    fn pump(&mut self) -> Result<(), String> {
        let out = self.out.as_mut().unwrap();
        let out_ch = out.channels;
        if !self.backlog.is_empty() {
            let n = out.prod.push_slice(&self.backlog);
            self.backlog.drain(..n);
            if !self.backlog.is_empty() {
                self.after_buffered();
                std::thread::sleep(Duration::from_millis(8));
                return Ok(());
            }
        }
        // keep the ring topped up; sleep briefly while it is full
        if out.prod.vacant_len() < 16384 * out_ch {
            self.after_buffered();
            std::thread::sleep(Duration::from_millis(8));
            return Ok(());
        }
        let t = self.cur.as_mut().unwrap();
        let packet = match t.format.next_packet() {
            Ok(Some(p)) => Some(p),
            Ok(None) => None,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => None,
            Err(SymError::ResetRequired) => None,
            Err(e) => return Err(format!("{e}")),
        };
        let Some(packet) = packet else {
            // end of stream: flush the resampler tail and let the ring drain
            Self::finish_tail(t, &mut out.prod, out_ch, &mut self.resampled, &mut self.backlog);
            t.eof = true;
            return Ok(());
        };
        if packet.track_id != t.track_id {
            return Ok(());
        }
        let ab = match t.decoder.decode(&packet) {
            Ok(ab) => ab,
            Err(SymError::DecodeError(_)) | Err(SymError::IoError(_)) => return Ok(()),
            Err(e) => return Err(format!("{e}")),
        };
        let src_ch = ab.spec().channels().count().max(1);
        let frames = ab.frames();
        self.decoded.resize(ab.samples_interleaved(), 0.0);
        ab.copy_to_slice_interleaved(&mut self.decoded[..]);

        // drop frames left over from a coarse seek
        let mut start = 0usize;
        if t.drop_frames > 0 {
            let d = (t.drop_frames as usize).min(frames);
            t.drop_frames -= d as u64;
            start = d;
        }
        // map source channels onto the device layout
        self.mapped.clear();
        for f in start..frames {
            let s = &self.decoded[f * src_ch..(f + 1) * src_ch];
            for c in 0..out_ch {
                self.mapped.push(if src_ch == 1 { s[0] } else if c < src_ch { s[c] } else { 0.0 });
            }
        }
        match t.resampler.as_mut() {
            None => {
                push_some(&mut out.prod, &self.mapped, &mut self.backlog);
            }
            Some(rs) => {
                t.pending.extend_from_slice(&self.mapped);
                loop {
                    let need = rs.input_frames_next();
                    if t.pending.len() < need * out_ch {
                        break;
                    }
                    self.resampled.resize(rs.output_frames_max() * out_ch, 0.0);
                    let cap = rs.output_frames_max();
                    let (used, made) = {
                        let inp = InterleavedSlice::new(&t.pending[..need * out_ch], out_ch, need).map_err(|e| e.to_string())?;
                        let mut outp = InterleavedSlice::new_mut(&mut self.resampled[..], out_ch, cap).map_err(|e| e.to_string())?;
                        rs.process_into_buffer(&inp, &mut outp, None).map_err(|e| e.to_string())?
                    };
                    push_some(&mut out.prod, &self.resampled[..made * out_ch], &mut self.backlog);
                    t.pending.drain(..used * out_ch);
                }
            }
        }
        self.after_buffered();
        Ok(())
    }

    fn finish_tail(t: &mut Track, prod: &mut HeapProd<f32>, ch: usize, buf: &mut Vec<f32>, backlog: &mut Vec<f32>) {
        let Some(rs) = t.resampler.as_mut() else { return };
        // feed what's left, then one block of silence to push out the filter delay
        for round in 0..2 {
            let need = rs.input_frames_next();
            let left = if round == 0 { t.pending.len() / ch } else { 0 };
            let mut input = vec![0f32; need * ch];
            input[..left.min(need) * ch].copy_from_slice(&t.pending[..left.min(need) * ch]);
            let cap = rs.output_frames_max();
            buf.resize(cap * ch, 0.0);
            let idx = Indexing::new().partial_len(left.min(need));
            let made = match (InterleavedSlice::new(&input[..], ch, need), InterleavedSlice::new_mut(&mut buf[..], ch, cap)) {
                (Ok(inp), Ok(mut outp)) => rs.process_into_buffer(&inp, &mut outp, Some(&idx)).map(|(_, m)| m).unwrap_or(0),
                _ => 0,
            };
            let keep = if round == 0 { made } else { made.min(rs.output_delay()) };
            push_some(prod, &buf[..keep * ch], backlog);
        }
        t.pending.clear();
    }

    /// Start audible playback once enough is buffered (avoids stutter on network starts).
    fn after_buffered(&mut self) {
        let out = self.out.as_ref().unwrap();
        let status = self.info.lock().unwrap().status;
        let eof = self.cur.as_ref().map(|t| t.eof).unwrap_or(false);
        if status == "loading" && (out.prod.occupied_len() >= out.rate as usize * out.channels / 3 || eof) {
            let play = self.want_play;
            self.cb.paused.store(!play, Ordering::Relaxed);
            self.set(|i| i.status = if play { "playing" } else { "paused" });
        }
    }

    fn check_drained(&mut self) {
        let Some(t) = self.cur.as_ref() else { return };
        if !t.eof {
            return;
        }
        if !self.backlog.is_empty() {
            let out = self.out.as_mut().unwrap();
            let n = out.prod.push_slice(&self.backlog);
            self.backlog.drain(..n);
        }
        let out = self.out.as_ref().unwrap();
        let status = self.info.lock().unwrap().status;
        if status == "loading" {
            self.after_buffered();
            return;
        }
        if status == "playing" && self.backlog.is_empty() && out.prod.occupied_len() == 0 {
            self.cb.paused.store(true, Ordering::Relaxed);
            self.cur = None;
            self.set(|i| i.status = "ended");
        }
    }
}

/// Push what fits into the device ring; keep the rest for later (never blocks, so
/// pause/seek commands are always handled even when the device isn't draining).
fn push_some(prod: &mut HeapProd<f32>, data: &[f32], backlog: &mut Vec<f32>) {
    if !backlog.is_empty() {
        backlog.extend_from_slice(data);
        return;
    }
    let n = prod.push_slice(data);
    backlog.extend_from_slice(&data[n..]);
}
