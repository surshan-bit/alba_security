// The Analysis "Buy / Sell ideas" filter (v1.295): narrows the table to the stocks in the Upward trend or Downward trend list that Process
// made in the Trade Log, so the header Refresh button works on just that shortlist. It reads the saved Process result (identity/ideasresults.js)
// of the strategy chosen in Analysis, or the newest result when no strategy is chosen. No result saved yet means no stock to show.
import { stocks } from '../core/stocks.js';
import { tickerSymbol } from '../core/util.js';
import { ideasResultsGet } from '../identity/ideasresults.js';
import { publishedStrategies } from '../strategies/state.js';

const IDEAS_KINDS = new Set(['up', 'down']);
const cleanIdeas = (v) => (IDEAS_KINDS.has(v) ? v : '');

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
function ideasStockSet(kind, strategyId){
  const source = ideasSource(strategyId);
  if(!cleanIdeas(kind)) return { set: null, source };
  const syms = new Set(((source.snap && source.snap.lists[kind]) || []).map(x => x.sym));
  return { set: new Set(stocks.filter(s => syms.has(tickerSymbol(s)))), source };
}
// "29 Oct 2026, 10:04 am" of when the result was made.
function ideasWhen(snap){
  const d = new Date(snap && snap.at);
  if(isNaN(d.getTime())) return '';
  const tz = { timeZone: 'Asia/Kolkata' };
  return d.toLocaleDateString('en-IN', { ...tz, day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + d.toLocaleTimeString('en-IN', { ...tz, hour: 'numeric', minute: '2-digit', hour12: true });
}

export { ideasStockSet, ideasWhen };
