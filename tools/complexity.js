// The size limits of CLAUDE.md section 1, measured on a parsed module: a function is at most 40 lines, takes at most 4 parameters (more: an options
// object) and nests control flow at most 3 levels. Pure: takes an ESTree (with loc) and returns counts, so tools/lint.js can ratchet them and tests can check it.
const estraverse = require('estraverse');

const MAX_LINES = 40, MAX_PARAMS = 4, MAX_NESTING = 3;
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const CONTROL = new Set(['IfStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement']);

/** The deepest nesting of control flow inside a function body (nested functions are measured on their own). */
function nestingDepth(body){
  let deepest = 0;
  (function walk(node, depth){
    if(!node || typeof node !== 'object') return;
    if(Array.isArray(node)){ node.forEach(child => walk(child, depth)); return; }
    const here = CONTROL.has(node.type) ? depth + 1 : depth;
    if(here > deepest) deepest = here;
    for(const key of Object.keys(node)){
      if(key === 'loc' || key === 'range' || key === 'type') continue;
      const child = node[key];
      if(child && FUNCTIONS.has(child.type)) continue;
      walk(child, here);
    }
  })(body, 0);
  return deepest;
}

/**
 * @param {object} ast an ESTree with loc
 * @returns {{ functions: number, tooLong: number, tooManyParams: number, tooDeep: number }}
 */
function measure(ast){
  const found = { functions: 0, tooLong: 0, tooManyParams: 0, tooDeep: 0 };
  estraverse.traverse(ast, { enter(node){
    if(!FUNCTIONS.has(node.type)) return;
    found.functions++;
    if(node.loc.end.line - node.loc.start.line + 1 > MAX_LINES) found.tooLong++;
    if(node.params.length > MAX_PARAMS) found.tooManyParams++;
    if(nestingDepth(node.body) > MAX_NESTING) found.tooDeep++;
  } });
  return found;
}

module.exports = { measure, nestingDepth, MAX_LINES, MAX_PARAMS, MAX_NESTING };
