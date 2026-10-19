//! Miek's own library (liked songs, saved albums, playlists, recently played).
//! Stored locally in %APPDATA%\Miek\library.json.

use serde_json::{json, Value};
use std::path::PathBuf;

fn path() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = base.join("Miek");
    dir.join("library.json")
}

fn empty() -> Value {
    json!({ "version": 1, "liked": [], "albums": [], "playlists": [], "recent": [] })
}

#[tauri::command]
pub fn library_load() -> Value {
    let Ok(txt) = std::fs::read_to_string(path()) else { return empty() };
    match serde_json::from_str::<Value>(&txt) {
        Ok(v) if v.is_object() => {
            let mut v = v;
            for k in ["liked", "albums", "playlists", "recent"] {
                if !v[k].is_array() {
                    v[k] = json!([]);
                }
            }
            v
        }
        _ => {
            // keep a copy of an unreadable file instead of silently overwriting it later
            let _ = std::fs::copy(path(), path().with_extension("json.bad"));
            empty()
        }
    }
}

#[tauri::command]
pub fn library_save(data: Value) -> Result<(), String> {
    let p = path();
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
