// Miek autoplay: keeps the music going with songs picked for you.
//
// Everything runs locally, with no account and no tracking:
// - a taste profile learned from what you do: finishing a song counts for it, skipping it in the
//   first 30 s counts against it, liking counts strongly; old signals fade so it follows your taste now;
// - the session: the last few songs you played, not just the current one;
// - candidates from your library, your liked songs, the same artists on Soulseek (when it's on), the
//   Internet Archive and Wikimedia Commons, and Archive recordings sharing genre/subject tags;
// - never a song you just heard again, even as another copy from another source or user;
// - a score from artist + tag similarity and your taste, with a little randomness for discovery,
//   then a diverse pick: at most 2 per artist or album, never the same artist twice in a row.
// Loaded after app.js; uses its globals (invoke, LIB, LOCAL, Q, current, norm, …).

const TASTE_DECAY = 0.97; // per signal: older signals fade
const SKIP_SECONDS = 30;

function taste() {
  const t = (LIB.data.taste = LIB.data.taste || {});
  t.artists = t.artists || {};
  t.tags = t.tags || {};
  t.skips = t.skips || {};
  return t;
}
const artistKeys = (t) => (t.artists || []).map((a) => norm(a.name)).filter(Boolean);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function decay(map, cap) {
  for (const k of Object.keys(map)) {
    map[k] *= TASTE_DECAY;
    if (Math.abs(map[k]) < 0.05) delete map[k];
  }
  const keys = Object.keys(map);
  if (keys.length > cap) keys.sort((a, b) => Math.abs(map[a]) - Math.abs(map[b])).slice(0, keys.length - cap).forEach((k) => delete map[k]);
}
function learn(track, weight) {
  if (!track) return;
  const T = taste();
  decay(T.artists, 300);
  decay(T.tags, 300);
  for (const a of artistKeys(track)) T.artists[a] = (T.artists[a] || 0) + weight;
  for (const g of track.tags || []) T.tags[g] = (T.tags[g] || 0) + weight * 0.5;
  libSave();
}

// called by the queue when a track is left behind
function recordListen(track, { ended, position }) {
  if (!track || track.uri.startsWith('test:')) return;
  if (ended) return learn(track, 1);
  if (position < SKIP_SECONDS) {
    const T = taste();
    T.skips[track.uri] = (T.skips[track.uri] || 0) + 1;
    return learn(track, -1);
  }
  learn(track, 0.5); // listened for a while, then moved on
}
const recordLike = (track, liked) => learn(track, liked ? 2 : -2);

function topKeys(map, n) {
  return Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}

// ----------------------------------------------------------------- candidates
async function archiveTracks(items, n) {
  const lists = await Promise.all(shuffleArr(items).slice(0, n).map((it) => iaItem(it.id).then((d) => d.tracks.map((t) => iaTrack(d, t))).catch(() => [])));
  return lists.flat();
}
// Soulseek: search for the artist, keep files whose path names that artist and that look like a song,
// one copy per song: FLAC over MP3 over the rest, then a free slot, a short queue, a fast peer
const SLSK_CANDIDATES = new Map(); // artist → { at, list }; spares the network repeated searches
async function soulseekCandidates(artist) {
  const key = norm(artist);
  const cached = SLSK_CANDIDATES.get(key);
  if (cached && Date.now() - cached.at < 10 * 60e3) return cached.list;
  const token = await invoke('slsk_search', { query: artist });
  await sleep(6000); // peers answer over a few seconds
  const { hits } = await invoke('slsk_results', { token, from: 0 });
  const want = words(artist);
  const rank = (x) => [FORMAT_ORDER(x.ext), x.slotFree ? 0 : 1, x.queue, -x.speed];
  const better = (a, b) => { const [p, q] = [rank(a), rank(b)]; for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] < q[i]; return false; };
  const best = new Map();
  for (const x of hits) {
    if (x.duration && (x.duration < 90 || x.duration > 720)) continue;
    const path = new Set(words(x.file));
    if (!want.every((w) => path.has(w))) continue;
    const t = slskTrack(x);
    if (!artistKeys(t).some((a) => a.includes(key) || key.includes(a))) t.artists = [{ name: artist }];
    const song = songWords(t).join(' ');
    const have = best.get(song);
    if (!have || better(x, have.x)) best.set(song, { x, t });
  }
  const list = [...best.values()].slice(0, 30).map((b) => b.t);
  SLSK_CANDIDATES.set(key, { at: Date.now(), list });
  return list;
}
async function slskOnline() {
  try { return (await invoke('slsk_status')).state === 'online'; } catch { return false; }
}
// same song, whichever copy: first artist + the title's identifying words
const songKey = (t) => (artistKeys(t)[0] || '') + '|' + songWords(t).join(' ');

async function gather(session) {
  const T = taste();
  const counts = (keysOf) => {
    const c = new Map();
    for (const t of session) for (const k of keysOf(t)) c.set(k, (c.get(k) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  // the session leads; your long-term taste fills in
  const names = new Map(session.flatMap((t) => t.artists.map((a) => [norm(a.name), a.name])));
  const artists = [...new Set([...counts(artistKeys), ...topKeys(T.artists, 2)])].slice(0, 3).map((k) => names.get(k) || k);
  const tags = [...new Set([...counts((t) => t.tags || []), ...topKeys(T.tags, 2)])].slice(0, 3);

  const slsk = artists.length && (await slskOnline());
  const jobs = [
    Promise.resolve(LOCAL.tracks),
    Promise.resolve(LIB.data.liked),
    ...(slsk ? artists.slice(0, 2).map((a) => soulseekCandidates(a).catch(() => [])) : []),
    ...artists.map((a) => invoke('ia_search', { term: a }).then((items) => archiveTracks(items.slice(0, 4), 2)).catch(() => [])),
    ...artists.slice(0, 2).map((a) => invoke('commons_search', { term: a }).then((r) => r.map(wcTrack)).catch(() => [])),
    ...tags.slice(0, 2).map((g) => invoke('ia_subject', { subject: g }).then((items) => archiveTracks(items, 2)).catch(() => [])),
  ];
  // nothing to go on yet (new listener, untagged music): something lossless and live
  if (!artists.length && !tags.length) jobs.push(invoke('ia_shelf', { kind: 'live' }).then((items) => archiveTracks(items, 2)).catch(() => []));
  return { candidates: (await Promise.all(jobs)).flat(), artists, tags };
}

// ----------------------------------------------------------------- scoring
function score(c, ctx) {
  const T = taste();
  const ca = artistKeys(c);
  const ct = c.tags || [];
  let s = 0;
  if (ca.some((a) => ctx.sessionArtists.has(a))) s += 2;
  s += Math.min(3, ct.filter((g) => ctx.sessionTags.has(g)).length) * 0.8;
  s += 0.8 * Math.tanh(sum(ca.map((a) => T.artists[a] || 0)) / 3);
  s += 0.5 * Math.tanh(sum(ct.map((g) => T.tags[g] || 0)) / 3);
  s -= 1.2 * (T.skips[c.uri] || 0);
  if (isLiked(c.uri)) s += 0.6;
  if (c.lossless) s += 0.2;
  if ((c.bits || 0) >= 24) s += 0.2;
  return s + Math.random() * 0.9; // discovery: don't always play the safest pick
}

// best-scored first, at most 2 per artist/album, same song only once, no artist twice in a row
function pickDiverse(scored, n, lastArtist) {
  const perArtist = new Map();
  const perAlbum = new Map();
  const songs = new Set();
  const pool = [];
  for (const c of scored) {
    const a = artistKeys(c)[0] || '';
    const al = (c.album && c.album.key) || c.uri;
    const song = songKey(c);
    if ((perArtist.get(a) || 0) >= 2 || (perAlbum.get(al) || 0) >= 2 || songs.has(song)) continue;
    perArtist.set(a, (perArtist.get(a) || 0) + 1);
    perAlbum.set(al, (perAlbum.get(al) || 0) + 1);
    songs.add(song);
    pool.push(c);
    if (pool.length >= n * 2) break;
  }
  const out = [];
  let prevArtist = lastArtist;
  while (out.length < n && pool.length) {
    let i = pool.findIndex((c) => (artistKeys(c)[0] || '') !== prevArtist);
    if (i < 0) i = 0;
    const [c] = pool.splice(i, 1);
    out.push(c);
    prevArtist = artistKeys(c)[0] || '';
  }
  return out;
}

async function recommend(n = 8) {
  const session = Q.list.slice(Math.max(0, Q.i - 4), Q.i + 1).filter(Boolean);
  if (!session.length) return [];
  const { candidates } = await gather(session);
  const T = taste();
  const recent = new Set(LIB.data.recent.slice(0, 25).map((t) => t.uri));
  // songs just heard or already queued, as songs: another user's copy of the same song is no new song
  const heard = new Set([...session, ...LIB.data.recent.slice(0, 25), ...Q.list.slice(Q.i + 1)].map(songKey));
  const seen = new Set();
  const fresh = candidates.filter((c) => {
    if (!c || !c.uri || seen.has(c.uri)) return false;
    seen.add(c.uri);
    return !Q.radioSeen.has(c.uri) && !recent.has(c.uri) && !heard.has(songKey(c)) && (T.skips[c.uri] || 0) < 2;
  });
  const ctx = {
    sessionArtists: new Set(session.flatMap(artistKeys)),
    sessionTags: new Set(session.flatMap((t) => t.tags || [])),
  };
  // related = same artist or genre as the session, or something your taste or likes lean towards.
  // With enough of those, unrelated picks don't pad the queue (it tops up again as it runs low).
  const related = (c) => artistKeys(c).some((a) => ctx.sessionArtists.has(a) || (T.artists[a] || 0) > 0)
    || (c.tags || []).some((g) => ctx.sessionTags.has(g) || (T.tags[g] || 0) > 0) || isLiked(c.uri);
  const close = fresh.filter(related);
  const pool = close.length >= 2 ? close : fresh;
  const scored = pool.map((c) => ({ c, s: score(c, ctx) })).sort((a, b) => b.s - a.s).map((x) => x.c);
  const last = session[session.length - 1];
  return pickDiverse(scored, n, artistKeys(last)[0] || '');
}

// ----------------------------------------------------------------- queue integration
const AUTOPLAY_KEY = 'miek.autoplay';
function autoplayOn() {
  try { return localStorage.getItem(AUTOPLAY_KEY) !== 'off'; } catch { return true; }
}
const REC = { busy: null };

// keep a few picks ahead of the current song, so the next one starts without a wait
function topUpAutoplay() {
  if (!autoplayOn() || Q.repeat !== 0 || REC.busy || !current()) return REC.busy;
  if (Q.list.length - Q.i - 1 >= 3) return null;
  const list = Q.list;
  REC.busy = recommend(8)
    .then((picks) => {
      if (Q.list !== list) return; // a new list started meanwhile
      const items = picks.filter((t) => !Q.radioSeen.has(t.uri)).map((t) => ({ ...t, radio: true }));
      Q.list.push(...items);
      items.forEach((t) => Q.radioSeen.add(t.uri));
      refreshQueue();
      prefetchNext();
    })
    .catch(() => {})
    .finally(() => { REC.busy = null; });
  return REC.busy;
}

// the song's real artist turned out different from the guess: replace the picks that haven't played yet
async function repickAutoplay() {
  await REC.busy;
  for (let k = Q.list.length - 1; k > Q.i; k--) {
    if (Q.list[k].radio) {
      Q.radioSeen.delete(Q.list[k].uri);
      Q.list.splice(k, 1);
    }
  }
  topUpAutoplay();
}

// ----------------------------------------------------------------- settings
function autoplaySettings() {
  const T = taste();
  const btn = h('button', { class: 'btn' }, autoplayOn() ? 'On' : 'Off');
  btn.onclick = () => {
    try { localStorage.setItem(AUTOPLAY_KEY, autoplayOn() ? 'off' : 'on'); } catch {}
    btn.textContent = autoplayOn() ? 'On' : 'Off';
    if (autoplayOn()) topUpAutoplay();
  };
  const favs = [...topKeys(T.artists, 3), ...topKeys(T.tags, 3)];
  return h('div', { class: 'panel' },
    h('div', { class: 'setting' },
      h('div', {}, h('div', { class: 'label', text: 'Autoplay' }), h('div', { class: 'fine', text: 'When your queue ends, keep playing songs picked for you from your music, Soulseek (when it’s on), the Internet Archive and Wikimedia Commons.' })),
      btn),
    h('div', { class: 'setting' },
      h('div', {}, h('div', { class: 'label', text: 'Your taste' }),
        h('div', { class: 'fine', text: favs.length ? `Leaning towards: ${favs.join(', ')}. Learned on this computer from what you finish, skip and like.` : 'Nothing learned yet. Miek learns on this computer from what you finish, skip and like.' })),
      h('button', { class: 'btn', onclick: async () => {
        if (!(await confirmBox('Reset your taste?', 'Autoplay forgets what it learned from your listening. Likes and playlists stay.', 'Reset'))) return;
        LIB.data.taste = {};
        libSave();
        refresh();
      } }, 'Reset')));
}
