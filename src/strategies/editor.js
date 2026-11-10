// The rule editor: a table with one row per rule (field, condition, value, stocks passing, remove), column headings, an "add a rule" picker and
// a total of the stocks that pass all the rules together. Rows show how many stocks pass that rule on its own, which makes it easy to see which
// rule is doing the filtering. Removing a rule can be undone from the line under the table until the next change.
import { escapeHtml } from '../core/util.js';
import { stocks } from '../core/stocks.js';
import { FIELDS, FIELD_BY_ID } from './fields.js';
import { knownField } from './lookup.js';
import { OPS, defaultRule, describeRule, isNum, qualifyingStocks, ruleReady, testRule, withOp } from './rules.js';
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

const CHEV = (up) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}"/></svg>`;
const TRASH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
// The last rule removed, so "Undo" can put it back: { st, rule, i } (a later change of any kind clears it).
let undo = null;

function ruleRowHtml(rule, i, all){
  const f = knownField(FIELD_BY_ID, rule.field);
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
      <span class="sr-move"><button type="button" class="sr-up" aria-label="Move rule up" title="Move this rule up"${i === 0 ? ' disabled' : ''}>${CHEV(true)}</button><button type="button" class="sr-down" aria-label="Move rule down" title="Move this rule down"${i === all.length - 1 ? ' disabled' : ''}>${CHEV(false)}</button></span>
      <button type="button" class="sr-del" aria-label="Remove rule: ${escapeHtml(ruleReady(rule) ? describeRule(rule) : FIELD_BY_ID.get(rule.field)?.label || "")}" title="Remove this rule">${TRASH}</button>
    </div>`;
}

function rulesEditorHtml(strategy){
  const rows = strategy.rules.length
    ? strategy.rules.map((r, i, all) => ruleRowHtml(r, i, all)).join('')
    : `<div class="strat-empty">No rules yet, so every stock qualifies. Add a rule below.</div>`;
  const ready = strategy.rules.filter(ruleReady).length;
  const n = ready ? qualifyingStocks(stocks, strategy.rules).length : 0;
  const total = ready
    ? `${ready === strategy.rules.length ? 'All ' : ''}${ready} rule${ready === 1 ? '' : 's'}${ready === strategy.rules.length ? ' together' : ' applied'}: <b>${n} stock${n === 1 ? '' : 's'} pass</b>`
    : 'No rule applied yet, so every stock qualifies';
  const undoLine = undo && undo.st === strategy
    ? `<div class="sr-undo" role="status"><span>Removed &ldquo;${escapeHtml(ruleReady(undo.rule) ? describeRule(undo.rule) : (FIELD_BY_ID.get(undo.rule.field)?.label || 'rule'))}&rdquo;</span><button type="button" class="sr-undo-btn">Undo</button></div>` : '';
  const head = strategy.rules.length ? '<div class="sr-head" aria-hidden="true"><span>Field</span><span>Condition</span><span>Value</span><span title="Stocks that pass this rule on its own">Passing</span><span>Order</span><span></span></div>' : '';
  return `${head}<div class="sr-rules">${rows}</div>
    <div class="sr-foot"><select class="sr-add" aria-label="Add a rule"><option value="">Add a rule</option>${fieldOptions('')}</select><span class="sr-total">${total}</span></div>${undoLine}`;
}

const rowIndex = (el) => { const row = el.closest('.sr-row'); return row ? Number(row.dataset.i) : -1; };

// A typed value goes into the rule: text as it is, numbers as a number or empty, and a "between" rule keeps its other end.
function setRuleValue(rule, input){
  if(knownField(FIELD_BY_ID, rule.field).type === 'text'){ rule.value = input.value; return; }
  const v = input.value.trim() === '' ? null : Number(input.value), val = isNum(v) ? v : null;
  if(rule.op !== 'between'){ rule.value = val; return; }
  rule.value = input.classList.contains('sr-v1') ? [val, rule.value[1]] : [rule.value[0], val];
}
// A drop-down or input in the table changed. `commit` saves and redraws.
function onRuleChange(e, st, commit){
  const t = e.target;
  if(t.classList.contains('sr-add')){
    if(t.value){ st.rules.push(defaultRule(t.value)); commit(); }
    return;
  }
  const i = rowIndex(t); if(i < 0) return;
  if(t.classList.contains('sr-field')){ st.rules[i] = defaultRule(t.value); commit(); }
  else if(t.classList.contains('sr-op')){ st.rules[i] = withOp(st.rules[i], t.value); commit(); }
  else if(t.classList.contains('sr-v1') || t.classList.contains('sr-v2')){ setRuleValue(st.rules[i], t); commit(); }
}
// Moves a rule up or down, then puts keyboard focus on the same arrow at the rule's new place (or the other arrow when it ran out of room).
function moveRule(root, st, mv, commit){
  const up = mv.classList.contains('sr-up'), i = rowIndex(mv), j = up ? i - 1 : i + 1;
  if(i < 0 || j < 0 || j >= st.rules.length) return;
  [st.rules[i], st.rules[j]] = [st.rules[j], st.rules[i]];
  commit();
  const again = root.querySelector(`.sr-row[data-i="${j}"] ${up ? '.sr-up' : '.sr-down'}`) || root.querySelector(`.sr-row[data-i="${j}"] .sr-move button:not(:disabled)`);
  if(again) again.focus();
}
// Removes a rule, keeping it for the Undo line.
function deleteRule(st, del, commit){
  const i = rowIndex(del); if(i < 0) return;
  undo = { st, rule: st.rules[i], i }; st.rules.splice(i, 1); commit(true);
}
// Turns one choice of an "is one of" rule on or off.
function toggleOption(st, opt, commit){
  const i = rowIndex(opt); if(i < 0) return;
  const list = st.rules[i].value, v = opt.dataset.v, k = list.indexOf(v);
  if(k >= 0) list.splice(k, 1); else list.push(v);
  commit();
}
// A click in the table: Undo, a move arrow, delete or a choice button. First match wins.
function onRuleClick(e, root, st, commit){
  if(e.target.closest('.sr-undo-btn')){
    if(undo && undo.st === st){ st.rules.splice(Math.min(undo.i, st.rules.length), 0, undo.rule); undo = null; commit(); }
    return;
  }
  const mv = e.target.closest('.sr-up, .sr-down');
  if(mv && !mv.disabled){ moveRule(root, st, mv, commit); return; }
  const del = e.target.closest('.sr-del');
  if(del){ deleteRule(st, del, commit); return; }
  const opt = e.target.closest('.sr-opt');
  if(opt) toggleOption(st, opt, commit);
}
// One set of listeners on the section, using whichever strategy is selected at the time.
function wireRulesEditor(root, getStrategy, onChange){
  const commit = (keepUndo) => { const st = getStrategy(); if(st) st.learned = ''; if(!keepUndo) undo = null; saveStrategies(); onChange(); };
  root.addEventListener('change', (e) => { const st = getStrategy(); if(st) onRuleChange(e, st, commit); });
  root.addEventListener('click', (e) => { const st = getStrategy(); if(st) onRuleClick(e, root, st, commit); });
}

export { rulesEditorHtml, wireRulesEditor };
