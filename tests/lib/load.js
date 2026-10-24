// Loads a module from src/ into Node without touching it: bundles it with esbuild and runs it. `extra` is appended to the
// source first, which is how the tests reach an engine object that the module keeps private (e.g. `export { FundEngine };`).
const fs = require('fs'), path = require('path'), esbuild = require('esbuild');
const root = path.resolve(__dirname, '..', '..');
function load(file, extra){
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const res = esbuild.buildSync({ stdin: { contents: src + '\n' + (extra || ''), resolveDir: path.dirname(path.join(root, file)), sourcefile: file }, bundle: true, format: 'cjs', write: false, logLevel: 'silent' });
  const m = { exports: {} };
  new Function('module', 'exports', res.outputFiles[0].text)(m, m.exports);
  return m.exports;
}
module.exports = { load, root };
