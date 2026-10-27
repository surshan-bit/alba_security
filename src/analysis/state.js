// Analysis screen state: sort options, saved filters and persistence.
import { monthPct, mosPct, weekPct } from '../list/metrics.js';
import { stockResearchAgeDays } from '../research/status.js';
import { prefSet, uiStateSet } from '../identity/prefs.js';

// A stock with no RSI reading yet is listed (while that RSI range is left at 0-100) and always sorts last.
const rsiVal = (s, key) => { const v = s.technical && s.technical.raw ? s.technical.raw[key] : null; return typeof v === 'number' && isFinite(v) ? v : null; };
const rsiCmp = (key, dir) => (a, b) => {
  const x = rsiVal(a, key), y = rsiVal(b, key);
  if(x === null || y === null) return x === y ? 0 : (x === null ? 1 : -1);
  return dir * (x - y);
};

// A stock with no margin of safety (no Intrinsic Value) always sorts last, whichever way the list is sorted.
const mosCmp = (dir) => (a, b) => {
  const x = mosPct(a), y = mosPct(b);
  if(x === -Infinity || y === -Infinity) return x === y ? 0 : (x === -Infinity ? 1 : -1);
  return dir * (x - y);
};

const ANALYSIS_SORT_OPTIONS = [
  { value: 'mos_desc', label: 'Margin of Safety (high to low)', cmp: mosCmp(-1) },
  { value: 'mos_asc', label: 'Margin of Safety (low to high)', cmp: mosCmp(1) },
  { value: 'score_desc', label: 'Fundamental Score (high to low)', cmp: (a, b) => (b.score || 0) - (a.score || 0) },
  { value: 'weekRsi_desc', label: 'W RSI (high to low)', cmp: rsiCmp('weekRsi', -1) },
  { value: 'weekRsi_asc', label: 'W RSI (low to high)', cmp: rsiCmp('weekRsi', 1) },
  { value: 'monthRsi_desc', label: 'M RSI (high to low)', cmp: rsiCmp('monthRsi', -1) },
  { value: 'monthRsi_asc', label: 'M RSI (low to high)', cmp: rsiCmp('monthRsi', 1) },
  { value: 'weekChg_desc', label: 'Weekly % change (high to low)', cmp: (a, b) => (weekPct(b)) - (weekPct(a)) },
  { value: 'monthChg_desc', label: 'Monthly % change (high to low)', cmp: (a, b) => (monthPct(b)) - (monthPct(a)) },
  { value: 'price_desc', label: 'Price (high to low)', cmp: (a, b) => (b.valuation && b.valuation.currentPrice || 0) - (a.valuation && a.valuation.currentPrice || 0) },
  { value: 'research_old', label: 'Research age (never / oldest first)', cmp: (a, b) => { const x = stockResearchAgeDays(a), y = stockResearchAgeDays(b); return (y === null ? Infinity : y) === (x === null ? Infinity : x) ? 0 : (x === null ? Infinity : x) > (y === null ? Infinity : y) ? -1 : 1; } },
  { value: 'research_new', label: 'Research age (most recent first)', cmp: (a, b) => { const x = stockResearchAgeDays(a), y = stockResearchAgeDays(b); return (x === null ? Infinity : x) === (y === null ? Infinity : y) ? 0 : (x === null ? Infinity : x) < (y === null ? Infinity : y) ? -1 : 1; } },
  { value: 'name_asc', label: 'Name (A to Z)', cmp: (a, b) => a.name.localeCompare(b.name) }
];
const ANALYSIS_SORT_KEYS = new Set(ANALYSIS_SORT_OPTIONS.map(o => o.value));
function analysisSortComparator(sortBy){
  const opt = ANALYSIS_SORT_OPTIONS.find(o => o.value === sortBy);
  return opt ? opt.cmp : ANALYSIS_SORT_OPTIONS[0].cmp;
}

// "Group by" for the leaderboard: no grouping, or one block of rows per industry / industry group.
const ANALYSIS_GROUP_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'industry', label: 'Industry' },
  { value: 'group', label: 'Industry Group' }
];
const ANALYSIS_GROUP_KEYS = new Set(ANALYSIS_GROUP_OPTIONS.map(o => o.value));

const ANALYSIS_FILTERS_KEY = 'albaDashboard.analysisFilters.v1';
function saveAnalysisFilters(filters){
  prefSet(ANALYSIS_FILTERS_KEY, JSON.stringify(filters));
}
// Fundamental Score / MoS Rating filters for the Analysis section: multiselect (an empty array means "All").
// Defaults: every verdict, MoS Rating Green only (positive Margin of Safety).
const ANALYSIS_VERDICT_KEYS = ['buy', 'mbuy', 'hold', 'avoid'];
const ANALYSIS_MOS_KEYS = ['green', 'orange', 'red'];
// Tech Rating W / M filters (2026-10-07): the MACD state behind the Tech Rating badge (weekMacd / monthMacd).
const ANALYSIS_TECH_KEYS = ['bull_above', 'bull_below', 'bear_above', 'bear_below'];
function loadAnalysisFilters(){
  const fallback = { weekMin: 0, weekMax: 100, monthMin: 0, monthMax: 100, colorBy: 'week', xAxis: 'week', yAxis: 'month', sortBy: 'mos_desc', groupBy: 'none', verdicts: [], mosRatings: ['green'], techW: [], techM: [], mosLo: null, mosHi: null, strategyId: '', rebound: false, columnOrder: null };
  try {
    const raw = localStorage.getItem(ANALYSIS_FILTERS_KEY);
    if(!raw) return fallback;
    const parsed = JSON.parse(raw);
    const isPct = (n) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100;
    const weekMin = isPct(parsed.weekMin) ? parsed.weekMin : fallback.weekMin;
    const weekMax = isPct(parsed.weekMax) ? parsed.weekMax : fallback.weekMax;
    const monthMin = isPct(parsed.monthMin) ? parsed.monthMin : fallback.monthMin;
    const monthMax = isPct(parsed.monthMax) ? parsed.monthMax : fallback.monthMax;
    const colorBy = parsed.colorBy === 'month' ? 'month' : 'week';
    let xAxis = parsed.xAxis === 'month' ? 'month' : 'week';
    let yAxis = parsed.yAxis === 'month' ? 'month' : 'week';
    if(xAxis === yAxis) yAxis = xAxis === 'week' ? 'month' : 'week'; // the two axes must show different timeframes
    const sortBy = ANALYSIS_SORT_KEYS.has(parsed.sortBy) ? parsed.sortBy : fallback.sortBy;
    const groupBy = ANALYSIS_GROUP_KEYS.has(parsed.groupBy) ? parsed.groupBy : fallback.groupBy;
    const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts.filter(v => ANALYSIS_VERDICT_KEYS.includes(v)) : fallback.verdicts;
    const mosRatings = Array.isArray(parsed.mosRatings) ? parsed.mosRatings.filter(v => ANALYSIS_MOS_KEYS.includes(v)) : fallback.mosRatings;
    const techW = Array.isArray(parsed.techW) ? parsed.techW.filter(v => ANALYSIS_TECH_KEYS.includes(v)) : [];
    const techM = Array.isArray(parsed.techM) ? parsed.techM.filter(v => ANALYSIS_TECH_KEYS.includes(v)) : [];
    const isNum = (n) => typeof n === 'number' && isFinite(n);
    const mosLo = isNum(parsed.mosLo) ? parsed.mosLo : null, mosHi = isNum(parsed.mosHi) ? parsed.mosHi : null;
    const strategyId = typeof parsed.strategyId === 'string' ? parsed.strategyId : '';
    const rebound = parsed.rebound === true;
    const columnOrder = Array.isArray(parsed.columnOrder) ? parsed.columnOrder : fallback.columnOrder;
    return {
      weekMin: Math.min(weekMin, weekMax), weekMax: Math.max(weekMin, weekMax),
      monthMin: Math.min(monthMin, monthMax), monthMax: Math.max(monthMin, monthMax),
      colorBy, xAxis, yAxis, sortBy, groupBy, verdicts, mosRatings, techW, techM, mosLo, mosHi, strategyId, rebound, columnOrder
    };
  } catch(e){ return fallback; }
}
const analysisFilters = loadAnalysisFilters();
// Whether the "Reorder columns" panel is expanded — kept as in-session UI state (not persisted
// to localStorage like analysisFilters) so it starts closed on a fresh visit but stays open
// across re-renders while the viewer is actively reordering columns.
let analysisColumnsPanelOpen = false;

let analysisShownIdx = [];
// Remembered across refreshes (saved with the rest of the screen state; restored in js/ui.js).
function analysisPersistUi(){
  uiStateSet({ aColsOpen: analysisColumnsPanelOpen }, 400);
}

function getAnalysisColumnsPanelOpen(){ return analysisColumnsPanelOpen; }
function getAnalysisShownIdx(){ return analysisShownIdx; }
function setAnalysisColumnsPanelOpen(v){ analysisColumnsPanelOpen = v; }
function setAnalysisShownIdx(v){ analysisShownIdx = v; }

export { ANALYSIS_GROUP_KEYS, ANALYSIS_GROUP_OPTIONS, ANALYSIS_SORT_KEYS, ANALYSIS_SORT_OPTIONS, analysisFilters, analysisPersistUi, analysisSortComparator, getAnalysisColumnsPanelOpen, getAnalysisShownIdx, saveAnalysisFilters, setAnalysisColumnsPanelOpen, setAnalysisShownIdx };
