// The Analysis filter panel: which stocks qualify (Fundamental Score, MoS Rating, Tech Rating W / M),
// the count shown on each button, and the button wiring.
// Two multiselect groups of buttons. It is drawn into
// #analysisGlobalFilters (then docked into the toolbar row, outside the chart body), so picking filters down to zero results never strands
// the viewer with no way back.
import { stocks } from '../core/stocks.js';
import { mosRatingAny } from '../list/metrics.js';
import { analysisFilters, saveAnalysisFilters } from './state.js';
import { stocksInRange } from './geometry.js';
import { publishedStrategies } from '../strategies/state.js';
import { qualifyingStocks } from '../strategies/rules.js';
import { strategyStockSet } from '../strategies/pick.js';
import { sheetFrame } from '../ui/phonesheet.js';
import { filtersOpenSaved, rememberFiltersOpen } from '../ui/filterdock.js';
import { escapeHtml } from '../core/util.js';
import { isRebound } from '../list/rebound.js';
import { ensureAllPriceBars } from '../prices/store.js';
import { ideasStockSet, ideasWhen } from './ideasfilter.js';

// Both filter groups are multiselect (changed 2026-10-06): clicking "All" clears the group back
// to showing everything; clicking any other button toggles just that option in/out of the active
// set, so e.g. Strong + Good can be selected together. An empty set behaves exactly like "All"
// (see the `size === 0 ||` checks in the filter predicates), so clicking every specific option one-by-one back to
// zero is equivalent to clicking "All" — the UI doesn't force that collapse, it's just how the
// filter predicate reads an empty set either way.
function wireMultiselectFilterGroup(btns, dataAttr, getSet, setSet, onChange){
  btns.forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const val = btn.dataset[dataAttr];
      const set = getSet();
      if(val === 'all'){
        set.clear();
      } else {
        if(set.has(val)) set.delete(val); else set.add(val);
      }
      setSet(set);
      btns.forEach(b=>{
        const v = b.dataset[dataAttr];
        b.classList.toggle('active', v === 'all' ? set.size === 0 : set.has(v));
      });
      onChange();
    });
  });
}

const techStates = (s) => (s.technical && s.technical.states) || {};

// The stocks the Analysis section works on: every stock. A stock with no Intrinsic Value (so no margin of safety) is listed with its MoS
// and price cells blank; it is left out only when a MoS Rating button or the MoS range is used, as those need a margin of safety.
// Tech Rating W / M: a stock with no rating for that timeframe is excluded once any button there is active.
const strategyPassSet = () => strategyStockSet(analysisFilters.strategyId);
const ideasPassSet = () => ideasStockSet(analysisFilters.ideas, analysisFilters.strategyId).set;
function analysisBucket(){
  const inStrategy = strategyPassSet(), inIdeas = ideasPassSet();
  return stocks.filter(s => {
    if(inStrategy && !inStrategy.has(s)) return false;
    if(inIdeas && !inIdeas.has(s)) return false;
    const verdictOk = analysisFilters.verdicts.length === 0 || analysisFilters.verdicts.includes(s.verdict);
    if(!verdictOk) return false;
    const rating = mosRatingAny(s);
    if(analysisFilters.mosRatings.length !== 0 && !analysisFilters.mosRatings.includes(rating)) return false;
    const st = techStates(s);
    if(analysisFilters.techW.length !== 0 && !analysisFilters.techW.includes(st.weekMacd)) return false;
    if(analysisFilters.techM.length !== 0 && !analysisFilters.techM.includes(st.monthMacd)) return false;
    if(analysisFilters.rebound && !isRebound(s)) return false;
    return true;
  });
}

// Number next to each filter button: how many stocks you would get by choosing it, given the OTHER filter
// groups' current choices (its own group is ignored, so the numbers show what each button would add).
function analysisPasses(s, skip, inStrategy, inIdeas){
  if(inStrategy && !inStrategy.has(s)) return false;
  if(skip !== 'aideas' && inIdeas && !inIdeas.has(s)) return false;
  const rating = mosRatingAny(s);
  if(stocksInRange([s]).length === 0) return false;   // the same MoS and RSI ranges the list applies, so a count equals what the list shows
  const st = techStates(s);
  if(skip !== 'averdict' && analysisFilters.verdicts.length && !analysisFilters.verdicts.includes(s.verdict)) return false;
  if(skip !== 'amos' && analysisFilters.mosRatings.length && !analysisFilters.mosRatings.includes(rating)) return false;
  if(skip !== 'atechw' && analysisFilters.techW.length && !analysisFilters.techW.includes(st.weekMacd)) return false;
  if(skip !== 'atechm' && analysisFilters.techM.length && !analysisFilters.techM.includes(st.monthMacd)) return false;
  if(skip !== 'arebound' && analysisFilters.rebound && !isRebound(s)) return false;
  return true;
}

function facetCounts(){
  const cache = {}, inStrategy = strategyPassSet(), inIdeas = ideasPassSet();
  return function facetCount(group, key){
    if(!cache[group]){
      const c = { all: 0 };
      stocks.forEach(s => {
        if(!analysisPasses(s, group, inStrategy, inIdeas)) return;
        c.all++;
        const st = techStates(s);
        if(group === 'arebound'){ if(isRebound(s)) c.on = (c.on || 0) + 1; return; }
        const v = group === 'averdict' ? s.verdict : group === 'amos' ? mosRatingAny(s) : group === 'atechw' ? st.weekMacd : st.monthMacd;
        if(v != null) c[v] = (c[v] || 0) + 1;
      });
      cache[group] = c;
    }
    return cache[group][key] || 0;
  };
}

// ---- markup ----
const TECH_BUTTONS = [
  ['bull_above', 'var(--buy)', 'Bullish', 'MACD above its signal line and above zero'],
  ['bull_below', 'var(--mbuy)', 'Turning Up', 'MACD crossed above its signal line but is still below zero'],
  ['bear_above', 'var(--hold)', 'Weakening', 'MACD below its signal line but still above zero'],
  ['bear_below', 'var(--avoid)', 'Bearish', 'MACD below its signal line and below zero']
];
const VERDICT_BUTTONS = [
  ['buy', 'var(--buy)', 'Strong'],
  ['mbuy', 'var(--mbuy)', 'Good'],
  ['hold', 'var(--hold)', 'Hold'],
  ['avoid', 'var(--avoid)', 'Avoid']
];
const MOS_BUTTONS = [
  ['green', 'var(--buy)', 'Green', 'Trading at or above CSV intrinsic value (MoS ≥ 0%)'],
  ['orange', 'var(--tech-sell)', 'Orange', '-25% ≤ MoS &lt; 0%'],
  ['red', 'var(--avoid)', 'Red', 'MoS &lt; -25%']
];

function filterButton(attr, value, active, dot, label, count, title){
  return `<button class="filter-btn${active ? ' active' : ''}" data-${attr}="${value}"${title ? ` title="${title}"` : ''}><span class="filter-dot" style="background:${dot}"></span>${label}<span class="filter-n">${count}</span></button>`;
}

// One filter group: an "All" button (active when nothing is chosen) followed by the choices.
function filterGroup(id, heading, attr, chosen, choices, facetCount){
  const buttons = [filterButton(attr, 'all', chosen.length === 0, 'var(--text)', 'All', facetCount(attr, 'all'))]
    .concat(choices.map(([value, dot, label, title]) => filterButton(attr, value, chosen.includes(value), dot, label, facetCount(attr, value), title)));
  return `<div class="filter-group" id="${id}">
        <h2>${heading}</h2>
        <div class="filter-group-row">
          ${buttons.join('\n          ')}
        </div>
      </div>`;
}

// Down last week, up this week. One on/off button; its number is how many stocks it would give with the other filters applied.
function reboundGroup(facetCount){
  return `<div class="filter-group" id="analysisReboundFilter">
        <h2>Weekly Move</h2>
        <div class="filter-group-row">
          ${filterButton('arebound', 'all', !analysisFilters.rebound, 'var(--text)', 'All', facetCount('arebound', 'all'))}
          ${filterButton('arebound', 'on', analysisFilters.rebound, 'var(--buy)', 'Rebound', facetCount('arebound', 'on'), 'Down last week, up this week')}
        </div>
      </div>`;
}

// Optional: narrow Analysis to the stocks that qualify for one of your strategies. "All" (no strategy) is the default.
// Each button's number is how many stocks it would give with the other Analysis filters applied.
function strategyGroup(){
  const strategies = publishedStrategies();
  const chosen = analysisFilters.strategyId && strategies.some(x => x.id === analysisFilters.strategyId) ? analysisFilters.strategyId : '';
  let all = 0; const counts = new Map(strategies.map(x => [x.id, 0]));
  const sets = new Map(strategies.map(x => [x.id, new Set(qualifyingStocks(stocks, x.rules))]));
  stocks.forEach(s => {
    if(!analysisPasses(s, 'astrat', null, ideasPassSet())) return;
    all++;
    strategies.forEach(x => { if(sets.get(x.id).has(s)) counts.set(x.id, counts.get(x.id) + 1); });
  });
  const hiddenNoteHtml = hiddenNote();
  const buttons = [filterButton('astrat', 'all', !chosen, 'var(--text)', 'All', all, 'Do not narrow Analysis by a strategy')]
    .concat(strategies.map(x => filterButton('astrat', escapeHtml(x.id), x.id === chosen, 'var(--accent)', `<span class="filter-label">${escapeHtml(x.name)}</span>`, counts.get(x.id), 'Only stocks that qualify for this strategy today')));
  return `<div class="filter-group" id="analysisStrategyFilter">
        <h2>Strategy</h2>
        <div class="filter-group-row">
          ${buttons.join('\n          ')}
        </div>${hiddenNoteHtml}
      </div>`;
}

// Optional: only the stocks in the Upward trend or Downward trend list from Process in the Trade Log (for the chosen strategy, else the newest result).
// Each number is how many of those stocks the other Analysis filters leave in. Handy before a Refresh: it works on just the shortlist.
const IDEAS_BUTTONS = [['up', 'var(--buy)', 'Upward Trend', 'The Upward trend list from the last Process'], ['down', 'var(--hold)', 'Downward Trend', 'The Downward trend (bounce back) list from the last Process']];
function ideasGroup(){
  const inStrategy = strategyPassSet(), chosen = analysisFilters.ideas;
  const c = { all: 0, up: 0, down: 0 };
  const sets = { up: ideasStockSet(['up'], analysisFilters.strategyId).set, down: ideasStockSet(['down'], analysisFilters.strategyId).set };
  stocks.forEach(s => {
    if(!analysisPasses(s, 'aideas', inStrategy, null)) return;
    c.all++;
    if(sets.up && sets.up.has(s)) c.up++;
    if(sets.down && sets.down.has(s)) c.down++;
  });
  const { source } = ideasStockSet(chosen, analysisFilters.strategyId);
  const note = !chosen.length ? '' : source.snap
    ? `<p class="filter-note" id="analysisIdeasNote">From &ldquo;${escapeHtml(source.name)}&rdquo;, processed ${escapeHtml(ideasWhen(source.snap))}. Process again in the Trade Log to update the list.</p>`
    : `<p class="filter-note" id="analysisIdeasNote">No Buy / Sell result is saved yet${analysisFilters.strategyId && source.name ? ' for &ldquo;' + escapeHtml(source.name) + '&rdquo;' : ''}. Open the Trade Log, choose a strategy and press Process.</p>`;
  const buttons = [filterButton('aideas', 'all', !chosen.length, 'var(--text)', 'All', c.all, 'Do not narrow Analysis by the Buy / Sell ideas')]
    .concat(IDEAS_BUTTONS.map(([v, dot, label, title]) => filterButton('aideas', v, chosen.includes(v), dot, label, c[v], title)));
  return `<div class="filter-group" id="analysisIdeasFilter">
        <h2>Buy / Sell ideas</h2>
        <div class="filter-group-row">
          ${buttons.join('\n          ')}
        </div>${note}
      </div>`;
}

// Why the numbers above can be lower than the total: a stock with no Intrinsic Value is hidden as soon as the MoS range is narrowed (or a
// MoS Rating button is chosen), and a stock with no RSI reading is hidden as soon as that RSI range is narrowed. Shown only when something is hidden.
function hiddenNote(){
  const inStrategy = strategyPassSet(), inIdeas = ideasPassSet(), f = analysisFilters;
  const base = stocks.filter(s => (!inStrategy || inStrategy.has(s)) && (!inIdeas || inIdeas.has(s)));
  const weekFull = f.weekMin === 0 && f.weekMax === 100, monthFull = f.monthMin === 0 && f.monthMax === 100, mosNarrowed = f.mosLo !== null || f.mosHi !== null;
  const n = { noVal: 0, noWeek: 0, noMonth: 0, range: 0, other: 0 };
  let shown = 0;
  base.forEach(s => {
    if(mosNarrowed && mosRatingAny(s) == null){ n.noVal++; return; }
    const raw = (s.technical && s.technical.raw) || {};
    if(raw.weekRsi == null && !weekFull){ n.noWeek++; return; }
    if(raw.monthRsi == null && !monthFull){ n.noMonth++; return; }
    if(analysisPasses(s, null, null, null)){ shown++; return; }
    if(stocksInRange([s]).length === 0) n.range++; else n.other++;
  });
  const hidden = base.length - shown;
  if(!hidden) return '';
  const fmt = (v) => v.toLocaleString('en-IN');
  const parts = [];
  if(n.noVal) parts.push(`${fmt(n.noVal)} with no Intrinsic Value (so no margin of safety) while the MoS range is narrowed`);
  if(n.noWeek) parts.push(`${fmt(n.noWeek)} with no weekly RSI while the W RSI range is ${f.weekMin}–${f.weekMax}`);
  if(n.noMonth) parts.push(`${fmt(n.noMonth)} with no monthly RSI while the M RSI range is ${f.monthMin}–${f.monthMax}`);
  if(n.range) parts.push(`${fmt(n.range)} outside the MoS or RSI ranges`);
  if(n.other) parts.push(`${fmt(n.other)} left out by the Fundamental Score, MoS Rating or Tech Rating buttons`);
  return `
        <p class="filter-note" id="analysisHiddenNote">Showing ${fmt(shown)} of ${fmt(base.length)} ${inIdeas ? 'stocks in the Buy / Sell ideas list' : inStrategy ? 'stocks that qualify for this strategy' : 'stocks'}. Hidden: ${parts.join('; ')}.</p>`;
}

// Phones: the filters fold into one "Filters" line that lists what is selected (closed to start with).
// Wide screens: the same button shows or hides the filter column, and the choice is remembered (src/ui/filterdock.js).
var analysisFiltersOpen = filtersOpenSaved('aFiltersOpen');
function analysisFiltersHtml(){
  const facetCount = facetCounts();
  return `
    <div class="filters analysis-filters-panel${analysisFiltersOpen ? '' : ' filters-collapsed'}" id="analysisFilterPanel">
      <button type="button" class="filters-toggle" id="analysisFiltersToggle" aria-expanded="${analysisFiltersOpen}" aria-controls="analysisFilterGroups"><span class="ft-label" aria-label="Filters"></span><span class="ft-summary" id="analysisFiltersSummary"></span><span class="ft-count" id="analysisFiltersCount"></span><span class="ft-caret" aria-hidden="true">&#9662;</span></button>
      ${sheetFrame(`      <div class="filter-groups" id="analysisFilterGroups">
      ${strategyGroup()}
      ${ideasGroup()}
      ${filterGroup('analysisVerdictFilters', 'Fundamental Score', 'averdict', analysisFilters.verdicts, VERDICT_BUTTONS, facetCount)}
      ${filterGroup('analysisMosFilters', 'MoS Rating', 'amos', analysisFilters.mosRatings, MOS_BUTTONS, facetCount)}
      ${filterGroup('analysisTechWFilters', 'W Tech Rating', 'atechw', analysisFilters.techW, TECH_BUTTONS, facetCount)}
      ${reboundGroup(facetCount)}
      ${filterGroup('analysisTechMFilters', 'M Tech Rating', 'atechm', analysisFilters.techM, TECH_BUTTONS, facetCount)}
      </div>
`)}
    </div>
  `;
}

// Docks the panel into the toolbar row, after the View menu, so the View menu and the "Filters" chip share one line. The panel
// itself takes no box (stylesheet: display:contents): its chip becomes a toolbar item and its filter groups wrap onto the line below.
// Without a toolbar (the section is not drawn yet) the panel stays in its own container.
function dockFiltersPanel(){
  const bar = document.querySelector('.analysis-toolbar'), panel = document.getElementById('analysisFilterPanel');
  const viewBar = bar && bar.querySelector('.analysis-view-bar');
  if(bar && panel && panel.parentElement !== bar){ if(viewBar) viewBar.after(panel); else bar.prepend(panel); }
}

// ---- wiring ----
// [group id, data attribute, which analysisFilters list it edits]
const GROUPS = [
  ['analysisVerdictFilters', 'averdict', 'verdicts'],
  ['analysisTechWFilters', 'atechw', 'techW'],
  ['analysisTechMFilters', 'atechm', 'techM'],
  ['analysisMosFilters', 'amos', 'mosRatings'],
  ['analysisIdeasFilter', 'aideas', 'ideas']   // v1.306: Upward and Downward Trend can both be chosen
];

// Draws the panel and makes its buttons work. `rerender` redraws the whole Analysis section.
let barsAsked = false;
function renderAnalysisFilterPanel(rerender){
  if(analysisFilters.rebound && !barsAsked){   // last week's move needs the weekly bars: load them once, then redraw
    barsAsked = true;
    ensureAllPriceBars().then(ok => { if(ok) rerender(); else barsAsked = false; });
  }
  const host = document.getElementById('analysisGlobalFilters');
  const old = document.getElementById('analysisFilterPanel');
  if(old) old.remove();   // the panel docked in the toolbar is the one being replaced
  if(host) host.innerHTML = analysisFiltersHtml();
  const panel = document.getElementById('analysisFilterPanel'), toggle = document.getElementById('analysisFiltersToggle'), summary = document.getElementById('analysisFiltersSummary');
  if(panel && toggle && summary){
    const names = Array.from(panel.querySelectorAll('.filter-btn.active')).filter(b => !['all'].includes(/** @type {HTMLElement} */ (b).dataset.averdict || /** @type {HTMLElement} */ (b).dataset.amos || /** @type {HTMLElement} */ (b).dataset.atechw || /** @type {HTMLElement} */ (b).dataset.atechm || /** @type {HTMLElement} */ (b).dataset.arebound || /** @type {HTMLElement} */ (b).dataset.astrat || /** @type {HTMLElement} */ (b).dataset.aideas)).map(b => {
      const c = b.cloneNode(true); /** @type {Element} */ (c).querySelectorAll('.filter-n').forEach(n => n.remove()); return c.textContent.trim();
    });
    summary.textContent = names.length ? names.join(', ') : 'All stocks';
    const cnt = document.getElementById('analysisFiltersCount'), shown = document.getElementById('analysisLeaderboardCount');
    if(cnt && shown) cnt.textContent = shown.dataset.short || '';   // (a phone shows the count inside this chip: see phone.css)
    toggle.addEventListener('click', () => {
      analysisFiltersOpen = panel.classList.toggle('filters-collapsed') === false;
      toggle.setAttribute('aria-expanded', String(analysisFiltersOpen));
      rememberFiltersOpen('aFiltersOpen', analysisFiltersOpen);
    });
  }
  dockFiltersPanel();
  document.querySelectorAll('#analysisStrategyFilter .filter-btn').forEach(btn => btn.addEventListener('click', () => {
    const id = /** @type {HTMLElement} */ (btn).dataset.astrat === 'all' ? '' : /** @type {HTMLElement} */ (btn).dataset.astrat;
    analysisFilters.strategyId = (id && id === analysisFilters.strategyId) ? '' : id;   // clicking the chosen one again goes back to All
    saveAnalysisFilters(analysisFilters);
    rerender();
  }));
  document.querySelectorAll('#analysisReboundFilter .filter-btn').forEach(btn => btn.addEventListener('click', () => {
    analysisFilters.rebound = /** @type {HTMLElement} */ (btn).dataset.arebound === 'on' && !analysisFilters.rebound;
    saveAnalysisFilters(analysisFilters);
    rerender();
  }));
  GROUPS.forEach(([id, attr, list]) => {
    const btns = Array.from(document.querySelectorAll('#' + id + ' .filter-btn'));
    wireMultiselectFilterGroup(btns, attr, () => new Set(analysisFilters[list]), (s) => { analysisFilters[list] = Array.from(s); }, () => {
      saveAnalysisFilters(analysisFilters);
      rerender();
    });
  });
}

export { analysisBucket, renderAnalysisFilterPanel };
