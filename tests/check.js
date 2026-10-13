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
fs.rmSync(out, { recursive: true, force: true });
step('engine unit tests (CSV import engines)', 'node', process.argv.includes('--update') ? ['tests/engines.js', '--update'] : ['tests/engines.js']);
step('regression harness', 'node', ['tests/run.js', '.', out]);
step('browser smoke test (Chromium; skipped if Playwright is missing)', 'node', ['tests/browser.js']);
step('state tests in Chromium (pins, Trade Log; skipped if Playwright is missing)', 'node', ['tests/state.js']);
step('live ticker in Chromium (price, MoS, W% CHG, M% CHG; skipped if Playwright is missing)', 'node', ['tests/ticker.js']);
step('refresh menus, tiers, resume and Analysis counts in Chromium (skipped if Playwright is missing)', 'node', ['tests/refresh.js']);
step('import flows in Chromium (upload, import, backup, restore, watchlist sync; skipped if Playwright is missing)', 'node', ['tests/imports.js']);
const now = JSON.parse(fs.readFileSync(path.join(out, '_index.json'), 'utf8'));
const goldenFile = path.join(__dirname, 'golden.json');
if(process.argv.includes('--update')){
  fs.writeFileSync(goldenFile, JSON.stringify(now, null, 1) + '\n');
  console.log('golden.json updated (' + Object.keys(now).length + ' snapshots)');
  process.exit(0);
}
const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
const names = new Set([...Object.keys(golden), ...Object.keys(now)]);
const diffs = [...names].filter(k => golden[k] !== now[k]);
if(diffs.length){
  console.error('\n' + diffs.length + ' snapshot(s) differ from tests/golden.json:');
  diffs.forEach(k => console.error('  ' + k + (golden[k] === undefined ? '  (new)' : now[k] === undefined ? '  (missing)' : '')));
  console.error('\nThe new snapshots are in tests/out/. If the change is intended, run "npm run update-golden".');
  console.error('To see what changed, run the harness on the previous version (node tests/run.js <old project dir> <dir>) and diff the two folders.');
  process.exit(1);
}
console.log('\nOK: ' + Object.keys(now).length + ' snapshots match tests/golden.json');
