// The qualifying-stocks table and the "why isn't this stock in?" lookup.
import { escapeHtml, tickerSymbol } from '../core/util.js';
import { stockIndex, stocks } from '../core/stocks.js';
import { FIELD_BY_ID } from './fields.js';
import { describeRule, evaluateStock, formatValue } from './rules.js';
import { ANALYSIS_SORT_KEYS, ANALYSIS_SORT_OPTIONS, analysisSortComparator } from '../analysis/state.js';
import { analysisLbCell, analysisRowContext, columnHeaderHtml, stockGridColumnIds } from '../analysis/columns.js';
import { kit } from '../refresh/kit.js';

const ROW_CAP = 300;

// The "Sort by" choices are the Analysis page's (same list, same meaning). The choice is kept in this browser.
const SORT_KEY = 'albaDashboard.strategySort.v1', DEFAULT_SORT = 'score_desc';
let sortBy = DEFAULT_SORT;
try { const v = localStorage.getItem(SORT_KEY); if(ANALYSIS_SORT_KEYS.has(v)) sortBy = v; } catch(e){ /* storage unavailable: default order */ }
function setResultsSort(v){
  sortBy = ANALYSIS_SORT_KEYS.has(v) ? v : DEFAULT_SORT;
  try { localStorage.setItem(SORT_KEY, sortBy); } catch(e){ /* optional */ }
}
const sortLabel = () => ANALYSIS_SORT_OPTIONS.find(o => o.value === sortBy).label;
function sortSelectHtml(){
  return `<label class="analysis-filter-label strat-sort">Sort by:
    <select class="sort-select" id="stratSort">${ANALYSIS_SORT_OPTIONS.map(o => `<option value="${o.value}"${o.value === sortBy ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select></label>`;
}

// The picks in the order the table lists them (ties keep the best Fundamental score first): also the order a refresh works through them.
const orderedPicks = (matches) => matches.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).sort(analysisSortComparator(sortBy));
function resultsHtml(matches, selected){
  if(!matches.length) return `<div class="strat-empty">No stock passes all of these rules right now.</div>`;
  const sorted = orderedPicks(matches);
  const cols = stockGridColumnIds();   // the order set in Analysis
  const rows = sorted.slice(0, ROW_CAP).map((s, i) => {
    const idx = stockIndex.get(s), ctx = analysisRowContext(s, i, idx);
    return `<tr class="strat-row" data-idx="${idx}" tabindex="0">
      <td class="strat-selcell"><input type="checkbox" class="strat-sel" data-sym="${escapeHtml(tickerSymbol(s))}"${selected.has(tickerSymbol(s)) ? ' checked' : ''} aria-label="Select ${escapeHtml(s.name)} to track">${kit.rowBtn()}</td>
      ${cols.map(id => analysisLbCell(id, ctx)).join('')}
    </tr>`;
  }).join('');
  const more = sorted.length > ROW_CAP ? `<div class="strat-empty">Showing the first ${ROW_CAP} of ${sorted.length}, sorted by ${escapeHtml(sortLabel().toLowerCase())}.</div>` : '';
  return `<div class="strat-table-wrap"><table class="strat-table">
      <thead><tr><th class="strat-selcell"><input type="checkbox" class="strat-sel" data-sym="*" aria-label="Select all to track"></th>${cols.map(columnHeaderHtml).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></div>${more}`;
}

// The first stock whose symbol equals the text, else whose name or ticker line contains it.
function findStock(q){
  const t = q.trim().toLowerCase();
  if(!t) return null;
  return stocks.find(s => tickerSymbol(s).toLowerCase() === t)
    || stocks.find(s => s.name.toLowerCase().includes(t) || s.ticker.toLowerCase().includes(t))
    || null;
}
function whyDatalist(){
  return `<datalist id="stratWhyList">${stocks.map(s => `<option value="${escapeHtml(tickerSymbol(s))}">${escapeHtml(s.name)}</option>`).join('')}</datalist>`;
}
function whyHtml(query, rules){
  if(!query.trim()) return '';
  const s = findStock(query);
  if(!s) return `<div class="strat-why-none">No stock matches &ldquo;${escapeHtml(query.trim())}&rdquo;.</div>`;
  const ev = evaluateStock(s, rules);
  const head = `<div class="strat-why-head"><b>${escapeHtml(s.name)}</b> <span class="analysis-lb-ticker">${escapeHtml(tickerSymbol(s))}</span> &mdash; ${ev.pass ? '<span class="strat-yes">qualifies</span>' : '<span class="strat-no">does not qualify</span>'}</div>`;
  if(!ev.results.length) return head + `<div class="strat-empty">There are no rules to check yet.</div>`;
  const rows = ev.results.map(r => {
    const f = FIELD_BY_ID.get(r.rule.field);
    const shown = r.missing ? 'no data' : formatValue(f, r.value === null && f.noneLabel ? 'none' : r.value);
    return `<li class="${r.pass ? 'ok' : 'bad'}"><span class="strat-mark">${r.pass ? '&#10003;' : '&#10007;'}</span> ${escapeHtml(describeRule(r.rule))} <span class="strat-have">(this stock: ${escapeHtml(shown)})</span></li>`;
  }).join('');
  return head + `<ul class="strat-why-list">${rows}</ul>`;
}

export { orderedPicks, resultsHtml, setResultsSort, sortLabel, sortSelectHtml, whyDatalist, whyHtml };
