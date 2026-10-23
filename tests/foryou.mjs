// "For you" test: runs the real UI scripts in a VM with a stand-in DOM and a fake Soulseek, and checks
// the listener profile, similar artists (from co-credits), language artists and fresh songs.
//   node tests/foryou.mjs ui
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const UI = process.argv[2];

const any = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === Symbol.iterator ? function* () {} : any),
  apply: () => any, construct: () => any, set: () => true,
});
const hit = (user, file, ext = 'flac') => ({ user, file, latin1: false, size: 9e6, ext, bitrate: null, duration: 240, vbr: false, sampleRate: 44100, bitDepth: 16, slotFree: true, speed: 500000, queue: 0 });
const SLSK = {
  'arijit singh': [
    // Pritam: credited with Arijit in three folders (two users) → most similar
    hit('u1', 'Music\\Aashiqui 2\\Pritam, Arijit Singh - Tum Hi Ho.flac'),
    hit('u2', 'Bollywood\\Hits 2013\\Pritam, Arijit Singh - Tum Hi Ho.flac'),
    hit('u3', 'Music\\Ae Dil\\Pritam, Arijit Singh - Channa Mereya.flac'),
    // Shreya Ghoshal: two folders
    hit('u1', 'Music\\Duets\\Arijit Singh & Shreya Ghoshal - Sunn Raha Hai.flac'),
    hit('u4', 'Hindi\\Romance\\Arijit Singh & Shreya Ghoshal - Samjhawan.flac'),
    // Amaal Mallik: many files, all in one folder → counted once → not enough
    ...[1, 2, 3, 4, 5].map((i) => hit('u5', `Music\\Amaal Mallik Collection\\Amaal Mallik, Arijit Singh - Song ${i}.flac`)),
    // "Various Artists" is not an artist; a file not crediting Arijit doesn't count
    hit('u6', 'Music\\Comp\\Various Artists, Arijit Singh - Medley.flac'),
    hit('u6', 'Music\\Comp2\\Various Artists, Arijit Singh - Medley 2.flac'),
    hit('u7', 'Music\\Atif Aslam - Tera Hone Laga Hoon.flac'),
    // songs by Arijit himself
    hit('u8', 'Music\\Arijit Singh\\Arijit Singh - Satranga.flac'),
    hit('u8', 'Music\\Arijit Singh\\Arijit Singh - Kabhi Jo Badal Barse.mp3', 'mp3'),
  ],
  bollywood: [
    hit('b1', 'Bollywood\\Atif Aslam\\Atif Aslam - Tera Hone Laga Hoon.flac'),
    hit('b2', 'Bollywood Hits\\Atif Aslam - Pehli Nazar Mein.flac'),
    hit('b3', 'Bollywood\\Old\\Atif Aslam - Woh Lamhe.mp3', 'mp3'),
    hit('b4', 'Bollywood\\Shreya Ghoshal - Sun Raha Hai Na Tu.mp3', 'mp3'),
    hit('b5', 'Bollywood\\Romance\\Shreya Ghoshal - Teri Ore.flac'),
    hit('b6', 'Bollywood\\Arijit Singh - Tum Hi Ho.flac'),
    hit('b7', 'Bollywood\\Lata Mangeshkar - Lag Ja Gale.flac'),
  ],
};
const searches = [];
const backend = {
  library_load: () => ({ liked: [], albums: [], playlists: [], recent: [] }),
  local_get: () => ({ folders: [], tracks: [] }),
  slsk_status: () => ({ state: 'online' }),
  slsk_search: ({ query }) => { searches.push(query); return query; },
  slsk_results: ({ token }) => ({ hits: SLSK[token.toLowerCase()] || [], done: true }),
  ia_search: () => [], ia_subject: () => [], ia_shelf: () => [], commons_search: () => [],
};
const ctx = {
  console, Math, Date, JSON, Promise, Map, Set, Error, Object, Array, String, Number, RegExp, Symbol, performance,
  setTimeout: (f) => { queueMicrotask(f); return 0; }, clearTimeout: () => {}, setInterval: () => 0,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: any, addEventListener: () => {}, innerWidth: 1200, innerHeight: 800, Image: function () { return any; }, Node: function () {},
  getComputedStyle: () => any, icon: () => any, hydrateIcons: () => {}, loadLogo: async () => {}, playIntro: () => {}, introPrefs: {},
};
ctx.window = ctx;
ctx.__TAURI__ = { core: { invoke: async (cmd, args) => (backend[cmd] ? backend[cmd](args || {}) : null), convertFileSrc: (p) => p }, window: { getCurrentWindow: () => any }, dialog: {} };
vm.createContext(ctx);
for (const f of ['app.js', 'soulseek.js', 'recommend.js', 'foryou.js']) vm.runInContext(readFileSync(`${UI}/${f}`, 'utf8'), ctx, { filename: f });
await new Promise((r) => setTimeout(r, 50));
const run = (code) => vm.runInContext(code, ctx);
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) process.exitCode = 1; };

// a new listener: no profile, Explore keeps the Archive shelves
check(run(`forYouProfile().artists.length`) === 0 && (await run(`exploreForYou()`)) === null, 'new listener: nothing to pick from yet, Explore keeps the Archive shelves');

// someone who listens to Arijit Singh (and once skipped Jack Johnson)
run(`
  const s = (name, artist) => ({ uri: 'x:' + name, name, artists: [{ name: artist }], tags: [] });
  LIB.data.recent = [s('Tum Hi Ho', 'Arijit Singh'), s('Kabhi Jo Badal Barse', 'Arijit Singh'), s('Same Girl', 'Jack Johnson'), s('Jaan Abhi Baaki Hai', 'Sangeet Wala')];
  LIB.data.taste = { artists: { 'arijit singh': 3.2, 'sangeet wala': 0.6, 'jack johnson': -1 }, tags: {}, skips: {}, langs: {} };
`);
const p = run(`const p = forYouProfile(); ({ artists: p.artists, lang: p.lang })`);
console.log('profile:', JSON.stringify(p));
check(p.artists[0] === 'Arijit Singh' && !p.artists.includes('Jack Johnson'), 'top artist first; an artist you skip is left out');
check(p.lang === 'hi', 'language: Hindi');

const similar = await run(`similarArtists('Arijit Singh')`);
console.log('similar to Arijit Singh:', similar);
check(similar[0] === 'Pritam' && similar[1] === 'Shreya Ghoshal', 'similar artists from co-credits, most folders first');
check(!similar.includes('Amaal Mallik'), 'many files in one folder count once (not enough on their own)');
check(!similar.some((a) => /various/i.test(a)) && !similar.includes('Atif Aslam'), "no 'Various Artists'; files that don't credit him don't count");

const langArtists = await run(`languageArtists('hi', new Set(['arijit singh']))`);
console.log('Hindi artists to try:', langArtists);
check(langArtists[0] === 'Atif Aslam' && !langArtists.includes('Arijit Singh'), 'language artists: most found first, not your own');

const songs = await run(`songsBy('Arijit Singh', 8).then((l) => l.map((t) => t.name))`);
console.log('because you listen to Arijit Singh:', songs);
check(!songs.includes('Tum Hi Ho') && !songs.includes('Kabhi Jo Badal Barse') && songs.includes('Satranga'), "songs by him, minus what you've just heard");

check((await run(`exploreForYou()`)) !== null, 'Explore is built for you');
check(searches.filter((q) => /arijit/i.test(q)).length === 1, `one Soulseek search per artist, reused (${searches.join(', ')})`);
