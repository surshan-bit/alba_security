// Median weekly % change of each industry (all of its stocks), for showing next to the industry name in the grids.
import { stocks } from './stocks.js';
import { tickerIndustry } from './util.js';

let cache = null, builtAt = 0;
function build(){
  const by = new Map();
  stocks.forEach(s => {
    const raw = s.technical && s.technical.raw, v = raw ? raw.weekPctChange : null;
    if(!Number.isFinite(v)) return;
    const k = tickerIndustry(s);
    if(!by.has(k)) by.set(k, []);
    by.get(k).push(v);
  });
  const out = new Map();
  by.forEach((xs, k) => { xs.sort((a, b) => a - b); const m = xs.length >> 1; out.set(k, xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2); });
  return out;
}
// null when the industry has no weekly figures.
function industryMedianW(s){
  const now = Date.now();
  if(!cache || now - builtAt > 5000){ cache = build(); builtAt = now; }   // refreshed price data shows up within a few seconds
  const v = cache.get(tickerIndustry(s));
  return v === undefined ? null : v;
}

export { industryMedianW };
