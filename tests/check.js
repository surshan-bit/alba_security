// Pre-publish check: build, syntax, lint, then the regression harness compared with tests/golden.json.
// Usage: node tests/check.js            run everything, exit 1 on any difference
//        node tests/check.js --update   accept the current behaviour as the new golden (after reviewing the differences)
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path');
// The app works on India time (market hours, week and month starts), so every test runs on India time whatever machine it is on.
process.env.TZ = 'Asia/Kolkata';
const root = path.resolve(__dirname, '..'), out = path.join(__dirname, 'out');
// --live: test the published build as it is (app.js, chunks/, styles.css, index.html). Use this while src/ is behind the published build:
// it skips the build-from-src and lint steps, which would otherwise rebuild the files from the older sources.
const LIVE = process.argv.includes('--live');
const step = (title, cmd, args) => {
  process.stdout.write('== ' + title + '\n');
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if(r.status !== 0){ console.error('\nFAILED: ' + title); process.exit(1); }
};
if(!LIVE){ step('build app.js, chunks/ and styles.css from src/ and styles/', 'node', ['tools/build.js']); step('built files are up to date', 'node', ['tools/build.js', '--check']); }
step('syntax check js/loader.js', 'node', ['--check', 'js/loader.js']);
{ // app.js and chunks/ are ES modules (node --check reads .js as CommonJS), so parse them as modules
  const espree = require('espree'); process.stdout.write('== syntax check app.js and chunks/ (as modules)\n');
  const built = ['app.js'].concat(fs.readdirSync(path.join(root, 'chunks')).map(f => 'chunks/' + f));
  for(const f of built){ try { espree.parse(fs.readFileSync(path.join(root, f), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }); } catch(e){ console.error('\nFAILED: syntax check ' + f + ': ' + e.message); process.exit(1); } }
}
if(!LIVE) step('lint src/', 'node', ['tools/lint.js', '--strict']);
if(!LIVE) step('type check of src/ (TypeScript checkJs; no new findings vs tests/types.baseline.txt)', 'node', ['tools/typecheck.js']);
fs.rmSync(out, { recursive: true, force: true });
step('engine unit tests (CSV import engines)', 'node', process.argv.includes('--update') ? ['tests/engines.js', '--update'] : ['tests/engines.js']);
step('alba-screener Worker tests (pretend Screener, no network)', 'node', ['--test', 'screener-worker/test/worker.test.js']);
step('regression harness', 'node', ['tests/run.js', '.', out]);
step('browser smoke test (Chromium; skipped if Playwright is missing)', 'node', ['tests/browser.js']);
step('state tests in Chromium (pins, Trade Log; skipped if Playwright is missing)', 'node', ['tests/state.js']);
step('live ticker in Chromium (price, MoS, W% CHG, M% CHG; skipped if Playwright is missing)', 'node', ['tests/ticker.js']);
step('refresh menus, tiers, resume and Analysis counts in Chromium (skipped if Playwright is missing)', 'node', ['tests/refresh.js']);
step('import flows in Chromium (upload, import, backup, restore, watchlist sync; skipped if Playwright is missing)', 'node', ['tests/imports.js']);
const now = JSON.parse(fs.readFileSync(path.join(out, '_index.json'), 'utf8'));

// ---- readable differences: the text behind each golden hash is kept (compressed) in tests/golden-text.json.gz, so a mismatch can show
// what changed instead of only which snapshot. The page text of a snapshot is tests/out/<name>.txt.
const textFile = path.join(__dirname, 'golden-text.json.gz');
function writeTextBaseline(names){
  const o = {};
  names.forEach(k => { const f = path.join(out, k + '.txt'); if(fs.existsSync(f)) o[k] = fs.readFileSync(f, 'utf8'); });
  fs.writeFileSync(textFile, require('zlib').gzipSync(JSON.stringify(o)));
}
function loadTextBaseline(){ try { return JSON.parse(require('zlib').gunzipSync(fs.readFileSync(textFile)).toString('utf8')); } catch(e){ return {}; } }
function showDiff(name, before, after){
  const a = before.split('\n'), b = after.split('\n');
  let i = 0; while(i < a.length && i < b.length && a[i] === b[i]) i++;
  let ea = a.length, eb = b.length; while(ea > i && eb > i && a[ea - 1] === b[eb - 1]){ ea--; eb--; }
  const cut = (l) => (l.length > 220 ? l.slice(0, 220) + '…' : l);
  console.error('\n--- ' + name + ' (line ' + (i + 1) + ': ' + (ea - i) + ' line(s) before, ' + (eb - i) + ' after)');
  a.slice(i, Math.min(ea, i + 6)).forEach(l => console.error('  - ' + cut(l)));
  b.slice(i, Math.min(eb, i + 6)).forEach(l => console.error('  + ' + cut(l)));
}
const goldenFile = path.join(__dirname, 'golden.json');
if(process.argv.includes('--update')){
  fs.writeFileSync(goldenFile, JSON.stringify(now, null, 1) + '\n');
  writeTextBaseline(Object.keys(now));
  console.log('golden.json updated (' + Object.keys(now).length + ' snapshots)');
  process.exit(0);
}
const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
const names = new Set([...Object.keys(golden), ...Object.keys(now)]);
const diffs = [...names].filter(k => golden[k] !== now[k]);
if(diffs.length){
  console.error('\n' + diffs.length + ' snapshot(s) differ from tests/golden.json:');
  diffs.forEach(k => console.error('  ' + k + (golden[k] === undefined ? '  (new)' : now[k] === undefined ? '  (missing)' : '')));
  const before = loadTextBaseline();
  diffs.slice(0, 12).forEach(k => {
    const f = path.join(out, k + '.txt');
    if(before[k] !== undefined && fs.existsSync(f)) showDiff(k, before[k], fs.readFileSync(f, 'utf8'));
    else if(fs.existsSync(f)) console.error('\n--- ' + k + ': no stored text to compare with');
  });
  console.error('\nThe new snapshots are in tests/out/. If the change is intended, run "npm run update-golden".');
  console.error('The first lines that changed are shown above (the text behind each golden hash is in tests/golden-text.json.gz).');
  process.exit(1);
}
console.log('\nOK: ' + Object.keys(now).length + ' snapshots match tests/golden.json');
