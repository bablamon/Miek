// Miek Soulseek UI: search results, playing a chosen file while it arrives, downloads, settings.
// The client itself (login, search, transfers) is native: src-tauri/src/slsk.rs.
// Loaded after app.js; uses its globals (invoke, h, Q, current, LIB, …).

// ===================================================================== Soulseek (files shared by other people)
// A search shows what peers actually answered, in the order they answered. The user picks one;
// playing it streams that exact file from that peer (it plays while it arrives).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtSize = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtRate = (r) => `${+(r / 1000).toFixed(1)} kHz`;
function slskQuality(x) {
  if (x.bitDepth && x.sampleRate) return `${x.bitDepth}-bit / ${fmtRate(x.sampleRate)}`;
  if (x.bitrate) return `${x.bitrate} kbps${x.vbr ? ' VBR' : ''}${x.sampleRate ? ' · ' + fmtRate(x.sampleRate) : ''}`;
  return x.sampleRate ? fmtRate(x.sampleRate) : '';
}
const splitArtists = (s) => s.split(/\s*[;,]\s*|\s+\/\s+/).filter(Boolean).map((name) => ({ name }));
// a first guess from the path: "Artist - Title" in the filename, else the artist of an "Artist - Album"
// folder. The file's own tags replace it once it plays (adoptTags).
function guessFromPath(parts, base) {
  const stem = base.replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}[\s.\-_)]+(?=\D)/, '');
  const m = stem.match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (m) return { artist: m[1], title: m[2] };
  const f = (parts[parts.length - 1] || '').match(/^(.+?)\s+[-–]\s+.+$/);
  return { artist: f ? f[1] : null, title: stem };
}
function slskTrack(x) {
  const parts = x.file.split(/[\\/]/).filter(Boolean);
  const base = parts.pop() || x.file;
  const guess = guessFromPath(parts, base);
  return {
    uri: 'slsk:' + x.user + '\n' + x.file,
    source: 'slsk',
    src: { kind: 'slsk', value: x.user + '\n' + x.file }, // the real transfer id is made at play time
    slsk: { user: x.user, file: x.file, latin1: !!x.latin1, size: x.size },
    fileName: base,
    name: guess.title || base,
    folder: parts.slice(-2).join(' / '),
    artists: guess.artist ? splitArtists(guess.artist) : [],
    album: null,
    image: null,
    duration: (x.duration || 0) * 1000,
    quality: [x.ext.toUpperCase(), slskQuality(x)].filter(Boolean).join(' '),
    tags: [],
    lossless: ['flac', 'wav', 'aif', 'aiff', 'aifc'].includes(x.ext),
    bits: x.bitDepth || null,
    rate: x.sampleRate || null,
  };
}
function slskStateText(x) {
  if (!x) return 'Soulseek';
  switch (x.state) {
    case 'connecting': return `Connecting to ${x.user}`;
    case 'requested': return `Asking ${x.user}`;
    case 'queued': return `Queued${x.place != null ? ' #' + x.place : ''} at ${x.user}`;
    case 'transferring': return `↓ ${x.size ? Math.floor((100 * x.received) / x.size) : 0}%`;
    case 'done': return `From ${x.user}`;
    case 'failed': return 'Failed';
    default: return 'Cancelled';
  }
}
function slskNote(st) {
  const msg = st.state === 'off' ? 'Soulseek is off. Turn it on to search files other people share.'
    : st.state === 'connecting' ? 'Still connecting to Soulseek…'
    : `Soulseek isn’t connected: ${st.error || 'unknown error'}`;
  return h('div', { class: 'slsk-note' }, h('span', { text: msg }), h('button', { class: 'btn', onclick: () => go('settings') }, icon('settings', 15), 'Soulseek settings'));
}
// the results page: the last search (reused when the page is rebuilt) and your filters and sort
const SLSK_VIEW = { last: null, prefs: { lossless: MODE.get() === 'lossless', free: false, sort: null, dir: 1 } }; // Lossless mode starts on lossless files
const FORMAT_ORDER = (ext) => (ext === 'flac' ? 0 : ext === 'mp3' ? 1 : 2);
// live results: filled in as peers answer, until the search runs out or the user leaves the page
function soulseekResults(term) {
  const box = h('div', {}, h('p', { class: 'fine', text: 'Searching Soulseek…' }));
  const mine = go.token; // the view being built belongs to this navigation
  const live = () => go.token === mine;
  (async () => {
    let st = await invoke('slsk_status');
    for (let i = 0; st.state === 'connecting' && i < 30 && live(); i++) { await sleep(500); st = await invoke('slsk_status'); }
    if (!live()) return;
    if (st.state !== 'online') return box.replaceChildren(slskNote(st));
    // the page is rebuilt when your music rescans: show the same search again rather than a new one
    const last = SLSK_VIEW.last;
    let token = last && last.term === term && Date.now() - last.at < 5 * 60e3 ? last.token : null;
    if (token == null) {
      try { token = await invoke('slsk_search', { query: term }); } catch (e) { return box.replaceChildren(h('p', { class: 'fine', text: String(e) })); }
      SLSK_VIEW.last = { term, token, at: Date.now() };
    }
    const hits = []; // in arrival order
    const users = new Set();
    const prefs = SLSK_VIEW.prefs; // filters and sort carry over to the next search
    const rows = h('div', {});
    const count = h('p', { class: 'fine' });
    let shown = 200;
    let done = false;
    let hover = false; // pointer over the list: hold new answers back, so rows don't move under it
    let held = 0;
    const more = h('button', { class: 'btn hidden', text: 'Show more', onclick: () => { shown += 200; render(); } });
    const COLS = [['name', 'File'], ['user', 'User'], ['format', 'Format'], ['length', 'Length'], ['size', 'Size']];
    const heads = COLS.map(([k, label]) => h('span', { class: 'sortable', title: 'Sort by ' + label.toLowerCase(), onclick: () => { if (prefs.sort === k) prefs.dir = -prefs.dir; else { prefs.sort = k; prefs.dir = k === 'name' || k === 'user' ? 1 : -1; } render(); } }, label));
    const head = h('div', { class: 'slsk-row slsk-head' }, h('span'), ...heads);
    const chip = (label, key) => {
      const b = h('button', { class: 'chip' + (prefs[key] ? ' active' : ''), text: label, onclick: () => { prefs[key] = !prefs[key]; b.classList.toggle('active', prefs[key]); render(); } });
      return b;
    };
    const reset = h('button', { class: 'chip', text: 'Default order', onclick: () => { prefs.sort = null; render(); } });
    const filters = h('div', { class: 'chips slsk-filters' }, chip('Lossless only', 'lossless'), chip('Free slot only', 'free'), reset);
    const quality = (x) => (x.bitDepth && x.sampleRate ? x.bitDepth * x.sampleRate : (x.bitrate || 0) * 50);
    const KEY = {
      name: (t) => t.fileName.toLowerCase(), user: (t) => t.hit.user.toLowerCase(),
      format: (t) => [-FORMAT_ORDER(t.hit.ext), quality(t.hit)], length: (t) => t.hit.duration || 0, size: (t) => t.hit.size,
    };
    const cmp = (a, b) => (Array.isArray(a) ? a.reduce((r, v, i) => r || (v < b[i] ? -1 : v > b[i] ? 1 : 0), 0) : a < b ? -1 : a > b ? 1 : 0);
    const view = () => {
      let v = hits.filter((t) => (!prefs.lossless || t.lossless) && (!prefs.free || t.hit.slotFree));
      if (prefs.sort) v = v.slice().sort((a, b) => prefs.dir * cmp(KEY[prefs.sort](a), KEY[prefs.sort](b)) || a.n - b.n);
      else v = v.slice().sort((a, b) => FORMAT_ORDER(a.hit.ext) - FORMAT_ORDER(b.hit.ext) || a.n - b.n); // FLAC, then MP3, then the rest
      return v;
    };
    const describe = () => prefs.sort
      ? `sorted by ${COLS.find((c) => c[0] === prefs.sort)[1].toLowerCase()}${prefs.dir === 1 ? '' : ' (descending)'}`
      : 'FLAC first, then MP3, each in the order they answered';
    const render = () => {
      held = 0;
      const v = view();
      rows.replaceChildren(...v.slice(0, shown).map((t) => (t.row ||= slskRow(t))));
      heads.forEach((el, i) => { el.dataset.dir = prefs.sort === COLS[i][0] ? (prefs.dir === 1 ? '↑' : '↓') : ''; });
      reset.classList.toggle('hidden', !prefs.sort);
      const hidden = hits.length - v.length;
      count.textContent = hits.length
        ? `${plural(hits.length, 'file')} from ${plural(users.size, 'user')}${hidden ? ` (${hidden} hidden by filters)` : ''} · ${describe()}${done ? '' : ' · still searching…'}`
        : done ? 'No one answered with a playable file.' : 'Waiting for answers…';
      more.classList.toggle('hidden', v.length <= shown);
      markPlaying();
    };
    const table = h('div', { class: 'tracks slsk-table', onmouseenter: () => (hover = true), onmouseleave: () => { hover = false; if (held) render(); } }, head, rows);
    box.replaceChildren(filters, count, table, more);
    render();
    while (live() && !done) {
      await sleep(700);
      const had = hits.length;
      try {
        const r = await invoke('slsk_results', { token, from: hits.length });
        for (const x of r.hits) {
          hits.push({ ...slskTrack(x), hit: x, n: hits.length });
          users.add(x.user);
        }
        done = r.done;
      } catch { done = true; }
      if (!live() || (hits.length === had && !done)) continue;
      if (hover) {
        held += hits.length - had;
        if (held) count.textContent = `${plural(hits.length, 'file')} from ${plural(users.size, 'user')} · ${held} new, shown when you move the pointer off the list`;
      } else render();
    }
  })().catch((e) => box.replaceChildren(h('p', { class: 'fine', text: String(e) })));
  return box;
}
function slskRow(t) {
  const x = t.hit;
  const play = () => playOne(t);
  const row = h('div', { class: 'trow slsk-row', 'data-uri': t.uri, ondblclick: play, oncontextmenu: (e) => { e.preventDefault(); trackMenu(e, t, 0, {}, row); } },
    h('div', { class: 't-idx', onclick: play, title: 'Play this file' }, icon('play', 14)),
    h('div', { class: 't-text', title: x.file }, h('div', { class: 't-name', text: t.fileName }), h('div', { class: 't-sub', text: t.folder || x.file })),
    h('div', { class: 't-text', title: `${x.slotFree ? 'Free upload slot' : 'No free upload slot'} · ${x.queue} queued · ${fmtSize(x.speed)}/s average` },
      h('div', { class: 't-sub', text: x.user }), h('div', { class: 'fine', text: x.slotFree ? 'slot free' : `${x.queue} in queue` })),
    h('div', { class: 't-text' }, h('div', { class: 't-sub', text: x.ext.toUpperCase() }), h('div', { class: 'fine', text: slskQuality(x) || '—' })),
    h('div', { class: 't-dur', text: x.duration ? fmt(x.duration * 1000) : '—' }),
    h('div', { class: 't-dur', text: fmtSize(x.size) }));
  return row;
}

// The stream being played: start (or reuse) the transfer, wait until the first part has arrived,
// then hand it to the player. Returns null when the user moved on or cancelled meanwhile.
const SL = { id: null, uri: null, info: null, waiting: false, wait: 0, failed: null };
async function slskPrepare(t) {
  const mine = ++SL.wait;
  const { user, file, latin1, size } = t.slsk;
  Object.assign(SL, { id: null, uri: t.uri, info: { state: 'connecting', user }, waiting: true, failed: null });
  // (reuses the transfer if this file was fetched ahead as the next song)
  try {
    const id = await invoke('slsk_stream', { user, file, latin1, size, keep: false });
    if (mine !== SL.wait) { invoke('slsk_cancel', { id }).catch(() => {}); return null; }
    SL.id = id;
    const asked = Date.now();
    for (;;) {
      if (mine !== SL.wait || current() !== t) return null;
      const x = (SL.info = await invoke('slsk_transfer', { id }));
      if (x.state === 'failed') throw new Error(`Soulseek · ${x.error}`);
      if (x.state === 'cancelled') return null;
      // an Autoplay pick you didn't choose doesn't get to keep you waiting in someone's queue
      if (t.radio && x.state !== 'transferring' && x.state !== 'done' && Date.now() - asked > 20000) {
        invoke('slsk_cancel', { id }).catch(() => {});
        throw new Error(`Soulseek · ${x.user} didn’t start sending “${t.name}”; skipping it`);
      }
      if (x.state === 'done' || x.received >= Math.min(x.size, 256 * 1024)) return id;
      await sleep(250);
    }
  } finally {
    if (mine === SL.wait) SL.waiting = false;
  }
}
function slskCancelWait() {
  if (!SL.waiting) return false;
  SL.wait++;
  SL.waiting = false;
  if (SL.id) invoke('slsk_cancel', { id: SL.id }).catch(() => {});
  toast('Stopped waiting for that file');
  return true;
}
// "Download to your music" (optional): keeps the file in Music\Miek Soulseek and adds that folder to your music
const DL = new Set();
// quiet: a liked song being kept; no messages unless it fails
async function slskDownload(t, { quiet = false } = {}) {
  const { user, file, latin1, size } = t.slsk;
  if (DL.has(t.uri)) return quiet || toast('Already downloading that file');
  DL.add(t.uri);
  if (!quiet) toast(`Downloading “${t.name}” from ${user}`);
  try {
    const id = await invoke('slsk_stream', { user, file, latin1, size, keep: true });
    for (;;) {
      const x = await invoke('slsk_transfer', { id });
      if (x.state === 'failed') throw new Error(`Soulseek · ${x.error}`);
      if (x.state === 'cancelled') throw new Error('Download cancelled');
      if (x.state === 'done') break;
      await sleep(1000);
    }
    const saved = await invoke('slsk_save', { id });
    if (!LOCAL.folders.includes(saved.folder)) {
      LOCAL.folders = [...LOCAL.folders, saved.folder];
      await invoke('local_set_folders', { folders: LOCAL.folders });
    }
    keptLocally(t, saved.path);
    if (quiet) {
      if (!LOCAL.scanning) {
        LOCAL.scanning = true;
        try { indexLocal(await invoke('local_scan')); } catch {}
        LOCAL.scanning = false;
      }
    } else {
      toast(`Saved “${t.name}” to your music`);
      rescan();
    }
  } catch (e) {
    if (!quiet) fail(e);
    else if (isLiked(t.uri)) toast(`Couldn’t keep “${t.name}” yet (${String(e).replace(/^Error:\s*Soulseek · /, '')}); Miek tries again later`, 6000);
  }
  DL.delete(t.uri);
}
// saved entries of this song (likes, history, playlists) now play the downloaded file
function keptLocally(t, path) {
  const lists = [LIB.data.liked, LIB.data.recent, ...LIB.data.playlists.map((p) => p.tracks)];
  for (const list of lists) for (const x of list) if (x.uri === t.uri) Object.assign(x, { src: { kind: 'file', value: path }, source: 'local', slsk: null, from: t.slsk.user });
  libSave();
}
// liked Soulseek songs not kept yet (liked before this, or the download failed): fetch them one by one
async function keepLikedSoulseek() {
  for (const t of LIB.data.liked.filter((x) => x.slsk)) {
    const st = await invoke('slsk_status').catch(() => null);
    if (!st || st.state !== 'online') return;
    await slskDownload(t, { quiet: true });
  }
}

// a Soulseek file's own tags replace what was guessed from its path (title, artist, genre), so the
// player shows the real names and Autoplay knows what you're listening to
function adoptTags(t, tg) {
  t.tagged = true;
  const before = artistKeys(t).join('|');
  if (tg.title) t.name = tg.title;
  const who = tg.artist || tg.albumArtist;
  if (who) t.artists = splitArtists(who);
  if (tg.genre) t.tags = tg.genre.split(/\s*[;,/]\s*/).map(norm).filter(Boolean);
  const lists = [LIB.data.recent, LIB.data.liked, ...LIB.data.playlists.map((p) => p.tracks)];
  for (const list of lists) for (const x of list) if (x.uri === t.uri) Object.assign(x, { name: t.name, artists: t.artists, tags: t.tags });
  dedupeRecent(); // the real names may show it's a song already in your history
  $('np-title').textContent = t.name;
  $('np-artist').replaceChildren(artistLinks(t));
  document.title = `${t.name} · ${names(t.artists)}`;
  libSave();
  // Autoplay may have picked from the guessed artist; pick again from the real one
  if (artistKeys(t).join('|') !== before && current() === t) repickAutoplay();
  refreshQueue();
}

// ===================================================================== Soulseek settings
function soulseekSettings() {
  const panel = h('div', { class: 'panel' });
  const user = h('input', { class: 'field', maxlength: '30', placeholder: 'Picked for you', spellcheck: 'false', 'aria-label': 'Soulseek username' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Picked for you', spellcheck: 'false', 'aria-label': 'Soulseek password' });
  const status = h('div', { class: 'fine' });
  const toggle = h('button', { class: 'btn' }, '…');
  let cfg = { enabled: false, username: '', password: '' };
  const showStatus = async () => {
    const st = await invoke('slsk_status').catch(() => null);
    if (!st || !panel.isConnected) return;
    status.textContent = st.state === 'online' ? `Signed in as ${st.username} · listening on port ${st.port}`
      : st.state === 'connecting' ? 'Connecting…' : st.state === 'off' ? 'Off' : st.error || 'Not connected';
    if (st.state === 'connecting') setTimeout(showStatus, 700);
  };
  const show = (c) => { cfg = c; user.value = c.username; pass.value = c.password; toggle.textContent = c.enabled ? 'On' : 'Off'; };
  const save = async (enabled) => {
    try {
      show(await invoke('slsk_config_set', { enabled, username: user.value, password: pass.value }));
      SLSK_VIEW.last = null; // reconnecting forgets earlier searches
      setTimeout(showStatus, 150);
    } catch (e) { fail(e); }
  };
  toggle.onclick = () => save(!cfg.enabled);
  invoke('slsk_config_get').then((c) => { show(c); showStatus(); }).catch(fail);
  panel.append(
    h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'Search and play from Soulseek' }), status), toggle),
    h('div', { class: 'setting' }, h('div', {}, h('div', { class: 'label', text: 'Soulseek name' }),
      h('div', { class: 'fine', text: 'Soulseek registers a name the first time it signs in. Keep the password to use the same name again.' })),
      h('div', { class: 'slsk-account' }, user, pass, h('button', { class: 'btn', onclick: () => save(cfg.enabled) }, 'Save'))),
    h('div', { class: 'setting' }, h('div', { class: 'fine', style: 'max-width:640px', text: 'Soulseek is a peer-to-peer network: files come straight from other people’s computers. A search lists what they answer; you choose the file, and it plays while it downloads. Miek shares nothing back, and some people only upload to users who share. Only play and download music you have the right to. If Windows asks, allowing Miek through the firewall lets more people reach you.' })));
  return panel;
}
