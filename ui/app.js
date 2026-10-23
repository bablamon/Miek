// Miek UI. Sources: Soulseek (results the user picks from), your own music files, the Internet Archive
// and Wikimedia Commons. Each source is shown on its own; Miek never picks or swaps a version for you.
// Audio is decoded and played by Miek's native engine (Rust); this file drives it.
const { invoke, convertFileSrc } = window.__TAURI__.core;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const $ = (id) => document.getElementById(id);

// tiny DOM builder — text always goes through text nodes, never innerHTML
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const fmt = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtLong = (ms) => {
  const m = Math.round((ms || 0) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const names = (artists) => (artists || []).map((a) => a.name).join(', ');
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const shuffleArr = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
// errors stay up long enough to read
const fail = (e) => toast(String(e).replace(/^Error:\s*/, '').slice(0, 200), 6000);

function img(src) {
  const i = h('img', { alt: '', loading: 'lazy' });
  if (src) i.src = src;
  return i;
}
function cover(src, fallbackIcon = 'music', cls = 'thumb') {
  return h('div', { class: cls }, src ? img(src) : icon(fallbackIcon, 18));
}
function mosaic(images, cls = 'thumb') {
  const imgs = [...new Set(images.filter(Boolean))].slice(0, 4);
  if (imgs.length < 4) return cover(imgs[0], 'music', cls);
  return h('div', { class: cls + ' mosaic' }, imgs.map((s) => img(s)));
}
function artistLinks(t) {
  if (t.slsk) {
    const by = names(t.artists) || t.folder;
    return h('span', { text: `${by ? by + ' · ' : ''}from ${t.slsk.user}` });
  }
  const span = h('span', {});
  (t.artists || []).forEach((a, i) => {
    if (i) span.append(', ');
    span.append(h('a', { class: 'lnk', onclick: (e) => { e.stopPropagation(); openArtist(t, a.name); }, text: a.name }));
  });
  return span;
}
// local artists have a page; archive creators open a search
function openArtist(t, name) {
  if (t && t.source === 'local' && LOCAL.byArtist.has(norm(name))) go('artist', name);
  else searchFor(name);
}

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff']);

// ===================================================================== local music (indexed by the Rust side)
const LOCAL = { folders: [], tracks: [], albums: [], byAlbum: new Map(), byArtist: new Map(), scanning: false };

function localTrack(x) {
  const q = [x.codec ? x.codec.toUpperCase() : null, x.bitDepth && x.sampleRate ? `${x.bitDepth}/${+(x.sampleRate / 1000).toFixed(1)}` : null].filter(Boolean).join(' ');
  const albumArtist = x.albumArtist || x.artist || 'Unknown artist';
  return {
    uri: 'local:' + x.path,
    source: 'local',
    src: { kind: 'file', value: x.path },
    name: x.title || x.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''),
    artists: (x.artist || 'Unknown artist').split(/\s*;\s*|\s+\/\s+/).filter(Boolean).map((name) => ({ name })),
    album: { key: 'local:' + norm(albumArtist) + '|' + norm(x.album || ''), name: x.album || 'Unknown album' },
    albumArtist,
    image: x.cover ? convertFileSrc(x.cover) : null,
    duration: Math.round((x.duration || 0) * 1000),
    number: x.track || 0,
    disc: x.disc || 1,
    year: x.year || null,
    genre: x.genre || null,
    tags: x.genre ? x.genre.split(/\s*[;,/]\s*/).map(norm).filter(Boolean) : [],
    quality: q,
    lossless: LOSSLESS.has(x.codec),
    bits: x.bitDepth || null,
    rate: x.sampleRate || null,
  };
}
function indexLocal(data) {
  LOCAL.folders = data.folders || [];
  LOCAL.tracks = (data.tracks || []).map(localTrack);
  LOCAL.byAlbum = new Map();
  LOCAL.byArtist = new Map();
  for (const t of LOCAL.tracks) {
    if (!LOCAL.byAlbum.has(t.album.key)) LOCAL.byAlbum.set(t.album.key, { key: t.album.key, name: t.album.name, artist: t.albumArtist, year: t.year, image: t.image, tracks: [] });
    const a = LOCAL.byAlbum.get(t.album.key);
    a.tracks.push(t);
    if (!a.image && t.image) a.image = t.image;
    for (const ar of new Set([t.albumArtist, ...t.artists.map((x) => x.name)])) {
      const k = norm(ar);
      if (!LOCAL.byArtist.has(k)) LOCAL.byArtist.set(k, { name: ar, tracks: new Set(), albums: new Set() });
      LOCAL.byArtist.get(k).tracks.add(t);
      if (ar === t.albumArtist) LOCAL.byArtist.get(k).albums.add(t.album.key);
    }
  }
  for (const a of LOCAL.byAlbum.values()) a.tracks.sort((x, y) => x.disc - y.disc || x.number - y.number || x.name.localeCompare(y.name));
  LOCAL.albums = [...LOCAL.byAlbum.values()].sort((a, b) => a.artist.localeCompare(b.artist) || (a.year || 0) - (b.year || 0));
}
async function loadLocal() {
  try { indexLocal(await invoke('local_get')); } catch (e) { fail(e); }
}
async function rescan() {
  if (LOCAL.scanning) return;
  LOCAL.scanning = true;
  toast('Scanning your music…');
  refresh();
  try {
    indexLocal(await invoke('local_scan'));
    toast(`Found ${plural(LOCAL.tracks.length, 'song')}`);
  } catch (e) { fail(e); }
  LOCAL.scanning = false;
  refresh();
}
async function addFolder() {
  const dir = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title: 'Choose a music folder' });
  if (!dir) return;
  if (LOCAL.folders.includes(dir)) return toast('That folder is already in your library');
  LOCAL.folders = [...LOCAL.folders, dir];
  await invoke('local_set_folders', { folders: LOCAL.folders });
  rescan();
}
const localAlbumCard = (a) => ({ key: a.key, name: a.name, image: a.image, sub: [a.year, a.artist].filter(Boolean).join(' · ') });

// ===================================================================== archive
const iaAlbumCard = (it) => ({ key: 'ia:' + it.id, name: it.title, image: it.image, sub: [it.year, it.creator].filter(Boolean).join(' · ') });
function iaTrack(item, t) {
  return {
    uri: t.uri,
    source: 'ia',
    src: { kind: 'url', value: t.url },
    name: t.name.replace(/\s*-?>\s*$/, ''), // live recordings mark segues with ">" / "->"
    artists: [{ name: t.artist || item.creator || 'Unknown artist' }],
    album: { key: 'ia:' + item.id, name: item.title },
    image: item.image,
    duration: Math.round((t.duration || 0) * 1000),
    number: t.number,
    quality: t.format,
    tags: item.subjects || [],
    lossless: true,
    // the Archive labels 24-bit masters separately; its plain "Flac" files are 16-bit
    bits: /24/.test(t.format) ? 24 : 16,
    rate: null,
  };
}
// ===================================================================== Wikimedia Commons (single FLAC files, no account)
function wcTrack(t) {
  return {
    uri: t.uri,
    source: 'commons',
    src: { kind: 'url', value: t.url },
    name: t.name,
    artists: [{ name: t.artist || 'Unknown artist' }],
    album: null,
    image: null,
    duration: Math.round((t.duration || 0) * 1000),
    quality: [t.format, t.license].filter(Boolean).join(' · '),
    tags: t.tags || [],
    lossless: true,
    bits: t.bitDepth || null,
    rate: t.sampleRate || null,
  };
}

const IA_CACHE = new Map();
function iaItem(id) {
  if (!IA_CACHE.has(id)) IA_CACHE.set(id, invoke('ia_item', { id }).catch((e) => { IA_CACHE.delete(id); throw e; }));
  return IA_CACHE.get(id);
}

// ===================================================================== song words (used by Autoplay to spot the same song twice)
const words = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 1);
// a song's identifying words: no "Composer - " prefix, bracketed notes, leading track number,
// artist names or filler words. Opus/movement numbers stay, so different works stay apart.
const FILLER = new Set(['op', 'no', 'nr', 'in', 'the', 'of', 'and', 'live']);
function songWords(t) {
  const artist = new Set(t.artists.flatMap((a) => words(a.name)));
  const title = t.name.replace(/^[^-–]{1,40}\s[-–]\s(?=\S)/, '').replace(/[([{].*?[)\]}]/g, ' ').replace(/^\s*\d+[\s.)_-]+/, '');
  const w = words(title).filter((x) => !artist.has(x) && !FILLER.has(x));
  return w.length ? w : words(t.name);
}

// ===================================================================== library (likes, playlists, history) — local JSON
const LIB = { data: { liked: [], albums: [], playlists: [], recent: [] }, liked: new Set(), timer: null };
const slimTrack = (t) => ({ uri: t.uri, source: t.source, src: t.src, slsk: t.slsk || null, folder: t.folder || null, name: t.name, artists: t.artists, album: t.album, image: t.image, duration: t.duration, quality: t.quality || '', genre: t.genre || null, tags: t.tags || [], lossless: !!t.lossless, bits: t.bits || null, rate: t.rate || null });

function reindex() { LIB.liked = new Set(LIB.data.liked.map((t) => t.uri)); }
async function libLoad() {
  try { LIB.data = await invoke('library_load'); } catch (e) { fail(e); }
  // drop entries that have no playable source
  const playable = (t) => t && t.src && t.src.value;
  LIB.data.liked = LIB.data.liked.filter(playable);
  LIB.data.recent = LIB.data.recent.filter(playable);
  dedupeRecent();
  LIB.data.playlists.forEach((p) => (p.tracks = p.tracks.filter(playable)));
  reindex();
}
function libSave() {
  reindex();
  renderSidebar();
  clearTimeout(LIB.timer);
  LIB.timer = setTimeout(() => invoke('library_save', { data: LIB.data }).catch(fail), 300);
}
const isLiked = (uri) => LIB.liked.has(uri);
function toggleLike(t) {
  if (!t || !t.uri) return;
  if (isLiked(t.uri)) { LIB.data.liked = LIB.data.liked.filter((x) => x.uri !== t.uri); toast('Removed from Liked songs'); recordLike(t, false); }
  else {
    LIB.data.liked.unshift(slimTrack(t));
    toast('Added to Liked songs');
    recordLike(t, true);
    if (t.slsk) slskDownload(t, { quiet: true }); // so it keeps playing when its sharer is offline
  }
  libSave();
  syncLikeButtons();
}
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const findPlaylist = (id) => LIB.data.playlists.find((p) => p.id === id);
function createPlaylist(name, tracks = []) {
  const p = { id: newId(), name, created: new Date().toISOString(), tracks: tracks.map(slimTrack) };
  LIB.data.playlists.unshift(p);
  libSave();
  return p;
}
function addToPlaylist(id, tracks) {
  const p = findPlaylist(id);
  if (!p) return 0;
  const have = new Set(p.tracks.map((t) => t.uri));
  const fresh = tracks.filter((t) => t.uri && !have.has(t.uri)).map(slimTrack);
  p.tracks.push(...fresh);
  libSave();
  return fresh.length;
}
// one entry per song: another copy of the same song (another Soulseek user's, another source's)
// replaces the older one. Only when the artist is known, so two different "Intro"s stay apart.
const sameSong = (a, b) => a.uri === b.uri || (!!artistKeys(a).length && songSet([a]).has(b));
function pushRecent(t) {
  LIB.data.recent = [slimTrack(t), ...LIB.data.recent.filter((x) => !sameSong(x, t))].slice(0, 40);
  libSave();
}
function dedupeRecent() {
  const out = [];
  for (const t of LIB.data.recent) if (!out.some((x) => sameSong(x, t))) out.push(t);
  LIB.data.recent = out;
}

// ===================================================================== queue + playback
const Q = { list: [], i: -1, shuffle: false, repeat: 0, seq: -1, radioSeen: new Set() };
const current = () => Q.list[Q.i] || null;

async function loadIndex(i, autoplay = true) {
  const t = Q.list[i];
  if (!t) return;
  Q.i = i;
  onTrackChange(t);
  try {
    if (t.slsk) {
      Q.seq = -1; // the previous track's end/error must not move the queue while we wait
      if (S.player && S.player.status === 'playing') invoke('player_toggle').catch(() => {});
      const id = await slskPrepare(t);
      if (id == null) return;
      Q.seq = await invoke('player_load', { src: { kind: 'slsk', value: id }, autoplay });
    } else {
      SL.wait++;
      invoke('slsk_stop_streams').catch(() => {});
      Q.seq = await invoke('player_load', { src: t.src, autoplay });
    }
  } catch (e) {
    fail(e);
    if (t.slsk && current() === t) SL.failed = String(e).replace(/^Error:\s*/, '');
    // a Soulseek file you picked stays put; an Autoplay pick that can't be had is skipped
    if (t.slsk && t.radio) setTimeout(() => current() === t && next(true), 1500);
  }
  prefetchNext();
  topUpAutoplay();
}
// start downloading the beginning of the next track now, so it starts without waiting
function prefetchNext() {
  const t = Q.list[Q.i + 1];
  if (t && t.src && t.src.kind === 'url') invoke('player_prefetch', { src: t.src }).catch(() => {});
  // a Soulseek file: once the one playing has fully arrived, so the two don't share the bandwidth
  const cur = current();
  if (t && t.slsk && !(cur && cur.slsk && (!SL.info || SL.info.state !== 'done'))) {
    const { user, file, latin1, size } = t.slsk;
    invoke('slsk_stream', { user, file, latin1, size, keep: false, prefetch: true }).catch(() => {});
  }
}
function playList(tracks, i = 0) {
  if (!tracks.length) return;
  Q.list = tracks.map((t) => ({ ...t }));
  Q.radioSeen = new Set(Q.list.map((t) => t.uri));
  if (Q.shuffle) {
    const first = Q.list[i];
    Q.list = [first, ...shuffleArr(Q.list.filter((_, k) => k !== i))];
    i = 0;
  }
  loadIndex(i);
}
function playOne(t) { playList([t], 0); }
function queueAdd(tracks, next = false) {
  const items = tracks.map((t) => ({ ...t, queued: true }));
  if (!Q.list.length) return playList(items);
  if (next) Q.list.splice(Q.i + 1, 0, ...items);
  else {
    // after other queued items, before "keep playing" picks
    let at = Q.i + 1;
    while (at < Q.list.length && !Q.list[at].radio) at++;
    Q.list.splice(at, 0, ...items);
  }
  items.forEach((t) => Q.radioSeen.add(t.uri));
  refreshQueue();
  prefetchNext();
}

async function next(auto = false) {
  if (!current()) return;
  // teach autoplay: finished (good), skipped early (bad), or listened a while
  const st = S.player;
  if (st && st.seq === Q.seq && st.status !== 'error') recordListen(current(), { ended: auto && st.status === 'ended', position: st.position || 0 });
  if (auto && Q.repeat === 2) return loadIndex(Q.i);
  if (Q.i + 1 < Q.list.length) return loadIndex(Q.i + 1);
  if (Q.repeat === 1) return loadIndex(0);
  // end of the queue: autoplay keeps the music going
  if (autoplayOn()) {
    const at = Q.i;
    await (REC.busy || topUpAutoplay());
    if (Q.i === at && Q.i + 1 < Q.list.length) return loadIndex(Q.i + 1);
  }
  if (!auto) toast(autoplayOn() ? 'Nothing more to play' : 'End of the queue · Autoplay is off');
}
function prev() {
  const s = S.player;
  if ((s && s.position > 3) || Q.i <= 0) return invoke('player_seek', { secs: 0 }).catch(fail);
  loadIndex(Q.i - 1);
}

// ===================================================================== router
const R = { stack: [], i: -1 };
function go(route, arg, push = true) {
  if (push) {
    R.stack = R.stack.slice(0, R.i + 1);
    R.stack.push({ route, arg });
    R.i = R.stack.length - 1;
  }
  $('back').disabled = R.i <= 0;
  $('fwd').disabled = R.i >= R.stack.length - 1;
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
  document.querySelectorAll('.pl-item').forEach((b) => b.classList.toggle('active', route === 'playlist' && b.dataset.id === arg));
  const view = $('view');
  const token = (go.token = (go.token || 0) + 1);
  view.replaceChildren(h('div', { class: 'blank' }, h('div', { class: 'spinner' })));
  Promise.resolve()
    .then(() => VIEWS[route](arg))
    .then((node) => {
      if (token !== go.token) return;
      view.replaceChildren(node);
      view.scrollTop = 0;
      markPlaying();
    })
    .catch((e) => {
      if (token !== go.token) return;
      view.replaceChildren(h('div', { class: 'blank' }, h('div', {}, h('div', { class: 'page-title', text: 'Hmm.' }), h('p', { text: String(e).replace(/^Error:\s*/, '') }), h('button', { class: 'btn', text: 'Try again', onclick: () => go(route, arg, false) }))));
    });
}
const refresh = () => { const r = R.stack[R.i]; if (r) go(r.route, r.arg, false); };
$('back').onclick = () => { if (R.i > 0) { R.i--; go(R.stack[R.i].route, R.stack[R.i].arg, false); } };
$('fwd').onclick = () => { if (R.i < R.stack.length - 1) { R.i++; go(R.stack[R.i].route, R.stack[R.i].arg, false); } };
document.querySelectorAll('.nav[data-route]').forEach((b) => (b.onclick = () => go(b.dataset.route)));

// ===================================================================== track list
function trackList(tracks, playAt, opts = {}) {
  const wrap = h('div', { class: 'tracks' });
  tracks.forEach((t, i) => {
    const play = () => playAt(i);
    const like = h('button', { class: 'ibtn sm t-like' + (isLiked(t.uri) ? ' liked' : ''), title: 'Like', 'data-like': t.uri, onclick: (e) => { e.stopPropagation(); toggleLike(t); } }, icon('heart', 16));
    const row = h('div', {
      class: 'trow' + (opts.compact ? ' compact' : ''),
      'data-uri': t.uri,
      ondblclick: play,
      oncontextmenu: (e) => { e.preventDefault(); trackMenu(e, t, i, opts, row); },
    },
      h('div', { class: 't-idx', onclick: play }, h('span', { class: 'n', text: opts.numbers ? t.number || i + 1 : i + 1 }), icon('play', 14)),
      h('div', { class: 't-main' },
        opts.noCover ? null : cover(t.image),
        h('div', { class: 't-text' },
          h('div', { class: 't-name', text: t.name }),
          h('div', { class: 't-sub' }, artistLinks(t), t.quality && !opts.noQuality ? h('span', { class: 'q', text: t.quality }) : null))),
      opts.compact ? null : h('div', { class: 't-album' }, t.album ? h('a', { class: 'lnk', onclick: () => go('album', t.album.key), text: t.album.name }) : ''),
      like,
      h('div', { class: 't-dur', text: t.duration ? fmt(t.duration) : '' }));
    wrap.append(row);
  });
  return wrap;
}
function markPlaying() {
  const t = current();
  document.querySelectorAll('.trow[data-uri]').forEach((r) => r.classList.toggle('playing', !!t && r.dataset.uri === t.uri));
}
function syncLikeButtons() {
  document.querySelectorAll('[data-like]').forEach((b) => b.classList.toggle('liked', isLiked(b.dataset.like)));
  const t = current();
  $('np-like').classList.toggle('liked', !!(t && isLiked(t.uri)));
}

// ===================================================================== cards
function card(item, { round = false, onOpen, onPlay, onMenu } = {}) {
  return h('div', { class: 'card' + (round ? ' round' : ''), onclick: onOpen, oncontextmenu: onMenu ? (e) => { e.preventDefault(); onMenu(e); } : null },
    item.mosaic ? mosaic(item.mosaic, 'cover') : cover(item.image, round ? 'user' : 'disc', 'cover'),
    onPlay ? h('button', { class: 'hover-play', title: 'Play', onclick: (e) => { e.stopPropagation(); onPlay(); } }, icon('play', 18)) : null,
    h('div', { class: 'c-title', text: item.name }),
    item.sub ? h('div', { class: 'c-sub', text: item.sub }) : null);
}
const albumCard = (c) => card(c, { onOpen: () => go('album', c.key), onPlay: () => playAlbum(c.key), onMenu: (e) => albumMenu(e, c.key) });
const artistCard = (a) => card({ name: a.name, image: [...a.tracks].find((t) => t.image)?.image, sub: plural(a.tracks.size, 'song') }, { round: true, onOpen: () => go('artist', a.name) });
const shelf = (nodes) => h('div', { class: 'shelf' }, nodes);
const grid = (nodes) => h('div', { class: 'grid' }, nodes);
const section = (title, ...rest) => h('div', { class: 'section' }, h('h2', { text: title }), ...rest);
const playlistCard = (p) => card({ name: p.name, sub: plural(p.tracks.length, 'song'), mosaic: p.tracks.map((t) => t.image) }, { onOpen: () => go('playlist', p.id), onPlay: p.tracks.length ? () => playList(p.tracks) : null });

async function albumTracks(key) {
  if (key.startsWith('ia:')) { const d = await iaItem(key.slice(3)); return d.tracks.map((t) => iaTrack(d, t)); }
  const a = LOCAL.byAlbum.get(key);
  return a ? a.tracks : [];
}
const playAlbum = (key) => albumTracks(key).then((t) => playList(t)).catch(fail);

// lazily filled shelf (archive requests)
function lazyShelf(load, empty = 'Nothing found here.') {
  const el = h('div', { class: 'shelf' }, Array.from({ length: 6 }, () => h('div', { class: 'card ghost-card' }, h('div', { class: 'cover' }), h('div', { class: 'ghost-line' }))));
  load()
    .then((nodes) => el.replaceChildren(...(nodes.length ? nodes : [h('p', { class: 'fine', text: empty })])))
    .catch(() => el.replaceChildren(h('p', { class: 'fine', text: 'The Internet Archive is unreachable right now.' })));
  return el;
}
// lazily filled track list (network search)
function lazyTracks(load, name) {
  const el = h('div', {}, h('p', { class: 'fine', text: 'Searching…' }));
  load()
    .then((tracks) => el.replaceChildren(tracks.length ? trackList(tracks, (i) => playList(tracks, i)) : h('p', { class: 'fine', text: 'Nothing found here.' })))
    .catch(() => el.replaceChildren(h('p', { class: 'fine', text: `${name} is unreachable right now.` })));
  return el;
}
const SHELVES = [['live', 'Live concerts'], ['jazz', 'Jazz'], ['classical', 'Classical'], ['electronic', 'Electronic'], ['netlabels', 'Netlabel releases'], ['78rpm', '78 rpm records']];
const iaShelf = (kind) => lazyShelf(async () => (await invoke('ia_shelf', { kind })).map((it) => albumCard(iaAlbumCard(it))));

// ===================================================================== views
function greeting() {
  const hr = new Date().getHours();
  const [a, b] = hr < 5 ? ['Late', 'night'] : hr < 12 ? ['Good', 'morning'] : hr < 18 ? ['Good', 'afternoon'] : ['Good', 'evening'];
  return h('div', { class: 'page-title' }, `${a} `, h('em', { text: b }));
}
const searchFor = (q) => { $('search').value = q; go('search', q); };

const VIEWS = {
  home() {
    const d = LIB.data;
    const out = h('div', {}, greeting());
    if (!LOCAL.folders.length && !d.recent.length) {
      out.append(
        h('p', { class: 'muted', style: 'max-width:560px;line-height:1.6;margin-top:10px', text: 'Miek plays lossless audio — your own FLAC, ALAC, WAV and AIFF files, nearly a million lossless recordings on the Internet Archive, and FLAC music from Wikimedia Commons. No accounts, no ads.' }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: addFolder }, icon('folder', 16), 'Add your music folder'),
          h('button', { class: 'btn', onclick: () => go('explore') }, icon('globe', 16), 'Explore the Internet Archive')));
    }
    if (d.recent.length) out.append(section('Recently played'), shelf(d.recent.slice(0, 16).map((t) => card({ name: t.name, image: t.image, sub: names(t.artists) }, { onOpen: () => playOne(t), onPlay: () => playOne(t) }))));
    if (d.playlists.length) out.append(section('Your playlists'), shelf(d.playlists.map(playlistCard)));
    if (LOCAL.albums.length) out.append(section('From your music', h('a', { class: 'more lnk', text: 'Show all', onclick: () => go('library') })), shelf(shuffleArr(LOCAL.albums).slice(0, 16).map((a) => albumCard(localAlbumCard(a)))));
    out.append(...homeForYou());
    return out;
  },

  // picked from what you listen to (foryou.js); a new listener gets the Archive's shelves
  async explore() {
    const out = h('div', {}, h('div', { class: 'page-title', text: 'Explore' }));
    const mine = await exploreForYou();
    if (mine) {
      out.append(h('p', { class: 'muted', style: 'max-width:560px;line-height:1.6', text: 'Picked from what you listen to: more by your artists, similar artists, and more in your language. It changes as you listen.' }), mine);
      return out;
    }
    out.append(h('p', { class: 'muted', style: 'max-width:560px;line-height:1.6', text: 'Lossless recordings from the Internet Archive — concerts, netlabels, public-domain and historic releases, streamed as FLAC (often 24-bit). Once you’ve played some music, this page is picked from what you listen to.' }));
    for (const [k, title] of SHELVES) out.append(section(title), iaShelf(k));
    return out;
  },

  search(term) {
    if (!term) return VIEWS.home();
    const q = norm(term);
    const out = h('div', {}, h('div', { class: 'page-title', style: 'font-size:44px' }, 'Results for ', h('em', { text: term })));
    const songs = LOCAL.tracks.filter((t) => norm(t.name).includes(q) || t.artists.some((a) => norm(a.name).includes(q)) || norm(t.album.name).includes(q)).slice(0, 12);
    const albums = LOCAL.albums.filter((a) => norm(a.name).includes(q) || norm(a.artist).includes(q)).slice(0, 16);
    const artists = [...LOCAL.byArtist.values()].filter((a) => norm(a.name).includes(q)).slice(0, 12);
    out.append(section('Soulseek'), soulseekResults(term));
    if (songs.length) out.append(section('Your songs'), trackList(songs, (i) => playList(songs, i)));
    if (artists.length) out.append(section('Your artists'), shelf(artists.map(artistCard)));
    if (albums.length) out.append(section('Your albums'), shelf(albums.map((a) => albumCard(localAlbumCard(a)))));
    out.append(section('Internet Archive · lossless'), lazyShelf(async () => (await invoke('ia_search', { term })).map((it) => albumCard(iaAlbumCard(it)))));
    out.append(section('Wikimedia Commons · lossless'), lazyTracks(async () => (await invoke('commons_search', { term })).map(wcTrack), 'Wikimedia Commons'));
    return out;
  },

  async album(key) {
    let head, tracks, extra = null;
    if (key.startsWith('ia:')) {
      const d = await iaItem(key.slice(3));
      tracks = d.tracks.map((t) => iaTrack(d, t));
      head = { kicker: 'Internet Archive', name: d.title, image: d.image, by: d.creator, year: d.year };
      if (d.description) {
        extra = h('p', { class: 'fine desc clamp', text: d.description, title: 'Show more' });
        extra.onclick = () => extra.classList.toggle('clamp');
      }
      if (!tracks.length) throw new Error('This item has no lossless audio files.');
    } else {
      const a = LOCAL.byAlbum.get(key);
      if (!a) throw new Error('Album not found in your music.');
      tracks = a.tracks;
      head = { kicker: 'Album', name: a.name, image: a.image, by: a.artist, year: a.year };
    }
    const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    const qual = [...new Set(tracks.map((t) => t.quality).filter(Boolean))].join(' · ');
    return h('div', {},
      h('div', { class: 'hero' }, cover(head.image, 'disc', 'art'),
        h('div', {}, h('div', { class: 'kicker', text: head.kicker }), h('div', { class: 'page-title' + (head.name.length > 34 ? ' long' : ''), text: head.name }),
          h('div', { class: 'byline' }, head.by ? h('a', { class: 'lnk', text: head.by, onclick: () => openArtist(tracks[0], head.by) }) : null, (head.by ? ' · ' : '') + [head.year, plural(tracks.length, 'track'), fmtLong(total)].filter(Boolean).join(' · ')),
          qual ? h('div', { class: 'qual-pill', text: qual }) : null)),
      h('div', { class: 'actions' },
        h('button', { class: 'bigplay', title: 'Play', onclick: () => playList(tracks) }, icon('play', 22)),
        h('button', { class: 'btn', onclick: () => { Q.shuffle = true; renderShuffle(); playList(tracks, (Math.random() * tracks.length) | 0); } }, icon('shuffle', 16), 'Shuffle'),
        h('button', { class: 'btn', onclick: (e) => playlistPicker(e, tracks) }, icon('plus', 16), 'Add to playlist')),
      extra,
      trackList(tracks, (i) => playList(tracks, i), { compact: true, noCover: true, numbers: true, noQuality: true }));
  },

  artist(name) {
    const a = LOCAL.byArtist.get(norm(name));
    if (!a) return VIEWS.search(name);
    const tracks = [...a.tracks];
    const albums = [...a.albums].map((k) => LOCAL.byAlbum.get(k)).filter(Boolean);
    const out = h('div', {},
      h('div', { class: 'hero round' }, cover(tracks.find((t) => t.image)?.image, 'user', 'art'),
        h('div', {}, h('div', { class: 'kicker', text: 'Artist' }), h('div', { class: 'page-title', text: a.name }), h('div', { class: 'byline', text: `${plural(tracks.length, 'song')} in your music` }))),
      h('div', { class: 'actions' },
        h('button', { class: 'bigplay', title: 'Play', onclick: () => playList(shuffleArr(tracks)) }, icon('play', 22)),
        h('button', { class: 'btn', onclick: () => searchFor(a.name) }, icon('globe', 16), 'Find on the Internet Archive')));
    if (albums.length) out.append(section('Albums'), grid(albums.map((x) => albumCard(localAlbumCard(x)))));
    out.append(section('Songs'), trackList(tracks, (i) => playList(tracks, i)));
    return out;
  },

  library(tab = 'albums') {
    const out = h('div', {}, h('div', { class: 'page-title', text: 'Your music' }));
    if (!LOCAL.folders.length) {
      out.append(h('p', { class: 'muted', style: 'max-width:520px;line-height:1.6', text: 'Point Miek at the folders where you keep music. It reads FLAC, ALAC, WAV, AIFF, MP3, AAC, Ogg and Opus, with their tags and cover art.' }),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: addFolder }, icon('folder', 16), 'Add a music folder')));
      return out;
    }
    const tabs = [['albums', 'Albums'], ['artists', 'Artists'], ['songs', 'Songs']];
    out.append(h('div', { class: 'chips', style: 'margin:6px 0 22px' },
      tabs.map(([k, label]) => h('button', { class: 'chip' + (k === tab ? ' active' : ''), text: label, onclick: () => { R.stack[R.i].arg = k; go('library', k, false); } })),
      h('span', { class: 'fine', style: 'margin-left:auto;align-self:center', text: `${plural(LOCAL.tracks.length, 'song')} · ${plural(LOCAL.albums.length, 'album')}` }),
      h('button', { class: 'chip', onclick: rescan }, LOCAL.scanning ? 'Scanning…' : 'Rescan')));
    if (!LOCAL.tracks.length) out.append(h('p', { class: 'muted', text: LOCAL.scanning ? 'Scanning…' : 'No music found in your folders yet.' }));
    else if (tab === 'albums') out.append(grid(LOCAL.albums.map((a) => albumCard(localAlbumCard(a)))));
    else if (tab === 'artists') out.append(grid([...LOCAL.byArtist.values()].filter((a) => a.albums.size).sort((x, y) => x.name.localeCompare(y.name)).map(artistCard)));
    else {
      const songs = [...LOCAL.tracks].sort((a, b) => a.name.localeCompare(b.name));
      out.append(trackList(songs, (i) => playList(songs, i)));
    }
    return out;
  },

  playlist(id) {
    const p = findPlaylist(id);
    if (!p) return h('div', { class: 'blank' }, h('div', {}, h('div', { class: 'page-title', text: 'Playlist not found' })));
    const total = p.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    return h('div', {},
      h('div', { class: 'hero' }, mosaic(p.tracks.map((t) => t.image), 'art'),
        h('div', {}, h('div', { class: 'kicker', text: 'Playlist' }), h('div', { class: 'page-title', text: p.name }),
          h('div', { class: 'byline', text: [plural(p.tracks.length, 'song'), p.tracks.length ? fmtLong(total) : null].filter(Boolean).join(' · ') }))),
      h('div', { class: 'actions' },
        p.tracks.length ? h('button', { class: 'bigplay', title: 'Play', onclick: () => playList(p.tracks) }, icon('play', 22)) : null,
        h('button', { class: 'btn', onclick: () => renamePlaylist(p) }, icon('pencil', 15), 'Rename'),
        h('button', { class: 'btn danger', onclick: () => deletePlaylist(p) }, icon('trash', 15), 'Delete')),
      p.tracks.length
        ? trackList(p.tracks, (i) => playList(p.tracks, i), { extraMenu: (t, i) => [{ icon: 'trash', text: 'Remove from this playlist', run: () => { p.tracks.splice(i, 1); libSave(); refresh(); } }] })
        : h('p', { class: 'muted', style: 'margin-top:24px', text: 'Empty for now. Right-click any song and choose “Add to playlist”.' }));
  },

  liked() {
    const t = LIB.data.liked;
    return h('div', {},
      h('div', { class: 'hero' }, h('div', { class: 'art', style: 'background:linear-gradient(150deg, rgba(255,255,255,.16), rgba(255,255,255,.03));color:var(--ink)' }, icon('heart', 72)),
        h('div', {}, h('div', { class: 'kicker', text: 'Collection' }), h('div', { class: 'page-title' }, 'Liked ', h('em', { text: 'songs' })), h('div', { class: 'byline', text: plural(t.length, 'song') }))),
      h('div', { class: 'actions' }, t.length ? h('button', { class: 'bigplay', title: 'Play', onclick: () => playList(t) }, icon('play', 22)) : null),
      t.length ? trackList(t, (i) => playList(t, i)) : h('p', { class: 'muted', text: 'Tap the heart on any song to keep it here.' }));
  },

  settings() {
    const out = h('div', {}, h('div', { class: 'page-title', text: 'Settings' }));
    out.append(section('Music folders'), h('div', { class: 'panel' },
      ...LOCAL.folders.map((f) => h('div', { class: 'setting' }, h('div', { class: 'label', text: f }),
        h('button', { class: 'btn', onclick: async () => { LOCAL.folders = LOCAL.folders.filter((x) => x !== f); await invoke('local_set_folders', { folders: LOCAL.folders }); rescan(); } }, 'Remove'))),
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: LOCAL.folders.length ? 'Add another folder' : 'No folders yet' }), h('div', { class: 'fine', text: 'FLAC, ALAC, WAV, AIFF, MP3, AAC, Ogg, Opus.' })),
        h('div', { style: 'display:flex;gap:8px' }, h('button', { class: 'btn', onclick: addFolder }, icon('folder', 15), 'Add'), LOCAL.folders.length ? h('button', { class: 'btn', onclick: rescan }, icon('refresh', 15), 'Rescan') : null))));

    const st = S.player || {};
    out.append(section('Playback'), h('div', { class: 'panel' },
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'Output' }),
        h('div', { class: 'fine', text: st.device ? `${st.device}${st.outRate ? ' · ' + (st.outRate / 1000).toFixed(1) + ' kHz' : ''}` : 'System default device' })),
        h('div', { class: 'fine', style: 'max-width:320px;text-align:right', text: 'Decoded natively in 32-bit float. Resampled with a high-quality sinc filter only when the source rate differs from the device.' }))));

    out.append(section('Soulseek'), soulseekSettings());
    out.append(section('Autoplay'), autoplaySettings());

    const soundBtn = h('button', { class: 'btn' }, introPrefs.sound ? 'On' : 'Off');
    soundBtn.onclick = () => { introPrefs.sound = !introPrefs.sound; soundBtn.textContent = introPrefs.sound ? 'On' : 'Off'; };
    out.append(section('Opening'), h('div', { class: 'panel' },
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'Intro beat' }), h('div', { class: 'fine', text: 'Play the drum groove with the opening animation.' })), soundBtn),
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'Replay intro' })), h('button', { class: 'btn', onclick: () => playIntro() }, 'Play'))));

    out.append(section('Updates'), updateSettings());
    out.append(section('About'), h('div', { class: 'panel' },
      h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'Miek' }), h('div', { class: 'fine', text: 'Open source · MIT license · no accounts, no ads, no tracking. Sources: Soulseek, your files, the Internet Archive and Wikimedia Commons.' })))));
    return out;
  },
};

// ===================================================================== sidebar
function renderSidebar() {
  const cur = R.stack[R.i];
  const list = LIB.data.playlists;
  $('playlists').replaceChildren(...(list.length
    ? list.map((p) => h('button', { class: 'pl-item' + (cur && cur.route === 'playlist' && cur.arg === p.id ? ' active' : ''), 'data-id': p.id, title: p.name, onclick: () => go('playlist', p.id) },
        mosaic(p.tracks.map((t) => t.image)),
        h('div', { class: 'meta' }, h('div', { class: 'name', text: p.name }), h('div', { class: 'count', text: plural(p.tracks.length, 'song') }))))
    : [h('div', { class: 'side-empty', text: 'No playlists yet. Use + to make one.' })]));
}

// ===================================================================== search box
let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const term = $('search').value.trim();
    const cur = R.stack[R.i];
    if (cur && cur.route === 'search') { cur.arg = term; go('search', term, false); } else go('search', term);
  }, 350);
});
$('search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('search').value = ''; $('search').blur(); } });

// ===================================================================== menus & dialogs
function openMenu(e, items, anchorRow) {
  const m = $('menu');
  const list = items.filter(Boolean);
  while (list[list.length - 1] === '-') list.pop();
  m.replaceChildren(...list.map((it) => {
    if (it === '-') return h('div', { class: 'msep' });
    if (it.label) return h('div', { class: 'mlabel', text: it.label });
    return h('button', { class: 'mi', disabled: it.disabled, onclick: () => { closeMenu(); it.run && Promise.resolve(it.run()).catch(fail); } }, it.icon ? icon(it.icon, 16) : null, h('span', { text: it.text }));
  }));
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
  document.querySelectorAll('.menu-open').forEach((x) => x.classList.remove('menu-open'));
  if (anchorRow) anchorRow.classList.add('menu-open');
}
function closeMenu() {
  $('menu').classList.add('hidden');
  document.querySelectorAll('.menu-open').forEach((x) => x.classList.remove('menu-open'));
}
addEventListener('mousedown', (e) => { if (!$('menu').contains(e.target)) closeMenu(); });
addEventListener('blur', closeMenu);
addEventListener('contextmenu', (e) => { if (!e.defaultPrevented && e.target.tagName !== 'INPUT') e.preventDefault(); });

function playlistPicker(e, tracks) {
  openMenu(e, [
    { label: 'Add to playlist' },
    { icon: 'plus', text: 'New playlist…', run: async () => { const name = await promptBox('New playlist', 'Name it something you’ll recognise.', 'Create'); if (name) { const p = createPlaylist(name, tracks); toast(`Added ${plural(p.tracks.length, 'song')} to “${name}”`); } } },
    LIB.data.playlists.length ? '-' : null,
    ...LIB.data.playlists.map((p) => ({ text: p.name, run: () => { const n = addToPlaylist(p.id, tracks); toast(n ? `Added ${plural(n, 'song')} to “${p.name}”` : `Already in “${p.name}”`); } })),
  ]);
}
function trackMenu(e, t, i, opts, row) {
  openMenu(e, [
    { icon: 'play', text: 'Play', run: () => playOne(t) },
    { icon: 'skipForward', text: 'Play next', run: () => { queueAdd([t], true); toast('Playing next'); } },
    { icon: 'queue', text: 'Add to queue', run: () => { queueAdd([t]); toast('Added to queue'); } },
    { icon: 'heart', text: isLiked(t.uri) ? 'Remove from Liked songs' : 'Add to Liked songs', run: () => toggleLike(t) },
    { icon: 'plus', text: 'Add to playlist…', run: () => playlistPicker(e, [t]) },
    t.slsk ? { icon: 'download', text: 'Download to your music', run: () => slskDownload(t) } : null,
    ...(opts.extraMenu ? opts.extraMenu(t, i) : []),
    '-',
    t.album ? { icon: 'disc', text: 'Go to album', run: () => go('album', t.album.key) } : null,
    ...(t.artists || []).slice(0, 3).map((a) => ({ icon: 'user', text: `Go to ${a.name}`, run: () => openArtist(t, a.name) })),
  ], row);
}
function albumMenu(e, key) {
  openMenu(e, [
    { icon: 'play', text: 'Play', run: () => playAlbum(key) },
    { icon: 'queue', text: 'Add to queue', run: async () => { queueAdd(await albumTracks(key)); toast('Added to queue'); } },
    { icon: 'plus', text: 'Add to playlist…', run: async () => playlistPicker(e, await albumTracks(key)) },
  ]);
}

function closeModal() { $('modal').classList.add('hidden'); $('modal').replaceChildren(); }
function dialog(title, text, okText, withInput, value = '') {
  return new Promise((resolve) => {
    const input = withInput ? h('input', { maxlength: '100', placeholder: 'My playlist' }) : null;
    if (input) input.value = value;
    const done = (ok) => { closeModal(); resolve(ok ? (withInput ? input.value.trim() || null : true) : withInput ? null : false); };
    const box = h('div', { class: 'modal-card glass-solid' }, h('h3', { text: title }), text ? h('p', { text }) : null, input,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', text: 'Cancel', onclick: () => done(false) }), h('button', { class: 'btn primary', text: okText, onclick: () => done(true) })));
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    $('modal').replaceChildren(box);
    $('modal').classList.remove('hidden');
    $('modal').onmousedown = (e) => { if (e.target === $('modal')) done(false); };
    (input || box.querySelector('.primary')).focus();
    if (input) input.select();
  });
}
const promptBox = (t, x, ok, v) => dialog(t, x, ok, true, v);
const confirmBox = (t, x, ok) => dialog(t, x, ok, false);

async function renamePlaylist(p) {
  const name = await promptBox('Rename playlist', null, 'Save', p.name);
  if (name) { p.name = name; libSave(); refresh(); }
}
async function deletePlaylist(p) {
  if (!(await confirmBox(`Delete “${p.name}”?`, 'This removes it from Miek. It can’t be undone.', 'Delete'))) return;
  LIB.data.playlists = LIB.data.playlists.filter((x) => x !== p);
  libSave();
  go('home');
}
$('new-playlist').onclick = async () => {
  const name = await promptBox('New playlist', 'Name it something you’ll recognise.', 'Create');
  if (name) go('playlist', createPlaylist(name).id);
};

// ===================================================================== player bar
const S = { player: null, handledSeq: -1, preMute: 0.8 };
const setRange = (el, f) => el.style.setProperty('--p', `${Math.max(0, Math.min(1, f)) * 100}%`);
let seeking = false;
let volDrag = false;

function onTrackChange(t) {
  $('np-title').textContent = t.name;
  $('np-artist').replaceChildren(artistLinks(t));
  setArt(t.image);
  document.title = `${t.name} · ${names(t.artists)}`;
  pushRecent(t);
  markPlaying();
  syncLikeButtons();
  refreshQueue();
}
function renderShuffle() { $('shuffle').classList.toggle('on', Q.shuffle); }
function renderRepeat() {
  $('repeat').classList.toggle('on', Q.repeat > 0);
  $('repeat').replaceChildren(icon(Q.repeat === 2 ? 'repeatOne' : 'repeat', 18));
}

async function pollState() {
  let s;
  try { s = await invoke('player_state'); } catch { return; }
  S.player = s;
  const busy = s.status === 'playing' || s.status === 'loading';
  $('play').replaceChildren(icon(busy ? 'pause' : 'play', 20));
  $('play').title = busy ? 'Pause' : 'Play';
  $('play').classList.toggle('loading', s.status === 'loading' || SL.waiting || (s.buffering && s.seq === Q.seq));
  if (SL.waiting) $('play').title = 'Stop waiting';
  const cur0 = current();
  if (cur0 && cur0.slsk && SL.uri === cur0.uri && SL.id && !SL.waiting && (!SL.info || SL.info.state !== 'done')) {
    SL.info = await invoke('slsk_transfer', { id: SL.id }).catch(() => SL.info);
    if (SL.info && SL.info.state === 'done') prefetchNext(); // the next song can start arriving now
  }
  $('prev').disabled = !current();
  $('next').disabled = !current();
  $('np-like').disabled = !current();
  // Q.seq -1: a Soulseek file is selected but not loaded (waiting, or it failed); the engine still holds the old track
  const loaded = Q.seq !== -1;
  if (!seeking) {
    const f = loaded && s.duration ? s.position / s.duration : 0;
    $('seek').value = Math.round(f * 1000);
    setRange($('seek'), f);
    $('pos').textContent = fmt(loaded ? s.position * 1000 : 0);
  }
  $('dur').textContent = fmt(((loaded && s.duration) || (current() && current().duration / 1000) || 0) * 1000);
  if (!volDrag) {
    $('volume').value = Math.round(s.volume * 100);
    setRange($('volume'), s.volume);
    $('mute').replaceChildren(icon(s.volume === 0 ? 'volumeX' : 'volume', 18));
  }
  // source format → output, e.g. "FLAC 24/96 → 48"
  const qb = $('quality');
  const slskNow = cur0 && cur0.slsk && SL.uri === cur0.uri ? SL.info : null;
  if (SL.waiting && slskNow) {
    qb.textContent = slskStateText(slskNow);
    qb.title = `Soulseek · ${cur0.slsk.file}`;
    qb.classList.remove('hidden');
  } else if (cur0 && cur0.slsk && Q.seq === -1 && SL.uri === cur0.uri && SL.failed) {
    // stays until you move on: why this file isn't playing, and that Play tries again
    qb.textContent = 'Not available · Play retries';
    qb.title = SL.failed;
    qb.classList.remove('hidden');
  } else if (s.codec && current() && s.seq === Q.seq) {
    const src = s.codec.toUpperCase() + (s.bitDepth ? ` ${s.bitDepth}/${+(s.sampleRate / 1000).toFixed(1)}` : ` ${+(s.sampleRate / 1000).toFixed(1)}k`);
    const resampled = s.outRate && s.outRate !== s.sampleRate;
    // after a seek past what has arrived: the time shows where it's going while that part comes in
    const buffering = s.buffering ? ' · buffering' : '';
    qb.textContent = (resampled ? `${src} → ${+(s.outRate / 1000).toFixed(1)}` : src) + buffering + (slskNow && slskNow.state !== 'done' ? ` · ${slskStateText(slskNow)}` : '');
    const arriving = slskNow && slskNow.state !== 'done' ? `\nSoulseek · ${slskNow.user}${slskNow.speed ? ' · ' + fmtSize(slskNow.speed) + '/s' : ''} · ${fmtSize(slskNow.received)} of ${fmtSize(slskNow.size)}` : '';
    qb.title = `Source ${src} · output ${s.device || 'default device'} at ${(s.outRate / 1000).toFixed(1)} kHz${resampled ? ' (high-quality resampling)' : ' (no resampling)'}${arriving}`;
    qb.classList.remove('hidden');
  } else qb.classList.add('hidden');
  // only this song's own file: never what the engine still reports about the previous one
  const own = cur0 && s.seq === Q.seq && s.source === (cur0.slsk ? (SL.uri === cur0.uri ? SL.id : null) : cur0.src.value);
  if (own && s.cover && !cur0.image) adoptCover(cur0, convertFileSrc(s.cover));
  if (own && s.tags && cur0.slsk && !cur0.tagged) adoptTags(cur0, s.tags);
  if ((s.status === 'ended' || s.status === 'error') && s.seq === Q.seq && S.handledSeq !== s.seq) {
    S.handledSeq = s.seq;
    const cur = current();
    // never swap in another version: report it; a Soulseek file stays put so the user can pick another result
    if (s.status === 'error') {
      toast(`Couldn’t play “${cur ? cur.name : 'track'}”: ${s.error || 'unknown error'}`);
      if (!(cur && cur.slsk) || cur.radio) setTimeout(() => next(true), 900);
    } else next(true);
  }
}

// a song without artwork (e.g. from Soulseek) that carries its own picture: show it and remember it
function adoptCover(t, src) {
  t.image = src;
  setArt(src);
  const lists = [LIB.data.recent, LIB.data.liked, ...LIB.data.playlists.map((p) => p.tracks)];
  for (const list of lists) for (const x of list) if (x.uri === t.uri && !x.image) x.image = src;
  libSave();
  refreshQueue();
}

// cover art drives the backdrop and the accent colour
function setArt(src) {
  const np = $('np-cover');
  const bd = $('backdrop-art');
  np.classList.remove('on');
  bd.classList.remove('on');
  if (!src) { document.documentElement.style.setProperty('--accent', '#e9dcc4'); return; }
  const show = () => {
    np.src = src;
    np.classList.add('on');
    setTimeout(() => { bd.src = src; bd.classList.add('on'); }, 250);
  };
  // sample the accent colour when the image host allows it (CORS); show the art either way
  const probe = new Image();
  probe.crossOrigin = 'anonymous';
  probe.onload = () => { show(); try { applyAccent(probe); } catch {} };
  probe.onerror = show;
  probe.src = src;
}
function applyAccent(image) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, 24, 24);
  const px = ctx.getImageData(0, 0, 24, 24).data;
  const buckets = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (d < 0.12 || l < 0.15 || l > 0.9) continue;
    const s = d / (1 - Math.abs(2 * l - 1));
    let hue = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = Math.round(((hue * 60 + 360) % 360) / 15) * 15;
    const k = buckets.get(hue) || { n: 0, s: 0 };
    k.n += 1; k.s += s;
    buckets.set(hue, k);
  }
  let best = null;
  for (const [hue, k] of buckets) if (!best || k.s > best.score) best = { hue, score: k.s, sat: k.s / k.n };
  document.documentElement.style.setProperty('--accent', best ? `hsl(${best.hue} ${Math.round(Math.min(0.75, best.sat) * 100)}% 74%)` : '#e9dcc4');
}

$('play').onclick = () => {
  if (slskCancelWait()) return;
  if (current() && Q.seq === -1) return loadIndex(Q.i); // try that Soulseek file again
  if (!current()) { const r = LIB.data.recent[0]; return r ? playOne(r) : toast('Pick something to play'); }
  invoke('player_toggle').then(pollState).catch(fail);
};
$('next').onclick = () => next(false);
$('prev').onclick = prev;
$('shuffle').onclick = () => {
  Q.shuffle = !Q.shuffle;
  if (Q.shuffle && Q.list.length) Q.list = [...Q.list.slice(0, Q.i + 1), ...shuffleArr(Q.list.slice(Q.i + 1))];
  renderShuffle();
  prefetchNext();
  refreshQueue();
};
$('repeat').onclick = () => { Q.repeat = (Q.repeat + 1) % 3; renderRepeat(); };
$('np-like').onclick = () => current() && toggleLike(current());
$('np-title').onclick = () => { const t = current(); if (t && t.album) go('album', t.album.key); };
$('quality').onclick = () => go('settings');

const seek = $('seek');
seek.addEventListener('input', () => {
  seeking = true;
  setRange(seek, seek.value / 1000);
  if (S.player) $('pos').textContent = fmt((seek.value / 1000) * S.player.duration * 1000);
});
seek.addEventListener('change', () => {
  if (Q.seq === -1) return void (seeking = false);
  const secs = S.player ? (seek.value / 1000) * S.player.duration : 0;
  invoke('player_seek', { secs }).catch(fail).finally(() => setTimeout(() => (seeking = false), 400));
});
const vol = $('volume');
const setVolume = (v) => invoke('player_volume', { v }).catch(fail);
vol.addEventListener('input', () => { volDrag = true; setRange(vol, vol.value / 100); setVolume(vol.value / 100); });
vol.addEventListener('change', () => { setTimeout(() => (volDrag = false), 300); try { localStorage.setItem('miek.volume', String(vol.value / 100)); } catch {} });
$('mute').onclick = () => {
  const cur = S.player ? S.player.volume : 0.8;
  if (cur > 0) { S.preMute = cur; setVolume(0); } else setVolume(S.preMute || 0.8);
};

addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (!$('modal').classList.contains('hidden')) return;
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  else if (e.ctrlKey && e.key === 'ArrowRight') next(false);
  else if (e.ctrlKey && e.key === 'ArrowLeft') prev();
  else if (e.key === 'Escape') closeMenu();
});

// ===================================================================== queue panel
function refreshQueue() {
  if ($('queue').classList.contains('hidden')) return;
  const kids = [];
  const block = (title, items) => {
    if (!items.length) return;
    kids.push(h('div', { class: 'q-label', text: title }), trackList(items.map((x) => x.t), (k) => loadIndex(items[k].i), { compact: true, noQuality: true }));
  };
  const cur = current();
  if (cur) block('Now playing', [{ t: cur, i: Q.i }]);
  const after = Q.list.slice(Q.i + 1).map((t, k) => ({ t, i: Q.i + 1 + k }));
  block('Next up', after.filter((x) => !x.t.radio));
  block('Autoplay · picked for you', after.filter((x) => x.t.radio));
  if (!kids.length) kids.push(h('p', { class: 'fine', style: 'padding:10px', text: 'Play something to see what comes next. When the queue ends, Autoplay keeps going with songs picked for you.' }));
  $('queue-list').replaceChildren(...kids);
  markPlaying();
}
$('queue-btn').onclick = () => {
  const q = $('queue');
  q.classList.toggle('hidden');
  $('queue-btn').classList.toggle('on', !q.classList.contains('hidden'));
  refreshQueue();
};
$('queue-close').onclick = () => $('queue-btn').click();

// ===================================================================== window chrome
$('win-min').onclick = () => appWindow.minimize();
$('win-max').onclick = () => appWindow.toggleMaximize();
$('win-close').onclick = () => appWindow.close();

// ===================================================================== boot
hydrateIcons();
loadLogo().catch(() => {});
playIntro();
Promise.all([libLoad(), loadLocal()]).then(() => {
  renderSidebar();
  renderShuffle();
  renderRepeat();
  go('home');
  try { const v = parseFloat(localStorage.getItem('miek.volume')); if (v >= 0 && v <= 1) setVolume(v); } catch {}
  setInterval(pollState, 250);
  setTimeout(keepLikedSoulseek, 15000);
});
