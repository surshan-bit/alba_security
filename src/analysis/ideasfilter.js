// The Analysis "Buy / Sell ideas" filter (v1.295): narrows the table to the stocks in the Upward trend or Downward trend list that Process
// made in the Trade Log, so the header Refresh button works on just that shortlist. It reads the saved Process result (identity/ideasresults.js)
// of the strategy chosen in Analysis, or the newest result when no strategy is chosen. No result saved yet means no stock to show.
import { stockByTickerSymbol } from '../core/stocks.js';
import { ideasResultsGet } from '../identity/ideasresults.js';
import { publishedStrategies } from '../strategies/state.js';

const IDEAS_KINDS = new Set(['up', 'down']);
const cleanIdeas = (v) => (Array.isArray(v) ? v : [v]).filter(k => IDEAS_KINDS.has(k));

// -> { sid, name, snap }: the saved result that applies, or snap null when there is none.
function ideasSource(strategyId){
  const all = ideasResultsGet(), strategies = publishedStrategies();
  let sid = strategyId && all[strategyId] ? strategyId : '';
  if(!strategyId){
    sid = Object.keys(all).filter(k => all[k] && all[k].lists && strategies.some(x => x.id === k)).sort((a, b) => String(all[b].at).localeCompare(String(all[a].at)))[0] || '';
  }
  const st = strategies.find(x => x.id === (strategyId || sid));
  return { sid, name: st ? st.name : '', snap: sid && all[sid] && all[sid].lists ? all[sid] : null };
}
// -> { set, source }: set is null for "All" (no narrowing), otherwise the stocks of that list (empty when nothing is saved).
// v1.306: the sets are kept until the saved result changes. A redraw asks for them a dozen times (the table, every filter count, the hidden-stocks note), and each
// ask used to scan the whole stock list again, which made every click in Analysis take over a second while this filter was on.
const setMemo = new Map();   // "<kind>|<strategy id>" -> { snap, set }
function kindSet(kind, strategyId, source){
  const key = kind + '|' + (strategyId || ''), hit = setMemo.get(key);
  if(hit && hit.snap === source.snap) return hit.set;
  const set = new Set();
  ((source.snap && source.snap.lists[kind]) || []).forEach(x => { const s = stockByTickerSymbol.get(x.sym); if(s) set.add(s); });
  setMemo.set(key, { snap: source.snap, set });
  return set;
}
// `kinds` is the chosen lists ('up', 'down', or both: the stocks of either list); none chosen means All.
function ideasStockSet(kinds, strategyId){
  const source = ideasSource(strategyId), chosen = cleanIdeas(kinds);
  if(!chosen.length) return { set: null, source };
  if(chosen.length === 1) return { set: kindSet(chosen[0], strategyId, source), source };
  const both = ideasBoth.get(strategyId || '');
  const a = kindSet('up', strategyId, source), b = kindSet('down', strategyId, source);
  if(both && both.a === a && both.b === b) return { set: both.set, source };
  const set = new Set([...a, ...b]);
  ideasBoth.set(strategyId || '', { a, b, set });
  return { set, source };
}
const ideasBoth = new Map();
// "29 Oct 2026, 10:04 am" of when the result was made.
function ideasWhen(snap){
  const d = new Date(snap && snap.at);
  if(isNaN(d.getTime())) return '';
  const tz = { timeZone: 'Asia/Kolkata' };
  return d.toLocaleDateString('en-IN', { ...tz, day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString('en-IN', { ...tz, hour: 'numeric', minute: '2-digit', hour12: true });
}

export { ideasStockSet, ideasWhen };
