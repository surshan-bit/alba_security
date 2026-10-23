// Type check of src/ with TypeScript's checkJs (no annotations needed: it infers from the code and from the DOM types).
//   node tools/typecheck.js            fails on any error that is not in tests/types.baseline.txt
//   node tools/typecheck.js --update   rewrites the baseline (review the diff first)
// `strict` is on (null checks, function types) with noImplicitAny off (3,000+ findings, mostly untyped event handlers). The baseline holds today's findings (mostly an element that getElementById may not find, and `catch (e)` being unknown: not bugs here), so the
// check catches NEW wrong names, wrong argument counts and wrong shapes without forcing a rewrite of working code. Lines numbers are not
// part of an entry, so editing a file does not make old findings look new.
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..'), base = path.join(root, 'tests', 'types.baseline.txt');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
if(!fs.existsSync(tsc)){
  console.log('typecheck: TypeScript is not installed (npm install); ' + (process.env.CI ? 'failing, because CI must run it' : 'skipped'));
  process.exit(process.env.CI ? 1 : 0);
}
const r = spawnSync(tsc, ['-p', root, '--pretty', 'false'], { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024 });
const found = (r.stdout + r.stderr).split('\n').filter(l => /error TS\d+/.test(l))
  .map(l => l.replace(/^([^(]+)\(\d+,\d+\): /, '$1: ')).sort();
const count = (arr) => { const m = new Map(); arr.forEach(x => m.set(x, (m.get(x) || 0) + 1)); return m; };
if(process.argv.includes('--update')){ fs.writeFileSync(base, found.join('\n') + '\n'); console.log('typecheck: baseline written (' + found.length + ' findings)'); process.exit(0); }
const known = count(fs.existsSync(base) ? fs.readFileSync(base, 'utf8').split('\n').filter(Boolean) : []), now = count(found);
const fresh = [];
for(const [k, n] of now){ const extra = n - (known.get(k) || 0); for(let i = 0; i < extra; i++) fresh.push(k); }
if(fresh.length){ console.log('typecheck: ' + fresh.length + ' new finding(s):\n  ' + fresh.slice(0, 40).join('\n  ')); process.exit(1); }
const gone = [...known].reduce((a, [k, n]) => a + Math.max(0, n - (now.get(k) || 0)), 0);
console.log('typecheck: no new findings (' + found.length + ' known' + (gone ? '; ' + gone + ' fixed since the baseline: run with --update to shrink it' : '') + ')');
