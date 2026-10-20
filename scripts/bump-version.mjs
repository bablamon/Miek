// Set Miek's version everywhere it lives: node scripts/bump-version.mjs 0.4.0
// (package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json)
import { readFileSync, writeFileSync } from 'node:fs';

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || '')) {
  console.error('usage: node scripts/bump-version.mjs <major.minor.patch>   e.g. 0.4.0');
  process.exit(1);
}
const edit = (path, fn) => {
  const before = readFileSync(path, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`nothing changed in ${path}`);
  writeFileSync(path, after);
  console.log(`  ${path}`);
};
const json = (path, fn) => edit(path, (s) => { const o = JSON.parse(s); fn(o); return JSON.stringify(o, null, 2) + '\n'; });

const old = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
if (old === v) { console.error(`Already at ${v}`); process.exit(1); }
console.log(`${old} → ${v}`);
edit('src-tauri/tauri.conf.json', (s) => s.replace(`"version": "${old}"`, `"version": "${v}"`));
json('package.json', (o) => { o.version = v; });
json('package-lock.json', (o) => { o.version = v; if (o.packages && o.packages['']) o.packages[''].version = v; });
edit('src-tauri/Cargo.toml', (s) => s.replace(/^(\[package\][^[]*?\nversion = ")[^"]+"/m, `$1${v}"`));
edit('src-tauri/Cargo.lock', (s) => s.replace(/(\[\[package\]\]\nname = "miek"\nversion = ")[^"]+"/, `$1${v}"`));
console.log(`
Next:
  git commit -am "Miek ${v}"
  git tag -a v${v} -m "What's new in ${v}: ..."
  git push origin main v${v}`);
