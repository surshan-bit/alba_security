// Live prices: while the market is open, the stocks you are looking at (up to 50 rows on screen and the open stock page) get a fresh
// price from TradingView every 20 seconds, and their price, Margin of Safety, W% CHG and M% CHG cells change in place (the weekly
// figures are this week's and this month's move against the last close before the week / month began, from the weekly and monthly bars). This is polling, not a
// WebSocket (the page cannot open one); it saves nothing, so a Live Data Refresh is still what stores prices and bars.
import { stocks, stockByTickerSymbol } from '../core/stocks.js';
import { allTrades } from '../core/store.js';
import { renderTradeLogPanel } from '../tradelog/panel.js';
import { detailEl } from '../core/dom.js';
import { getShownIndex } from '../detail/render.js';
import { pcTickerKey, priceSymbolByTicker } from '../prices/store.js';
import { tvCall, tvMcp } from '../tv/connector.js';
import { pctChangeSpan } from '../core/util.js';
import { ldQuote, ldSymOk, ldVerifiedSymbol } from '../livedata/symbols.js';
import { getLdBatch } from '../livedata/batch.js';
import { analysisRowContext } from '../analysis/columns.js';

const INTERVAL_MS = 20000, BACKOFF_MS = 120000, MAX_ROWS = 50, PARALLEL = 3, KEY = 'albaDashboard.live.v1';
let enabled = true, timer = null, busy = false, fails = 0, btn = null, lastAt = 0, lastCount = 0;
try { enabled = localStorage.getItem(KEY) !== 'off'; } catch(e){ /* storage unavailable: on */ }
const livePrice = new Map();   // ticker key -> latest price seen live

// NSE cash session: Monday to Friday, 9:15 to 15:30 India time (exchange holidays are not known here).
function marketOpen(now = new Date()){
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000), d = ist.getDay(), m = ist.getHours() * 60 + ist.getMinutes();
  return d >= 1 && d <= 5 && m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}
const isShown = (el) => !!el && el.offsetParent !== null;
// The Trade Log is open: its open positions are watched too, so their price, return and today's call stay live.
const tradeLogOpen = () => isShown(document.getElementById('section-trackrecord'));
function openTradeIdx(){
  const out = [];
  for(const tr of allTrades()){
    if(tr.status === 'closed' && tr.sell) continue;
    const s = stockByTickerSymbol.get(tr.ticker), idx = s ? stocks.indexOf(s) : -1;
    if(idx >= 0 && !out.includes(idx)) out.push(idx);
  }
  return out;
}

// The stocks to watch: the open stock page first, then the rows on screen, in grid order. When more than MAX_ROWS rows are on
// screen, each sweep takes the ones looked at longest ago, so every row gets its turn (and a sweep stays short).
const lastLook = new Map();   // stock index -> time of its last live price
function watched(){
  const out = [];
  if(tradeLogOpen()) openTradeIdx().forEach(i => out.push(i));
  if(isShown(detailEl)){ const d = getShownIndex(); if(d >= 0 && stocks[d]) out.push(d); }
  const rows = [];
  document.querySelectorAll('.app-section.active tr[data-idx]').forEach(tr => {
    const idx = Number(tr.dataset.idx);
    if(isShown(tr) && stocks[idx] && !out.includes(idx) && !rows.includes(idx)) rows.push(idx);
  });
  const room = MAX_ROWS - out.length;
  if(rows.length <= room) return out.concat(rows);
  const oldest = rows.map((idx, pos) => ({ idx, pos, t: lastLook.get(idx) || 0 })).sort((a, b) => a.t - b.t || a.pos - b.pos).slice(0, room);
  return out.concat(oldest.sort((a, b) => a.pos - b.pos).map(x => x.idx));
}

// W% CHG and M% CHG are this week's and this month's move: the live price against the last close before the week (Monday) or the month
// (the 1st) began, India time. That close comes from the weekly / monthly bars, is read once per stock per period and kept. A stock
// whose bars cannot be read keeps its shown figure.
const refs = new Map();   // 'W' or 'M' + ticker key -> { start, ref }
function periodStartSec(kind, now = Date.now()){
  const ist = new Date(now + 330 * 60000);
  const day = kind === 'W' ? ist.getUTCDate() - (ist.getUTCDay() + 6) % 7 : 1;   // the Monday of this week, or the 1st of this month
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), day) / 1000 - 330 * 60;
}
async function periodRefOf(kind, key, sym){
  const start = periodStartSec(kind), id = kind + key, have = refs.get(id);
  if(have && have.start === start) return have.ref;
  const p = await tvCall('mcp-tv-get-ohlcv', { symbol: sym, interval: kind === 'W' ? '1W' : '1mo', count: 4, format: 'columns' });
  const b = p && p.bars, t = b && b.t, c = b && b.c;
  if(!Array.isArray(t) || !Array.isArray(c) || t.length !== c.length) return null;
  let ref = null;
  for(let i = 0; i < t.length; i++){ const v = Number(c[i]); if(t[i] < start && isFinite(v) && v > 0) ref = v; }
  if(ref != null) refs.set(id, { start, ref });
  return ref;
}

// One look at a stock: its current price and TradingView's weekly and monthly performance, from the same call.
async function quoteOf(s){
  const key = pcTickerKey(s);
  const known = ldSymOk.get(key);
  if(!known){ return await ldVerifiedSymbol(s); }   // the first look also finds the right TradingView symbol
  return await ldQuote(priceSymbolByTicker[key] || known.sym);
}

// Price, Margin of Safety, W% CHG and M% CHG change in place. `changed` flags the cells whose value moved.
function paintRow(tr, s, idx, changed){
  const ctx = analysisRowContext(s, 0, idx);
  const mos = tr.querySelector('[data-live="mos"]'), px = tr.querySelector('[data-live="price"]');
  const wk = tr.querySelector('[data-live="weekChg"]'), mo = tr.querySelector('[data-live="monthChg"]');
  if(mos){ mos.textContent = ctx.mosLabel; mos.className = mos.className.replace(/\bmos-\w+\b/g, '').trim() + ' ' + ctx.mosClass; }
  if(px) px.textContent = ctx.price;
  if(wk) wk.innerHTML = pctChangeSpan(ctx.r.weekPctChange);
  if(mo) mo.innerHTML = pctChangeSpan(ctx.r.monthPctChange);
  [[mos, changed.price], [px, changed.price], [wk, changed.week], [mo, changed.month]].forEach(([c, on]) => { if(c && on){ c.classList.remove('live-flash'); void c.offsetWidth; c.classList.add('live-flash'); } });
}
// A small live price beside the open stock's ticker (the stock page itself is only redrawn when it is opened again).
function paintDetail(){
  const idx = getShownIndex(), s = stocks[idx];
  const host = detailEl.querySelector('.detail-ticker');
  if(!host || !s) return;
  const v = livePrice.get(pcTickerKey(s));
  let chip = host.querySelector('.live-px');
  if(v == null){ if(chip) chip.remove(); return; }
  if(!chip){ chip = document.createElement('span'); chip.className = 'live-px'; host.appendChild(chip); }
  const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  chip.textContent = '₹' + v.toLocaleString('en-IN') + ' live · ' + t;
  chip.classList.remove('live-flash'); void chip.offsetWidth; chip.classList.add('live-flash');
}

function paintButton(){
  if(!btn) return;
  const open = marketOpen(), live = enabled && open && !document.hidden && fails < 3;
  btn.className = 'live-toggle' + (enabled ? ' on' : '') + (live ? ' live' : '');
  btn.textContent = !enabled ? 'Live off' : !open ? 'Market closed' : fails >= 3 ? 'Live paused' : '● Live';
  btn.dataset.short = !enabled ? 'Live off' : !open ? 'Closed' : fails >= 3 ? 'Paused' : 'Live';
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  btn.title = !enabled ? 'Turn live prices on' : !open ? 'Live prices run on weekdays 9:15 to 15:30 (India time). Click to turn off.' : fails >= 3 ? 'TradingView did not answer; trying again every 2 minutes. Click to turn off.' : 'Prices of the stocks on screen refresh every 20 seconds (' + lastCount + ' watched' + (lastAt ? ', last ' + new Date(lastAt).toLocaleTimeString('en-IN', { hour12: false }) : '') + '). Nothing is saved. Click to turn off.';
}

async function tick(){
  if(busy) return;
  paintButton();
  if(!enabled || document.hidden || !marketOpen()) return;
  const batch = getLdBatch();
  if(batch && batch.running) return;   // a refresh is using the connector
  const list = watched();
  lastCount = list.length;
  if(!list.length || !(await tvMcp())) return;
  busy = true;
  let ok = 0, bad = 0, i = 0;
  const worker = async () => {
    while(i < list.length){
      const idx = list[i++], s = stocks[idx];
      try {
        const q = await quoteOf(s), px = q.price;
        if(px == null){ bad++; continue; }
        const key = pcTickerKey(s), before = s.valuation && s.valuation.currentPrice;
        livePrice.set(key, px); lastLook.set(idx, Date.now()); s.liveAt = Date.now();
        if(!s.valuation) s.valuation = {};
        s.valuation.currentPrice = px;
        // W% CHG and M% CHG follow the live price too. They are kept on the stock's technical readings, so sorting, filters and
        // every grid agree with what is shown; a stock without technical readings has none to move. A figure TradingView did
        // not return leaves the saved one in place.
        const raw = s.technical && s.technical.raw, changed = { price: before !== px, week: false, month: false };
        if(raw){
          const sym = priceSymbolByTicker[key] || (ldSymOk.get(key) || {}).sym;
          for(const [kind, field, flag] of [['W', 'weekPctChange', 'week'], ['M', 'monthPctChange', 'month']]){
            let ref = null;
            try { ref = await periodRefOf(kind, key, sym); } catch(e){ /* keeps the shown figure */ }
            if(ref != null){ const v = Math.round((px / ref - 1) * 10000) / 100; changed[flag] = raw[field] !== v; raw[field] = v; }
          }
        }
        document.querySelectorAll('.app-section.active tr[data-idx="' + idx + '"]').forEach(tr => paintRow(tr, s, idx, changed));
        ok++;
      } catch(e){ bad++; }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker)); }
  finally { busy = false; }
  if(ok){ fails = 0; lastAt = Date.now(); paintDetail(); if(tradeLogOpen()) renderTradeLogPanel(); } else if(bad) fails++;
  paintButton();
}

function schedule(){
  clearTimeout(timer);
  timer = setTimeout(async () => { await tick(); schedule(); }, fails >= 3 ? BACKOFF_MS : INTERVAL_MS);
}

function init_live_ticker(){
  const search = document.querySelector('.topbar-search');
  if(!search) return;
  btn = document.createElement('button');
  btn.type = 'button';
  search.parentNode.insertBefore(btn, search.nextSibling);
  btn.addEventListener('click', () => {
    enabled = !enabled; fails = 0;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch(e){ /* kept for this visit only */ }
    paintButton(); if(enabled) tick();
  });
  document.addEventListener('visibilitychange', () => { if(!document.hidden) tick(); paintButton(); });
  // a page switch or an opened stock brings new rows on screen: look at them soon
  document.addEventListener('click', () => { setTimeout(() => { if(enabled && !busy && marketOpen()) tick(); }, 1500); });
  paintButton();
  schedule();
  setTimeout(tick, 4000);
}

export { init_live_ticker };
