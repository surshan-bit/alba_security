// The Analysis filter panel: which stocks qualify (Fundamental Score, MoS Rating, Tech Rating W / M),
// the count shown on each button, and the button wiring.
// Two multiselect groups of buttons. It is drawn into
// #analysisGlobalFilters, outside the chart body, so picking filters down to zero results never strands
// the viewer with no way back.
import { stocks } from '../core/stocks.js';
import { mosRatingAny } from '../list/metrics.js';
import { analysisFilters, saveAnalysisFilters } from './state.js';
import { publishedStrategies } from '../strategies/state.js';
import { qualifyingStocks } from '../strategies/rules.js';
import { strategyStockSet } from '../strategies/pick.js';
import { escapeHtml } from '../core/util.js';

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

// The stocks the Analysis section works on. A stock with no valuation data at all is never included.
// Tech Rating W / M: a stock with no rating for that timeframe is excluded once any button there is active.
const strategyPassSet = () => strategyStockSet(analysisFilters.strategyId);
function analysisBucket(){
  const inStrategy = strategyPassSet();
  return stocks.filter(s => {
    if(inStrategy && !inStrategy.has(s)) return false;
    const verdictOk = analysisFilters.verdicts.length === 0 || analysisFilters.verdicts.includes(s.verdict);
    if(!verdictOk) return false;
    const rating = mosRatingAny(s);
    if(rating == null) return false;
    if(analysisFilters.mosRatings.length !== 0 && !analysisFilters.mosRatings.includes(rating)) return false;
    const st = techStates(s);
    if(analysisFilters.techW.length !== 0 && !analysisFilters.techW.includes(st.weekMacd)) return false;
    if(analysisFilters.techM.length !== 0 && !analysisFilters.techM.includes(st.monthMacd)) return false;
    return true;
  });
}

// Number next to each filter button: how many stocks you would get by choosing it, given the OTHER filter
// groups' current choices (its own group is ignored, so the numbers show what each button would add).
function analysisPasses(s, skip, inStrategy){
  if(inStrategy && !inStrategy.has(s)) return false;
  const rating = mosRatingAny(s);
  if(rating == null) return false;
  const st = techStates(s);
  if(skip !== 'averdict' && analysisFilters.verdicts.length && !analysisFilters.verdicts.includes(s.verdict)) return false;
  if(skip !== 'amos' && analysisFilters.mosRatings.length && !analysisFilters.mosRatings.includes(rating)) return false;
  if(skip !== 'atechw' && analysisFilters.techW.length && !analysisFilters.techW.includes(st.weekMacd)) return false;
  if(skip !== 'atechm' && analysisFilters.techM.length && !analysisFilters.techM.includes(st.monthMacd)) return false;
  return true;
}

function facetCounts(){
  const cache = {}, inStrategy = strategyPassSet();
  return function facetCount(group, key){
    if(!cache[group]){
      const c = { all: 0 };
      stocks.forEach(s => {
        if(!analysisPasses(s, group, inStrategy)) return;
        c.all++;
        const st = techStates(s);
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

// Optional: narrow Analysis to the stocks that qualify for one of your strategies. "All" (no strategy) is the default.
// Each button's number is how many stocks it would give with the other Analysis filters applied.
function strategyGroup(){
  const strategies = publishedStrategies();
  const chosen = analysisFilters.strategyId && strategies.some(x => x.id === analysisFilters.strategyId) ? analysisFilters.strategyId : '';
  let all = 0; const counts = new Map(strategies.map(x => [x.id, 0]));
  const sets = new Map(strategies.map(x => [x.id, new Set(qualifyingStocks(stocks, x.rules))]));
  stocks.forEach(s => {
    if(!analysisPasses(s, 'astrat', null)) return;
    all++;
    strategies.forEach(x => { if(sets.get(x.id).has(s)) counts.set(x.id, counts.get(x.id) + 1); });
  });
  const buttons = [filterButton('astrat', 'all', !chosen, 'var(--text)', 'All', all, 'Do not narrow Analysis by a strategy')]
    .concat(strategies.map(x => filterButton('astrat', escapeHtml(x.id), x.id === chosen, 'var(--accent)', `<span class="filter-label">${escapeHtml(x.name)}</span>`, counts.get(x.id), 'Only stocks that qualify for this strategy today')));
  return `<div class="filter-group" id="analysisStrategyFilter">
        <h2>Strategy</h2>
        <div class="filter-group-row">
          ${buttons.join('\n          ')}
        </div>
      </div>`;
}

// Phones: the filters fold into one "Filters" line that lists what is selected (closed to start with).
var analysisFiltersOpen = false;
function analysisFiltersHtml(){
  const facetCount = facetCounts();
  return `
    <div class="filters analysis-filters-panel${analysisFiltersOpen ? '' : ' filters-collapsed'}" id="analysisFilterPanel">
      <button type="button" class="filters-toggle" id="analysisFiltersToggle" aria-expanded="${analysisFiltersOpen}" aria-controls="analysisFilterGroups"><span class="ft-label">Filters</span><span class="ft-summary" id="analysisFiltersSummary"></span><span class="ft-caret" aria-hidden="true">&#9662;</span></button>
      <div class="filter-groups" id="analysisFilterGroups">
      ${strategyGroup()}
      ${filterGroup('analysisVerdictFilters', 'Fundamental Score', 'averdict', analysisFilters.verdicts, VERDICT_BUTTONS, facetCount)}
      ${filterGroup('analysisMosFilters', 'MoS Rating', 'amos', analysisFilters.mosRatings, MOS_BUTTONS, facetCount)}
      ${filterGroup('analysisTechWFilters', 'W Tech Rating', 'atechw', analysisFilters.techW, TECH_BUTTONS, facetCount)}
      ${filterGroup('analysisTechMFilters', 'M Tech Rating', 'atechm', analysisFilters.techM, TECH_BUTTONS, facetCount)}
      </div>
    </div>
  `;
}

// ---- wiring ----
// [group id, data attribute, which analysisFilters list it edits]
const GROUPS = [
  ['analysisVerdictFilters', 'averdict', 'verdicts'],
  ['analysisTechWFilters', 'atechw', 'techW'],
  ['analysisTechMFilters', 'atechm', 'techM'],
  ['analysisMosFilters', 'amos', 'mosRatings']
];

// Draws the panel and makes its buttons work. `rerender` redraws the whole Analysis section.
function renderAnalysisFilterPanel(rerender){
  const host = document.getElementById('analysisGlobalFilters');
  if(host) host.innerHTML = analysisFiltersHtml();
  const panel = document.getElementById('analysisFilterPanel'), toggle = document.getElementById('analysisFiltersToggle'), summary = document.getElementById('analysisFiltersSummary');
  if(panel && toggle && summary){
    const names = Array.from(panel.querySelectorAll('.filter-btn.active')).filter(b => !['all'].includes(b.dataset.averdict || b.dataset.amos || b.dataset.atechw || b.dataset.atechm || b.dataset.astrat)).map(b => {
      const c = b.cloneNode(true); c.querySelectorAll('.filter-n').forEach(n => n.remove()); return c.textContent.trim();
    });
    summary.textContent = names.length ? names.join(', ') : 'All stocks';
    toggle.addEventListener('click', () => {
      analysisFiltersOpen = panel.classList.toggle('filters-collapsed') === false;
      toggle.setAttribute('aria-expanded', String(analysisFiltersOpen));
    });
  }
  document.querySelectorAll('#analysisStrategyFilter .filter-btn').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.astrat === 'all' ? '' : btn.dataset.astrat;
    analysisFilters.strategyId = (id && id === analysisFilters.strategyId) ? '' : id;   // clicking the chosen one again goes back to All
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
