// Loads a module from src/ into Node without touching it: bundles it with esbuild and runs it. `extra` is appended to the
// source first, which is how the tests reach an engine object that the module keeps private (e.g. `export { FundEngine };`).
// loadWithStubs() is the async version (esbuild plugins need it). `stubs` replaces imported modules by tiny stand-ins, { 'core/store.js': 'export const allTrades = () => [];' }, for modules whose
// imports reach the page at start-up (core/store.js, list/metrics.js): the logic under test runs, the page does not.
const fs = require('fs'), path = require('path'), esbuild = require('esbuild');
const root = path.resolve(__dirname, '..', '..');
function stubPlugin(stubs){
  return { name: 'stubs', setup(b){
    b.onResolve({ filter: /.*/ }, a => {
      const hit = Object.keys(stubs).find(k => a.path.endsWith('/' + k) || a.path === k);
      return hit ? { path: hit, namespace: 'stub' } : null;
    });
    b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: stubs[a.path], loader: 'js' }));
  } };
}
const COVER = !!process.env.ALBA_COVERAGE;   // tools/coverage.js: bundles carry a source map and run from a file, so V8 coverage maps back to src/
let seq = 0;
const options = (file, extra) => ({ stdin: { contents: fs.readFileSync(path.join(root, file), 'utf8') + '\n' + (extra || ''), resolveDir: path.dirname(path.join(root, file)), sourcefile: path.join(root, file) }, bundle: true, format: 'cjs', write: false, logLevel: 'silent', sourcemap: COVER ? 'inline' : false, sourcesContent: false, sourceRoot: root + '/' });
const run = res => {
  const m = { exports: {} };
  if(!COVER){ new Function('module', 'exports', res.outputFiles[0].text)(m, m.exports); return m.exports; }
  const dir = path.join(root, 'node_modules', '.cache', 'alba-coverage'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'bundle' + (seq++) + '.cjs'); fs.writeFileSync(f, res.outputFiles[0].text);
  return require(f);
};
function load(file, extra){ return run(esbuild.buildSync(options(file, extra))); }
async function loadWithStubs(file, extra, stubs){ return run(await esbuild.build(Object.assign(options(file, extra), { plugins: [stubPlugin(stubs)] }))); }
module.exports = { load, loadWithStubs, root };
