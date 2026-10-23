// Miek autoplay: keeps the music going with songs picked for you.
//
// Everything runs locally, with no account and no tracking:
// - a taste profile learned from what you do: finishing a song counts for it, skipping it in the
//   first 30 s counts against it, liking counts strongly; old signals fade so it follows your taste now;
// - the session: the last few songs you played, not just the current one;
// - candidates from your library, your liked songs, the same artists on Soulseek (when it's on), the
//   Internet Archive and Wikimedia Commons, and Archive recordings sharing genre/subject tags;
// - never a song you just heard again, even as another copy from another source or user;
// - in the language you're listening in (see "language" below);
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
  t.langs = t.langs || {}; // artist → { language: songs seen in it }
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
  rememberLanguage(track);
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
// (`artist` false: a plain keyword search, e.g. "bollywood"; artists then come from each file's path)
// What Soulseek answers for a search, kept 10 minutes (Autoplay and Explore ask for the same artists)
const SLSK_HITS = new Map(); // term → { at, hits: Promise }
function soulseekHits(term) {
  const key = norm(term);
  const cached = SLSK_HITS.get(key);
  if (cached && Date.now() - cached.at < 10 * 60e3) return cached.hits;
  const hits = (async () => {
    const token = await invoke('slsk_search', { query: term });
    // peers answer over several seconds: stop early once there's plenty, wait longer when answers are few
    const out = [];
    for (let waited = 0; ; ) {
      await sleep(500);
      waited += 500;
      const r = await invoke('slsk_results', { token, from: out.length });
      out.push(...r.hits);
      if (r.done || waited >= 12000 || (waited >= 2000 && out.length >= 60)) break;
    }
    return out;
  })();
  hits.catch(() => SLSK_HITS.delete(key));
  SLSK_HITS.set(key, { at: Date.now(), hits });
  return hits;
}
async function soulseekCandidates(artist, asArtist = true) {
  const key = norm(artist);
  const cached = SLSK_CANDIDATES.get(key);
  if (cached && Date.now() - cached.at < 10 * 60e3) return cached.list;
  const hits = await soulseekHits(artist);
  const want = words(artist);
  const rank = (x) => [FORMAT_ORDER(x.ext), x.slotFree ? 0 : 1, x.queue, -x.speed];
  const better = (a, b) => { const [p, q] = [rank(a), rank(b)]; for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] < q[i]; return false; };
  const best = new Map();
  for (const x of hits) {
    if (x.duration && (x.duration < 90 || x.duration > 720)) continue;
    const path = new Set(words(x.file));
    if (!want.every((w) => path.has(w))) continue;
    const t = slskTrack(x);
    if (asArtist && !artistKeys(t).some((a) => a.includes(key) || key.includes(a))) t.artists = [{ name: artist }];
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
// Same song, whichever copy: the title's identifying words, and at least one artist in common
// ("Pritam, Arijit Singh - Tum Hi Ho" is the "Tum Hi Ho" by Arijit Singh you just heard).
// A song set to look songs up in: title words → the artist sets of songs with that title.
function songSet(tracks = []) {
  const m = new Map();
  const set = {
    has: (t) => (m.get(songWords(t).join(' ')) || []).some((as) => artistKeys(t).some((a) => as.has(a)) || (!as.size && !artistKeys(t).length)),
    add: (t) => { const k = songWords(t).join(' '); if (!m.has(k)) m.set(k, []); m.get(k).push(new Set(artistKeys(t))); return set; },
  };
  tracks.forEach((t) => set.add(t));
  return set;
}

// ----------------------------------------------------------------- language
// Autoplay keeps to the language you're listening in. A song's language comes from its script, from
// marker words ("Bollywood", "Punjabi"…), from common words (romanized Hindi is written in Latin
// letters, so "Tum Hi Ho" is told apart from English by its words), or else from its artist's
// other songs. Unknown stays unknown.
const SCRIPTS = [
  [/[ऀ-ॿ]/, 'hi'], [/[਀-੿]/, 'pa'], [/[઀-૿]/, 'gu'], [/[ঀ-৿]/, 'bn'],
  [/[஀-௿]/, 'ta'], [/[ఀ-౿]/, 'te'], [/[ಀ-೿]/, 'kn'], [/[ഀ-ൿ]/, 'ml'],
  [/[؀-ۿ]/, 'ar'], [/[֐-׿]/, 'he'], [/[Ѐ-ӿ]/, 'ru'], [/[Ͱ-Ͽ]/, 'el'],
  [/[฀-๿]/, 'th'], [/[぀-ヿ]/, 'ja'], [/[가-힯]/, 'ko'], [/[一-鿿]/, 'zh'],
];
const MARKERS = [
  [/\b(bollywood|hindi|filmi|ghazal|qawwali|desi)\b/, 'hi'], [/\bpunjabi\b/, 'pa'], [/\b(tamil|kollywood)\b/, 'ta'],
  [/\b(telugu|tollywood)\b/, 'te'], [/\bmalayalam\b/, 'ml'], [/\bkannada\b/, 'kn'], [/\bbengali\b/, 'bn'], [/\bgujarati\b/, 'gu'],
];
const HI_WORDS = new Set('tum hi ho hai hain hoon mera meri mere tera teri tere dil pyaar pyar ishq mohabbat jaan ke ki ka ko se mein na nahi nahin kya kyun yeh woh aur bhi sajna sanam yaar zindagi tujhe mujhe tujhse mujhse tu hum jo kabhi raat baarish aankhen khuda saath abhi baaki kuch aaj kal dard chal rang sapna mann mahi dilbar humko tumko kaise kaun koi ek dono duniya jahan pal lamhe dhadkan aashiqui deewana deewani junoon tanha judaa barse badal'.split(' '));
const EN_WORDS = new Set('the of and you your my me i im it its in on is be love all dont cant aint baby night girl boy heart with for this that we she he they what when where time way day life go come never little man woman blues sunshine away down up out like just know want need feel'.split(' '));

function detectLanguage(t) {
  const full = [t.name, t.album && t.album.name, t.folder, t.slsk && t.slsk.file, ...(t.tags || [])].filter(Boolean).join(' ');
  for (const [re, l] of SCRIPTS) if (re.test(full)) return l;
  const low = norm(full);
  for (const [re, l] of MARKERS) if (re.test(low)) return l;
  // the title's own words; "(From "Animal")" and "(Live at …)" notes say nothing about the song's language
  const ws = norm(t.name || '').replace(/[([{].*?[)\]}]/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
  const hi = ws.filter((w) => HI_WORDS.has(w)).length;
  const en = ws.filter((w) => EN_WORDS.has(w)).length;
  if (hi >= 2 || (hi >= 1 && hi > en)) return 'hi';
  if (en >= 1 && en > hi) return 'en';
  return null;
}
// what language each artist sings in, kept with your taste: songs whose titles don't show it
// (e.g. "Satranga") are recognised even when you haven't played that artist lately.
// Only languages seen directly in a title are kept, so a guess never feeds itself.
function rememberLanguage(track) {
  const l = detectLanguage(track);
  if (!l) return;
  const L = taste().langs;
  for (const a of artistKeys(track)) {
    L[a] = L[a] || {};
    L[a][l] = Math.min(20, (L[a][l] || 0) + 1);
  }
  const keys = Object.keys(L);
  if (keys.length > 1000) keys.slice(0, keys.length - 1000).forEach((k) => delete L[k]);
}
// a song's language, falling back to the language most of its artist's known songs are in
function languages(tracks) {
  const byArtist = new Map(Object.entries(taste().langs).map(([a, m]) => [a, new Map(Object.entries(m))]));
  for (const t of tracks) {
    const l = detectLanguage(t);
    if (!l) continue;
    for (const a of artistKeys(t)) {
      const m = byArtist.get(a) || new Map();
      m.set(l, (m.get(l) || 0) + 1);
      byArtist.set(a, m);
    }
  }
  const artistLang = (a) => { const m = byArtist.get(a); return m ? [...m.entries()].sort((x, y) => y[1] - x[1])[0][0] : null; };
  return (t) => detectLanguage(t) || artistKeys(t).map(artistLang).find(Boolean) || null;
}
// the language you're listening in now: the current song's, else the session's most common
function sessionLanguage(session, langOf) {
  if (!session.length) return null; // nothing played yet
  const cur = langOf(session[session.length - 1]);
  if (cur) return cur;
  const c = new Map();
  for (const t of session) { const l = langOf(t); if (l) c.set(l, (c.get(l) || 0) + 1); }
  return [...c.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null;
}
// Soulseek searches that find more songs in a language than one artist has
const LANG_SEARCH = { hi: 'bollywood', pa: 'punjabi', ta: 'tamil', te: 'telugu', ml: 'malayalam', kn: 'kannada', bn: 'bengali', gu: 'gujarati' };

async function gather(session, lang) {
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
    ...(slsk && LANG_SEARCH[lang] ? [soulseekCandidates(LANG_SEARCH[lang], false).catch(() => [])] : []),
    ...artists.map((a) => invoke('ia_search', { term: a }).then((items) => archiveTracks(items.slice(0, 4), 2)).catch(() => [])),
    ...artists.slice(0, 2).map((a) => invoke('commons_search', { term: a }).then((r) => r.map(wcTrack)).catch(() => [])),
    // genre tags on the Archive are about Western recordings; they'd only bring the wrong language
    ...(lang && lang !== 'en' ? [] : tags.slice(0, 2).map((g) => invoke('ia_subject', { subject: g }).then((items) => archiveTracks(items, 2)).catch(() => []))),
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
  const songs = songSet();
  const pool = [];
  for (const c of scored) {
    const a = artistKeys(c)[0] || '';
    const al = (c.album && c.album.key) || c.uri;
    if ((perArtist.get(a) || 0) >= 2 || (perAlbum.get(al) || 0) >= 2 || songs.has(c)) continue;
    perArtist.set(a, (perArtist.get(a) || 0) + 1);
    perAlbum.set(al, (perAlbum.get(al) || 0) + 1);
    songs.add(c);
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

// ----------------------------------------------------------------- YouTube Mix
// After a YouTube song, Autoplay does what YouTube does: plays on through YouTube's Mix for the song you
// picked, in YouTube's order (yt-dlp reads it), minus what you've just heard or keep skipping. When
// that Mix runs out, it goes on from the newest YouTube song, so it drifts like YouTube's.
const YT_MIX = new Map(); // video id → { at, list }
async function youtubeMix(id) {
  const c = YT_MIX.get(id);
  if (c && Date.now() - c.at < 30 * 60e3) return c.list;
  const list = (await invoke('yt_mix', { id })).map((v) => ({ ...ytTrack(v), mix: true }));
  YT_MIX.set(id, { at: Date.now(), list });
  return list;
}
async function mixPicks(session, n) {
  const upto = Q.list.slice(0, Q.i + 1);
  const picked = [...upto].reverse().find((t) => t.yt && !t.radio);
  const newest = [...upto].reverse().find((t) => t.yt);
  const T = taste();
  const heard = songSet([...session, ...LIB.data.recent.slice(0, 25), ...Q.list.slice(Q.i + 1)]);
  for (const seed of [...new Set([picked, newest])].filter(Boolean)) {
    const mix = await youtubeMix(seed.yt.id).catch(() => []);
    const picks = mix.filter((t) => !Q.radioSeen.has(t.uri) && !heard.has(t) && (T.skips[t.uri] || 0) < 2);
    if (picks.length) return picks.slice(0, n);
  }
  return [];
}

async function recommend(n = 8) {
  const session = Q.list.slice(Math.max(0, Q.i - 4), Q.i + 1).filter(Boolean);
  if (!session.length) return [];
  if (session[session.length - 1].yt) {
    const mix = await mixPicks(session, n);
    if (mix.length) return mix;
  }
  const known = [...session, ...LIB.data.recent.slice(0, 50), ...LIB.data.liked];
  const lang = sessionLanguage(session, languages(known));
  const { candidates } = await gather(session, lang);
  const langOf = languages([...known, ...candidates]);
  const T = taste();
  const recent = new Set(LIB.data.recent.slice(0, 25).map((t) => t.uri));
  // songs just heard or already queued, as songs: another user's copy of the same song is no new song
  const heard = songSet([...session, ...LIB.data.recent.slice(0, 25), ...Q.list.slice(Q.i + 1)]);
  // in the session's language: for English, anything not known to be another language; for any
  // other language, only songs known to be in it (better a shorter queue than the wrong language)
  const sameLanguage = (c) => {
    if (!lang) return true;
    const l = langOf(c);
    return lang === 'en' ? !l || l === 'en' : l === lang;
  };
  const seen = new Set();
  const fresh = candidates.filter((c) => {
    if (!c || !c.uri || seen.has(c.uri)) return false;
    seen.add(c.uri);
    return !Q.radioSeen.has(c.uri) && !recent.has(c.uri) && !heard.has(c) && (T.skips[c.uri] || 0) < 2 && sameLanguage(c);
  });
  const ctx = {
    sessionArtists: new Set(session.flatMap(artistKeys)),
    sessionTags: new Set(session.flatMap((t) => t.tags || [])),
  };
  // related = same artist or genre as the session, or something your taste or likes lean towards.
  // With enough of those, unrelated picks don't pad the queue (it tops up again as it runs low).
  const related = (c) => artistKeys(c).some((a) => ctx.sessionArtists.has(a) || (T.artists[a] || 0) > 0)
    || (c.tags || []).some((g) => ctx.sessionTags.has(g) || (T.tags[g] || 0) > 0) || isLiked(c.uri)
    || (lang && lang !== 'en' && langOf(c) === lang); // e.g. other Bollywood artists after Arijit Singh
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
      h('div', {}, h('div', { class: 'label', text: 'Autoplay' }), h('div', { class: 'fine', text: 'When your queue ends, keep playing: after a YouTube song, YouTube’s own Mix for it; otherwise songs picked for you from your music, Soulseek (when it’s on), the Internet Archive and Wikimedia Commons.' })),
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
