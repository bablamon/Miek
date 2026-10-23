// Miek YouTube UI: search results through yt-dlp, and playing a video's audio (src-tauri/src/ytdlp.rs).
// A video's audio link expires after some hours, so only the video id is kept (likes, history,
// playlists); the link is resolved when it plays. Loaded after app.js; uses its globals.

const YT = { first: true };
// "Artist - Topic" channels are YouTube's auto-made music channels; "VEVO" ones belong to an artist
const ytArtist = (channel) => (channel || 'YouTube').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '').trim() || channel;
// The song and artist from a video title:
// "Arijit Singh - Tum Hi Ho (Official Video)" → "Tum Hi Ho" by Arijit Singh;
// "Tum Hi Ho | Aashiqui 2 | Aditya Roy Kapur, Shraddha Kapoor" (film-song style) → "Tum Hi Ho", by the
// channel; the part that is a list of names ("A, B") isn't the song.
function ytNames(v) {
  const clean = v.title
    .replace(/\s*[([](official|lyrics?|lyrical|audio|video|full song|hd|4k|music video)[^)\]]*[)\]]/gi, '')
    .replace(/\s*@\S+/g, '')
    .trim();
  const parts = clean.split(/\s*\|\s*/).filter(Boolean);
  const dash = parts[0] && parts[0].match(/^(.+?)\s+[-–]\s+(.+)$/);
  // usually "Artist - Song"; "Song - Artist" when the second half is an artist you listen to and the first isn't
  const known = (s) => typeof LIB !== 'undefined' && [...LIB.data.recent, ...LIB.data.liked].some((t) => (t.artists || []).some((a) => norm(a.name) === norm(s)));
  if (dash) return known(dash[2]) && !known(dash[1]) ? { name: dash[1], artist: dash[2] } : { name: dash[2], artist: dash[1] };
  const name = parts.find((p) => !p.includes(',')) || parts[0] || v.title;
  return { name, artist: ytArtist(v.channel) };
}
function ytTrack(v) {
  const n = ytNames(v);
  return {
    uri: 'yt:' + v.id,
    source: 'yt',
    src: { kind: 'yt', value: v.id }, // resolved to a stream link at play time
    yt: { id: v.id },
    name: n.name,
    artists: splitArtists(n.artist),
    album: null,
    image: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    duration: (v.duration || 0) * 1000,
    quality: 'YouTube · AAC',
    tags: [],
    lossless: false,
    bits: null,
    rate: null,
  };
}

// the search page's YouTube section
function youtubeResults(term) {
  const box = h('div', {}, h('p', { class: 'fine', text: 'Searching YouTube…' }));
  (async () => {
    const st = await invoke('yt_status');
    if (!st.installed) box.replaceChildren(h('p', { class: 'fine', text: 'Getting yt-dlp (one time, about 18 MB)…' }));
    const list = (await invoke('yt_search', { query: term })).map(ytTrack);
    box.replaceChildren(list.length ? trackList(list, (i) => playOne(list[i])) : h('p', { class: 'fine', text: 'Nothing found on YouTube.' }));
    markPlaying();
  })().catch((e) => box.replaceChildren(h('p', { class: 'fine', text: `YouTube: ${String(e).replace(/^Error:\s*/, '')}` })));
  return box;
}

// a YouTube track's stream link (resolved when it plays; cached for a few hours by the backend)
async function ytStream(t) {
  const s = await invoke('yt_resolve', { id: t.yt.id });
  if (s.duration && !t.duration) t.duration = s.duration * 1000;
  return { kind: 'url', value: s.url };
}

function youtubeSettings() {
  const status = h('div', { class: 'fine', text: 'Checking…' });
  const btn = h('button', { class: 'btn', text: 'Update yt-dlp' });
  const show = (st) => {
    status.textContent = st.installed ? `yt-dlp ${st.version || ''} · updated automatically once a day` : 'yt-dlp is downloaded the first time you search (about 18 MB).';
    btn.textContent = st.installed ? 'Update yt-dlp' : 'Get yt-dlp now';
  };
  invoke('yt_status').then(show).catch(() => (status.textContent = 'yt-dlp unavailable'));
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Updating…';
    try { toast(`yt-dlp ${await invoke('yt_update')}`); } catch (e) { fail(e); }
    btn.disabled = false;
    invoke('yt_status').then(show).catch(() => {});
  };
  return h('div', { class: 'panel' },
    h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'YouTube search and playback (yt-dlp)' }), status), btn),
    h('div', { class: 'setting' }, h('div', { class: 'fine', style: 'max-width:640px', text: 'Plays the AAC audio of the video you pick, streamed while it plays. YouTube’s terms of service don’t allow everything yt-dlp can do; only play what you have the right to.' })));
}
