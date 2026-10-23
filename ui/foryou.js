// Miek "for you": Explore and Home built from what you listen to, instead of fixed shelves.
//
// - who you listen to: your taste (finished, liked, skipped; see recommend.js), else your recent plays
// - songs by them on Soulseek you haven't just heard
// - similar artists: the ones credited on the same songs as yours ("Ed Sheeran, Arijit Singh -
//   Sapphire"), counted once per folder they appear in, so one big compilation doesn't decide it
// - more in the language you listen in (e.g. Bollywood), or Archive recordings with your genres
// New listeners (nothing played yet) still get the Archive shelves.
// Loaded after recommend.js; uses its globals (taste, topKeys, soulseekHits, soulseekCandidates, …).

const LANG_NAMES = { hi: 'Hindi', pa: 'Punjabi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', gu: 'Gujarati', ar: 'Arabic', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', he: 'Hebrew', el: 'Greek', th: 'Thai' };

// the artists you listen to most (taste first, then recent plays), the language and genres you lean to
function forYouProfile() {
  const T = taste();
  const known = [...LIB.data.recent, ...LIB.data.liked];
  const display = new Map();
  for (const t of known) for (const a of t.artists || []) if (!display.has(norm(a.name))) display.set(norm(a.name), a.name);
  const fromTaste = topKeys(T.artists, 3);
  const fromRecent = [];
  for (const t of LIB.data.recent.slice(0, 20)) for (const a of artistKeys(t)) if (!fromRecent.includes(a)) fromRecent.push(a);
  const keys = [...new Set([...fromTaste, ...fromRecent])].filter((k) => (T.artists[k] || 0) >= 0).slice(0, 3);
  const langOf = languages(known);
  const lang = sessionLanguage(LIB.data.recent.slice(0, 10).reverse(), langOf); // the newest last, as a session
  return { artists: keys.map((k) => display.get(k) || k), lang, tags: topKeys(T.tags, 3), langOf };
}

// credits on a file: "Pritam, Arijit Singh" / "Arijit Singh & Shreya Ghoshal" / "A feat. B"
const credits = (t) => (t.artists || []).flatMap((a) => a.name.split(/\s*(?:&|\+|\bfeat\.?|\bft\.?|\bwith\b|\bx\b|\band\b)\s*/i)).map((c) => c.trim()).filter(Boolean);
const NOT_ARTISTS = new Set(['various artists', 'various', 'va', 'unknown', 'unknown artist', 'bollywood', 'soundtrack', 'ost', 'original motion picture soundtrack', 'hits', 'songs', 'music', 'album', 'remix', 'lofi', 'live', 'mix', 'dj', 'mp3', 'flac', 'single', 'singles', 'top', 'best']);
function plausibleArtist(c) {
  const k = norm(c);
  return k.length >= 2 && k.length <= 40 && /\p{L}/u.test(k) && !NOT_ARTISTS.has(k) && k.split(/\s+/).length <= 5 && !/\d{3,}/.test(k);
}
// artists credited with `artist` on Soulseek, most often first (at least two folders)
async function similarArtists(artist, n = 8) {
  const key = norm(artist);
  const counts = new Map();
  const shown = new Map();
  const seen = new Set();
  for (const x of await soulseekHits(artist)) {
    const cs = credits(slskTrack(x));
    if (!cs.some((c) => norm(c) === key)) continue; // only files that credit your artist
    const folder = x.user + '|' + x.file.replace(/[\\/][^\\/]*$/, '');
    for (const c of cs) {
      const k = norm(c);
      if (k === key || k.includes(key) || key.includes(k) || !plausibleArtist(c) || seen.has(k + '|' + folder)) continue;
      seen.add(k + '|' + folder);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!shown.has(k)) shown.set(k, c);
    }
  }
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => shown.get(k));
}
// the artists most often found under a language's search ("bollywood"), other than yours
async function languageArtists(lang, exclude, n = 8) {
  const term = LANG_SEARCH[lang];
  if (!term) return [];
  const counts = new Map();
  const shown = new Map();
  const seen = new Set();
  for (const x of await soulseekHits(term)) {
    const folder = x.user + '|' + x.file.replace(/[\\/][^\\/]*$/, '');
    for (const c of credits(slskTrack(x))) {
      const k = norm(c);
      if (exclude.has(k) || !plausibleArtist(c) || seen.has(k + '|' + folder)) continue;
      seen.add(k + '|' + folder);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!shown.has(k)) shown.set(k, c);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => shown.get(k));
}

// songs you haven't just heard, at most `per` per artist
function freshSongs(list, n, per = 3) {
  const heard = songSet(LIB.data.recent.slice(0, 40));
  const count = new Map();
  const out = [];
  for (const t of list) {
    const a = artistKeys(t)[0] || '';
    if (heard.has(t) || (count.get(a) || 0) >= per) continue;
    count.set(a, (count.get(a) || 0) + 1);
    heard.add(t);
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}
const songsBy = async (artist, n) => freshSongs(await soulseekCandidates(artist), n, n);
function artistCardFor(name, sub) {
  return card({ name, sub }, {
    round: true,
    onOpen: () => searchFor(name),
    onPlay: () => songsBy(name, 15).then((l) => (l.length ? playList(l) : toast(`Nothing by ${name} found on Soulseek right now`))).catch(fail),
  });
}

// the Explore page for someone who has listened to something; null for a new listener
async function exploreForYou() {
  const p = forYouProfile();
  if (!p.artists.length) return null;
  const online = await slskOnline();
  const out = h('div', {});
  const mine = new Set(p.artists.map(norm));
  for (const a of p.artists.slice(0, 2)) {
    if (online) {
      out.append(section(`Because you listen to ${a}`), lazyTracks(() => songsBy(a, 8), 'Soulseek'));
      out.append(section(`Artists like ${a}`), lazyShelf(async () => (await similarArtists(a)).filter((x) => !mine.has(norm(x))).map((x) => artistCardFor(x, `Sings with ${a}`)), 'No similar artists found on Soulseek right now.'));
    } else {
      out.append(section(`Because you listen to ${a}`), lazyShelf(async () => (await invoke('ia_search', { term: a })).map((it) => albumCard(iaAlbumCard(it)))));
    }
  }
  const lname = LANG_NAMES[p.lang];
  if (online && LANG_SEARCH[p.lang]) {
    out.append(section(`More ${lname} music`), lazyTracks(async () => freshSongs((await soulseekCandidates(LANG_SEARCH[p.lang], false)).filter((t) => p.langOf(t) === p.lang && !artistKeys(t).some((k) => mine.has(k))), 10, 2), 'Soulseek'));
    out.append(section(`${lname} artists to try`), lazyShelf(async () => (await languageArtists(p.lang, mine)).map((x) => artistCardFor(x, `${lname} music`)), 'No artists found on Soulseek right now.'));
  }
  // the Archive's genre tags are about Western recordings: only for English or unknown
  if (!p.lang || p.lang === 'en') {
    for (const g of p.tags.slice(0, 2)) out.append(section(`${g[0].toUpperCase()}${g.slice(1)} on the Internet Archive`), lazyShelf(async () => (await invoke('ia_subject', { subject: g })).map((it) => albumCard(iaAlbumCard(it)))));
  }
  if (!online) out.prepend(h('div', { class: 'slsk-note' }, h('span', { text: 'Turn on Soulseek for songs and similar artists picked from what you listen to.' }), h('button', { class: 'btn', onclick: () => go('settings') }, icon('settings', 15), 'Soulseek settings')));
  return out;
}

// Home: a taste of it (your top artist), or the Archive's live shelf for a new listener
function homeForYou() {
  const p = forYouProfile();
  const a = p.artists[0];
  const more = h('a', { class: 'more lnk', text: 'More for you', onclick: () => go('explore') });
  if (!a) return [section('Live in lossless', h('a', { class: 'more lnk', text: 'Explore', onclick: () => go('explore') })), iaShelf('live')];
  // songs from Soulseek, or the artist's Archive recordings while Soulseek is off
  const box = h('div', {});
  slskOnline().then((on) => box.replaceChildren(on
    ? lazyTracks(() => songsBy(a, 6), 'Soulseek')
    : lazyShelf(async () => (await invoke('ia_search', { term: a })).map((it) => albumCard(iaAlbumCard(it))))));
  return [section(`Because you listen to ${a}`, more), box];
}
