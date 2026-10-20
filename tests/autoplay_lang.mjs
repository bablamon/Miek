// Autoplay language test: runs the real ui/app.js + ui/soulseek.js + ui/recommend.js in a VM with a stand-in DOM and
// a fake backend, and checks that Autoplay keeps the language of what you are listening to.
//   node tests/autoplay_lang.mjs ui
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const UI = process.argv[2];

const any = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === Symbol.iterator ? function* () {} : any),
  apply: () => any, construct: () => any, set: () => true,
});
const hit = (user, file, ext, extra = {}) => ({ user, file, latin1: false, size: 9e6, ext, bitrate: ext === 'mp3' ? 320 : null, duration: 240, vbr: false, sampleRate: 44100, bitDepth: ext === 'flac' ? 16 : null, slotFree: true, speed: 500000, queue: 0, ...extra });
const SLSK = {
  'arijit singh': [
    hit('u1', 'Music\\Arijit Singh\\Aashiqui 2\\02 - Sunn Raha Hai.flac', 'flac'),
    hit('u2', 'Music\\Arijit Singh\\Arijit Singh - Kabhi Jo Badal Barse.mp3', 'mp3'),
    hit('u3', 'Music\\Arijit Singh\\Arijit Singh - Satranga (From "Animal").flac', 'flac'),
    hit('u4', 'Music\\Arijit Singh\\Arijit Singh - Tum Hi Ho.flac', 'flac'), // the song playing: never again
  ],
  'jack johnson': [hit('u5', 'Music\\Jack Johnson\\Jack Johnson - Upside Down.flac', 'flac'), hit('u5', 'Music\\Jack Johnson\\Jack Johnson - Better Together.flac', 'flac')],
  bollywood: [
    hit('u6', 'Bollywood\\Atif Aslam\\Atif Aslam - Tera Hone Laga Hoon.flac', 'flac'),
    hit('u7', 'Bollywood Hits\\Shreya Ghoshal - Sun Raha Hai Na Tu.mp3', 'mp3'),
    hit('u8', 'Bollywood\\Lata Mangeshkar\\Lata Mangeshkar - Lag Ja Gale.flac', 'flac'),
  ],
};
let searches = [];
const ia = (creator, title, songs) => ({ title, creator, image: null, subjects: ['pop', 'rock'], tracks: songs.map((n, i) => ({ uri: `ia:${creator}:${n}`, url: `https://archive.org/download/x/${i}.flac`, name: n, artist: creator, duration: 200, format: 'Flac', number: i + 1 })) });
const backend = {
  library_load: () => ({ liked: [], albums: [], playlists: [], recent: [] }),
  local_get: () => ({ folders: [], tracks: [] }),
  slsk_status: () => ({ state: 'online' }),
  slsk_search: ({ query }) => { searches.push(query); return query; },
  slsk_results: ({ token }) => ({ hits: SLSK[token.toLowerCase()] || [], done: true }),
  ia_search: ({ term }) => [{ id: term }],
  ia_item: ({ id }) => (/jack/i.test(id) ? ia('Jack Johnson', 'Jack Johnson Live at Bonnaroo', ['Same Girl', 'Sitting, Waiting, Wishing']) : ia('Snake Oil Medicine Show', 'Live at the Grey Eagle', ['Burying Ground'])),
  ia_subject: () => [{ id: 'snake' }],
  ia_shelf: () => [{ id: 'snake' }],
  commons_search: () => [],
};
const ctx = {
  console, Math, Date, JSON, Promise, Map, Set, Error, Object, Array, String, Number, RegExp, Symbol, performance,
  setTimeout: (f) => { queueMicrotask(f); return 0; }, clearTimeout: () => {}, setInterval: () => 0,
  localStorage: { getItem: () => null, setItem: () => {} },
  document: any, addEventListener: () => {}, innerWidth: 1200, innerHeight: 800, Image: function () { return any; }, Node: function () {},
  getComputedStyle: () => any,
  icon: () => any, hydrateIcons: () => {}, loadLogo: async () => {}, playIntro: () => {}, introPrefs: {},
};
ctx.window = ctx;
ctx.__TAURI__ = {
  core: { invoke: async (cmd, args) => { if (!backend[cmd]) return null; return backend[cmd](args || {}); }, convertFileSrc: (p) => p },
  window: { getCurrentWindow: () => any }, dialog: {},
};
vm.createContext(ctx);
for (const f of ['app.js', 'soulseek.js', 'recommend.js']) vm.runInContext(readFileSync(`${UI}/${f}`, 'utf8'), ctx, { filename: f });
await new Promise((r) => setTimeout(r, 50));

const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) process.exitCode = 1; };
const run = (code) => vm.runInContext(code, ctx);

// detection
const det = run(`[
  ['Tum Hi Ho', ['Arijit Singh']], ['Kabhi Jo Badal Barse', ['Arijit Singh']], ['Jaan Abhi Baaki Hai', ['Sangeet Wala']],
  ['Satranga (From "Animal")', ['Arijit Singh']], ['Same Girl', ['Jack Johnson']], ['Ain\\'t No Sunshine', ['John Mayer']],
  ['Burying Ground', ['Snake Oil Medicine Show']], ['तुम ही हो', ['अरिजीत सिंह']],
].map(([name, a]) => [name, detectLanguage({ name, artists: a.map((n) => ({ name: n })) })])`);
console.log(det);
const want = { 'Tum Hi Ho': 'hi', 'Kabhi Jo Badal Barse': 'hi', 'Jaan Abhi Baaki Hai': 'hi', 'Satranga (From "Animal")': null, 'Same Girl': 'en', "Ain't No Sunshine": 'en', 'Burying Ground': null, 'तुम ही हो': 'hi' };
check(det.every(([n, l]) => want[n] === l), 'language of titles: Hindi (romanized and Devanagari), English, unknown');

// the situation from the screenshot: Arijit Singh playing, Jack Johnson in your taste, Arijit skipped once
const picks = await run(`
  const tum = { ...slskTrack(${JSON.stringify(hit('u0', 'Music\\Arijit Singh\\King Of Bollywood\\1. Tum Hi Ho.flac', 'flac'))}), name: 'Tum Hi Ho', artists: [{ name: 'Arijit Singh' }], tags: ['pop'], tagged: true };
  LIB.data.recent = [tum, { uri: 'ia:jj:same', name: 'Same Girl', artists: [{ name: 'Jack Johnson' }], tags: ['pop'] }, { uri: 'x:kabhi', name: 'Kabhi Jo Badal Barse', artists: [{ name: 'Arijit Singh' }], tags: [] }];
  LIB.data.taste = { artists: { 'jack johnson': 1.6, 'arijit singh': -0.8 }, tags: { pop: 1 }, skips: {} };
  Q.list = [tum]; Q.i = 0; Q.radioSeen = new Set([tum.uri]);
  recommend(8).then((r) => r.map((t) => ({ name: t.name, artists: names(t.artists), from: t.slsk ? 'soulseek ' + t.slsk.user : t.source, lang: languages([t])(t) })));
`);
console.log('searched Soulseek for:', searches);
console.log('picks after Tum Hi Ho:', picks);
check(picks.length >= 3, `Autoplay still has songs to play (${picks.length})`);
check(!picks.some((p) => /Jack Johnson|Snake Oil|John Mayer/.test(p.artists)), 'no English-language artists after a Hindi song');
check(picks.some((p) => p.artists === 'Arijit Singh') && picks.some((p) => p.artists && p.artists !== 'Arijit Singh'), 'Arijit Singh plus other Bollywood artists');
check(!picks.some((p) => /Tum Hi Ho/.test(p.name)), 'not the song that is playing');
check(searches.includes('bollywood'), 'searched Soulseek for more Bollywood');

// and the other way round: an English session gets no Hindi songs
searches = [];
const en = await run(`
  const sg = { uri: 'ia:jj:same2', source: 'ia', src: { kind: 'url', value: 'https://archive.org/download/x/9.flac' }, name: 'Same Girl', artists: [{ name: 'Jack Johnson' }], tags: ['pop'], album: { key: 'ia:jack', name: 'Jack Johnson Live at Bonnaroo' } };
  SLSK_CANDIDATES.clear(); LIB.data.recent = [sg]; LIB.data.taste = { artists: { 'arijit singh': 2 }, tags: {}, skips: {} };
  Q.list = [sg]; Q.i = 0; Q.radioSeen = new Set([sg.uri]);
  recommend(8).then((r) => r.map((t) => ({ name: t.name, artists: names(t.artists), lang: languages([t])(t) })));
`);
console.log('searched Soulseek for:', searches);
console.log('picks after Same Girl:', en);
check(en.length >= 1 && !en.some((p) => p.lang && p.lang !== 'en'), 'English session: no songs known to be in another language');
