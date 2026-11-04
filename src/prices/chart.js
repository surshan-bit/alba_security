// Weekly and monthly price chart.
import { pcTickerKey, priceHistoryByTicker } from './store.js';
import { followPrice, periodStartSec } from './periodmove.js';
import { EVENT_GROUPS, barReaction, eventsByBar, stockChartEvents } from './events.js';
import { bandRects, buildChartSvg } from './chartsvg.js';
import { changePct, eventTipHtml, macdTipHtml, tipLabel, tipLeft, tooltipHtml } from './charttip.js';
import { techMacdSeries } from '../engine/technical.js';
import { setHtml } from '../core/safehtml.js';

var pcObserver = null;
var pcKeyOpen = false;   // the colour key and event-tag buttons under "Price history" start hidden
function pcHasData(s){ const d = priceHistoryByTicker[pcTickerKey(s)]; return !!(d && d['1W'] && d['1M']); }
// One button per kind of event this stock has; pressing it hides or shows that lane of tags.
function renderEventToggles(s){
  const have = new Set(stockChartEvents(s).map(e => e.group));
  const btns = EVENT_GROUPS.filter(g => have.has(g.id)).map(g => `<button type="button" class="pc-evtoggle" data-g="${g.id}" aria-pressed="true"><span class="pc-evk pc-evk-${g.id}">${g.glyph}</span>${g.label}</button>`).join('');
  const labelled = stockChartEvents(s).some(e => e.group === 'news' && e.s);
  const key = labelled ? '<span class="pc-evkey"><i class="s-pos"></i>positive<i class="s-neg"></i>negative<i class="s-mix"></i>mixed<i class="s-neu"></i>neutral</span>' : '';
  return btns ? `<div class="pc-evlegend" role="group" aria-label="Event tags under the charts"><span class="pc-evlegend-label">Event tags</span>${btns}${key}</div>` : '';
}
// `sums` ({'1W': html, '1M': html}) are the change / rating / RSI figures of each timeframe; they are carried hidden and shown in that chart's header.
function renderPriceChartMount(s, sums){
  if(!pcHasData(s)) return '';
  return `<div class="pc-block${pcKeyOpen ? ' show-key' : ''}" id="priceChartBlock">
    <div class="pc-head"><button type="button" class="pc-keytoggle" id="pcKeyToggle" aria-expanded="${pcKeyOpen}">${pcKeyOpen ? 'Hide legend' : 'Legend'}</button></div>
    <div class="pc-legend"><span><i class="pc-up"></i>Close above open</span><span><i class="pc-down"></i>Close below open</span><span><i class="pc-vol"></i>Volume</span><span><i class="pc-lm"></i>MACD</span><span><i class="pc-ls"></i>MACD signal</span></div>
    ${renderEventToggles(s)}
    <div class="pc-panels"></div>
    <div class="pc-sums" hidden>${['1W', '1M'].map(k => `<div data-k="${k}">${sums && sums[k] || ''}</div>`).join('')}</div></div>`;
}
// The two timeframes, in the order they are shown. `ranges` are [button label, bars to show]; `def` is the range chosen first; `lbl` / `every` shape the date labels.
const ORDER = ['1W', '1M'];
const CFG = {
  '1M': { title: 'Monthly', ranges: [['1Y', 12], ['3Y', 36], ['5Y', 60], ['All', 999]], def: 3, lbl: { month: 'short', year: '2-digit' }, every: 3 },
  '1W': { title: 'Weekly', ranges: [['6M', 26], ['1Y', 52], ['All', 999]], def: 2, lbl: { day: 'numeric', month: 'short' }, every: 0 }
};
const PERIOD_SECS = { '1W': 7 * 86400, '1M': 31 * 86400 };
const FOLLOW_SECS = { '1W': 8 * 86400, '1M': 32 * 86400 };   // how far back the saved last bar may start and still be this week's / month's bar
const RESIZE_PAUSE_MS = 80, DEFAULT_WIDTH_PX = 320;

/**
 * Everything one drawn chart pair shares.
 * @typedef {{ root: Element, panels: Element, bars: Record<string, any[]>, macd: Record<string, any>, groups: any[], shown: Set<string>, byBar: Record<string, Map<number, any[]>>, events: any[], state: Record<string, number>, hover: Record<string, number>, geo: Record<string, any> }} ChartCtx
 */

const panelOf = (ctx, k) => /** @type {Element} */ (ctx.panels.querySelector('[data-k="' + k + '"]'));

/** The saved bars, with this week's and this month's bar following the current price as W % chg / M % chg do. */
function barsFor(s){
  const saved = priceHistoryByTicker[pcTickerKey(s)], px = s.valuation && s.valuation.currentPrice, now = Date.now();
  return Object.assign({}, saved, { '1W': followPrice(saved['1W'], px, periodStartSec('W', now), FOLLOW_SECS['1W']), '1M': followPrice(saved['1M'], px, periodStartSec('M', now), FOLLOW_SECS['1M']) });
}

function rebuildEvents(ctx){
  ORDER.forEach((k) => { ctx.byBar[k] = eventsByBar(ctx.events, ctx.bars[k], PERIOD_SECS[k], ctx.shown); });
}

function createChart(root, s){
  const bars = barsFor(s), macd = {}, events = stockChartEvents(s), groups = EVENT_GROUPS.filter((g) => events.some((e) => e.group === g.id));
  // MACD (12, 26, 9) of every bar, from all the bars so it does not change with the range chosen; null for a stock with too little history (no panel).
  ORDER.forEach((k) => { macd[k] = techMacdSeries(bars[k].map((r) => r[4])); });
  const ctx = { root, panels: /** @type {Element} */ (root.querySelector('.pc-panels')), bars, macd, groups, shown: new Set(groups.map((g) => g.id)), byBar: {}, events, state: {}, hover: {}, geo: {} };
  rebuildEvents(ctx);
  return ctx;
}

/** Time span [start, end) of bar i of timeframe k. */
function barSpan(ctx, k, i){ const b = ctx.bars[k]; return [b[i][0], i + 1 < b.length ? b[i + 1][0] : b[i][0] + PERIOD_SECS[k]]; }

/** Shade, on each chart, the bars that overlap the bar hovered on the other chart. */
function drawBands(ctx){
  ORDER.forEach((k) => {
    const g = panelOf(ctx, k).querySelector('.pc-band'), G = ctx.geo[k];
    if(!g || !G) return;
    const others = Object.keys(ctx.hover).filter((src) => src !== k).map((src) => barSpan(ctx, src, ctx.hover[src]));
    setHtml(g, bandRects(G, others, (i) => barSpan(ctx, k, i)));
  });
}

function drawPanel(ctx, k){
  const el = panelOf(ctx, k), svg = /** @type {Element} */ (el.querySelector('svg')), all = ctx.bars[k];
  const n = Math.min(all.length, CFG[k].ranges[ctx.state[k]][1]), off = all.length - n;
  const built = buildChartSvg({ view: all.slice(off), off, cfg: CFG[k], ms: ctx.macd[k], lanes: ctx.groups.filter((g) => ctx.shown.has(g.id)), byBar: ctx.byBar[k], W: /** @type {Element} */ (el.querySelector('.pc-chart')).clientWidth || DEFAULT_WIDTH_PX });
  svg.setAttribute('viewBox', `0 0 ${built.geo.W} ${built.geo.H}`); setHtml(svg, built.html);
  ctx.geo[k] = built.geo;
  drawBands(ctx);
}

const drawAll = (ctx) => ORDER.forEach((k) => drawPanel(ctx, k));

function tooltipFor(ctx, k, j){
  const bar = ctx.bars[k][j], per = k === '1W' ? 'week' : 'month';
  return tooltipHtml(tipLabel(k, bar), bar, changePct(bar, ctx.bars[k][j - 1]), macdTipHtml(ctx.macd[k], j) + eventTipHtml(ctx.byBar[k].get(j), barReaction(ctx.bars[k], j), per, EVENT_GROUPS));
}

/** The bar under the pointer: crosshair, the other chart's band, and the tooltip beside it. */
function onMove(ctx, k, e){
  const G = ctx.geo[k], el = panelOf(ctx, k), rect = /** @type {Element} */ (el.querySelector('.pc-chart')).getBoundingClientRect();
  const px = (e.clientX - rect.left) * (G.W / rect.width), i = Math.max(0, Math.min(G.n - 1, Math.floor((px - G.padL) / G.step)));
  ctx.hover[k] = G.off + i; drawBands(ctx);
  const xh = /** @type {Element} */ (el.querySelector('.pc-xh')), tip = /** @type {HTMLElement} */ (el.querySelector('.pc-tip'));
  xh.setAttribute('x1', String(G.X(i))); xh.setAttribute('x2', String(G.X(i))); xh.setAttribute('opacity', '1');
  setHtml(tip, tooltipFor(ctx, k, G.off + i));
  tip.style.setProperty('--x', tipLeft(rect.width, tip.offsetWidth, G.X(i) * (rect.width / G.W)) + 'px'); tip.classList.add('is-shown');
}

function onLeave(ctx, k){
  const el = panelOf(ctx, k);
  delete ctx.hover[k]; drawBands(ctx);
  /** @type {HTMLElement} */ (el.querySelector('.pc-tip')).classList.remove('is-shown'); /** @type {Element} */ (el.querySelector('.pc-xh')).setAttribute('opacity', '0');
}

/** The legend toggle, and the buttons that hide or show a kind of event tag. */
function wireLegend(ctx){
  const keyBtn = ctx.root.querySelector('#pcKeyToggle');
  if(keyBtn) keyBtn.addEventListener('click', () => {
    pcKeyOpen = !pcKeyOpen;
    ctx.root.classList.toggle('show-key', pcKeyOpen);
    keyBtn.setAttribute('aria-expanded', String(pcKeyOpen));
    keyBtn.textContent = pcKeyOpen ? 'Hide legend' : 'Legend';
  });
  ctx.root.querySelectorAll('.pc-evtoggle').forEach((btn) => btn.addEventListener('click', () => {
    const id = /** @type {string} */ (/** @type {HTMLElement} */ (btn).dataset.g), on = !ctx.shown.has(id);
    if(on) ctx.shown.add(id); else ctx.shown.delete(id);
    btn.setAttribute('aria-pressed', String(on));
    rebuildEvents(ctx); drawAll(ctx);
  }));
}

function panelHtml(ctx, k){
  const c = CFG[k];
  return `<div class="pc-ph"><div class="pc-ptitle">${c.title}<small>${ctx.bars[k].length} bars</small></div><div class="pc-psum"></div><div class="pc-pills" role="group" aria-label="${c.title} range">${c.ranges.map((r, i) => `<button type="button" class="pc-pill" data-i="${i}" aria-pressed="${i === ctx.state[k]}">${r[0]}</button>`).join('')}</div></div>
      <div class="pc-chart"><svg role="img" aria-label="${c.title} candlestick chart with volume and MACD"></svg><div class="pc-tip"></div></div>`;
}

/** The range buttons of one panel, and the pointer handling of its chart (moves are applied once per animation frame). */
function wirePanel(ctx, el, k){
  el.querySelectorAll('.pc-pill').forEach((btn) => /** @type {HTMLElement} */ (btn).onclick = () => {
    ctx.state[k] = +/** @type {string} */ (/** @type {HTMLElement} */ (btn).dataset.i);
    el.querySelectorAll('.pc-pill').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    drawPanel(ctx, k);
  });
  const ch = /** @type {Element} */ (el.querySelector('.pc-chart')); let pending = null, frame = 0;
  ch.addEventListener('pointermove', (e) => { pending = e; if(!frame) frame = requestAnimationFrame(() => { frame = 0; if(pending) onMove(ctx, k, pending); }); });
  ch.addEventListener('pointerleave', () => { pending = null; onLeave(ctx, k); });
}

function buildPanel(ctx, k){
  ctx.state[k] = CFG[k].def;
  const el = document.createElement('div'); el.className = 'pc-panel'; el.dataset.k = k;
  setHtml(el, panelHtml(ctx, k));
  // the summary figures are copied as nodes: serialising them to HTML and parsing that again would lose their custom properties under a strict policy
  const figures = ctx.root.querySelector('.pc-sums [data-k="' + k + '"]');
  if(figures) /** @type {Element} */ (el.querySelector('.pc-psum')).append(...Array.from(figures.childNodes, (n) => n.cloneNode(true)));
  ctx.panels.appendChild(el);
  wirePanel(ctx, el, k);
}

/** Redraw after the page is resized, once the resizing has paused. */
function watchResize(ctx){
  let timer;
  pcObserver = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => { if(ctx.root.isConnected) drawAll(ctx); }, RESIZE_PAUSE_MS); });
  pcObserver.observe(ctx.root);
}

function initPriceChart(s){
  if(pcObserver){ pcObserver.disconnect(); pcObserver = null; }
  const root = document.getElementById('priceChartBlock'); if(!root || !pcHasData(s)) return;
  const ctx = createChart(root, s);
  wireLegend(ctx);
  ORDER.forEach((k) => buildPanel(ctx, k));
  drawAll(ctx);
  watchResize(ctx);
}

export { initPriceChart, renderPriceChartMount };
