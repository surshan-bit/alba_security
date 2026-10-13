// What is missing for a stock, and the Live Data Refresh bar entry point.
import { isProxyFactor } from './fundtext.js';
import { fundMissingMetrics } from './completeness.js';
import { pcTickerKey, priceHistoryByTicker, priceLoaded } from '../prices/store.js';
import { renderLiveDataBar } from '../livedata/bar.js';

// Global/macro factors — a separate, optional panel naming the global commodity, demand-cycle,
// currency and trade-policy linkages that can move a stock's price, independent of the
// company-specific fundamentals and RSI/MACD technical read above. Currently populated for a
// pilot set of stocks (ACE, APL Apollo, Pricol); rolled out further as it proves useful.
// ---- Stock-level "Research this stock" (2026-10-06) ----
// ONE button at the top of a stock's detail screen. It researches everything missing for that stock
// in a single request: the Fundamental Score's Data-proxy / incomplete factors, any missing Technical
// Score inputs, and the Global & Macro Information. Same mechanism as the earlier per-panel buttons:
// opens a new Claude conversation with the request pre-filled and copies it to the clipboard.
// A factor with `research` is no longer a "Data proxy", and its remaining "n/a" figures count as
// already looked for.
function fundamentalPendingItems(s){
  const fs = (s.fundamentals && Array.isArray(s.fundamentals.factors)) ? s.fundamentals.factors : [];
  const items = [];
  fs.forEach(f => {
    const proxy = isProxyFactor(f);
    const missing = f.research ? [] : fundMissingMetrics(f);
    if(proxy || missing.length){
      items.push({ key: f.key, name: String(f.name).replace(/&amp;/g,'&'), weight: f.weight, score: f.score, proxy, missing });
    }
  });
  return items;
}
function technicalPendingItems(s){
  const t = s.technical;
  if(!t) return { none:true, keys:[] };
  const st = t.states || {};
  const keys = ['monthMacd','weekMacd','monthRsi','weekRsi'].filter(k => st[k] == null);
  return { none:false, keys, noScore: t.score == null };
}
function globalPendingInfo(s){
  const g = s.globalFactors;
  const hasContent = !!(g && ((g.positive && g.positive.length) || (g.negative && g.negative.length)));
  if(!hasContent) return 'not yet researched';
  if(g.scope !== 'company') return 'sector-level only, not researched for this company';
  return null;
}
// Price history (Daily / Weekly / Monthly bars in the `priceHistory` collection) is optional per stock.
// "Needed" = nothing stored yet, or the newest weekly bar is more than 14 days old. It is a separate tick-box,
// not part of the "missing" list, so it only runs when you want it for that stock.
function priceHistoryStatus(s){
  const d = (typeof priceHistoryByTicker !== 'undefined' && priceHistoryByTicker) ? priceHistoryByTicker[pcTickerKey(s)] : null;
  if(!d || !d['1W'] || !d['1W'].length) return { has:false, needed:true, text: (typeof priceLoaded !== 'undefined' && priceLoaded.has(pcTickerKey(s))) ? 'none stored yet' : 'loading…' };
  const last = d['1W'][d['1W'].length - 1][0];
  const lastTxt = new Date((last + 19800) * 1000).toLocaleDateString('en-GB', {timeZone:'UTC', day:'numeric', month:'short', year:'numeric'});
  const ageDays = (Date.now() / 1000 - last) / 86400;
  // Delta refresh: only the bars since the last stored one (plus 3 of overlap, so closed bars can be cross-checked) are fetched.
  const nowS = Date.now() / 1000, lastM = d['1M'] && d['1M'].length ? d['1M'][d['1M'].length - 1][0] : null;
  const wkN = Math.ceil((nowS - last) / (7 * 86400)) + 3;
  let moN = null;
  if(lastM){ const a = new Date((lastM + 19800) * 1000), b = new Date((nowS + 19800) * 1000); moN = (b.getUTCFullYear() * 12 + b.getUTCMonth()) - (a.getUTCFullYear() * 12 + a.getUTCMonth()) + 3; }
  const delta = !!(lastM && wkN < 200 && moN < 50) ? { wkN, moN, lastW:last, lastM } : null;
  return ageDays > 14 ? { has:true, needed:true, delta, text:`last bar ${lastTxt}, ${Math.floor(ageDays)} days old` }
                     : { has:true, needed:false, delta, text:`up to date, last bar ${lastTxt}` };
}
// v1.22: the old "Research this stock" / price-history tick-box / "Refresh price & technicals" controls are replaced by the
// two Live Data Refresh buttons in js/livedata.js. singleStockResearchMessage() below stays: the Analysis screen still uses it.
function renderStockResearchBar(s){
  return renderLiveDataBar(s);
}

export { fundamentalPendingItems, globalPendingInfo, priceHistoryStatus, renderStockResearchBar, technicalPendingItems };
