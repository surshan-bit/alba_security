// Analysis screen state: the sorted column, saved filters and persistence.
import { prefSet, uiStateSet } from '../identity/prefs.js';

// Sorting is by a column header (see columns.js): { col, dir }. These are the columns that can be sorted, and the readings of the old "Sort by" menu
// (saved before v1.273) mapped to the column and direction they meant, so a saved choice still applies.
const SORTABLE_COLUMNS = new Set(['score', 'techScore', 'mos', 'stock', 'weekChg', 'monthChg', 'weekRsi', 'monthRsi', 'techW', 'techM', 'idea', 'news', 'industry', 'triggered', 'price']);
const LEGACY_SORT = {
  mos_desc: ['mos', 'desc'], mos_asc: ['mos', 'asc'], score_desc: ['score', 'desc'], weekRsi_desc: ['weekRsi', 'desc'], weekRsi_asc: ['weekRsi', 'asc'],
  monthRsi_desc: ['monthRsi', 'desc'], monthRsi_asc: ['monthRsi', 'asc'], weekChg_desc: ['weekChg', 'desc'], monthChg_desc: ['monthChg', 'desc'],
  price_desc: ['price', 'desc'], research_old: ['triggered', 'desc'], research_new: ['triggered', 'asc'], name_asc: ['stock', 'asc']
};
// A saved sort ({ col, dir } or the legacy key) made safe: an unknown column or direction falls back to `fallback`.
function cleanSort(col, dir, legacy, fallback){
  if(typeof col === 'string' && SORTABLE_COLUMNS.has(col)) return { col, dir: dir === 'asc' ? 'asc' : 'desc' };
  const l = typeof legacy === 'string' ? LEGACY_SORT[legacy] : null;
  return l ? { col: l[0], dir: l[1] } : fallback;
}

// "View": the stocks one by one, or one row per industry / industry group (the table Explorer has).
const ANALYSIS_VIEW_OPTIONS = [
  { value: 'stocks', label: 'Stocks' },
  { value: 'industry', label: 'Industry' },
  { value: 'group', label: 'Industry Group' }
];
const ANALYSIS_VIEW_KEYS = new Set(ANALYSIS_VIEW_OPTIONS.map(o => o.value));

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
  const fallback = { weekMin: 0, weekMax: 100, monthMin: 0, monthMax: 100, colorBy: 'week', xAxis: 'week', yAxis: 'month', sortCol: 'mos', sortDir: 'desc', view: 'stocks', verdicts: [], mosRatings: ['green'], techW: [], techM: [], mosLo: null, mosHi: null, strategyId: '', ideas: [], rebound: false, columnOrder: null };
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
    const sort = cleanSort(parsed.sortCol, parsed.sortDir, parsed.sortBy, { col: fallback.sortCol, dir: fallback.sortDir });
    // Saved before v1.276 as "Group by" (none / industry / group): the nearest View is the industry table of the same kind.
    const view = ANALYSIS_VIEW_KEYS.has(parsed.view) ? parsed.view : (parsed.groupBy === 'industry' || parsed.groupBy === 'group' ? parsed.groupBy : fallback.view);
    const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts.filter(v => ANALYSIS_VERDICT_KEYS.includes(v)) : fallback.verdicts;
    const mosRatings = Array.isArray(parsed.mosRatings) ? parsed.mosRatings.filter(v => ANALYSIS_MOS_KEYS.includes(v)) : fallback.mosRatings;
    const techW = Array.isArray(parsed.techW) ? parsed.techW.filter(v => ANALYSIS_TECH_KEYS.includes(v)) : [];
    const techM = Array.isArray(parsed.techM) ? parsed.techM.filter(v => ANALYSIS_TECH_KEYS.includes(v)) : [];
    const isNum = (n) => typeof n === 'number' && isFinite(n);
    const mosLo = isNum(parsed.mosLo) ? parsed.mosLo : null, mosHi = isNum(parsed.mosHi) ? parsed.mosHi : null;
    const strategyId = typeof parsed.strategyId === 'string' ? parsed.strategyId : '';
    // v1.306: Upward and Downward Trend can be chosen together, so this is a list. Before, it was one word ('up' or 'down'), which is read as a list of one.
    const ideas = [...new Set((Array.isArray(parsed.ideas) ? parsed.ideas : [parsed.ideas]).filter(v => v === 'up' || v === 'down'))];
    const rebound = parsed.rebound === true;
    const columnOrder = Array.isArray(parsed.columnOrder) ? parsed.columnOrder : fallback.columnOrder;
    return {
      weekMin: Math.min(weekMin, weekMax), weekMax: Math.max(weekMin, weekMax),
      monthMin: Math.min(monthMin, monthMax), monthMax: Math.max(monthMin, monthMax),
      colorBy, xAxis, yAxis, sortCol: sort.col, sortDir: sort.dir, view, verdicts, mosRatings, techW, techM, mosLo, mosHi, strategyId, ideas, rebound, columnOrder
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

export { ANALYSIS_VIEW_KEYS, ANALYSIS_VIEW_OPTIONS, analysisFilters, analysisPersistUi, cleanSort, getAnalysisColumnsPanelOpen, getAnalysisShownIdx, saveAnalysisFilters, setAnalysisColumnsPanelOpen, setAnalysisShownIdx };
