// Weekly and monthly price chart.
import { escapeHtml } from '../core/util.js';
import { pcTickerKey, priceHistoryByTicker } from './store.js';
import { followPrice, periodStartSec } from './periodmove.js';
import { EVENT_GROUPS, barReaction, eventsByBar, stockChartEvents } from './events.js';
import { techMacdSeries } from '../engine/technical.js';

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
    <div class="pc-legend"><span><i style="background:var(--buy)"></i>Close above open</span><span><i style="background:var(--avoid)"></i>Close below open</span><span><i class="pc-vol"></i>Volume</span><span><i class="pc-lm"></i>MACD</span><span><i class="pc-ls"></i>MACD signal</span></div>
    ${renderEventToggles(s)}
    <div class="pc-panels"></div>
    <div class="pc-sums" hidden>${['1W', '1M'].map(k => `<div data-k="${k}">${sums && sums[k] || ''}</div>`).join('')}</div></div>`;
}
function initPriceChart(s){
  if(pcObserver){ pcObserver.disconnect(); pcObserver = null; }
  const root = document.getElementById('priceChartBlock'); if(!root || !pcHasData(s)) return;
  const saved = priceHistoryByTicker[pcTickerKey(s)], px = s.valuation && s.valuation.currentPrice, now = Date.now();
  const bars = Object.assign({}, saved, { '1W': followPrice(saved['1W'], px, periodStartSec('W', now), 8 * 86400), '1M': followPrice(saved['1M'], px, periodStartSec('M', now), 32 * 86400) });   // this week's and this month's bar follow the price, as W % chg / M % chg do
  const IST = 19800;
  const fmtD = (t, o) => new Date((t + IST) * 1000).toLocaleDateString('en-GB', Object.assign({timeZone:'UTC'}, o));
  const rs = n => '₹' + n.toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  const vol = v => v >= 1e7 ? (v/1e7).toFixed(2) + ' Cr' : v >= 1e5 ? (v/1e5).toFixed(2) + ' L' : v >= 1e3 ? (v/1e3).toFixed(1) + 'K' : String(v);
  const cfg = {
    '1M': {title:'Monthly', ranges:[['1Y', 12], ['3Y', 36], ['5Y', 60], ['All', 999]], def:3, lbl:{month:'short', year:'2-digit'}, every:3},
    '1W': {title:'Weekly',  ranges:[['6M', 26], ['1Y', 52], ['All', 999]], def:2, lbl:{day:'numeric', month:'short'}, every:0}
  };
  const order = ['1W', '1M'], state = {}, hover = {}, geo = {}; const pend = {}, raf = {};
  // MACD (12, 26, 9) of every bar, from all the bars so it does not change with the range chosen; null for a stock with too little history (no panel).
  const macd = {};
  order.forEach(k => { macd[k] = techMacdSeries(bars[k].map(r => r[4])); });
  // Event tags: lanes for the kinds of event this stock has; a toggle in the legend hides a kind.
  const events = stockChartEvents(s), haveGroups = EVENT_GROUPS.filter(g => events.some(e => e.group === g.id));
  const shown = new Set(haveGroups.map(g => g.id)), LANE = 14;
  const byBar = {};
  const rebuildEvents = () => order.forEach(k => { byBar[k] = eventsByBar(events, bars[k], k === '1M' ? 31 * 86400 : 7 * 86400, shown); });
  rebuildEvents();
  const span = (k, i) => { const b = bars[k]; return [b[i][0], i + 1 < b.length ? b[i+1][0] : b[i][0] + (k==='1M' ? 31*86400 : k==='1W' ? 7*86400 : 86400)]; };
  const panels = root.querySelector('.pc-panels');
  const elOf = k => panels.querySelector('[data-k="' + k + '"]');

  function drawBands(){
    order.forEach(k => {
      const g = elOf(k).querySelector('.pc-band'), G = geo[k]; if(!g || !G) return;
      let out = '';
      for(const src in hover){
        if(src === k) continue;
        const [t0, t1] = span(src, hover[src]); let a = -1, z = -1;
        G.b.forEach((r, i) => { const [s0, s1] = span(k, G.off + i); if(s0 < t1 && s1 > t0){ if(a < 0) a = i; z = i; } });
        if(a >= 0) out += `<rect x="${G.X(a) - G.step / 2}" y="8" width="${(z - a + 1) * G.step}" height="${G.H - 30}" class="pc-bandrect"/>`;
      }
      g.innerHTML = out;
    });
  }
  function draw(k){
    const c = cfg[k], el = elOf(k), svg = el.querySelector('svg');
    const lanes = haveGroups.filter(g => shown.has(g.id)), evH = lanes.length ? lanes.length * LANE + 4 : 0;
    const ms = macd[k], MH = ms ? 70 : 0, MG = ms ? 22 : 0, mBlock = MH + MG;   // the MACD band sits under the volume, above the event tags
    const W = el.querySelector('.pc-chart').clientWidth || 320, H = 250 + evH + mBlock, padL = 6, padR = 44, padT = 8, padB = 22 + evH, volH = 44, gap = 8;
    const all = bars[k], n = Math.min(all.length, c.ranges[state[k]][1]), off = all.length - n, b = all.slice(off);
    const pw = W - padL - padR, ph = H - padT - padB - mBlock - volH - gap, vBase = H - padB - mBlock;   // vBase: the volume bars' baseline
    let lo = Math.min(...b.map(r => r[3])), hi = Math.max(...b.map(r => r[2])); const pad = (hi - lo) * .06; lo -= pad; hi += pad;
    const step = pw / n, bw = Math.max(1.2, Math.min(18, step * .64));
    const X = i => padL + step * (i + .5), Y = v => padT + (hi - v) / (hi - lo) * ph;
    const vmax = Math.max(...b.map(r => r[5])), VY = v => vBase - v / vmax * volH;
    const ticks = (a, z, m) => { const raw = (z - a) / m, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p, st = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = []; for(let v = Math.ceil(a / st) * st; v <= z; v += st) out.push(v); return out; };
    let g = '';
    ticks(lo, hi, 5).forEach(v => { g += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" class="pc-grid"/><text x="${W - padR + 6}" y="${Y(v) + 4}">${Math.round(v)}</text>`; });
    g += '<g class="pc-band"></g>';
    // One <path> per colour/layer instead of 2-3 elements per bar: same picture, ~1000x fewer nodes.
    const f = v => +v.toFixed(2); let vol = '', wU = '', wD = '', bU = '', bD = '', big = '';
    b.forEach((r, i) => {
      const up = r[4] >= r[1], x = X(i), vw = Math.max(1.2, step * .6), vy = VY(r[5]);
      vol += `M${f(x - vw / 2)} ${f(vy)}h${f(vw)}v${f(vBase - vy)}h${f(-vw)}z`;
      const wk = `M${f(x)} ${f(Y(r[2]))}V${f(Y(r[3]))}`; if(up) wU += wk; else wD += wk;
      const y1 = Y(Math.max(r[1], r[4])), hh = Math.max(1, Math.abs(Y(r[1]) - Y(r[4])));
      if(bw >= 2){
        if(bw > 6) big += `<rect x="${f(x - bw / 2)}" y="${f(y1)}" width="${f(bw)}" height="${f(hh)}" fill="${up ? 'var(--buy)' : 'var(--avoid)'}" rx="1.5"/>`;
        else { const rc = `M${f(x - bw / 2)} ${f(y1)}h${f(bw)}v${f(hh)}h${f(-bw)}z`; if(up) bU += rc; else bD += rc; }
      }
    });
    const sw = bw < 3 ? 1 : 1.3;
    g += `<path d="${vol}" class="pc-volbar"/>`;
    if(wU) g += `<path d="${wU}" fill="none" stroke="var(--buy)" stroke-width="${sw}"/>`;
    if(wD) g += `<path d="${wD}" fill="none" stroke="var(--avoid)" stroke-width="${sw}"/>`;
    if(bU) g += `<path d="${bU}" fill="var(--buy)"/>`;
    if(bD) g += `<path d="${bD}" fill="var(--avoid)"/>`;
    g += big;
    // MACD band: histogram bars from zero, the MACD and signal lines, a dashed zero line. Bars before ms.from are the warm-up of the averages:
    // they are drawn faded and dashed on a light shade (and the first reliable point joins the two parts), so the line spans the whole chart.
    if(ms){
      const mTop = vBase + MG, vis = [];
      for(let i = 0; i < n; i++) vis.push(i);
      if(vis.length){
        let mLo = 0, mHi = 0;
        vis.forEach(i => { const j = off + i; mLo = Math.min(mLo, ms.macd[j], ms.signal[j], ms.hist[j]); mHi = Math.max(mHi, ms.macd[j], ms.signal[j], ms.hist[j]); });
        if(mHi - mLo < 1e-9){ mHi += 1; mLo -= 1; }
        const mPad = (mHi - mLo) * .08; mLo -= mPad; mHi += mPad;
        const MY = v => mTop + (mHi - v) / (mHi - mLo) * MH;
        g += `<text x="${padL}" y="${vBase + 14}"><tspan class="pc-mtitle">MACD (12, 26, 9)</tspan><tspan class="pc-mlab-m" dx="12">— MACD</tspan><tspan class="pc-mlab-s" dx="10">— Signal</tspan></text>`;
        const nEarly = Math.max(0, Math.min(n, ms.from - off));      // bars in view that are still warming up
        if(nEarly){
          const wx = X(nEarly - 1) + step / 2;
          g += `<rect x="${padL}" y="${f(mTop)}" width="${f(Math.max(0, wx - padL))}" height="${MH}" class="pc-mwarm"/>`;
          if(wx - padL > 120) g += `<text x="${f(padL + (wx - padL) / 2)}" y="${f(mTop + 11)}" text-anchor="middle" class="pc-mwarm-t">warm-up: less reliable</text>`;
        }
        const mt = ticks(mLo, mHi, 3), mst = mt.length > 1 ? mt[1] - mt[0] : 1, mdp = mst >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(mst) - 1e-9));
        mt.forEach(v => { if(Math.abs(v) < mst / 1e3) return; g += `<line x1="${padL}" x2="${W - padR}" y1="${f(MY(v))}" y2="${f(MY(v))}" class="pc-grid"/><text x="${W - padR + 6}" y="${f(MY(v) + 4)}">${v.toFixed(mdp)}</text>`; });
        const y0 = MY(0), hw = Math.max(1.2, step * .6);
        const P = { hu: ['', ''], hd: ['', ''], lm: ['', ''], ls: ['', ''] };   // [warm-up, reliable]
        vis.forEach(i => {
          const j = off + i, x = X(i), hv = ms.hist[j], y1 = MY(hv), e = j < ms.from ? 0 : 1, rc = `M${f(x - hw / 2)} ${f(Math.min(y0, y1))}h${f(hw)}v${f(Math.max(.5, Math.abs(y1 - y0)))}h${f(-hw)}z`;
          P[hv >= 0 ? 'hu' : 'hd'][e] += rc;
          const pt = (k, v) => { const q = P[k]; q[e] += (q[e] ? 'L' : 'M') + f(x) + ' ' + f(MY(v)); if(!e && i === nEarly - 1) q[1] += 'M' + f(x) + ' ' + f(MY(v)); };
          pt('lm', ms.macd[j]); pt('ls', ms.signal[j]);
        });
        const path = (k, cls) => [0, 1].map(e => P[k][e] ? `<path d="${P[k][e]}" class="${cls}${e ? '' : ' pc-early'}"/>` : '').join('');
        g += path('hu', 'pc-mhu') + path('hd', 'pc-mhd') + `<line x1="${padL}" x2="${W - padR}" y1="${f(y0)}" y2="${f(y0)}" class="pc-mzero"/><text x="${W - padR + 6}" y="${f(y0 + 4)}">0</text>` + path('lm', 'pc-mline') + path('ls', 'pc-msig');
      }
    }
    // Date labels: spaced by the room they need (so neighbours never touch) and kept inside the chart's side edges.
    const LBW = 50, minBars = Math.max(1, Math.ceil(LBW / step));
    const every = c.every ? c.every * Math.max(1, Math.ceil(minBars / c.every)) : Math.max(minBars, Math.round(n / (W < 520 ? 4 : 8)));
    b.forEach((r, i) => {
      if(i % every !== 0) return;
      const x = X(i), t = fmtD(r[0], c.lbl), hw = t.length * 3.1;
      const a = x - hw < padL ? ['start', padL] : x + hw > W - padR + 20 ? ['end', W - padR + 20] : ['middle', x];
      g += `<text x="${f(a[1])}" y="${H - 5}" text-anchor="${a[0]}">${t}</text>`;
    });
    // Event tags, one lane per kind, under the volume bars (only the bars in view).
    if(lanes.length){
      const ts = Math.max(11, Math.min(14, step - 1)), label = true;
      lanes.forEach((ln, li) => {
        const y = H - 22 - evH + 2 + li * LANE;
        g += `<line x1="${padL}" x2="${W - padR}" y1="${y + LANE - 1}" y2="${y + LANE - 1}" class="pc-grid"/>`;
        byBar[k].forEach((list, gi) => {
          if(gi < off) return;
          const here = list.filter(e => e.group === ln.id); if(!here.length) return;
          const x = X(gi - off), glyph = ln.id === 'trade' ? (here.some(e => e.k === 'sell') && !here.some(e => e.k === 'buy') ? 'S' : 'B') : ln.glyph;
          g += `<g class="pc-ev pc-evk-${ln.id}${ln.id === 'trade' ? (glyph === 'S' ? ' sell' : ' buy') : ''}${ln.id === 'news' ? ' s-' + sentimentOf(here) : ''}">` + (ln.id === 'news' ? `<circle cx="${f(x)}" cy="${y + LANE / 2 - .5}" r="${f(ts / 2)}"/>` : `<rect x="${f(x - ts / 2)}" y="${y + LANE / 2 - 0.5 - ts / 2}" width="${f(ts)}" height="${f(ts)}" rx="2"/>`) + (label ? `<text x="${f(x)}" y="${y + LANE / 2 + 3}" text-anchor="middle">${glyph}</text>` : '') + `</g>`;
        });
      });
    }
    g += `<line class="pc-xh" y1="${padT}" y2="${H - padB}" opacity="0"/>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.innerHTML = g;
    geo[k] = {W, H, padL, step, X, off, n, b};
    drawBands();
  }
  function onMove(k, e){
    const G = geo[k], el = elOf(k), rect = el.querySelector('.pc-chart').getBoundingClientRect();
    const px = (e.clientX - rect.left) * (G.W / rect.width);
    const i = Math.max(0, Math.min(G.n - 1, Math.floor((px - G.padL) / G.step))), r = G.b[i];
    hover[k] = G.off + i; drawBands();
    const xh = el.querySelector('.pc-xh'); xh.setAttribute('x1', String(G.X(i))); xh.setAttribute('x2', String(G.X(i))); xh.setAttribute('opacity', '1');
    const prev = bars[k][G.off + i - 1], chg = (r[4] / (prev && prev[4] > 0 ? prev[4] : r[1]) - 1) * 100, tip = el.querySelector('.pc-tip');
    const label = k === '1W' ? 'Week of ' + fmtD(r[0], {day:'numeric', month:'short', year:'numeric'}) : fmtD(r[0], {month:'long', year:'numeric'});
    tip.innerHTML = `<b>${label}</b><div class="r"><span>Open</span><span>${rs(r[1])}</span></div><div class="r"><span>High</span><span>${rs(r[2])}</span></div><div class="r"><span>Low</span><span>${rs(r[3])}</span></div><div class="r"><span>Close</span><span>${rs(r[4])}</span></div><div class="r"><span>Change</span><span>${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%</span></div><div class="r"><span>Volume</span><span>${vol(r[5])}</span></div>${macdTipHtml(k, G.off + i)}${eventTipHtml(byBar[k].get(G.off + i), barReaction(bars[k], G.off + i), k === '1W' ? 'week' : 'month')}`;
    const tw = /** @type {HTMLElement} */ (tip).offsetWidth, xx = G.X(i) * (rect.width / G.W);
    /** @type {HTMLElement} */ (tip).style.left = Math.max(0, Math.min(rect.width - tw, xx + 14 + tw > rect.width ? xx - tw - 14 : xx + 14)) + 'px'; /** @type {HTMLElement} */ (tip).style.top = '6px'; /** @type {HTMLElement} */ (tip).style.opacity = '1';
  }
  // Colour of a news tag: green / red when all its labelled items agree, amber when they disagree, grey when neutral, purple when unlabelled.
  const sentimentOf = (list) => {
    const has = v => list.some(e => e.s === v);
    if(has('pos') && has('neg')) return 'mix';
    if(has('pos')) return 'pos';
    if(has('neg')) return 'neg';
    return list.length && list.every(e => e.s === 'neu') ? 'neu' : '';
  };
  const pctTxt = v => v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  // MACD, signal and histogram of the hovered bar (nothing for a bar still warming up, or a stock with no MACD).
  const macdTipHtml = (k, j) => {
    const ms = macd[k]; if(!ms) return '';
    const row = (name, v) => `<div class="r"><span>${name}</span><span>${v.toFixed(2)}</span></div>`;
    return row('MACD', ms.macd[j]) + row('Signal', ms.signal[j]) + row('Histogram', ms.hist[j]) + (j < ms.from ? '<div class="r"><span>MACD still warming up</span><span></span></div>' : '');
  };
  // Events of the hovered bar, listed under its prices (newest first, at most 5).
  const eventTipHtml = (list, react, per) => {
    if(!list || !list.length) return '';
    const sorted = list.slice().sort((a, b) => b.t - a.t), more = sorted.length - 5;
    const glyphFor = e => e.k === 'news' ? '⚡' : (e.glyph || EVENT_GROUPS.find(x => x.id === e.group).glyph);
    return '<div class="evs">' + sorted.slice(0, 5).map(e => `<div class="ev"><span class="pc-evk pc-evk-${e.group}${e.k === 'sell' ? ' sell' : ''}${e.group === 'news' && e.s ? ' s-' + e.s : ''}">${glyphFor(e)}</span><span>${escapeHtml(e.text)}<small>${escapeHtml(e.d + (e.src ? ' · ' + e.src : ''))}</small></span></div>`).join('') + (more > 0 ? `<div class="ev more">+${more} more</div>` : '') + (react && list.some(e => e.group === 'news') ? `<div class="evmove">Price: ${per} ${pctTxt(react.same)}, next ${per} ${pctTxt(react.next)}</div>` : '') + '</div>';
  };
  const keyBtn = root.querySelector('#pcKeyToggle');
  if(keyBtn) keyBtn.addEventListener('click', () => {
    pcKeyOpen = !pcKeyOpen;
    root.classList.toggle('show-key', pcKeyOpen);
    keyBtn.setAttribute('aria-expanded', String(pcKeyOpen));
    keyBtn.textContent = pcKeyOpen ? 'Hide legend' : 'Legend';
  });
  root.querySelectorAll('.pc-evtoggle').forEach(btn => btn.addEventListener('click', () => {
    const id = /** @type {HTMLElement} */ (btn).dataset.g, on = !shown.has(id);
    if(on) shown.add(id); else shown.delete(id);
    btn.setAttribute('aria-pressed', String(on));
    rebuildEvents(); order.forEach(draw);
  }));
  order.forEach(k => {
    const c = cfg[k]; state[k] = c.def;
    const el = document.createElement('div'); el.className = 'pc-panel'; el.dataset.k = k;
    el.innerHTML = `<div class="pc-ph"><div class="pc-ptitle">${c.title}<small>${bars[k].length} bars</small></div><div class="pc-psum">${(root.querySelector('.pc-sums [data-k="' + k + '"]') || {}).innerHTML || ''}</div><div class="pc-pills" role="group" aria-label="${c.title} range">${c.ranges.map((r, i) => `<button type="button" class="pc-pill" data-i="${i}" aria-pressed="${i === state[k]}">${r[0]}</button>`).join('')}</div></div>
      <div class="pc-chart"><svg role="img" aria-label="${c.title} candlestick chart with volume and MACD"></svg><div class="pc-tip"></div></div>`;
    panels.appendChild(el);
    el.querySelectorAll('.pc-pill').forEach(btn => /** @type {HTMLElement} */ (btn).onclick = () => { state[k] = +/** @type {HTMLElement} */ (btn).dataset.i; el.querySelectorAll('.pc-pill').forEach(x => x.setAttribute('aria-pressed', String(x === btn))); draw(k); });
    const ch = el.querySelector('.pc-chart');
    ch.addEventListener('pointermove', e => { pend[k] = e; if(!raf[k]) raf[k] = requestAnimationFrame(() => { raf[k] = 0; if(pend[k]) onMove(k, pend[k]); }); });
    ch.addEventListener('pointerleave', () => { pend[k] = null; delete hover[k]; drawBands(); /** @type {HTMLElement} */ (el.querySelector('.pc-tip')).style.opacity = '0'; el.querySelector('.pc-xh').setAttribute('opacity', '0'); });
  });
  order.forEach(draw);
  let rz; pcObserver = new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { if(root.isConnected) order.forEach(draw); }, 80); });
  pcObserver.observe(root);
}

export { initPriceChart, renderPriceChartMount };
