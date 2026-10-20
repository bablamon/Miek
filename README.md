<p align="center"><img src="ui/miek-logo.svg" height="160" alt="Miek logo — a hand-drawn music player with earphones"></p>

<h1 align="center">miek</h1>

<p align="center">A lossless music player for Windows. No accounts, no ads, no tracking.</p>

---

Miek plays **your own music files**, **lossless recordings from the Internet Archive** and **FLAC music from Wikimedia Commons** through a native audio engine written in Rust. No accounts and no API keys.

## What it does

- **Your music** — point it at your folders; it reads FLAC, ALAC, WAV, AIFF, MP3, AAC, Ogg and Opus with their tags and cover art (embedded or `cover.jpg`/`folder.jpg`). Rescans only re-read files that changed.
- **Explore** — search and stream nearly a million lossless items from the [Internet Archive](https://archive.org): live concerts (Live Music Archive), netlabels, jazz, classical, 78 rpm transfers. Streamed as FLAC, often 24-bit. No key, no login.
- **Wikimedia Commons** — public-domain and Creative Commons recordings (much of it classical, e.g. Musopen), as FLAC with real bit depth and sample rate (often 24/48). Shown with each recording's licence.
- **Best versions** — a search groups the same song across your files, the Archive and Commons, and plays the best lossless copy: lossless first, then higher bit depth, then higher sample rate, with your own file winning a tie. If that source fails to stream, Miek falls back to the next-best copy.
- **Autoplay** — when the queue runs out, Miek keeps playing songs picked for you, back to back. It learns your taste on your computer (finishing a song counts for it, skipping it in the first 30 s counts against it, likes count strongly, and old signals fade). It looks at your last few songs, gathers candidates from your library, your likes, the same artists on the Archive and Commons, and recordings sharing genre tags, then scores them with a little randomness for discovery and keeps the mix varied (at most 2 per artist or album, never the same artist twice in a row). It tops up the queue before it runs out, so there's no wait between songs. Can be turned off or reset in Settings.
- **Library** — liked songs, playlists, play history; stored locally in `%APPDATA%\Miek`.
- **Quality you can see** — the player shows the real source format and what the device gets, e.g. `FLAC 24/96 → 48`.

## Audio engine

```
file / network stream → symphonia (demux + decode) → 32-bit float
  → channel mapping → rubato sinc resampler (only if source rate ≠ device rate)
  → lock-free ring buffer → cpal / WASAPI
```

- Decoding with [Symphonia](https://github.com/pdeljanov/Symphonia) (FLAC, ALAC, WAV/AIFF, MP3, AAC, Vorbis…), gapless-aware decoders.
- No resampling when the source matches the output device; otherwise a 256-tap Blackman-Harris sinc filter via [rubato](https://github.com/HEnquist/rubato).
- Network streams download over one connection into a local cache while playing: seeks inside the downloaded part are instant, replays start immediately (cache capped at 2 GB in `%LOCALAPPDATA%\Miek\stream-cache`).
- Follows the default output device; reopens it if headphones are unplugged.

## Build

Requirements: Windows 10/11, [Rust](https://rustup.rs) (MSVC toolchain), Visual Studio C++ Build Tools, Node.js.

```
npm install
npm run build        # → src-tauri/target/release/miek.exe
```

`npm run dev` runs it with live reload of the UI.

## Project layout

| Path | What |
|---|---|
| `src-tauri/src/player.rs` | audio engine (decode, resample, output, network stream cache) |
| `src-tauri/src/local.rs` | music folder scanner (tags, format, cover art) |
| `src-tauri/src/archive.rs` | Internet Archive search + item → FLAC tracks |
| `src-tauri/src/commons.rs` | Wikimedia Commons FLAC music search (with format + licence) |
| `src-tauri/src/library.rs` | likes / playlists / history storage |
| `ui/` | interface (plain HTML/CSS/JS, no framework) |
| `ui/recommend.js` | Autoplay: taste profile, candidates, scoring, queue top-up |
| `ui/intro.js` | opening animation: the logo sketch draws itself, then beats to a synthesized drum groove |

## Not yet

- Exclusive-mode (bit-perfect) WASAPI output
- Gapless transitions between tracks (decoders are gapless; track switching isn't yet)
- Media keys / Windows media overlay
- Jamendo (Creative Commons FLAC; needs a free developer key)

## Credits & licenses

Miek is MIT licensed (see `LICENSE`).

- Icons adapted from [Lucide](https://lucide.dev) (ISC)
- [Ubuntu](https://design.ubuntu.com/font) font (Ubuntu Font Licence 1.0, `ui/fonts/UBUNTU-FONT-LICENCE.txt`)
- Audio: Symphonia (MPL-2.0), rubato (MIT), cpal (Apache-2.0), lofty (MIT/Apache-2.0); app shell: Tauri (MIT/Apache-2.0)

Archive recordings are provided by the Internet Archive and their uploaders under each item's own terms; Miek streams them and doesn't redistribute anything.
