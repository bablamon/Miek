//! Wikimedia Commons source: public, no account or key. Mostly public-domain and Creative Commons
//! recordings (classical, historic, Musopen), as FLAC with real bit depth / sample rate metadata.

use serde::Serialize;
use serde_json::Value;

const UA: &str = concat!("Miek/", env!("CARGO_PKG_VERSION"), " (open-source music player; https://github.com/bablamon/Miek)");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    uri: String,
    url: String,
    name: String,
    artist: Option<String>,
    duration: f64,
    sample_rate: Option<u32>,
    bit_depth: Option<u32>,
    format: String,
    license: Option<String>,
    tags: Vec<String>,
}

/// getID3 metadata is a tree of {name, value}; find a numeric value by name anywhere in it.
fn find_num(md: &Value, key: &str) -> Option<u64> {
    for m in md.as_array()? {
        if m["name"] == key {
            if let Some(n) = m["value"].as_u64() {
                return Some(n);
            }
        }
        if m["value"].is_array() {
            if let Some(n) = find_num(&m["value"], key) {
                return Some(n);
            }
        }
    }
    None
}

fn ext(vi: &Value, key: &str) -> Option<String> {
    vi["extmetadata"][key]["value"].as_str().map(crate::archive::plain_text).map(|s| s.lines().next().unwrap_or("").to_string()).filter(|s| !s.is_empty())
}

/// Commons categories as music tags: genre/form categories and the composer, not licences or file housekeeping.
fn tags(categories: &str) -> Vec<String> {
    let mut out = vec![];
    for c in categories.split('|') {
        let c = c.trim().replace('_', " ");
        let lc = c.to_lowercase();
        let tag = if let Some(who) = lc.strip_prefix("audio files of music by ") {
            who.to_string()
        } else if lc.starts_with("pd") || lc.starts_with("cc-") || lc.contains("license") || lc.contains("files") || lc.contains("upload") || lc.contains("musopen") || lc.contains("self-published") {
            continue;
        } else {
            lc
        };
        if tag.len() >= 3 && !out.contains(&tag) {
            out.push(tag);
        }
    }
    out.truncate(10);
    out
}

fn to_track(page: &Value) -> Option<Track> {
    let vi = &page["videoinfo"][0];
    if vi["mime"] != "audio/flac" {
        return None;
    }
    // music only: skip sound effects, speech and short samples
    let duration = vi["duration"].as_f64().unwrap_or(0.0);
    let categories = vi["extmetadata"]["Categories"]["value"].as_str().unwrap_or("").to_ascii_lowercase();
    if duration < 30.0 || !categories.contains("music") {
        return None;
    }
    let title = page["title"].as_str()?;
    let url = vi["url"].as_str()?.split('?').next()?.to_string();
    let sample_rate = find_num(&vi["metadata"], "sample_rate").map(|n| n as u32);
    let bit_depth = find_num(&vi["metadata"], "bits_per_sample").map(|n| n as u32);
    let format = match (bit_depth, sample_rate) {
        (Some(b), Some(r)) => format!("FLAC {b}/{}", (r as f64 / 1000.0).to_string().trim_end_matches(".0")),
        _ => "FLAC".into(),
    };
    let fallback = title.trim_start_matches("File:").trim_end_matches(".flac").replace('_', " ");
    Some(Track {
        uri: format!("wc:{title}"),
        url,
        name: ext(vi, "ObjectName").unwrap_or(fallback),
        artist: ext(vi, "Artist"),
        duration,
        sample_rate,
        bit_depth,
        format,
        license: ext(vi, "LicenseShortName"),
        tags: tags(vi["extmetadata"]["Categories"]["value"].as_str().unwrap_or("")),
    })
}

/// Free-text search across FLAC music files on Wikimedia Commons.
#[tauri::command]
pub async fn commons_search(term: String) -> Result<Vec<Track>, String> {
    let clean: String = term.chars().filter(|c| !"\":\\[]{}|<>".contains(*c)).collect();
    if clean.trim().is_empty() {
        return Ok(vec![]);
    }
    let resp: Value = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .unwrap()
        .get("https://commons.wikimedia.org/w/api.php")
        .query(&[
            ("action", "query"),
            ("format", "json"),
            ("formatversion", "2"),
            ("generator", "search"),
            ("gsrnamespace", "6"),
            ("gsrlimit", "30"),
            ("gsrsearch", &format!("{} filemime:audio/flac", clean.trim())),
            ("prop", "videoinfo"),
            ("viprop", "url|size|mime|metadata|extmetadata"), // "size" is what makes the API include duration
            ("viextmetadatafilter", "ObjectName|Artist|LicenseShortName|Categories"),
        ])
        .send()
        .await
        .map_err(|e| format!("Wikimedia Commons unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut pages = resp["query"]["pages"].as_array().cloned().unwrap_or_default();
    // the generator returns pages unordered; "index" is the search rank
    pages.sort_by_key(|p| p["index"].as_u64().unwrap_or(u64::MAX));
    Ok(pages.iter().filter_map(to_track).collect())
}
