// Rule evaluation. A rule is { field, op, value }:
//   number fields: >= <= > <  (value is a number) or between (value is [low, high])
//   choice fields: in         (value is a list of the allowed choices)
//   text fields:   contains   (value is text)
// A choice field with a `noneLabel` also offers the choice 'none': stocks that have no reading for it.
// A rule that is not filled in yet is ignored. A stock with no reading for the field fails the rule.
import { FIELD_BY_ID } from './fields.js';

const OPS = {
  num: [['>=', 'at least'], ['<=', 'at most'], ['>', 'above'], ['<', 'below'], ['between', 'between']],
  enum: [['in', 'is any of']],
  text: [['contains', 'contains']]
};
const isNum = (v) => typeof v === 'number' && isFinite(v);

function defaultRule(fieldId){
  const f = FIELD_BY_ID.get(fieldId);
  if(f.type === 'enum') return { field: fieldId, op: 'in', value: [] };
  if(f.type === 'text') return { field: fieldId, op: 'contains', value: '' };
  return { field: fieldId, op: '>=', value: null };
}
// Keep the value's shape in step with the operator after the operator is changed.
function withOp(rule, op){
  if(op === 'between') return { ...rule, op, value: [isNum(rule.value) ? rule.value : null, null] };
  return { ...rule, op, value: Array.isArray(rule.value) ? (isNum(rule.value[0]) ? rule.value[0] : null) : rule.value };
}
function ruleReady(rule){
  const f = FIELD_BY_ID.get(rule.field);
  if(!f) return false;
  if(f.type === 'enum') return Array.isArray(rule.value) && rule.value.length > 0;
  if(f.type === 'text') return typeof rule.value === 'string' && rule.value.trim() !== '';
  if(rule.op === 'between') return Array.isArray(rule.value) && isNum(rule.value[0]) && isNum(rule.value[1]);
  return isNum(rule.value);
}
// -> { pass, value, missing } for one stock.
function testRule(s, rule){
  const f = FIELD_BY_ID.get(rule.field);
  const value = f.get(s);
  if(value === null || value === undefined){
    if(rule.op === 'in' && f.noneLabel && rule.value.includes('none')) return { pass: true, value: null, missing: false };
    return { pass: false, value: null, missing: true };
  }
  let pass;
  switch(rule.op){
    case '>=': pass = value >= rule.value; break;
    case '<=': pass = value <= rule.value; break;
    case '>': pass = value > rule.value; break;
    case '<': pass = value < rule.value; break;
    case 'between': pass = value >= Math.min(...rule.value) && value <= Math.max(...rule.value); break;
    case 'in': pass = rule.value.includes(value); break;
    case 'contains': pass = String(value).toLowerCase().includes(rule.value.trim().toLowerCase()); break;
    default: pass = false;
  }
  return { pass, value, missing: false };
}
// Every ready rule must pass.
function evaluateStock(s, rules){
  const results = rules.filter(ruleReady).map(rule => ({ rule, ...testRule(s, rule) }));
  return { pass: results.every(r => r.pass), results };
}
function qualifyingStocks(universe, rules){
  return universe.filter(s => evaluateStock(s, rules).pass);
}

function formatValue(f, v){
  if(v === 'none' && f.noneLabel) return f.noneLabel;
  if(v === null || v === undefined) return '—';
  if(f.type === 'num') return Number(v).toFixed(f.dp) + (f.unit || '');
  if(f.type === 'enum'){ const o = f.options.find(x => x[0] === v); return o ? o[1] : String(v); }
  return String(v);
}
function describeRule(rule){
  const f = FIELD_BY_ID.get(rule.field);
  const unit = f.unit || '';
  if(f.type === 'enum') return `${f.label} is ${rule.value.map(v => formatValue(f, v)).join(' or ')}`;
  if(f.type === 'text') return `${f.label} contains "${rule.value.trim()}"`;
  if(rule.op === 'between') return `${f.label} between ${rule.value[0]} and ${rule.value[1]}${unit}`;
  const word = { '>=': 'at least', '<=': 'at most', '>': 'above', '<': 'below' }[rule.op];
  return `${f.label} ${word} ${rule.value}${unit}`;
}

export { OPS, defaultRule, describeRule, evaluateStock, formatValue, isNum, qualifyingStocks, ruleReady, testRule, withOp };
