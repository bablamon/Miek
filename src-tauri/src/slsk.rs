//! Soulseek client, built in (no daemon to install): server login, search, and downloads that
//! play while they arrive.
//!
//! server (server.slsknet.org:2242) ── login, FileSearch, GetPeerAddress, ConnectToPeer
//! peer "P" connections ── search results (zlib), QueueUpload → their TransferRequest → our TransferResponse
//! peer "F" connection  ── uploader sends the transfer token, we send a byte offset, then the file
//!                          arrives front to back. It's written into the stream cache and the player
//!                          reads it while it lands (seeks inside the received part are instant; a seek
//!                          further ahead waits for the transfer to get there).
//!
//! If a peer can't reach us directly (or we can't reach it), the server relays a ConnectToPeer and
//! the other side connects out and sends PierceFireWall. If both sides are firewalled, it fails.
//! Protocol reference: https://nicotine-plus.org/doc/SLSKPROTOCOL.html
//!
//! Miek shares nothing; it only downloads files the user picks.

use crate::player::{self, Shared};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SERVER: &str = "server.slsknet.org:2242";
const MAX_FRAME: usize = 64 << 20;
const PLAYABLE: &[&str] = &["flac", "wav", "aif", "aiff", "aifc", "mp3", "m4a", "ogg", "oga", "caf"];

// ---------------------------------------------------------------- wire format

/// Little-endian message builder; the first 4 bytes are filled with the length at the end.
struct W(Vec<u8>);
impl W {
    fn msg(code: u32) -> W {
        let mut v = vec![0; 4];
        v.extend(code.to_le_bytes());
        W(v)
    }
    fn init(code: u8) -> W {
        W(vec![0, 0, 0, 0, code])
    }
    fn u8(mut self, x: u8) -> W {
        self.0.push(x);
        self
    }
    fn u32(mut self, x: u32) -> W {
        self.0.extend(x.to_le_bytes());
        self
    }
    fn bytes(mut self, b: &[u8]) -> W {
        self.0.extend((b.len() as u32).to_le_bytes());
        self.0.extend(b);
        self
    }
    fn str(self, s: &str) -> W {
        self.bytes(s.as_bytes())
    }
    fn done(mut self) -> Vec<u8> {
        let n = (self.0.len() - 4) as u32;
        self.0[..4].copy_from_slice(&n.to_le_bytes());
        self.0
    }
}

struct R<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> R<'a> {
    fn new(b: &'a [u8]) -> Self {
        R { b, p: 0 }
    }
    fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
        let s = self.b.get(self.p..self.p + n).ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?;
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> io::Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn raw(&mut self) -> io::Result<Vec<u8>> {
        let n = self.u32()? as usize;
        Ok(self.take(n)?.to_vec())
    }
    fn str(&mut self) -> io::Result<String> {
        Ok(decode(self.raw()?).0)
    }
}

/// Filenames are bytes on the wire: UTF-8 from current clients, Latin-1 from some old ones.
/// They must be sent back byte for byte, so remember which it was.
fn decode(b: Vec<u8>) -> (String, bool) {
    match String::from_utf8(b) {
        Ok(s) => (s, false),
        Err(e) => (e.into_bytes().iter().map(|&c| c as char).collect(), true),
    }
}
fn encode(s: &str, latin1: bool) -> Vec<u8> {
    if latin1 { s.chars().map(|c| c as u32 as u8).collect() } else { s.as_bytes().to_vec() }
}

/// Splits a byte stream into length-prefixed frames. A read timeout returns Ok(None), so callers
/// can check for shutdown; bytes past the last frame stay buffered for whoever reads next.
#[derive(Default)]
struct Frames {
    buf: Vec<u8>,
}
impl Frames {
    fn fill(&mut self, s: &mut TcpStream) -> io::Result<bool> {
        let mut tmp = [0u8; 32 * 1024];
        match s.read(&mut tmp) {
            Ok(0) => Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                self.buf.extend_from_slice(&tmp[..n]);
                Ok(true)
            }
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => Ok(false),
            Err(e) => Err(e),
        }
    }
    fn next(&mut self, s: &mut TcpStream) -> io::Result<Option<Vec<u8>>> {
        loop {
            if self.buf.len() >= 4 {
                let n = u32::from_le_bytes(self.buf[..4].try_into().unwrap()) as usize;
                if n > MAX_FRAME {
                    return Err(io::Error::other("oversized message"));
                }
                if self.buf.len() >= 4 + n {
                    let f = self.buf[4..4 + n].to_vec();
                    self.buf.drain(..4 + n);
                    return Ok(Some(f));
                }
            }
            if !self.fill(s)? {
                return Ok(None);
            }
        }
    }
    /// Exactly `n` raw (unframed) bytes, waiting up to `limit`.
    fn exact(&mut self, s: &mut TcpStream, n: usize, limit: Duration) -> io::Result<Vec<u8>> {
        let t = Instant::now();
        while self.buf.len() < n {
            if t.elapsed() > limit {
                return Err(io::ErrorKind::TimedOut.into());
            }
            self.fill(s)?;
        }
        Ok(self.buf.drain(..n).collect())
    }
}

fn md5_hex(s: &str) -> String {
    format!("{:x}", md5::compute(s.as_bytes()))
}

fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}
fn rand_token() -> u32 {
    (rand_u64() as u32) & 0x7fff_ffff
}
fn rand_word(n: usize) -> String {
    const A: &[u8] = b"abcdefghijkmnopqrstuvwxyz23456789";
    (0..n).map(|_| A[(rand_u64() % A.len() as u64) as usize] as char).collect()
}

// ---------------------------------------------------------------- settings

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Config {
    enabled: bool,
    username: String,
    password: String,
}

fn config_path() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Miek").join("soulseek.json")
}
/// The saved settings. On first run (no settings yet) Soulseek is on, with a generated name and
/// password filled in (Soulseek registers a new name on its first login), so it works out of the box.
fn load_config() -> Config {
    if let Some(c) = std::fs::read(config_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        return c;
    }
    if config_path().exists() {
        return Config::default(); // unreadable: don't overwrite what's there
    }
    let c = Config { enabled: true, username: format!("miek-{}", rand_word(7)), password: rand_word(16) };
    let _ = save_config(&c);
    c
}
fn save_config(c: &Config) -> Result<(), String> {
    let p = config_path();
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_vec_pretty(c).unwrap()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- client state

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    user: String,
    file: String,
    latin1: bool,
    size: u64,
    ext: String,
    bitrate: Option<u32>,
    duration: Option<u32>,
    vbr: bool,
    sample_rate: Option<u32>,
    bit_depth: Option<u32>,
    slot_free: bool,
    speed: u32,
    queue: u32,
}

struct Search {
    started: Instant,
    hits: Vec<Hit>,
}

type PeerWriter = Arc<Mutex<TcpStream>>;

pub struct Transfer {
    user: String,
    file: String,
    latin1: bool,
    size: AtomicU64,
    keep: AtomicBool,
    shared: Arc<Shared>,
    path: PathBuf,
    m: Mutex<TState>,
}

struct TState {
    state: &'static str, // connecting | requested | queued | transferring | done | failed | cancelled
    error: Option<String>,
    place: Option<u32>,
    token: Option<u32>,
    speed: f64,
    retry: bool,
    heard: Instant, // last sign of life from the peer about this file
}

impl Transfer {
    fn set(&self, f: impl FnOnce(&mut TState)) {
        f(&mut self.m.lock().unwrap());
    }
    fn state(&self) -> &'static str {
        self.m.lock().unwrap().state
    }
    fn active(&self) -> bool {
        !matches!(self.state(), "done" | "failed" | "cancelled")
    }
    fn fail(&self, e: String) {
        self.shared.fail(&e);
        self.set(|t| {
            if !matches!(t.state, "done" | "cancelled") {
                t.state = "failed";
                t.error = Some(e);
            }
        });
    }
}

#[derive(Default)]
struct St {
    status: &'static str, // off | connecting | online | error
    error: Option<String>,
    user: String,
    port: u16,
    searches: HashMap<u32, Search>,
    transfers: HashMap<u64, Arc<Transfer>>,
    next_id: u64,
    /// our ConnectToPeer requests: token → whoever waits for the peer's PierceFireWall
    pierce: HashMap<u32, Sender<(TcpStream, Frames)>>,
    /// GetPeerAddress requests waiting for the server's answer
    addr: HashMap<String, Vec<Sender<Option<SocketAddr>>>>,
    /// live "P" connections we can write to
    peers: HashMap<String, (u64, PeerWriter)>,
}

struct Client {
    gen: AtomicU64, // bumped on every reconfigure: threads of an older generation stop
    st: Mutex<St>,
    server: Mutex<Option<TcpStream>>,
}

fn client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| Client { gen: AtomicU64::new(0), st: Mutex::new(St { status: "off", ..Default::default() }), server: Mutex::new(None) })
}
fn alive(gen: u64) -> bool {
    client().gen.load(Ordering::SeqCst) == gen
}
fn st() -> std::sync::MutexGuard<'static, St> {
    client().st.lock().unwrap()
}
fn set_status(gen: u64, status: &'static str, error: Option<String>) {
    if alive(gen) {
        let mut s = st();
        s.status = status;
        s.error = error;
    }
}
fn server_send(b: Vec<u8>) -> io::Result<()> {
    match client().server.lock().unwrap().as_mut() {
        Some(s) => s.write_all(&b),
        None => Err(io::Error::new(io::ErrorKind::NotConnected, "not connected to the Soulseek server")),
    }
}
fn spawn(name: &str, f: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name.into()).spawn(f);
}

/// Start (or stop) according to the saved settings.
pub fn boot() {
    apply(load_config());
}

fn apply(cfg: Config) {
    let c = client();
    let gen = c.gen.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(s) = c.server.lock().unwrap().take() {
        let _ = s.shutdown(Shutdown::Both);
    }
    {
        let mut s = st();
        for (_, w) in s.peers.drain() {
            let _ = w.1.lock().unwrap().shutdown(Shutdown::Both);
        }
        s.status = if cfg.enabled { "connecting" } else { "off" };
        s.error = None;
        s.user = cfg.username.clone();
        s.searches.clear();
    }
    if !cfg.enabled {
        for t in all_transfers() {
            cancel(&t);
        }
        return;
    }
    spawn("miek-slsk", move || supervise(gen, cfg));
}

fn all_transfers() -> Vec<Arc<Transfer>> {
    st().transfers.values().cloned().collect()
}

// ---------------------------------------------------------------- server session

fn supervise(gen: u64, cfg: Config) {
    let port = match listen(gen) {
        Ok(p) => p,
        Err(e) => return set_status(gen, "error", Some(format!("Couldn't open a port for Soulseek: {e}"))),
    };
    st().port = port;
    let mut wait = 5;
    while alive(gen) {
        set_status(gen, "connecting", None);
        match session(gen, &cfg, port) {
            Ok(()) => wait = 5,
            Err(Stop::Fatal(e)) => return set_status(gen, "error", Some(e)),
            Err(Stop::Retry(e)) => set_status(gen, "error", Some(format!("{e} · retrying"))),
        }
        *client().server.lock().unwrap() = None;
        for _ in 0..wait * 10 {
            if !alive(gen) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        wait = (wait * 2).min(120);
    }
}

enum Stop {
    Fatal(String),
    Retry(String),
}

fn session(gen: u64, cfg: &Config, port: u16) -> Result<(), Stop> {
    let host = std::env::var("MIEK_SLSK_SERVER").unwrap_or_else(|_| SERVER.into());
    let addr = host
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.find(|a| a.is_ipv4()))
        .ok_or_else(|| Stop::Retry("Can't reach the Soulseek server (no network?)".into()))?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(15)).map_err(|e| Stop::Retry(format!("Can't reach the Soulseek server: {e}")))?;
    let _ = s.set_nodelay(true);
    s.set_read_timeout(Some(Duration::from_secs(1))).ok();
    let login = W::msg(1)
        .str(&cfg.username)
        .str(&cfg.password)
        .u32(160)
        .str(&md5_hex(&format!("{}{}", cfg.username, cfg.password)))
        .u32(1)
        .done();
    s.write_all(&login).map_err(|e| Stop::Retry(e.to_string()))?;

    let mut frames = Frames::default();
    let t = Instant::now();
    let reply = loop {
        if !alive(gen) {
            return Ok(());
        }
        if t.elapsed() > Duration::from_secs(20) {
            return Err(Stop::Retry("The Soulseek server didn't answer".into()));
        }
        if let Some(f) = frames.next(&mut s).map_err(|e| Stop::Retry(format!("Soulseek server closed the connection: {e}")))? {
            if f.len() >= 4 && u32::from_le_bytes(f[..4].try_into().unwrap()) == 1 {
                break f;
            }
        }
    };
    let mut r = R::new(&reply[4..]);
    if r.u8().unwrap_or(0) == 0 {
        let reason = r.str().unwrap_or_default();
        return Err(Stop::Fatal(match reason.as_str() {
            "INVALIDPASS" => "Soulseek rejected the password for this username. Change the username or password in Settings.".into(),
            "INVALIDUSERNAME" => format!("Soulseek rejected the username: {}", r.str().unwrap_or_default()),
            "INVALIDVERSION" => "Soulseek rejected this client version.".into(),
            other => format!("Soulseek login failed: {other}"),
        }));
    }

    let w = s.try_clone().map_err(|e| Stop::Retry(e.to_string()))?;
    *client().server.lock().unwrap() = Some(w);
    // where peers can reach us; we share no files; we're online
    let _ = server_send(W::msg(2).u32(port as u32).done());
    let _ = server_send(W::msg(35).u32(0).u32(0).done());
    let _ = server_send(W::msg(28).u32(2).done());
    set_status(gen, "online", None);

    let mut ping = Instant::now();
    loop {
        if !alive(gen) {
            return Ok(());
        }
        if ping.elapsed() > Duration::from_secs(300) {
            ping = Instant::now();
            let _ = server_send(W::msg(32).done());
        }
        let f = match frames.next(&mut s) {
            Ok(Some(f)) => f,
            Ok(None) => continue,
            Err(e) => return Err(Stop::Retry(format!("Lost the Soulseek server: {e}"))),
        };
        if f.len() < 4 {
            continue;
        }
        let code = u32::from_le_bytes(f[..4].try_into().unwrap());
        let mut r = R::new(&f[4..]);
        match code {
            3 => {
                // GetPeerAddress
                if let (Ok(user), Ok(ip), Ok(port)) = (r.str(), r.u32(), r.u32()) {
                    let a = (ip != 0 && port != 0).then(|| SocketAddr::from((Ipv4Addr::from(ip), port as u16)));
                    for tx in st().addr.remove(&user).unwrap_or_default() {
                        let _ = tx.send(a);
                    }
                }
            }
            18 => {
                // ConnectToPeer: a peer couldn't reach us, so we connect to it and pierce
                if let (Ok(user), Ok(kind), Ok(ip), Ok(port), Ok(token)) = (r.str(), r.str(), r.u32(), r.u32(), r.u32()) {
                    let a = SocketAddr::from((Ipv4Addr::from(ip), port as u16));
                    spawn("miek-slsk-pierce", move || {
                        let Ok(mut c) = TcpStream::connect_timeout(&a, Duration::from_secs(10)) else { return };
                        if c.write_all(&W::init(0).u32(token).done()).is_ok() {
                            route(gen, c, Frames::default(), user, &kind);
                        }
                    });
                }
            }
            1001 => {
                // CantConnectToPeer: our relayed request failed; dropping the waiter makes it give up
                if let Ok(token) = r.u32() {
                    st().pierce.remove(&token);
                }
            }
            41 => return Err(Stop::Fatal("Someone signed in to Soulseek with this username elsewhere.".into())),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- peer connections

fn listen(gen: u64) -> io::Result<u16> {
    // MIEK_SLSK_BIND=127.0.0.1 keeps tests against tests/mock_slsk.py off the network
    let ip = std::env::var("MIEK_SLSK_BIND").unwrap_or_else(|_| "0.0.0.0".into());
    let l = (2234..=2240)
        .chain(std::iter::once(0))
        .find_map(|p| TcpListener::bind((ip.as_str(), p)).ok())
        .ok_or_else(|| io::Error::other("no free port"))?;
    let port = l.local_addr()?.port();
    l.set_nonblocking(true)?;
    spawn("miek-slsk-listen", move || {
        while alive(gen) {
            match l.accept() {
                Ok((c, _)) => spawn("miek-slsk-in", move || incoming(gen, c)),
                Err(_) => std::thread::sleep(Duration::from_millis(150)),
            }
        }
    });
    Ok(port)
}

/// A peer connected to us: PeerInit (it reached us directly) or PierceFireWall (answering our request).
fn incoming(gen: u64, mut c: TcpStream) {
    let _ = c.set_nonblocking(false);
    let _ = c.set_read_timeout(Some(Duration::from_secs(1)));
    let mut frames = Frames::default();
    let t = Instant::now();
    let first = loop {
        match frames.next(&mut c) {
            Ok(Some(f)) => break f,
            Ok(None) if t.elapsed() < Duration::from_secs(20) => continue,
            _ => return,
        }
    };
    let mut r = R::new(&first);
    match r.u8() {
        Ok(0) => {
            if let Ok(token) = r.u32() {
                if let Some(tx) = st().pierce.remove(&token) {
                    let _ = tx.send((c, frames));
                }
            }
        }
        Ok(1) => {
            if let (Ok(user), Ok(kind)) = (r.str(), r.str()) {
                route(gen, c, frames, user, &kind);
            }
        }
        _ => {}
    }
}

fn route(gen: u64, c: TcpStream, frames: Frames, user: String, kind: &str) {
    let _ = c.set_read_timeout(Some(Duration::from_secs(1)));
    match kind {
        "P" => {
            if let Ok(w) = c.try_clone() {
                let id = register(&user, w);
                peer_loop(gen, c, frames, user, id);
            }
        }
        "F" => file_conn(c, frames, &user),
        _ => {}
    }
}

fn register(user: &str, w: TcpStream) -> u64 {
    let id = rand_u64();
    st().peers.insert(user.to_string(), (id, Arc::new(Mutex::new(w))));
    id
}

/// A writable "P" connection to `user`: an existing one, a direct connection, or one relayed by the server.
fn peer(user: &str) -> Result<PeerWriter, String> {
    if let Some((_, w)) = st().peers.get(user) {
        return Ok(w.clone());
    }
    let gen = client().gen.load(Ordering::SeqCst);
    let me = st().user.clone();
    let (tx, rx) = channel();
    st().addr.entry(user.to_string()).or_default().push(tx);
    server_send(W::msg(3).str(user).done()).map_err(|e| e.to_string())?;
    let addr = rx.recv_timeout(Duration::from_secs(15)).map_err(|_| "The Soulseek server didn't say where this user is".to_string())?;
    let Some(addr) = addr else { return Err(format!("{user} is offline")) };
    if let Ok(mut c) = TcpStream::connect_timeout(&addr, Duration::from_secs(6)) {
        if c.write_all(&W::init(1).str(&me).str("P").u32(0).done()).is_ok() {
            return start_peer(gen, c, Frames::default(), user);
        }
    }
    // couldn't connect: ask the peer (through the server) to connect to us instead
    let token = rand_token();
    let (tx, rx) = channel();
    st().pierce.insert(token, tx);
    server_send(W::msg(18).u32(token).str(user).str("P").done()).map_err(|e| e.to_string())?;
    match rx.recv_timeout(Duration::from_secs(25)) {
        Ok((c, frames)) => start_peer(gen, c, frames, user),
        Err(_) => {
            st().pierce.remove(&token);
            Err(format!("Couldn't connect to {user}. You may both be behind firewalls; forwarding port {} on your router helps.", st().port))
        }
    }
}

fn start_peer(gen: u64, c: TcpStream, frames: Frames, user: &str) -> Result<PeerWriter, String> {
    let _ = c.set_nodelay(true);
    let _ = c.set_read_timeout(Some(Duration::from_secs(1)));
    let w = c.try_clone().map_err(|e| e.to_string())?;
    let id = register(user, w);
    let writer = st().peers.get(user).map(|p| p.1.clone()).unwrap();
    let u = user.to_string();
    spawn("miek-slsk-peer", move || peer_loop(gen, c, frames, u, id));
    Ok(writer)
}

fn peer_send(w: &PeerWriter, b: Vec<u8>) -> io::Result<()> {
    w.lock().unwrap().write_all(&b)
}

fn peer_loop(gen: u64, mut c: TcpStream, mut frames: Frames, user: String, id: u64) {
    let mut idle = Instant::now();
    while alive(gen) && idle.elapsed() < Duration::from_secs(300) {
        let f = match frames.next(&mut c) {
            Ok(Some(f)) => f,
            Ok(None) => continue,
            Err(_) => break,
        };
        idle = Instant::now();
        if f.len() < 4 {
            continue;
        }
        let code = u32::from_le_bytes(f[..4].try_into().unwrap());
        let _ = peer_message(&mut c, &user, code, &f[4..]);
    }
    let mut s = st();
    if s.peers.get(&user).map(|p| p.0) == Some(id) {
        s.peers.remove(&user);
    }
    // peers often close the connection they sent search results on; a request we wrote into it
    // just before that, still unanswered, may never have been read: send it again
    let unanswered: Vec<_> = s.transfers.values().filter(|t| t.user == user && t.state() == "requested").cloned().collect();
    drop(s);
    for t in unanswered {
        t.set(|s| s.retry = true);
    }
    let _ = c.shutdown(Shutdown::Both);
}

fn find(user: &str, file: &[u8]) -> Option<Arc<Transfer>> {
    st().transfers.values().find(|t| t.user == user && encode(&t.file, t.latin1) == file && t.active()).cloned()
}

fn peer_message(c: &mut TcpStream, user: &str, code: u32, body: &[u8]) -> io::Result<()> {
    let mut r = R::new(body);
    match code {
        9 => search_reply(body),
        4 => {
            // share list request: we share nothing
            let empty = zlib(&W(vec![]).u32(0).u32(0).u32(0).0);
            c.write_all(&{
                let mut m = W::msg(5);
                m.0.extend(empty);
                m.done()
            })?;
        }
        15 => {
            // user info request
            c.write_all(&W::msg(16).str("Miek music player").u8(0).u32(0).u32(0).u8(0).u32(0).done())?;
        }
        40 => {
            // TransferRequest: direction 1 = they're about to upload to us
            let dir = r.u32()?;
            let token = r.u32()?;
            let file = r.raw()?;
            let size = if dir == 1 { r.u64().ok() } else { None };
            let t = (dir == 1).then(|| find(user, &file)).flatten().filter(|t| !t.shared.cancel.load(Ordering::SeqCst));
            match t {
                Some(t) => {
                    if let Some(sz) = size.filter(|&s| s > 0) {
                        t.size.store(sz, Ordering::SeqCst);
                        t.shared.len.store(sz, Ordering::SeqCst);
                    }
                    t.set(|s| {
                        s.token = Some(token);
                        s.place = None;
                        s.heard = Instant::now();
                    });
                    c.write_all(&W::msg(41).u32(token).u8(1).done())?;
                }
                None => {
                    let why = if dir == 1 { "Cancelled" } else { "File not shared." };
                    c.write_all(&W::msg(41).u32(token).u8(0).str(why).done())?;
                }
            }
        }
        44 => {
            // PlaceInQueueResponse
            let file = r.raw()?;
            let place = r.u32()?;
            if let Some(t) = find(user, &file) {
                t.set(|s| {
                    s.place = Some(place);
                    s.heard = Instant::now();
                    if matches!(s.state, "connecting" | "requested") {
                        s.state = "queued";
                    }
                });
            }
        }
        46 => {
            // UploadFailed: their side of an upload broke; queue it again
            let file = r.raw()?;
            if let Some(t) = find(user, &file) {
                t.set(|s| s.retry = true);
            }
        }
        50 => {
            // UploadDenied
            let file = r.raw()?;
            let reason = r.str().unwrap_or_default();
            if let Some(t) = find(user, &file) {
                t.fail(format!("{user} declined: {reason}"));
            }
        }
        _ => {}
    }
    Ok(())
}

fn zlib(b: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = e.write_all(b);
    e.finish().unwrap_or_default()
}

fn search_reply(body: &[u8]) {
    let mut raw = Vec::new();
    if flate2::read::ZlibDecoder::new(body).take(MAX_FRAME as u64).read_to_end(&mut raw).is_err() {
        return;
    }
    let mut r = R::new(&raw);
    let parse = |r: &mut R| -> io::Result<(String, u32, Vec<Hit>)> {
        let user = r.str()?;
        let token = r.u32()?;
        let n = r.u32()?.min(5000);
        let mut hits = Vec::new();
        for _ in 0..n {
            r.u8()?;
            let (file, latin1) = decode(r.raw()?);
            let size = r.u64()?;
            r.raw()?; // extension (blank from SoulseekQt): taken from the filename instead
            let mut h = Hit { user: user.clone(), ext: ext_of(&file), file, latin1, size, bitrate: None, duration: None, vbr: false, sample_rate: None, bit_depth: None, slot_free: false, speed: 0, queue: 0 };
            for _ in 0..r.u32()?.min(16) {
                let (code, v) = (r.u32()?, r.u32()?);
                match code {
                    0 => h.bitrate = Some(v),
                    1 => h.duration = Some(v),
                    2 => h.vbr = v == 1,
                    4 => h.sample_rate = Some(v),
                    5 => h.bit_depth = Some(v),
                    _ => {}
                }
            }
            hits.push(h);
        }
        let slot = r.u8()? != 0;
        let speed = r.u32()?;
        let queue = r.u32()?;
        for h in &mut hits {
            h.slot_free = slot;
            h.speed = speed;
            h.queue = queue;
        }
        Ok((user, token, hits))
    };
    let Ok((_, token, hits)) = parse(&mut r) else { return };
    let mut s = st();
    if let Some(search) = s.searches.get_mut(&token) {
        let room = 2000usize.saturating_sub(search.hits.len());
        search.hits.extend(hits.into_iter().filter(|h| PLAYABLE.contains(&h.ext.as_str()) && h.size > 0).take(room));
    }
}

fn ext_of(file: &str) -> String {
    let base = file.rsplit(['\\', '/']).next().unwrap_or(file);
    base.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

// ---------------------------------------------------------------- transfers

/// The uploader's "F" connection: it sends the transfer token, we answer with how much we already
/// have, then the rest of the file arrives in order and goes straight into the stream cache.
fn file_conn(mut c: TcpStream, mut frames: Frames, user: &str) {
    let Ok(tok) = frames.exact(&mut c, 4, Duration::from_secs(30)) else { return };
    let token = u32::from_le_bytes(tok[..4].try_into().unwrap());
    let t = st().transfers.values().find(|t| t.user == user && t.m.lock().unwrap().token == Some(token) && t.active()).cloned();
    let Some(t) = t else { return };
    if t.shared.cancel.load(Ordering::SeqCst) {
        return;
    }
    let offset = t.shared.downloaded.load(Ordering::SeqCst);
    let mut file = match std::fs::OpenOptions::new().write(true).create(true).truncate(false).open(&t.path) {
        Ok(f) => f,
        Err(e) => return t.fail(format!("Couldn't write the stream cache: {e}")),
    };
    use std::io::Seek;
    if file.set_len(offset).is_err() || file.seek(io::SeekFrom::Start(offset)).is_err() || c.write_all(&offset.to_le_bytes()).is_err() {
        return t.set(|s| s.retry = true);
    }
    t.set(|s| {
        s.state = "transferring";
        s.place = None;
        s.heard = Instant::now();
    });
    let size = t.size.load(Ordering::SeqCst);
    // bytes that arrived together with the token (normally none: the uploader waits for the offset)
    let leftover = std::mem::take(&mut frames.buf);
    let mut buf = vec![0u8; 64 * 1024];
    let mut pre = leftover.len().min(buf.len());
    buf[..pre].copy_from_slice(&leftover[..pre]);
    let (mut window, mut window_at) = (0u64, Instant::now());
    let mut quiet = Instant::now();
    loop {
        if t.shared.cancel.load(Ordering::SeqCst) {
            let _ = c.shutdown(Shutdown::Both);
            return;
        }
        let have = t.shared.downloaded.load(Ordering::SeqCst);
        if size > 0 && have >= size {
            let _ = file.flush();
            let _ = std::fs::write(t.path.with_extension("done"), b"");
            t.shared.done.store(true, Ordering::SeqCst);
            t.set(|s| s.state = "done");
            let _ = c.shutdown(Shutdown::Both); // the downloader closes when it has everything
            return;
        }
        let n = if pre > 0 {
            std::mem::take(&mut pre)
        } else {
            match c.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                    if quiet.elapsed() > Duration::from_secs(60) {
                        break;
                    }
                    continue;
                }
                Err(_) => break,
            }
        };
        quiet = Instant::now();
        let n = if size > 0 { n.min((size - have) as usize) } else { n };
        if file.write_all(&buf[..n]).is_err() {
            return t.fail("Couldn't write the stream cache".into());
        }
        t.shared.downloaded.fetch_add(n as u64, Ordering::SeqCst);
        window += n as u64;
        let el = window_at.elapsed().as_secs_f64();
        if el > 1.0 {
            t.set(|s| s.speed = window as f64 / el);
            window = 0;
            window_at = Instant::now();
        }
    }
    // closed early: queue the rest again (resumes at the offset)
    t.set(|s| s.retry = true);
}

/// Ask the peer to upload, then wait while they queue or send it. Retries a broken upload,
/// resuming from what already arrived.
fn drive(t: Arc<Transfer>) {
    let file = encode(&t.file, t.latin1);
    let mut attempts = 0;
    'attempt: loop {
        attempts += 1;
        if t.shared.cancel.load(Ordering::SeqCst) {
            return;
        }
        if attempts > 4 {
            return t.fail(format!("The transfer from {} kept breaking off", t.user));
        }
        t.set(|s| {
            s.state = "connecting";
            s.retry = false;
            s.token = None;
            s.heard = Instant::now();
        });
        let w = match peer(&t.user) {
            Ok(w) => w,
            Err(e) => return t.fail(e),
        };
        if peer_send(&w, W::msg(43).bytes(&file).done()).and_then(|_| peer_send(&w, W::msg(51).bytes(&file).done())).is_err() {
            st().peers.remove(&t.user);
            continue;
        }
        t.set(|s| {
            if s.state == "connecting" {
                s.state = "requested";
            }
        });
        let mut asked = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(200));
            if t.shared.cancel.load(Ordering::SeqCst) {
                return;
            }
            let (state, retry, heard) = {
                let s = t.m.lock().unwrap();
                (s.state, s.retry, s.heard)
            };
            match state {
                "done" | "failed" | "cancelled" => return,
                _ if retry => continue 'attempt,
                "transferring" => {}
                "requested" if heard.elapsed() > Duration::from_secs(90) => return t.fail(format!("{} didn't answer the request", t.user)),
                _ => {
                    // still waiting in their queue: ask for our place now and then
                    if asked.elapsed() > Duration::from_secs(45) {
                        asked = Instant::now();
                        match peer(&t.user) {
                            Ok(w) => {
                                let _ = peer_send(&w, W::msg(51).bytes(&file).done());
                            }
                            Err(e) => return t.fail(e),
                        }
                    }
                }
            }
        }
    }
}

fn cancel(t: &Transfer) {
    t.shared.cancel.store(true, Ordering::SeqCst);
    t.set(|s| {
        if !matches!(s.state, "done" | "failed") {
            s.state = "cancelled";
        }
    });
}

/// Stream cache file for a Soulseek file (finished ones replay without the network).
fn cache_file(user: &str, file: &str, size: u64) -> PathBuf {
    player::cache_path(&format!("slsk:{user}\n{file}\n{size}"))
}

/// For the player: the cache file being written and its download state.
pub fn source(id: &str) -> Result<(PathBuf, Arc<Shared>, String), String> {
    let id: u64 = id.parse().map_err(|_| "bad Soulseek transfer id")?;
    let t = st().transfers.get(&id).cloned().ok_or("That Soulseek transfer is gone")?;
    if let Some(e) = t.m.lock().unwrap().error.clone() {
        return Err(e);
    }
    Ok((t.path.clone(), t.shared.clone(), t.file.clone()))
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    state: &'static str,
    error: Option<String>,
    username: String,
    port: u16,
}

#[tauri::command]
pub fn slsk_status() -> Status {
    let s = st();
    Status { enabled: s.status != "off", state: s.status, error: s.error.clone(), username: s.user.clone(), port: s.port }
}

#[tauri::command]
pub fn slsk_config_get() -> Config {
    load_config()
}

/// Turning Soulseek on without a name picks a random one; the server registers a new name on first login.
#[tauri::command]
pub fn slsk_config_set(enabled: bool, username: String, password: String) -> Result<Config, String> {
    let mut c = Config { enabled, username: username.trim().to_string(), password };
    if c.enabled && c.username.is_empty() {
        c.username = format!("miek-{}", rand_word(7));
    }
    if c.enabled && c.password.is_empty() {
        c.password = rand_word(16);
    }
    if c.username.chars().count() > 30 {
        return Err("Soulseek usernames are at most 30 characters".into());
    }
    save_config(&c)?;
    apply(c.clone());
    Ok(c)
}

/// Why Soulseek can't be used right now, or None when it's signed in.
fn offline() -> Option<String> {
    let s = st();
    match s.status {
        "online" => None,
        "off" => Some("Soulseek is off".into()),
        "connecting" => Some("Still connecting to Soulseek".into()),
        _ => Some(s.error.clone().unwrap_or_else(|| "Soulseek isn't connected".into())),
    }
}

#[tauri::command]
pub fn slsk_search(query: String) -> Result<u32, String> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Err("Type a little more to search Soulseek".into());
    }
    if let Some(e) = offline() {
        return Err(e);
    }
    let token = rand_token();
    {
        let mut s = st();
        s.searches.retain(|_, x| x.started.elapsed() < Duration::from_secs(600));
        s.searches.insert(token, Search { started: Instant::now(), hits: vec![] });
    }
    server_send(W::msg(26).u32(token).str(q).done()).map_err(|e| e.to_string())?;
    Ok(token)
}

#[derive(Serialize)]
pub struct Results {
    hits: Vec<Hit>,
    /// peers keep answering for a while; after this the UI stops asking
    done: bool,
}

#[tauri::command]
pub fn slsk_results(token: u32, from: usize) -> Result<Results, String> {
    let s = st();
    let x = s.searches.get(&token).ok_or("That Soulseek search expired")?;
    Ok(Results { hits: x.hits.iter().skip(from).cloned().collect(), done: x.started.elapsed() > Duration::from_secs(25) })
}

/// Start streaming a search result (or reuse a transfer of the same file). `keep` = a download the
/// user asked to keep; plain streams are cancelled when another stream starts. `prefetch` = the next
/// song in the queue, fetched ahead: it leaves the playing stream alone.
#[tauri::command]
pub fn slsk_stream(user: String, file: String, latin1: bool, size: u64, keep: bool, prefetch: Option<bool>) -> Result<String, String> {
    // a transfer of this file that is running or finished (asking again must not pile up entries)
    let existing = st()
        .transfers
        .iter()
        .find(|(_, t)| {
            let done = t.state() == "done" && t.path.with_extension("done").exists(); // still in the cache
            t.user == user && t.file == file && (t.active() || done) && !t.shared.cancel.load(Ordering::SeqCst)
        })
        .map(|(id, t)| (*id, t.clone()));
    if !keep && !prefetch.unwrap_or(false) {
        stop_streams(existing.as_ref().map(|e| e.0));
    }
    if let Some((id, t)) = existing {
        if keep {
            t.keep.store(true, Ordering::SeqCst);
        }
        return Ok(id.to_string());
    }
    let path = cache_file(&user, &file, size);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let done = path.with_extension("done").exists() && std::fs::metadata(&path).map(|m| m.len() == size).unwrap_or(false);
    if !done {
        player::trim_cache();
        let _ = std::fs::remove_file(path.with_extension("done"));
        if let Some(e) = offline() {
            return Err(e);
        }
    }
    let shared = Arc::new(Shared::new(size, false));
    // a partial file from an earlier, interrupted transfer: resume after it
    let have = std::fs::metadata(&path).map(|m| m.len().min(size)).unwrap_or(0);
    shared.downloaded.store(if done { size } else { have }, Ordering::SeqCst);
    shared.done.store(done, Ordering::SeqCst);
    let t = Arc::new(Transfer {
        user,
        file,
        latin1,
        size: AtomicU64::new(size),
        keep: AtomicBool::new(keep),
        shared,
        path,
        m: Mutex::new(TState { state: if done { "done" } else { "connecting" }, error: None, place: None, token: None, speed: 0.0, retry: false, heard: Instant::now() }),
    });
    let id = {
        let mut s = st();
        s.next_id += 1;
        let id = s.next_id;
        s.transfers.insert(id, t.clone());
        id
    };
    if !done {
        spawn("miek-slsk-transfer", move || drive(t));
    }
    Ok(id.to_string())
}

fn stop_streams(except: Option<u64>) {
    let list: Vec<_> = st().transfers.iter().filter(|(id, t)| Some(**id) != except && !t.keep.load(Ordering::SeqCst) && t.active()).map(|(_, t)| t.clone()).collect();
    for t in list {
        cancel(&t);
    }
}

/// Cancel streams that aren't kept (the player moved on to something else).
#[tauri::command]
pub fn slsk_stop_streams() {
    stop_streams(None);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    state: &'static str,
    error: Option<String>,
    place: Option<u32>,
    received: u64,
    size: u64,
    speed: f64,
    user: String,
    keep: bool,
}

#[tauri::command]
pub fn slsk_transfer(id: String) -> Result<TransferInfo, String> {
    let id: u64 = id.parse().map_err(|_| "bad Soulseek transfer id")?;
    let t = st().transfers.get(&id).cloned().ok_or("That Soulseek transfer is gone")?;
    let s = t.m.lock().unwrap();
    Ok(TransferInfo {
        state: s.state,
        error: s.error.clone(),
        place: s.place,
        received: t.shared.downloaded.load(Ordering::SeqCst),
        size: t.size.load(Ordering::SeqCst),
        speed: s.speed,
        user: t.user.clone(),
        keep: t.keep.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub fn slsk_cancel(id: String) {
    if let Some(t) = id.parse().ok().and_then(|id: u64| st().transfers.get(&id).cloned()) {
        cancel(&t);
    }
}

#[derive(Serialize)]
pub struct Saved {
    folder: String,
    path: String,
}

/// Copy a finished transfer into Music\Miek Soulseek (the user asked to keep it).
#[tauri::command]
pub fn slsk_save(id: String) -> Result<Saved, String> {
    let id: u64 = id.parse().map_err(|_| "bad Soulseek transfer id")?;
    let t = st().transfers.get(&id).cloned().ok_or("That Soulseek transfer is gone")?;
    if t.state() != "done" {
        return Err("The download hasn't finished yet".into());
    }
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = home.join("Music").join("Miek Soulseek");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base: String = t.file.rsplit(['\\', '/']).next().unwrap_or("track").chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let (stem, ext) = base.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((base.clone(), String::new()));
    let mut dest = dir.join(&base);
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::copy(&t.path, &dest).map_err(|e| format!("Couldn't save the file: {e}"))?;
    Ok(Saved { folder: dir.to_string_lossy().into_owned(), path: dest.to_string_lossy().into_owned() })
}

#[cfg(test)]
mod tests {
    //! Against the mock network: `python -I tests/mock_slsk.py <file.flac> direct|relay`, then
    //! `MIEK_SLSK_SERVER=127.0.0.1:22420 MIEK_SLSK_TEST_FILE=<file.flac> cargo test -- --ignored --nocapture`
    use super::*;

    fn wait(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
        let t = Instant::now();
        while !f() {
            assert!(t.elapsed() < Duration::from_secs(secs), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    #[ignore]
    fn mock_network_end_to_end() {
        let original = std::fs::read(std::env::var("MIEK_SLSK_TEST_FILE").unwrap()).unwrap();
        slsk_config_set(true, "tester".into(), "secret".into()).unwrap();
        wait("login", 10, || slsk_status().state == "online");

        // search: real results arrive from the peer, non-audio files are left out
        let tok = slsk_search("test tone".into()).unwrap();
        let mut hits = vec![];
        wait("results", 10, || {
            hits = slsk_results(tok, 0).unwrap().hits;
            hits.len() >= 3
        });
        assert!(hits.iter().all(|h| h.ext != "jpg"), "cover.jpg should be filtered");
        let hit = hits.iter().find(|h| h.file.ends_with("01 - Test Tone.flac")).unwrap().clone();
        assert_eq!((hit.user.as_str(), hit.size, hit.sample_rate, hit.bit_depth, hit.duration), ("alice", original.len() as u64, Some(48000), Some(24), Some(30)));
        let latin = hits.iter().find(|h| h.latin1).expect("latin-1 filename").clone();
        assert!(latin.file.contains("Café"), "{}", latin.file);

        // stream: queued → transferring; playback starts long before the file is complete
        let id = slsk_stream(hit.user.clone(), hit.file.clone(), hit.latin1, hit.size, false, None).unwrap();
        let mut states = vec![];
        wait("first bytes", 30, || {
            let i = slsk_transfer(id.clone()).unwrap();
            if states.last() != Some(&i.state) {
                states.push(i.state);
            }
            assert_ne!(i.state, "failed", "{:?}", i.error);
            i.received >= 256 * 1024
        });
        println!("states: {states:?}");
        assert!(states.contains(&"queued"), "{states:?}");
        let (path, shared, _) = source(&id).unwrap();
        let at_start = shared.downloaded.load(Ordering::SeqCst);
        assert!(at_start < original.len() as u64 / 2, "should be streaming, not downloaded first");
        // seek to 20 s, far past what has arrived: waits for the transfer (which drops once at 40 %
        // and resumes from its offset), then decodes to the end
        let (frames, rate, bits) = crate::player::decode_soulseek(path.clone(), shared.clone(), "flac", Some(20.0)).unwrap();
        assert_eq!((rate, bits), (48000, Some(24)));
        assert!((frames as i64 - 10 * 48000).abs() < 48000 / 5, "frames after seek: {frames}");
        wait("done", 30, || slsk_transfer(id.clone()).unwrap().state == "done");
        assert_eq!(std::fs::read(&path).unwrap(), original, "received bytes differ");
        // full decode from the start, from the cache
        let (frames, _, _) = crate::player::decode_soulseek(path, shared, "flac", None).unwrap();
        assert!((frames as i64 - 30 * 48000).abs() < 48000 / 10, "{frames}");

        // a Latin-1 named file is requested with its original bytes; cancelling stops it
        let id2 = slsk_stream(latin.user.clone(), latin.file.clone(), true, latin.size, false, None).unwrap();
        wait("latin-1 transfer", 30, || slsk_transfer(id2.clone()).unwrap().state == "transferring");
        slsk_cancel(id2.clone());
        let got = slsk_transfer(id2.clone()).unwrap().received;
        std::thread::sleep(Duration::from_millis(800));
        let i = slsk_transfer(id2).unwrap();
        assert_eq!(i.state, "cancelled");
        assert!(i.received <= got + 64 * 1024, "kept receiving after cancel");

        // refusals and offline peers are reported, not papered over
        let id3 = slsk_stream("alice".into(), r"Music\Alice\denied.flac".into(), false, 1234567, false, None).unwrap();
        wait("denial", 15, || slsk_transfer(id3.clone()).unwrap().state == "failed");
        assert!(slsk_transfer(id3).unwrap().error.unwrap().contains("Too many files"));
        let id4 = slsk_stream("bob".into(), "x.flac".into(), false, 10, false, None).unwrap();
        wait("offline", 15, || slsk_transfer(id4.clone()).unwrap().state == "failed");
        assert_eq!(slsk_transfer(id4).unwrap().error.unwrap(), "bob is offline");

        // a finished transfer replays from the cache
        let again = slsk_stream(hit.user.clone(), hit.file.clone(), false, hit.size, false, None).unwrap();
        assert_eq!(slsk_transfer(again).unwrap().state, "done");

        slsk_config_set(false, "tester".into(), "secret".into()).unwrap();
        assert_eq!(slsk_status().state, "off");
        assert!(slsk_search("anything".into()).unwrap_err().contains("off"));
    }
}
