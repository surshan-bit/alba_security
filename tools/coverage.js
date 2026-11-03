// Unit-test coverage of src/ (CLAUDE.md section 5).
//   node tools/coverage.js                    run the unit tests (tests/engines.js) under c8, print the totals, fail if they fell below tools/coverage-ratchet.json
//   node tools/coverage.js --update           write the current totals as the new floor (do this when coverage went up)
//   node tools/coverage.js --changed[=<ref>]  also fail if any executable line this branch added or changed in src/ (against <ref>, default origin/main) is not covered
// How it works: with ALBA_COVERAGE=1 tests/lib/load.js bundles each module with a source map and runs it from a file, so V8's coverage maps back to
// src/. Every file in src/ counts (--all), loaded or not. Only tests/engines.js is measured: the jsdom and Chromium suites run the minified build,
// whose coverage cannot be mapped back yet, so a module they alone cover shows as uncovered here.
const { spawnSync, execFileSync } = require('child_process'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'tests', 'out', 'coverage'), ratchetFile = path.join(__dirname, 'coverage-ratchet.json');
const args = process.argv.slice(2), changedArg = args.find(a => a === '--changed' || a.startsWith('--changed='));
const KINDS = ['lines', 'branches', 'functions'];

fs.rmSync(out, { recursive: true, force: true });
const run = spawnSync(path.join(root, 'node_modules', '.bin', 'c8'), [
  '--all', '--src=src', '--include=src/**', '--exclude-after-remap', '--reporter=json', '--reporter=json-summary', '--reports-dir=' + out,
  'node', 'tests/engines.js'
], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { ALBA_COVERAGE: '1', TZ: 'Asia/Kolkata' }) });
if (run.status !== 0) { console.error(run.stdout + run.stderr); console.error('coverage: the unit tests failed, so there is no coverage to report'); process.exit(1); }

const summary = JSON.parse(fs.readFileSync(path.join(out, 'coverage-summary.json'), 'utf8')).total;
const now = Object.fromEntries(KINDS.map(k => [k, Math.floor(summary[k].pct * 100) / 100]));
console.log('coverage of src/ by unit tests: ' + KINDS.map(k => k + ' ' + now[k] + '% (' + summary[k].covered + '/' + summary[k].total + ')').join(', '));

let failed = false;
if (args.includes('--update')) {
  fs.writeFileSync(ratchetFile, JSON.stringify(now, null, 2) + '\n');
  console.log('coverage floor written to tools/coverage-ratchet.json');
} else {
  let floor = null;
  try { floor = JSON.parse(fs.readFileSync(ratchetFile, 'utf8')); } catch (e) { /* no floor recorded yet: run with --update */ }
  if (!floor) { console.error('coverage: no floor recorded; run node tools/coverage.js --update'); failed = true; }
  else for (const k of KINDS) {
    if (now[k] < floor[k]) { console.error('ERROR  coverage: ' + k + ' fell from ' + floor[k] + '% to ' + now[k] + '%. Add unit tests for the code you changed.'); failed = true; }
    else if (now[k] > floor[k]) console.log('coverage: ' + k + ' is up from ' + floor[k] + '% to ' + now[k] + '%: run node tools/coverage.js --update to lock it in');
  }
}

if (changedArg) {
  const base = changedArg.includes('=') ? changedArg.split('=')[1] : 'origin/main';
  const diff = execFileSync('git', ['diff', '-U0', '--no-color', base + '...HEAD', '--', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const added = new Map();   // file -> Set of added line numbers
  let file = null;
  for (const line of diff.split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { file = f[1]; continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) { const set = added.get(file) || added.set(file, new Set()).get(file); for (let i = 0; i < (h[2] === undefined ? 1 : +h[2]); i++) set.add(+h[1] + i); }
  }
  const detail = JSON.parse(fs.readFileSync(path.join(out, 'coverage-final.json'), 'utf8'));
  const byFile = new Map(Object.entries(detail).map(([p, d]) => [path.relative(root, p).split(path.sep).join('/'), d]));
  let executable = 0; const missed = [];
  for (const [f, lines] of added) {
    const d = byFile.get(f); if (!d || !f.endsWith('.js')) continue;
    const covered = new Map();   // line -> true when some statement starting on it ran
    for (const [id, loc] of Object.entries(d.statementMap)) covered.set(loc.start.line, (covered.get(loc.start.line) || false) || d.s[id] > 0);
    for (const n of [...lines].sort((a, b) => a - b)) if (covered.has(n)) { executable++; if (!covered.get(n)) missed.push(f + ':' + n); }
  }
  console.log('changed lines in src/: ' + executable + ' executable, ' + missed.length + ' not covered by a unit test');
  if (missed.length) { failed = true; console.error('ERROR  coverage: these added or changed lines have no unit test (CLAUDE.md section 5):\n  ' + missed.slice(0, 60).join('\n  ') + (missed.length > 60 ? '\n  ... and ' + (missed.length - 60) + ' more' : '')); }
}
process.exit(failed ? 1 : 0);
