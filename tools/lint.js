// Structural checks for src/ (what the old shared-scope code could not enforce):
//  1. every name a module uses is imported, declared, or a known browser/page global  (catches typos and missing imports)
//  2. start-up order: module-level code may only use imports from modules that are evaluated before it
//  3. no module-level declaration or export is unused                                    (catches dead code)
//  4. no exported let/var and no set_x exports: shared state goes through accessors / named actions (catches the old pattern)
// Usage: node tools/lint.js
const fs = require('fs'), path = require('path');
const espree = require('espree'), escope = require('eslint-scope'), estraverse = require('estraverse');
const root = path.resolve(__dirname, '..'), srcDir = path.join(root, 'src');
const GLOBALS = new Set(('AbortController Event Array Blob Float32Array Float64Array Int8Array Int32Array Uint8Array Boolean Date Error FileReader Infinity JSON Map Math IntersectionObserver MutationObserver NaN Number Object Promise ResizeObserver Set String TextEncoder URLSearchParams ' +
  'clearTimeout console decodeURIComponent document encodeURIComponent fetch history isFinite isNaN localStorage location navigator parseFloat parseInt requestAnimationFrame setTimeout undefined window ' +
  'WeakMap indexedDB performance setInterval clearInterval CustomEvent ' +
  'claude').split(' '));   // `claude` is the claude.ai page runtime; there are no other page-wide globals (identity and boot are modules in src/)
const files = []; (function walk(d){ for(const f of fs.readdirSync(d)){ const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); } })(srcDir);
const rel = p => path.relative(srcDir, p).split(path.sep).join('/');
let errors = 0, warnings = 0;
const err = m => { console.error('ERROR  ' + m); errors++; }, warn = m => { console.error('warn   ' + m); warnings++; };
const mods = new Map();
for(const f of files){
  const code = fs.readFileSync(f, 'utf8');
  const ast = espree.parse(code, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
  const sm = escope.analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const imports = ast.body.filter(n => n.type === 'ImportDeclaration').map(n => path.resolve(path.dirname(f), n.source.value));
  const dynImports = [];   // import('./x.js'): the module is loaded later, on demand (a separate chunk in the built page)
  estraverse.traverse(ast, { enter(n){ if(n.type === 'ImportExpression'){ if(n.source.type !== 'Literal') err(rel(f) + ':' + n.loc.start.line + ' import() needs a literal path (the build cannot split what it cannot see)'); else dynImports.push(path.resolve(path.dirname(f), n.source.value)); } } });
  mods.set(f, { ast, sm, imports, dynImports, mod: sm.globalScope.childScopes[0] });
}
// 1. unresolved names
for(const [f, m] of mods){
  for(const r of m.sm.globalScope.through){ if(!GLOBALS.has(r.identifier.name)) err(rel(f) + ':' + r.identifier.loc.start.line + ' uses undefined name "' + r.identifier.name + '" (missing import?)'); }
  for(const i of m.imports.concat(m.dynImports)) if(!mods.has(i)) err(rel(f) + ' imports a missing file ' + path.relative(srcDir, i));
}
// 2. evaluation order (ESM: depth-first over import declarations, in source order)
const order = [], seen = new Set();
const ev = f => { if(seen.has(f)) return; seen.add(f); for(const i of mods.get(f).imports) if(mods.has(i)) ev(i); order.push(f); };
const entry = path.join(srcDir, 'boot/start.js');   // the page's entry point; everything else is reached through it
const dynTargets = new Set();                         // modules that are only loaded on demand
{ const queue = [entry];
  while(queue.length){ ev(queue.shift()); for(const f of order) for(const d of mods.get(f).dynImports) if(mods.has(d) && !seen.has(d) && !queue.includes(d)){ queue.push(d); dynTargets.add(d); } } }
for(const f of mods.keys()) if(!seen.has(f)) err(rel(f) + ' is not reachable from boot/start.js (not imported by anything that runs)');
const pos = new Map(order.map((f, i) => [f, i]));
for(const [f, m] of mods){
  for(const v of m.mod.variables){
    if(!v.defs.length || v.defs[0].type !== 'ImportBinding') continue;
    const dep = path.resolve(path.dirname(f), v.defs[0].parent.source.value);
    for(const r of v.references){
      if(r.from.variableScope !== m.mod) continue;     // used inside a function: fine, runs later
      if(dep !== f && pos.get(dep) > pos.get(f)) err(rel(f) + ':' + r.identifier.loc.start.line + ' uses "' + v.name + '" at start-up but ' + rel(dep) + ' is evaluated after it');
    }
  }
}
// 3. unused declarations and exports
const importedNames = new Map();   // file -> Set(names imported by someone)
for(const [f, m] of mods){
  for(const n of m.ast.body) if(n.type === 'ImportDeclaration'){
    const dep = path.resolve(path.dirname(f), n.source.value);
    if(!importedNames.has(dep)) importedNames.set(dep, new Set());
    n.specifiers.forEach(s => importedNames.get(dep).add(s.imported ? s.imported.name : 'default'));
  }
}
for(const [f, m] of mods){
  const isRoot = f === entry || dynTargets.has(f);
  const exported = new Set();
  m.ast.body.forEach(n => { if(n.type === 'ExportNamedDeclaration' && !n.declaration) n.specifiers.forEach(s => exported.add(s.local.name)); else if(n.type === 'ExportNamedDeclaration' && n.declaration){ (n.declaration.declarations || [n.declaration]).forEach(d => exported.add(d.id.name)); } });
  for(const v of m.mod.variables){
    if(v.defs.length && v.defs[0].type === 'ImportBinding'){ if(!v.references.length) warn(rel(f) + ' imports "' + v.name + '" but never uses it'); continue; }
    if(!v.defs.length) continue;
    // 4. no exported mutable bindings: shared state is reached through accessor functions and named actions (see core/store.js)
    if(exported.has(v.name) && v.defs[0].type === 'Variable' && v.defs[0].parent.kind !== 'const') err(rel(f) + ' exports the mutable binding "' + v.name + '" (' + v.defs[0].parent.kind + '): keep it private and export a get' + v.name[0].toUpperCase() + v.name.slice(1) + '() accessor (and a named setter if other modules change it)');
    if(exported.has(v.name) && /^set_/.test(v.name)) err(rel(f) + ' exports "' + v.name + '": name setters setX / use a named action, not set_x');
    const used = v.references.some(r => !r.init);
    if(!used && !exported.has(v.name)) warn(rel(f) + ' "' + v.name + '" is declared but never used');
  }
  for(const n of exported) if(!isRoot && !(importedNames.get(f) || new Set()).has(n)) warn(rel(f) + ' exports "' + n + '" but no module imports it');
}
// 5. CSS: a selector with unbalanced brackets makes the browser swallow everything after it, so catch it here
for(const f of require('fs').readdirSync('styles').filter(x => x.endsWith('.css'))){
  const css = require('fs').readFileSync('styles/' + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for(const m of css.matchAll(/([^{}]*)\{[^{}]*\}/g)){
    let d = 0, bad = false;
    for(const c of m[1]){ if(c === '(') d++; else if(c === ')') d--; if(d < 0) bad = true; }
    if(bad || d !== 0) err('styles/' + f + ': unbalanced brackets in selector "' + m[1].trim().slice(0, 80) + '"');
  }
}
console.log('lint: ' + mods.size + ' modules, ' + errors + ' errors, ' + warnings + ' warnings');
process.exit(errors || (process.argv.includes('--strict') && warnings) ? 1 : 0);
