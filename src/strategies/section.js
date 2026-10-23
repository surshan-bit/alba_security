// The Strategies section: your list of strategies on the left; on the right the selected strategy's rules, the
// stocks that qualify today, and a lookup that explains why a given stock does or does not qualify.
// Drawn on demand (from showSection). Edits are saved straight away and redraw the right-hand side.
import { escapeHtml, tickerSymbol } from '../core/util.js';
import { stocks } from '../core/stocks.js';
import { appSections } from '../ui/navigation.js';
import { openStockInline } from '../ui/inlinedetail.js';
import { qualifyingStocks, ruleReady } from './rules.js';
import { addStrategy, deleteStrategy, duplicateStrategy, restoreStarters, saveStrategies, selectStrategy, selectedStrategy, strategies } from './state.js';
import { rulesEditorHtml, wireRulesEditor } from './editor.js';
import { orderedPicks, resultsHtml, setResultsSort, sortLabel, sortSelectHtml, whyDatalist, whyHtml } from './results.js';
import { sheetFrame } from '../ui/phonesheet.js';
import { cleanGoal } from './goal.js';
import { pcTickerKey } from '../prices/store.js';
import { kit } from '../refresh/kit.js';
import { forgetLearned, wireLearnPanel } from './learnpanel.js';
import { askConfirm } from '../ui/confirm.js';
import { renderTrackPanel, trackPanelHtml, wireTrackPanel } from './trackpanel.js';
import { getStrategiesStatus } from '../identity/strategies.js';
import { closestEl, targetEl } from '../core/evt.js';
import { keepScroll } from '../ui/scrollkeep.js';

let whyQuery = '';

function openStockFromStrategies(idx){
  openStockInline(appSections.strategies, 'Strategies', idx);
}

const readyRules = (st) => st.rules.filter(ruleReady);

let stratFiltersOpen = false;   // phones: the sort and the buttons above the picks sit in the Filters pop-up, closed at first
const folds = new Set();   // which collapsible blocks are open (kept across redraws)
// The picks in the order the table shows them: what a refresh works through.
const refreshList = (st) => orderedPicks(qualifyingStocks(stocks, st.rules));

const selected = new Set();   // symbols ticked in the results table (kept while you move between strategies)
const symOf = (s) => tickerSymbol(s);
// What is ticked on screen is the truth: bring the saved set in line with the visible tick boxes.
function syncSelected(){
  document.querySelectorAll('#stratResults tbody .strat-sel').forEach(b => { if(/** @type {HTMLInputElement} */ (b).checked) selected.add(/** @type {HTMLElement} */ (b).dataset.sym); else selected.delete(/** @type {HTMLElement} */ (b).dataset.sym); });
  const head = document.querySelector('#stratResults thead .strat-sel'), rows = document.querySelectorAll('#stratResults tbody .strat-sel');
  if(head) /** @type {HTMLInputElement} */ (head).checked = rows.length > 0 && Array.from(rows).every(b => /** @type {HTMLInputElement} */ (b).checked);
  return selected;
}
const trackLabel = (matches) => { const k = matches.filter(s => selected.has(symOf(s))).length; return k ? `Track ${k} ticked pick${k === 1 ? '' : 's'}` : 'Track these picks'; };
// Save status, shown beside the "Rules" heading: "Saving..." while a change is on its way, a brief "Saved" afterwards, and
// (kept on screen) a warning when it could not be saved to the account or when you are not signed in.
const SAVE_NOTE = { browser: ['Not signed in: saved in this browser only', 'warn'], saving: ['Saving&hellip;', ''], saved: ['&#10003; Saved to your account', 'ok'],
  failed: ['Could not save to your account (kept in this browser, will retry on your next change)', 'bad'] };
let flashSaved = false, prevStatus = '';
const saveNote = () => {
  const st = getStrategiesStatus();
  if(st === 'saved' && !flashSaved) return '';
  const n = SAVE_NOTE[st]; return n ? `<span class="strat-save-${n[1] || 'plain'}">${n[0]}</span>` : '';
};
let flashTimer = null;
function onSaveStatus(){
  const st = getStrategiesStatus();
  if(st === 'saved' && prevStatus === 'saving'){ flashSaved = true; clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashSaved = false; paintSaveNote(); }, 2500); }
  else if(st !== 'saved') flashSaved = false;
  prevStatus = st;
  paintSaveNote();
}
function paintSaveNote(){ const el = document.getElementById('stratSaveNote'); if(el) el.innerHTML = saveNote(); }
function listHtml(sel){
  const cards = strategies.map(st => {
    const n = qualifyingStocks(stocks, st.rules).length;
    return `<button type="button" class="strat-card${sel && st.id === sel.id ? ' active' : ''}" data-id="${escapeHtml(st.id)}">
        <span class="strat-card-name"><span class="strat-dot ${st.published ? 'on' : 'off'}" role="img" aria-label="${st.published ? 'Published' : 'Unpublished'}" title="${st.published ? 'Published' : 'Unpublished'}"></span>${escapeHtml(st.name)}</span>
        <span class="strat-card-n" title="Stocks that qualify now">${n}</span>
      </button>`;
  }).join('');
  return `${cards || '<div class="strat-empty">No strategies yet.</div>'}
    <button type="button" class="strat-new" id="stratNew">+ New strategy</button>
    <button type="button" class="strat-restore" id="stratRestore" title="Bring back the starter strategies, keeping your own">Restore starter strategies</button>`;
}

function mainHtml(st){
  if(!st) return `<div class="strat-empty">Create a strategy to get started.</div>`;
  const matches = qualifyingStocks(stocks, st.rules);
  const ignored = st.rules.length - readyRules(st).length;
  return `<div class="analysis-panel strat-panel">
      <details class="strat-fold strat-group" data-fold="setup"${folds.has('setup') ? ' open' : ''}>
        <summary class="analysis-panel-title strat-sub">Strategy setup <span class="strat-fold-sum">${escapeHtml(st.name)} &middot; ${st.published ? 'Published' : 'Unpublished'} &middot; gain at least ${st.goal.target}% within ${st.goal.days} days &middot; ${st.rules.length} rule${st.rules.length === 1 ? '' : 's'}</span> <span class="strat-save-note" id="stratSaveNote" aria-live="polite">${saveNote()}</span></summary>
        <div class="strat-section"><div class="strat-section-title">Strategy</div>
        <div class="strat-head">
          <input type="text" id="stratName" class="strat-name" value="${escapeHtml(st.name)}" aria-label="Strategy name" maxlength="60">
          <span class="strat-actions">
            <button type="button" class="strat-btn strat-pub${st.published ? ' on' : ''}" id="stratPub" aria-pressed="${st.published}" title="${st.published ? 'Shown in Explorer, Analysis and other screens. Click to unpublish.' : 'Hidden from Explorer, Analysis and other screens. Click to publish.'}">${st.published ? 'Published' : 'Unpublished'}</button>
            <button type="button" class="strat-btn" id="stratDup">Duplicate</button>
            <button type="button" class="strat-btn strat-btn-danger" id="stratDel">Delete</button>
          </span>
        </div>
        <input type="text" id="stratNote" class="strat-note" value="${escapeHtml(st.note)}" placeholder="A note about the idea behind this strategy (optional)" aria-label="Note" maxlength="200"></div>
        <div class="strat-section"><div class="strat-section-title">Goal</div>
        <div class="strat-goal">
          <span>Find stocks that can gain at least</span>
          <input type="number" id="goalTarget" class="strat-goal-in" min="0.5" max="100" step="0.5" value="${st.goal.target}" aria-label="Target gain in percent"><span>% within</span>
          <input type="number" id="goalDays" class="strat-goal-in" min="7" max="120" step="1" value="${st.goal.days}" aria-label="Number of days"><span>days.</span>
          <button type="button" class="strat-btn" id="stratLearn">Suggested Rules</button>
        </div></div>
        <div class="strat-section"><div class="strat-section-title">Rules <span class="strat-section-hint">a stock must pass all of them</span></div>
        ${st.learned ? `<div class="strat-learned">${escapeHtml(st.learned)}</div>` : ''}
        <div id="stratRules">${rulesEditorHtml(st)}</div></div>
      </details>
    </div>
    <div class="analysis-panel strat-panel">
      <div class="strat-result-head strat-filters-panel${stratFiltersOpen ? '' : ' filters-collapsed'}">
        <button type="button" class="biz-filters-toggle" data-strat-filters="1" aria-expanded="${stratFiltersOpen}"><span class="ft-label">Filters</span><span class="ft-summary">${escapeHtml('Sort: ' + sortLabel())}</span><span class="ft-caret" aria-hidden="true">&#9662;</span></button>
        <div class="strat-result-title"><span class="strat-count" aria-label="Qualifying stocks">Showing <b id="stratCount">${matches.length}</b> of ${stocks.length} stocks${ignored ? ` &middot; ${ignored} rule${ignored === 1 ? '' : 's'} not applied yet` : ''}</span></div>
        ${sheetFrame(`<div class="strat-total">${sortSelectHtml()}<button type="button" class="strat-btn" id="stratTrackBtn"${matches.length ? '' : ' disabled'} title="Save the ticked picks (or all of today's list when none is ticked) with their prices and judge them against the goal later">${trackLabel(matches)}</button>${(kit.defineScope('strat', { label: 'picks', source: 'strat', selName: 'strat', stocks: () => refreshList(st) }), kit.barHtml('strat'))}</div>`)}
      </div>
      <div id="stratResults">${resultsHtml(matches, selected)}</div>
      ${kit.selbarSlot('strat')}
    </div>
    ${trackPanelHtml()}
    <div class="analysis-panel strat-panel">
      <div class="analysis-panel-title">Why is a stock in or out?</div>
      <input type="text" id="stratWhy" class="strat-why-input" list="stratWhyList" value="${escapeHtml(whyQuery)}" placeholder="Type a stock symbol or name" aria-label="Stock to check" autocomplete="off">
      ${whyDatalist()}
      <div id="stratWhyOut">${whyHtml(whyQuery, st.rules)}</div>
    </div>`;
}

function renderStrategiesSection(){ keepScroll(document.getElementById('section-strategies'), drawStrategiesSection); }
function drawStrategiesSection(){
  const listEl = document.getElementById('stratList'), mainEl = document.getElementById('stratMain');
  if(!listEl || !mainEl) return;
  const sel = selectedStrategy();
  listEl.innerHTML = listHtml(sel);
  mainEl.innerHTML = mainHtml(sel);
  renderTrackPanel(sel);
}

function init_strategies_section(){
  kit.useExternalSelection('strat', () => new Set(stocks.filter(s => selected.has(symOf(s))).map(pcTickerKey)));
  document.addEventListener('alba-rk-clear', (e) => {
    if(!/** @type {CustomEvent} */ (e).detail || /** @type {CustomEvent} */ (e).detail.name !== 'strat') return;
    selected.clear();
    document.querySelectorAll('.strat-sel').forEach(b => { /** @type {HTMLInputElement} */ (b).checked = false; });
    const st = selectedStrategy(), tb = document.getElementById('stratTrackBtn');
    if(tb && st) tb.textContent = trackLabel(qualifyingStocks(stocks, st.rules));
  });
  window.addEventListener('alba-strategies-status', onSaveStatus);
  window.addEventListener('alba-strategies-reloaded', () => { if(document.getElementById('section-strategies').classList.contains('active')) renderStrategiesSection(); });
  const sec = document.getElementById('section-strategies');
  if(!sec) return;
  wireRulesEditor(sec, selectedStrategy, renderStrategiesSection);
  wireLearnPanel(sec, selectedStrategy, renderStrategiesSection);
  wireTrackPanel(sec, selectedStrategy, syncSelected);
  sec.addEventListener('toggle', (e) => {
    const d = /** @type {Element} */ (e.target).closest && closestEl(e, 'details.strat-fold');
    if(d){ if(/** @type {HTMLDetailsElement} */ (d).open) folds.add(d.dataset.fold); else folds.delete(d.dataset.fold); }
  }, true);
  sec.addEventListener('click', (e) => {
    if(closestEl(e, '[data-strat-filters]')){ stratFiltersOpen = !stratFiltersOpen; renderStrategiesSection(); return; }
    const card = closestEl(e, '.strat-card');
    if(card){ selectStrategy(card.dataset.id); renderStrategiesSection(); return; }
    if(closestEl(e, '#stratNew')){ addStrategy(); renderStrategiesSection(); return; }
    if(closestEl(e, '#stratRestore')){ restoreStarters(); renderStrategiesSection(); return; }
    const st = selectedStrategy();
    const tick = closestEl(e, '.strat-sel');
    if(tick){   // (a click on a tick box must not open the stock)
      const sym = tick.dataset.sym;
      if(sym === '*'){ const all = st ? qualifyingStocks(stocks, st.rules) : []; if(/** @type {HTMLInputElement} */ (tick).checked) all.forEach(s => selected.add(symOf(s))); else all.forEach(s => selected.delete(symOf(s))); document.querySelectorAll('.strat-sel').forEach(b => { /** @type {HTMLInputElement} */ (b).checked = /** @type {HTMLInputElement} */ (tick).checked; }); }
      else if(/** @type {HTMLInputElement} */ (tick).checked) selected.add(sym); else selected.delete(sym);
      syncSelected();
      const tb = document.getElementById('stratTrackBtn');
      if(tb && st) tb.textContent = trackLabel(qualifyingStocks(stocks, st.rules));
      kit.selectionChanged();
      return;
    }
    if(closestEl(e, '#stratPub') && st){ st.published = !st.published; saveStrategies(); renderStrategiesSection(); return; }
    if(closestEl(e, '#stratDup') && st){ duplicateStrategy(st); renderStrategiesSection(); return; }
    if(closestEl(e, '#stratDel') && st){
      askConfirm(`Delete the strategy "${st.name}"?`, 'Delete').then((yes) => { if(yes){ deleteStrategy(st); renderStrategiesSection(); } });
      return;
    }
    const row = closestEl(e, '.strat-row');
    if(row) openStockFromStrategies(Number(row.dataset.idx));
  });
  sec.addEventListener('keydown', (e) => {
    if(e.key !== 'Enter') return;
    const row = /** @type {Element} */ (e.target).closest && closestEl(e, '.strat-row');
    if(row) openStockFromStrategies(Number(row.dataset.idx));
  });
  // Text boxes save when you leave them. The name also updates the list on the left.
  sec.addEventListener('change', (e) => {
    const st = selectedStrategy();
    if(targetEl(e).id === 'stratName' && st){ st.name = targetEl(e).value.trim() || 'Untitled strategy'; saveStrategies(); renderStrategiesSection(); }
    else if((targetEl(e).id === 'goalTarget' || targetEl(e).id === 'goalDays') && st){
      st.goal = cleanGoal({ target: Number(/** @type {HTMLInputElement} */ (document.getElementById('goalTarget')).value), days: Number(/** @type {HTMLInputElement} */ (document.getElementById('goalDays')).value) });
      forgetLearned(st.id); saveStrategies(); renderStrategiesSection();
    }
    else if(targetEl(e).id === 'stratSort' && st){
      syncSelected(); setResultsSort(targetEl(e).value);
      document.getElementById('stratResults').innerHTML = resultsHtml(qualifyingStocks(stocks, st.rules), selected);
      syncSelected();
    }
    else if(targetEl(e).id === 'stratNote' && st){ st.note = targetEl(e).value.trim(); saveStrategies(); }
    else if(targetEl(e).id === 'stratWhy' && st){
      whyQuery = targetEl(e).value;
      document.getElementById('stratWhyOut').innerHTML = whyHtml(whyQuery, st.rules);
    }
  });
}

export { init_strategies_section, renderStrategiesSection };
