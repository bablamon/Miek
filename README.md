<p align="center"><img src="ui/miek-logo.svg" height="160" alt="Miek logo — a hand-drawn music player with earphones"></p>

<h1 align="center">miek</h1>

<p align="center">A lossless music player for Windows. No accounts, no ads, no tracking.</p>

---

Miek plays **files shared on Soulseek**, **your own music files**, **lossless recordings from the Internet Archive** and **FLAC music from Wikimedia Commons** through a native audio engine written in Rust. Nothing to install besides Miek; no API keys.

## What it does

- **Your music** — point it at your folders; it reads FLAC, ALAC, WAV, AIFF, MP3, AAC, Ogg and Opus with their tags and cover art (embedded or `cover.jpg`/`folder.jpg`). Rescans only re-read files that changed.
- **Explore** — search and stream nearly a million lossless items from the [Internet Archive](https://archive.org): live concerts (Live Music Archive), netlabels, jazz, classical, 78 rpm transfers. Streamed as FLAC, often 24-bit. No key, no login.
- **Wikimedia Commons** — public-domain and Creative Commons recordings (much of it classical, e.g. Musopen), as FLAC with real bit depth and sample rate (often 24/48). Shown with each recording's licence.
- **Soulseek** (on from the first start: Miek fills in a generated name and password, which Soulseek registers on first login; change or turn it off in Settings) — a search asks the Soulseek network and lists what people actually answer: filename and folder, who shares it, size, length, format, bitrate or bit depth / sample rate, free slot or queue. FLAC comes first, then MP3, each in the order people answered; you can sort by any column and filter to lossless or free slots, and rows don't move while the pointer is over them. Miek doesn't pick one; you choose the file. Playing it streams that exact file from that person: Miek asks for it, shows where you are in their queue, and starts playing once the first part has arrived (the rest keeps arriving while it plays). Seeks inside what has arrived are instant; a seek further ahead waits for the transfer to get there, because Soulseek peers send a file front to back. A broken transfer resumes where it stopped. If a file is refused or the person is offline, Miek says so and stays on it; it never swaps in a different copy. "Download to your music" (right-click) is optional: it keeps the file in `Music\Miek Soulseek` and adds that folder to your music. Liking a Soulseek song does this quietly, so liked songs keep playing when the person sharing them is offline. The next Soulseek song in the queue starts arriving once the current one has. The client is built in (no slskd or other daemon). Miek shares nothing back, and some people only upload to users who share. If both you and the other person are behind firewalls that block incoming connections, the transfer can't be made; forwarding the port shown in Settings fixes that. Only play and download music you have the right to.
- **Each source on its own** — search results from Soulseek, your files, the Archive and Commons are shown in separate sections. If a source fails to stream, Miek tells you instead of switching to another version.
- **Autoplay** — when the queue runs out, Miek keeps playing songs picked for you, back to back. It keeps to the language you're listening in: a Hindi song is followed by Hindi songs (told by the title's script or words, marker words like "Bollywood", or the artist's other songs), an English one by songs not known to be in another language. It learns your taste on your computer (finishing a song counts for it, skipping it in the first 30 s counts against it, likes count strongly, and old signals fade). It looks at your last few songs, gathers candidates from your library, your likes, the same artists on the Archive and Commons, and recordings sharing genre tags, then scores them with a little randomness for discovery and keeps the mix varied (at most 2 per artist or album, never the same artist twice in a row). It tops up the queue before it runs out, so there's no wait between songs. Can be turned off or reset in Settings.
- **Explore, picked for you** — once you've played some music, Explore and Home follow what you listen to: more by your artists on Soulseek (not what you just heard), similar artists (the ones credited on the same songs as yours, counted once per folder so one compilation doesn't decide it), more in the language you listen in, and your genres on the Internet Archive. A new listener gets the Archive's shelves.
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
- Network streams (and Soulseek transfers) download into a local cache while playing: seeks inside the downloaded part are instant, replays start immediately (cache capped at 2 GB in `%LOCALAPPDATA%\Miek\stream-cache`).
- Internet Archive files are fetched as chunks over 4 connections at once, nearest the playhead first (its servers are slow per connection), and playback reads a chunk while it is still arriving. Other servers get one connection (Wikimedia rate-limits parallel requests).
- Connections are kept alive between songs, the Archive's redirect to its storage server is remembered per album, and the start of the next song in the queue is preloaded, so pressing Next or autoplay starts it in a fraction of a second.
- Streams skip the decoder's end-of-file tag scan while opening (it forced an extra download before the first note); metadata comes from the source instead.
- Follows the default output device; reopens it if headphones are unplugged.

## Build

Requirements: Windows 10/11, [Rust](https://rustup.rs) (MSVC toolchain), Visual Studio C++ Build Tools, Node.js.

```
npm install
npm run build        # → installer: src-tauri/target/release/bundle/nsis/Miek_<version>_x64-setup.exe
npm run build:exe    # → just the app: src-tauri/target/release/miek.exe
```

The installer installs for the current user (no admin prompt) and fetches Microsoft's WebView2 runtime if Windows doesn't have it.
GitHub Actions (`.github/workflows/ci.yml`) builds the app and runs the tests on every push.

`npm run dev` runs it with live reload of the UI.

## Releasing an update

Installed copies of Miek check `https://github.com/bablamon/Miek/releases/latest/download/latest.json` a few seconds after they start, and offer a newer version in a pop-up (Settings → Updates checks by hand). Installing downloads the new installer, checks its signature against the public key built into Miek (anything not signed with the release key is refused), installs it and restarts Miek. Likes, playlists and settings live in `%APPDATA%\Miek` and stay.

One-time setup: a signing key pair. The public key goes in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`; the private key and its password go in the repository's Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Without the public key, a build has no updater ("Updates aren't set up in this build").

Each release:

```
node scripts/bump-version.mjs 0.4.0
git commit -am "Miek 0.4.0"
git tag -a v0.4.0 -m "What's new: ..."
git push origin main v0.4.0
```

The tag starts `.github/workflows/release.yml`: it builds, signs, and publishes the GitHub release with `latest.json` and three downloads:

- `Miek_<version>_x64-setup.exe`: installer (current user, no admin prompt); in-app updates use this one
- `Miek_<version>_x64_en-US.msi`: MSI installer (all users, needs admin)
- `Miek_<version>_x64_portable.exe`: the app on its own, no install (needs WebView2, which Windows 10/11 have)

The tag message becomes the release notes in the pop-up.

## Project layout

| Path | What |
|---|---|
| `src-tauri/src/player.rs` | audio engine (decode, resample, output, network stream cache) |
| `src-tauri/src/slsk.rs` | Soulseek client: login, search, peer connections, transfers streamed into the cache |
| `src-tauri/tests/mock_slsk.py` | mock Soulseek server and peer for the end-to-end test (`cargo test -- --ignored`, see the test in `slsk.rs`) |
| `tests/foryou.mjs` | Explore "for you" test against a fake backend (`node tests/foryou.mjs ui`) |
| `tests/autoplay_lang.mjs` | Autoplay language test against a fake backend (`node tests/autoplay_lang.mjs ui`) |
| `src-tauri/src/local.rs` | music folder scanner (tags, format, cover art) |
| `src-tauri/src/archive.rs` | Internet Archive search + item → FLAC tracks |
| `src-tauri/src/commons.rs` | Wikimedia Commons FLAC music search (with format + licence) |
| `src-tauri/src/library.rs` | likes / playlists / history storage |
| `ui/` | interface (plain HTML/CSS/JS, no framework) |
| `ui/tap.js` | tap sounds on button presses (made with Web Audio, no sound file) |
| `ui/soulseek.js` | Soulseek UI: results (filters, sorting), playing a chosen file, downloads, settings |
| `ui/foryou.js` | Explore and Home picked from what you listen to; similar artists |
| `ui/recommend.js` | Autoplay: taste profile, candidates, scoring, language, queue top-up |
| `ui/intro.js` | opening animation: the logo sketch draws itself, then beats to a synthesized drum groove |

## Not yet

- Exclusive-mode (bit-perfect) WASAPI output
- Gapless transitions between tracks (decoders are gapless; track switching isn't yet)
- Media keys / Windows media overlay
- Jamendo (Creative Commons FLAC; needs a free developer key)

## Credits & licenses

Miek is MIT licensed (see `LICENSE`).

- Icons: Google's [Material Symbols](https://fonts.google.com/icons) (Rounded), as on Pixel phones (Apache 2.0, `ui/icons-LICENSE.txt`)
- [Ubuntu](https://design.ubuntu.com/font) font (Ubuntu Font Licence 1.0, `ui/fonts/UBUNTU-FONT-LICENCE.txt`)
- Audio: Symphonia (MPL-2.0), rubato (MIT), cpal (Apache-2.0), lofty (MIT/Apache-2.0); app shell: Tauri (MIT/Apache-2.0)

Archive recordings are provided by the Internet Archive and their uploaders under each item's own terms; Miek streams them and doesn't redistribute anything.
