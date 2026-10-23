//! YouTube through yt-dlp: search, and turning a video into its audio stream for the player.
//!
//! yt-dlp isn't installed with Miek: on first use the official yt-dlp.exe is downloaded from its
//! GitHub releases, checked against the SHA-256 in that release's SHA2-256SUMS, and kept in
//! %LOCALAPPDATA%\Miek\yt-dlp. YouTube changes often, so it is updated with its own updater
//! (`yt-dlp -U`, which also checks the release's checksums) at most once a day.
//!
//! Playback uses YouTube's AAC audio (format 140, m4a), which Miek decodes natively and which yt-dlp
//! lists even without a JavaScript runtime; the stream then goes through the player's ranged-HTTP
//! source like any other link. yt-dlp runs hidden (no console window), never through a shell.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RELEASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
/// AAC in m4a (YouTube's 140, or another AAC/m4a stream if that one is missing)
const FORMAT: &str = "140/bestaudio[ext=m4a][acodec^=mp4a]";

fn dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Miek").join("yt-dlp")
}
fn exe() -> PathBuf {
    dir().join("yt-dlp.exe")
}

static SETUP: Mutex<()> = Mutex::new(()); // one download / update at a time
static STATE: Mutex<&'static str> = Mutex::new("idle"); // idle | downloading | updating

fn set_state(s: &'static str) {
    *STATE.lock().unwrap() = s;
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("Miek/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

/// Download yt-dlp.exe and install it if its SHA-256 matches the release's SHA2-256SUMS.
fn download() -> Result<(), String> {
    set_state("downloading");
    let res = (|| {
        let c = http()?;
        let sums = c.get(format!("{RELEASE}/SHA2-256SUMS")).send().and_then(|r| r.error_for_status()).and_then(|r| r.text()).map_err(|e| format!("Couldn't reach GitHub for yt-dlp: {e}"))?;
        let want = sums
            .lines()
            .find_map(|l| l.split_once("  ").filter(|(_, name)| name.trim() == "yt-dlp.exe").map(|(h, _)| h.trim().to_ascii_lowercase()))
            .ok_or("yt-dlp's checksum list has no yt-dlp.exe")?;
        let bytes = c.get(format!("{RELEASE}/yt-dlp.exe")).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't download yt-dlp: {e}"))?;
        let got = format!("{:x}", Sha256::digest(&bytes));
        if got != want {
            return Err("The downloaded yt-dlp didn't match its published checksum; not installed".to_string());
        }
        std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
        let tmp = exe().with_extension("exe.part");
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, exe()).map_err(|e| e.to_string())?;
        mark_updated();
        Ok(())
    })();
    set_state("idle");
    res
}

fn stamp() -> PathBuf {
    dir().join("updated")
}
fn mark_updated() {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::write(stamp(), now.to_string());
}
fn updated_ago() -> Duration {
    let then = std::fs::read_to_string(stamp()).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    Duration::from_secs(now.saturating_sub(then))
}

/// yt-dlp, downloaded if missing; updated in the background when a day old.
fn ensure() -> Result<PathBuf, String> {
    let _one = SETUP.lock().unwrap();
    if !exe().exists() {
        download()?;
    } else if updated_ago() > Duration::from_secs(24 * 3600) {
        mark_updated(); // once a day even if the update fails (e.g. offline)
        std::thread::spawn(|| {
            let _one = SETUP.lock().unwrap();
            set_state("updating");
            let _ = run(&["-U"], Duration::from_secs(180));
            set_state("idle");
        });
    }
    Ok(exe())
}

/// Run yt-dlp hidden; stdout on success, its last error line otherwise.
fn run(args: &[&str], limit: Duration) -> Result<String, String> {
    let mut cmd = Command::new(exe());
    cmd.args(["--ignore-config", "--no-warnings", "--socket-timeout", "15"]).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| format!("Couldn't start yt-dlp: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    let id = child.id();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = match rx.recv_timeout(limit) {
        Ok(o) => o.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = Command::new("taskkill").args(["/F", "/PID", &id.to_string()]).output();
            return Err("yt-dlp took too long".into());
        }
    };
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let line = err.lines().rev().find(|l| l.contains("ERROR")).unwrap_or_else(|| err.lines().last().unwrap_or("unknown error"));
    Err(line.trim().trim_start_matches("ERROR:").trim().to_string())
}

fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    id: String,
    title: String,
    channel: Option<String>,
    duration: Option<f64>,
}

#[derive(Serialize)]
pub struct Status {
    installed: bool,
    state: &'static str,
    version: Option<String>,
}

#[tauri::command]
pub async fn yt_status() -> Status {
    tauri::async_runtime::spawn_blocking(|| {
        let installed = exe().exists();
        let version = installed.then(|| run(&["--version"], Duration::from_secs(20)).ok()).flatten().map(|v| v.trim().to_string());
        Status { installed, state: *STATE.lock().unwrap(), version }
    })
    .await
    .unwrap_or(Status { installed: false, state: "idle", version: None })
}

/// Videos for a search, best match first.
#[tauri::command]
pub async fn yt_search(query: String) -> Result<Vec<Video>, String> {
    let q = query.trim().to_string();
    if q.chars().count() < 2 {
        return Err("Type a little more to search YouTube".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        ensure()?;
        // "ytsearch15:<query>" is one argument: a query can't be read as an option
        let out = run(&["--flat-playlist", "-J", &format!("ytsearch15:{q}")], Duration::from_secs(45))?;
        entries(&out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Videos from yt-dlp's flat-playlist JSON (a search or a playlist), in order.
fn entries(out: &str) -> Result<Vec<Video>, String> {
    let v: Value = serde_json::from_str(out).map_err(|e| format!("yt-dlp answered something unexpected: {e}"))?;
    Ok(v["entries"]
        .as_array()
        .map(|es| {
            es.iter()
                .filter_map(|e| {
                    let id = e["id"].as_str().filter(|id| valid_id(id))?.to_string();
                    Some(Video { id, title: e["title"].as_str()?.to_string(), channel: e["channel"].as_str().or(e["uploader"].as_str()).map(str::to_string), duration: e["duration"].as_f64() })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// YouTube's Mix for a video: what YouTube plays after it, in its order (without the video itself).
#[tauri::command]
pub async fn yt_mix(id: String) -> Result<Vec<Video>, String> {
    if !valid_id(&id) {
        return Err("Not a YouTube video id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        ensure()?;
        let out = run(&["--flat-playlist", "-J", "--playlist-end", "30", &format!("https://www.youtube.com/watch?v={id}&list=RD{id}")], Duration::from_secs(45))?;
        Ok(entries(&out)?.into_iter().filter(|v| v.id != id).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    url: String,
    duration: Option<f64>,
    bitrate: Option<f64>,
}

// resolved links last ~6 h; keep them a while so replays and Next/Previous don't ask again
static RESOLVED: Mutex<Vec<(String, Stream, SystemTime)>> = Mutex::new(Vec::new());

/// The video's AAC audio link, for the player. `fresh`: ask YouTube again (the last link was refused).
#[tauri::command]
pub async fn yt_resolve(id: String, fresh: Option<bool>) -> Result<Stream, String> {
    if !valid_id(&id) {
        return Err("Not a YouTube video id".into());
    }
    if fresh.unwrap_or(false) {
        RESOLVED.lock().unwrap().retain(|(i, _, _)| *i != id);
    }
    if let Some(s) = RESOLVED.lock().unwrap().iter().find(|(i, _, at)| *i == id && at.elapsed().unwrap_or_default() < Duration::from_secs(3 * 3600)).map(|(_, s, _)| s.clone()) {
        return Ok(s);
    }
    tauri::async_runtime::spawn_blocking(move || {
        ensure()?;
        // IPv4: the link is tied to the asking address, and the player streams it over IPv4 too
        let out = run(&["-f", FORMAT, "-j", "--no-playlist", "--force-ipv4", &format!("https://www.youtube.com/watch?v={id}")], Duration::from_secs(60))?;
        let v: Value = serde_json::from_str(&out).map_err(|e| format!("yt-dlp answered something unexpected: {e}"))?;
        let url = v["url"].as_str().filter(|u| u.starts_with("https://")).ok_or("YouTube didn't give an audio stream Miek can play for this video")?.to_string();
        let s = Stream { url, duration: v["duration"].as_f64(), bitrate: v["abr"].as_f64() };
        let mut r = RESOLVED.lock().unwrap();
        r.retain(|(i, _, at)| *i != id && at.elapsed().unwrap_or_default() < Duration::from_secs(3 * 3600));
        r.push((id, s.clone(), SystemTime::now()));
        Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Update yt-dlp now (Settings).
#[tauri::command]
pub async fn yt_update() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _one = SETUP.lock().unwrap();
        if !exe().exists() {
            download()?;
        } else {
            set_state("updating");
            let r = run(&["-U"], Duration::from_secs(180));
            set_state("idle");
            r?;
            mark_updated();
        }
        run(&["--version"], Duration::from_secs(20)).map(|v| v.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
