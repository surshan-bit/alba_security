// The rule editor: one row per rule (field, operator, value) plus an "add a rule" picker. Rows show how many stocks
// pass that rule on its own, which makes it easy to see which rule is doing the filtering.
import { escapeHtml } from '../core/util.js';
import { stocks } from '../core/stocks.js';
import { FIELDS, FIELD_BY_ID } from './fields.js';
import { OPS, defaultRule, isNum, ruleReady, testRule, withOp } from './rules.js';
import { saveStrategies } from './state.js';

function fieldOptions(selected){
  const groups = [];
  FIELDS.forEach(f => {
    let g = groups.find(x => x.name === f.group);
    if(!g){ g = { name: f.group, items: [] }; groups.push(g); }
    g.items.push(f);
  });
  return groups.map(g => `<optgroup label="${escapeHtml(g.name)}">${g.items.map(f => `<option value="${f.id}"${f.id === selected ? ' selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}</optgroup>`).join('');
}
const numVal = (v) => (isNum(v) ? String(v) : '');

function valueHtml(rule, f){
  if(f.type === 'enum'){
    const opts = f.noneLabel ? f.options.concat([['none', f.noneLabel, 'none']]) : f.options;
    return `<span class="sr-opts">${opts.map(([v, label, tone]) => `<button type="button" class="sr-opt"${tone ? ` data-tone="${tone}"` : ''} data-v="${v}" aria-pressed="${rule.value.includes(v)}">${escapeHtml(label)}</button>`).join('')}</span>`;
  }
  if(f.type === 'text') return `<input type="text" class="sr-v1 sr-text" value="${escapeHtml(rule.value)}" placeholder="part of the name" aria-label="${escapeHtml(f.label)} text">`;
  const unit = f.unit ? `<span class="sr-unit">${escapeHtml(f.unit.trim())}</span>` : '';
  if(rule.op === 'between'){
    return `<input type="number" step="any" class="sr-v1" value="${numVal(rule.value[0])}" aria-label="From"><span class="sr-and">and</span><input type="number" step="any" class="sr-v2" value="${numVal(rule.value[1])}" aria-label="To">${unit}`;
  }
  return `<input type="number" step="any" class="sr-v1" value="${numVal(rule.value)}" aria-label="Value">${unit}`;
}

function ruleRowHtml(rule, i){
  const f = FIELD_BY_ID.get(rule.field);
  const ops = OPS[f.type];
  let tail;
  if(!ruleReady(rule)) tail = `<span class="sr-count sr-incomplete" title="Fill in a value for this rule to apply it">not applied yet</span>`;
  else {
    const n = stocks.filter(s => testRule(s, rule).pass).length;
    tail = `<span class="sr-count" title="Stocks that pass this rule on its own">${n} pass</span>`;
  }
  return `<div class="sr-row" data-i="${i}">
      <select class="sr-field" aria-label="Field">${fieldOptions(rule.field)}</select>
      <select class="sr-op" aria-label="Condition"${ops.length === 1 ? ' disabled' : ''}>${ops.map(([v, label]) => `<option value="${v}"${v === rule.op ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <span class="sr-val">${valueHtml(rule, f)}</span>
      ${tail}
      <button type="button" class="sr-del" aria-label="Remove this rule" title="Remove this rule">&times;</button>
    </div>`;
}

function rulesEditorHtml(strategy){
  const rows = strategy.rules.length
    ? strategy.rules.map(ruleRowHtml).join('')
    : `<div class="strat-empty">No rules yet, so every stock qualifies. Add a rule below.</div>`;
  return `<div class="sr-rules">${rows}</div>
    <select class="sr-add" aria-label="Add a rule"><option value="">+ Add a rule&hellip;</option>${fieldOptions('')}</select>`;
}

// One set of listeners on the section, using whichever strategy is selected at the time.
function wireRulesEditor(root, getStrategy, onChange){
  const commit = () => { const st = getStrategy(); if(st) st.learned = ''; saveStrategies(); onChange(); };
  const rowOf = (el) => { const row = el.closest('.sr-row'); return row ? Number(row.dataset.i) : -1; };
  root.addEventListener('change', (e) => {
    const st = getStrategy(); if(!st) return;
    const t = e.target;
    if(t.classList.contains('sr-add')){
      if(t.value){ st.rules.push(defaultRule(t.value)); commit(); }
      return;
    }
    const i = rowOf(t); if(i < 0) return;
    const rule = st.rules[i];
    if(t.classList.contains('sr-field')){ st.rules[i] = defaultRule(t.value); commit(); }
    else if(t.classList.contains('sr-op')){ st.rules[i] = withOp(rule, t.value); commit(); }
    else if(t.classList.contains('sr-v1') || t.classList.contains('sr-v2')){
      if(FIELD_BY_ID.get(rule.field).type === 'text') rule.value = t.value;
      else {
        const v = t.value.trim() === '' ? null : Number(t.value);
        const val = isNum(v) ? v : null;
        if(rule.op === 'between') rule.value = t.classList.contains('sr-v1') ? [val, rule.value[1]] : [rule.value[0], val];
        else rule.value = val;
      }
      commit();
    }
  });
  root.addEventListener('click', (e) => {
    const st = getStrategy(); if(!st) return;
    const del = e.target.closest('.sr-del');
    if(del){ const i = rowOf(del); if(i >= 0){ st.rules.splice(i, 1); commit(); } return; }
    const opt = e.target.closest('.sr-opt');
    if(opt){
      const i = rowOf(opt); if(i < 0) return;
      const list = st.rules[i].value, v = opt.dataset.v;
      const k = list.indexOf(v);
      if(k >= 0) list.splice(k, 1); else list.push(v);
      commit();
    }
  });
}

export { rulesEditorHtml, wireRulesEditor };
