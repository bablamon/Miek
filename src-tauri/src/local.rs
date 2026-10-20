//! Local music library: scans the user's folders, reads tags + format details,
//! extracts cover art. Index lives in %APPDATA%\Miek\local.json; covers in
//! %LOCALAPPDATA%\Miek\covers (served to the UI through the asset protocol).

use lofty::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const EXTS: &[&str] = &["flac", "wav", "aif", "aiff", "m4a", "mp4", "alac", "mp3", "ogg", "oga", "opus", "caf", "mka"];
const COVER_FILES: &[&str] = &["cover", "folder", "front", "album", "albumart"];

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    path: String,
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    track: Option<u32>,
    disc: Option<u32>,
    year: Option<u16>,
    genre: Option<String>,
    duration: f64,
    sample_rate: Option<u32>,
    bit_depth: Option<u8>,
    codec: Option<String>,
    cover: Option<String>,
    mtime: u64,
    size: u64,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Index {
    folders: Vec<String>,
    tracks: Vec<LocalTrack>,
}

fn index_path() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Miek").join("local.json")
}
pub(crate) fn covers_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Miek").join("covers")
}

fn load() -> Index {
    std::fs::read_to_string(index_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
fn save(ix: &Index) -> Result<(), String> {
    let p = index_path();
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(ix).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn hash_str(s: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn codec_name(path: &Path, bit_depth: Option<u8>) -> String {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "flac" => "flac",
        "wav" => "wav",
        "aif" | "aiff" => "aiff",
        // MP4 audio is ALAC (lossless, has a bit depth) or AAC (lossy)
        "m4a" | "mp4" | "alac" | "caf" => if bit_depth.is_some() { "alac" } else { "aac" },
        "mp3" => "mp3",
        "ogg" | "oga" => "vorbis",
        "opus" => "opus",
        other => other,
    }
    .to_string()
}

/// Embedded front cover, else a cover image next to the file. Cached per album folder.
fn find_cover(path: &Path, tag: Option<&lofty::tag::Tag>, cache: &mut HashMap<String, Option<String>>) -> Option<String> {
    let dir = path.parent()?.to_string_lossy().to_string();
    let key = format!("{dir}|{}", tag.and_then(|t| t.album().map(|a| a.into_owned())).unwrap_or_default());
    if let Some(hit) = cache.get(&key) {
        return hit.clone();
    }
    let mut found = None;
    if let Some(pic) = tag.and_then(|t| {
        let pics = t.pictures();
        pics.iter().find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront).or(pics.first())
    }) {
        let ext = match pic.mime_type().map(|m| m.as_str()) {
            Some("image/png") => "png",
            _ => "jpg",
        };
        let out = covers_dir().join(format!("{}.{ext}", hash_str(&key)));
        if out.exists() || std::fs::write(&out, pic.data()).is_ok() {
            found = Some(out.to_string_lossy().to_string());
        }
    }
    if found.is_none() {
        if let Ok(rd) = std::fs::read_dir(path.parent()?) {
            for e in rd.flatten() {
                let p = e.path();
                let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
                let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
                if COVER_FILES.contains(&stem.as_str()) && matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                    // copy into the covers dir so the asset scope stays narrow
                    let out = covers_dir().join(format!("{}.{ext}", hash_str(&key)));
                    if out.exists() || std::fs::copy(&p, &out).is_ok() {
                        found = Some(out.to_string_lossy().to_string());
                    }
                    break;
                }
            }
        }
    }
    cache.insert(key, found.clone());
    found
}

fn read_track(path: &Path, mtime: u64, size: u64, covers: &mut HashMap<String, Option<String>>) -> LocalTrack {
    let mut t = LocalTrack { path: path.to_string_lossy().to_string(), mtime, size, ..Default::default() };
    match lofty::read_from_path(path) {
        Ok(tf) => {
            let pr = tf.properties();
            t.duration = pr.duration().as_secs_f64();
            t.sample_rate = pr.sample_rate();
            t.bit_depth = pr.bit_depth();
            let tag = tf.primary_tag().or_else(|| tf.first_tag());
            if let Some(tag) = tag {
                t.title = tag.title().map(|c| c.into_owned());
                t.artist = tag.artist().map(|c| c.into_owned());
                t.album = tag.album().map(|c| c.into_owned());
                t.genre = tag.genre().map(|c| c.into_owned());
                t.track = tag.track();
                t.disc = tag.disk();
                t.year = tag.date().map(|d| d.year);
                t.album_artist = tag.get_string(ItemKey::AlbumArtist).map(|s| s.to_string());
            }
            t.cover = find_cover(path, tag, covers);
        }
        Err(_) => t.cover = find_cover(path, None, covers),
    }
    t.codec = Some(codec_name(path, t.bit_depth));
    t
}

fn scan(folders: &[String], previous: Vec<LocalTrack>) -> Vec<LocalTrack> {
    let _ = std::fs::create_dir_all(covers_dir());
    let old: HashMap<String, LocalTrack> = previous.into_iter().map(|t| (t.path.clone(), t)).collect();
    let mut covers = HashMap::new();
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for folder in folders {
        for e in walkdir::WalkDir::new(folder).follow_links(true).into_iter().flatten() {
            let p = e.path();
            if !e.file_type().is_file() {
                continue;
            }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if !EXTS.contains(&ext.as_str()) {
                continue;
            }
            let key = p.to_string_lossy().to_string();
            if !seen.insert(key.clone()) {
                continue;
            }
            let md = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = md.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            let size = md.len();
            // unchanged since the last scan: reuse it
            if let Some(prev) = old.get(&key) {
                if prev.mtime == mtime && prev.size == size && prev.cover.as_ref().map(|c| Path::new(c).exists()).unwrap_or(true) {
                    out.push(prev.clone());
                    continue;
                }
            }
            out.push(read_track(p, mtime, size, &mut covers));
        }
    }
    out
}

#[tauri::command]
pub fn local_get() -> Index {
    load()
}

#[tauri::command]
pub fn local_set_folders(folders: Vec<String>) -> Result<(), String> {
    let mut ix = load();
    ix.folders = folders.into_iter().filter(|f| Path::new(f).is_dir()).collect();
    save(&ix)
}

#[tauri::command]
pub async fn local_scan() -> Result<Index, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let ix = load();
        let tracks = scan(&ix.folders, ix.tracks);
        let ix = Index { folders: ix.folders, tracks };
        save(&ix)?;
        Ok(ix)
    })
    .await
    .map_err(|e| e.to_string())?
}
