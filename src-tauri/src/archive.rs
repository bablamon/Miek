//! Internet Archive source: public, no account, ~1M audio items with FLAC (often 24-bit).
//! Search returns items ("albums"); an item resolves to its lossless tracks.

use serde::Serialize;
use serde_json::Value;

const UA: &str = concat!("Miek/", env!("CARGO_PKG_VERSION"), " (open-source music player)");

#[derive(Serialize)]
pub struct Item {
    id: String,
    title: String,
    creator: Option<String>,
    year: Option<String>,
    image: String,
}

#[derive(Serialize)]
pub struct Track {
    uri: String,
    url: String,
    name: String,
    artist: Option<String>,
    number: u32,
    duration: f64,
    format: String,
}

#[derive(Serialize)]
pub struct ItemDetail {
    #[serde(flatten)]
    item: Item,
    description: Option<String>,
    tracks: Vec<Track>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent(UA).build().unwrap()
}

/// Archive fields can be a string or a list of strings.
fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Array(a) => a.iter().filter_map(text).next(),
        _ => None,
    }
}

fn to_item(d: &Value) -> Option<Item> {
    let id = d["identifier"].as_str()?.to_string();
    Some(Item {
        title: text(&d["title"]).unwrap_or_else(|| id.clone()),
        creator: text(&d["creator"]),
        year: text(&d["date"]).or_else(|| text(&d["year"])).map(|s| s.chars().take(4).collect()),
        image: format!("https://archive.org/services/img/{id}"),
        id,
    })
}

async fn query(q: &str, rows: u32) -> Result<Vec<Item>, String> {
    let resp: Value = client()
        .get("https://archive.org/advancedsearch.php")
        .query(&[
            ("q", q),
            ("fl[]", "identifier"),
            ("fl[]", "title"),
            ("fl[]", "creator"),
            ("fl[]", "date"),
            ("fl[]", "year"),
            ("sort[]", "downloads desc"),
            ("rows", &rows.to_string()),
            ("output", "json"),
        ])
        .send()
        .await
        .map_err(|e| format!("Internet Archive unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp["response"]["docs"].as_array().map(|a| a.iter().filter_map(to_item).collect()).unwrap_or_default())
}

const LOSSLESS: &str = r#"format:(Flac OR "24bit Flac")"#;

/// Free-text search across lossless audio items.
#[tauri::command]
pub async fn ia_search(term: String) -> Result<Vec<Item>, String> {
    let clean: String = term.chars().filter(|c| !"():\"\\[]{}^~*?".contains(*c)).collect();
    if clean.trim().is_empty() {
        return Ok(vec![]);
    }
    query(&format!("({clean}) AND mediatype:(audio OR etree) AND {LOSSLESS}"), 36).await
}

/// Curated shelves for the Explore page.
#[tauri::command]
pub async fn ia_shelf(kind: String) -> Result<Vec<Item>, String> {
    let q = match kind.as_str() {
        "live" => "collection:etree",
        "jazz" => "subject:jazz AND mediatype:(audio OR etree)",
        "classical" => "subject:classical AND mediatype:audio",
        "netlabels" => "collection:netlabels",
        "78rpm" => "collection:georgeblood",
        "electronic" => "subject:electronic AND mediatype:audio",
        _ => return Err("unknown shelf".into()),
    };
    query(&format!("{q} AND {LOSSLESS}"), 24).await
}

/// Archive descriptions are HTML: keep readable plain text (line breaks kept, entities decoded).
fn plain_text(html: &str) -> String {
    let mut out = String::new();
    let mut tag = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let t = tag.trim_start_matches('/').split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                if matches!(t.as_str(), "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3") {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(c),
            _ => out.push(c),
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    let lines: Vec<String> = out
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n").chars().take(900).collect()
}

fn duration(v: &Value) -> f64 {
    let s = text(v).unwrap_or_default();
    if s.contains(':') {
        s.split(':').fold(0.0, |acc, p| acc * 60.0 + p.parse::<f64>().unwrap_or(0.0))
    } else {
        s.parse().unwrap_or(0.0)
    }
}

fn encode_path(name: &str) -> String {
    name.split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// An item's metadata and its FLAC tracks, in album order.
#[tauri::command]
pub async fn ia_item(id: String) -> Result<ItemDetail, String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        return Err("bad item id".into());
    }
    let v: Value = client()
        .get(format!("https://archive.org/metadata/{id}"))
        .send()
        .await
        .map_err(|e| format!("Internet Archive unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let md = &v["metadata"];
    let item = to_item(&serde_json::json!({
        "identifier": id, "title": md["title"], "creator": md["creator"], "date": md["date"], "year": md["year"]
    }))
    .ok_or("item not found")?;
    let files = v["files"].as_array().cloned().unwrap_or_default();
    let has_24 = files.iter().any(|f| f["format"] == "24bit Flac");
    let mut tracks: Vec<Track> = files
        .iter()
        .filter(|f| {
            let fmt = f["format"].as_str().unwrap_or("");
            // when an item has both, keep the 24-bit masters
            fmt == "24bit Flac" || (fmt == "Flac" && !has_24)
        })
        .filter_map(|f| {
            let name = f["name"].as_str()?.to_string();
            let stem = name.rsplit('/').next().unwrap_or(&name).trim_end_matches(".flac").to_string();
            let number = text(&f["track"]).and_then(|t| t.split('/').next().and_then(|n| n.trim().parse().ok())).unwrap_or(0);
            Some(Track {
                uri: format!("ia:{id}/{name}"),
                url: format!("https://archive.org/download/{id}/{}", encode_path(&name)),
                name: text(&f["title"]).unwrap_or(stem),
                artist: text(&f["creator"]).or_else(|| text(&f["artist"])).or_else(|| item.creator.clone()),
                number,
                duration: duration(&f["length"]),
                format: if f["format"] == "24bit Flac" { "FLAC 24-bit".into() } else { "FLAC".into() },
            })
        })
        .collect();
    tracks.sort_by(|a, b| (a.number == 0, a.number, &a.url).cmp(&(b.number == 0, b.number, &b.url)));
    let description = text(&md["description"]).map(|d| plain_text(&d));
    Ok(ItemDetail { item, description, tracks })
}
