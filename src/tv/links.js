// TradingView symbol map, links and the embedded chart.
import { LINK_ICON } from '../detail/icons.js';
import { dbCapabilityPromise } from '../core/store.js';

// NOTE: An embedded TradingView chart (iframe) was tried here and confirmed blocked
// by the Artifact sandbox's CSP (net::ERR_BLOCKED_BY_CSP) — Artifacts only allow a
// couple of approved CDN domains and block third-party iframes outright. Using a plain
// external link instead, now enabled for all stocks (was scoped to CASTROLIND for testing).

// A stock with no NSE listing stores a raw BSE numeric code as its `ticker` placeholder (e.g.
// "522294 · Industrial Products" for T & I Global) since there's no alpha symbol to show. That bare
// number is not a valid TradingView symbol on its own, so "Open chart on TradingView" for these
// ~180 stocks used to link to NSE:<numeric-code> and TradingView correctly showed no data for it
// (found 2026-09-30). This cache — resolved via the anthropic-skills:tradingview-watchlist-symbol-mapping
// skill's company-name search technique, the same one used to sync the TradingView watchlists —
// maps each raw code to its real BSE alpha symbol so the chart link actually resolves.
const BSE_ALPHA_MAP = {};   // BSE numeric code -> TradingView alpha symbol; loaded from the database document stockMeta/bseAlpha (flat { "<code>": "<symbol>" })

function tvUrlFor(s){
  const sym = s.ticker.split('·')[0].trim().toUpperCase();
  if(/^[0-9]+$/.test(sym)){
    // Raw BSE numeric code — resolve to its real alpha symbol and use the BSE exchange prefix.
    // Falls back to the bare code (better than nothing) on the rare unmapped case.
    return `https://www.tradingview.com/chart/?symbol=BSE%3A${encodeURIComponent(BSE_ALPHA_MAP[sym] || sym)}`;
  }
  return `https://www.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(sym)}`;
}
function renderTvChart(s){
  return `<a href="${tvUrlFor(s)}" target="_blank" rel="noopener noreferrer" class="tv-chart-link">${LINK_ICON}<span>Open chart on TradingView</span></a>`;
}

function init_tv_links(){
dbCapabilityPromise.then(db => db ? db.doc('stockMeta/bseAlpha').get() : null).then(r => {
  if(r && r.exists){ const d = r.data() || {}; Object.keys(d).forEach(k => { if(typeof d[k] === 'string') BSE_ALPHA_MAP[k] = d[k]; }); }
}).catch(() => {});
}

export { init_tv_links, renderTvChart, tvUrlFor };
