// The drawing of the weekly and monthly price charts as SVG markup: candles, volume, the MACD band, date labels and event tags.
// Pure: bars and sizes in, a string and the chart's geometry out; the page is not touched.
import { fmtDate } from './charttip.js';

const LANE = 14, PAD_L = 2, PAD_T = 8, VOL_H = 44, VOL_GAP = 8, MACD_H = 70, MACD_GAP = 22, BASE_H = 250, LABEL_W = 50, NARROW_PX = 520, MIN_WARM_LABEL_PX = 120;
const f = (v) => +v.toFixed(2);

/** "Nice" tick values from `a` to `z`, about `m` of them. */
function niceTicks(a, z, m){
  const raw = (z - a) / m, p = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / p, st = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * p, out = [];
  for(let v = Math.ceil(a / st) * st; v <= z; v += st) out.push(v);
  return out;
}

/** Colour of a news tag: green / red when all its labelled items agree, amber when they disagree, grey when neutral, purple when unlabelled. */
function sentimentOf(list){
  const has = (v) => list.some((e) => e.s === v);
  if(has('pos') && has('neg')) return 'mix';
  if(has('pos')) return 'pos';
  if(has('neg')) return 'neg';
  return list.length && list.every((e) => e.s === 'neu') ? 'neu' : '';
}

/** Sizes of the chart for a width, the number of event lanes and whether a MACD band is drawn. */
function layoutOf(W, laneCount, hasMacd){
  const evH = laneCount ? laneCount * LANE + 4 : 0, MH = hasMacd ? MACD_H : 0, MG = hasMacd ? MACD_GAP : 0, mBlock = MH + MG;
  const H = BASE_H + evH + mBlock, padB = 22 + evH;
  return { W, H, padL: PAD_L, padR: W < NARROW_PX ? 32 : 44, padT: PAD_T, padB, evH, MH, MG, ph: H - PAD_T - padB - mBlock - VOL_H - VOL_GAP, vBase: H - padB - mBlock };
}

/** Price and volume scales of the bars in view. */
function scaleOf(b, L){
  let lo = Math.min(...b.map((r) => r[3])), hi = Math.max(...b.map((r) => r[2]));
  const pad = (hi - lo) * .06, n = b.length, step = (L.W - L.padL - L.padR) / n, vmax = Math.max(...b.map((r) => r[5]));
  lo -= pad; hi += pad;
  return { n, b, step, bw: Math.max(1.2, Math.min(18, step * .64)), X: (i) => L.padL + step * (i + .5), Y: (v) => L.padT + (hi - v) / (hi - lo) * L.ph, VY: (v) => L.vBase - v / vmax * VOL_H, lo, hi };
}

function gridLayer(L, sc){
  return niceTicks(sc.lo, sc.hi, 5).map((v) => `<line x1="${L.padL}" x2="${L.W - L.padR}" y1="${sc.Y(v)}" y2="${sc.Y(v)}" class="pc-grid"/><text x="${L.W - L.padR + 6}" y="${sc.Y(v) + 4}">${Math.round(v)}</text>`).join('');
}

/** The volume bars, wicks and candle bodies, one <path> per colour/layer instead of 2-3 elements per bar: the same picture with ~1000x fewer nodes. */
function barPaths(L, sc){
  const { b, step, bw, X, Y, VY } = sc, P = { vol: '', wU: '', wD: '', bU: '', bD: '', big: '' };
  b.forEach((r, i) => {
    const up = r[4] >= r[1], x = X(i), vw = Math.max(1.2, step * .6), vy = VY(r[5]);
    P.vol += `M${f(x - vw / 2)} ${f(vy)}h${f(vw)}v${f(L.vBase - vy)}h${f(-vw)}z`;
    P[up ? 'wU' : 'wD'] += `M${f(x)} ${f(Y(r[2]))}V${f(Y(r[3]))}`;
    const y1 = Y(Math.max(r[1], r[4])), hh = Math.max(1, Math.abs(Y(r[1]) - Y(r[4])));
    if(bw < 2) return;
    if(bw > 6) P.big += `<rect x="${f(x - bw / 2)}" y="${f(y1)}" width="${f(bw)}" height="${f(hh)}" fill="${up ? 'var(--buy)' : 'var(--avoid)'}" rx="1.5"/>`;
    else P[up ? 'bU' : 'bD'] += `M${f(x - bw / 2)} ${f(y1)}h${f(bw)}v${f(hh)}h${f(-bw)}z`;
  });
  return P;
}

function candleLayer(L, sc){
  const P = barPaths(L, sc), sw = sc.bw < 3 ? 1 : 1.3;
  return `<path d="${P.vol}" class="pc-volbar"/>`
    + (P.wU ? `<path d="${P.wU}" fill="none" stroke="var(--buy)" stroke-width="${sw}"/>` : '')
    + (P.wD ? `<path d="${P.wD}" fill="none" stroke="var(--avoid)" stroke-width="${sw}"/>` : '')
    + (P.bU ? `<path d="${P.bU}" fill="var(--buy)"/>` : '')
    + (P.bD ? `<path d="${P.bD}" fill="var(--avoid)"/>` : '') + P.big;
}

/** Vertical range of the MACD band over the bars in view (always includes zero, with a little room). */
function macdBounds(ms, off, n){
  let lo = 0, hi = 0;
  for(let i = 0; i < n; i++){ const j = off + i; lo = Math.min(lo, ms.macd[j], ms.signal[j], ms.hist[j]); hi = Math.max(hi, ms.macd[j], ms.signal[j], ms.hist[j]); }
  if(hi - lo < 1e-9){ hi += 1; lo -= 1; }
  const pad = (hi - lo) * .08;
  return { lo: lo - pad, hi: hi + pad };
}

/** The shaded block over the bars still warming up the averages, with its note when there is room. */
function macdWarmup(L, sc, mTop, nEarly){
  if(!nEarly) return '';
  const wx = sc.X(nEarly - 1) + sc.step / 2, w = wx - L.padL;
  return `<rect x="${L.padL}" y="${f(mTop)}" width="${f(Math.max(0, w))}" height="${L.MH}" class="pc-mwarm"/>`
    + (w > MIN_WARM_LABEL_PX ? `<text x="${f(L.padL + w / 2)}" y="${f(mTop + 11)}" text-anchor="middle" class="pc-mwarm-t">warm-up: less reliable</text>` : '');
}

function macdAxis(L, MY, bounds){
  const mt = niceTicks(bounds.lo, bounds.hi, 3), mst = mt.length > 1 ? mt[1] - mt[0] : 1, dp = mst >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(mst) - 1e-9));
  return mt.map((v) => Math.abs(v) < mst / 1e3 ? '' : `<line x1="${L.padL}" x2="${L.W - L.padR}" y1="${f(MY(v))}" y2="${f(MY(v))}" class="pc-grid"/><text x="${L.W - L.padR + 6}" y="${f(MY(v) + 4)}">${v.toFixed(dp)}</text>`).join('');
}

/** Histogram bars and the MACD / signal lines as paths, each in two parts: [warm-up, reliable]. The first reliable point joins the two parts of a line. */
function macdPaths(sc, view){
  const { ms, off, MY, y0, nEarly } = view, P = { hu: ['', ''], hd: ['', ''], lm: ['', ''], ls: ['', ''] }, hw = Math.max(1.2, sc.step * .6);
  for(let i = 0; i < sc.n; i++){
    const j = off + i, x = sc.X(i), hv = ms.hist[j], y1 = MY(hv), e = j < ms.from ? 0 : 1;
    P[hv >= 0 ? 'hu' : 'hd'][e] += `M${f(x - hw / 2)} ${f(Math.min(y0, y1))}h${f(hw)}v${f(Math.max(.5, Math.abs(y1 - y0)))}h${f(-hw)}z`;
    [['lm', ms.macd[j]], ['ls', ms.signal[j]]].forEach(([key, v]) => {
      const q = P[key]; q[e] += (q[e] ? 'L' : 'M') + f(x) + ' ' + f(MY(v));
      if(!e && i === nEarly - 1) q[1] += 'M' + f(x) + ' ' + f(MY(v));
    });
  }
  return P;
}

/** The MACD band: histogram bars from zero, the MACD and signal lines and a dashed zero line. Bars before ms.from are drawn faded and dashed on a light shade. */
function macdLayer(L, sc, ms, off){
  const mTop = L.vBase + L.MG, bounds = macdBounds(ms, off, sc.n), MY = (v) => mTop + (bounds.hi - v) / (bounds.hi - bounds.lo) * L.MH, y0 = MY(0);
  const nEarly = Math.max(0, Math.min(sc.n, ms.from - off)), P = macdPaths(sc, { ms, off, MY, y0, nEarly });
  const path = (key, cls) => [0, 1].map((e) => P[key][e] ? `<path d="${P[key][e]}" class="${cls}${e ? '' : ' pc-early'}"/>` : '').join('');
  return `<text x="${L.padL}" y="${L.vBase + 14}"><tspan class="pc-mtitle">MACD (12, 26, 9)</tspan><tspan class="pc-mlab-m" dx="12">— MACD</tspan><tspan class="pc-mlab-s" dx="10">— Signal</tspan></text>`
    + macdWarmup(L, sc, mTop, nEarly) + macdAxis(L, MY, bounds)
    + path('hu', 'pc-mhu') + path('hd', 'pc-mhd') + `<line x1="${L.padL}" x2="${L.W - L.padR}" y1="${f(y0)}" y2="${f(y0)}" class="pc-mzero"/><text x="${L.W - L.padR + 6}" y="${f(y0 + 4)}">0</text>` + path('lm', 'pc-mline') + path('ls', 'pc-msig');
}

/** Date labels, spaced by the room they need (so neighbours never touch) and kept inside the chart's side edges. */
function dateLabels(L, sc, cfg){
  const minBars = Math.max(1, Math.ceil(LABEL_W / sc.step));
  const every = cfg.every ? cfg.every * Math.max(1, Math.ceil(minBars / cfg.every)) : Math.max(minBars, Math.round(sc.n / (L.W < NARROW_PX ? 4 : 8)));
  return sc.b.map((r, i) => {
    if(i % every !== 0) return '';
    const x = sc.X(i), t = fmtDate(r[0], cfg.lbl), hw = t.length * 3.1;
    const a = x - hw < L.padL ? ['start', L.padL] : x + hw > L.W - L.padR + 20 ? ['end', L.W - L.padR + 20] : ['middle', x];
    return `<text x="${f(a[1])}" y="${L.H - 5}" text-anchor="${a[0]}">${t}</text>`;
  }).join('');
}

/** One event tag (a circle for news, a rounded square otherwise) with its glyph, centred on bar x. */
function eventTag(ln, here, geom){
  const { x, y, ts } = geom, trade = ln.id === 'trade', news = ln.id === 'news';
  const glyph = trade ? (here.some((e) => e.k === 'sell') && !here.some((e) => e.k === 'buy') ? 'S' : 'B') : ln.glyph;
  const shape = news ? `<circle cx="${f(x)}" cy="${y + LANE / 2 - .5}" r="${f(ts / 2)}"/>` : `<rect x="${f(x - ts / 2)}" y="${y + LANE / 2 - 0.5 - ts / 2}" width="${f(ts)}" height="${f(ts)}" rx="2"/>`;
  return `<g class="pc-ev pc-evk-${ln.id}${trade ? (glyph === 'S' ? ' sell' : ' buy') : ''}${news ? ' s-' + sentimentOf(here) : ''}">${shape}<text x="${f(x)}" y="${y + LANE / 2 + 3}" text-anchor="middle">${glyph}</text></g>`;
}

/** Event tags, one lane per kind, under the volume bars (only the bars in view). `ev` = { lanes, byBar (bar index -> events), off }. */
function eventLanes(L, sc, ev){
  const ts = Math.max(11, Math.min(14, sc.step - 1));
  return ev.lanes.map((ln, li) => {
    const y = L.H - 22 - L.evH + 2 + li * LANE;
    let out = `<line x1="${L.padL}" x2="${L.W - L.padR}" y1="${y + LANE - 1}" y2="${y + LANE - 1}" class="pc-grid"/>`;
    ev.byBar.forEach((list, gi) => {
      const here = gi < ev.off ? [] : list.filter((e) => e.group === ln.id);
      if(here.length) out += eventTag(ln, here, { x: sc.X(gi - ev.off), y, ts });
    });
    return out;
  }).join('');
}

/** Translucent bands on a chart over the bars that overlap the bars hovered on the other chart(s): `others` are their [start, end] times, `spanAt` the time span of this chart's bar i. */
function bandRects(G, others, spanAt){
  return others.map(([t0, t1]) => {
    let a = -1, z = -1;
    G.b.forEach((r, i) => { const [s0, s1] = spanAt(G.off + i); if(s0 < t1 && s1 > t0){ if(a < 0) a = i; z = i; } });
    return a < 0 ? '' : `<rect x="${G.X(a) - G.step / 2}" y="8" width="${(z - a + 1) * G.step}" height="${G.H - 30}" class="pc-bandrect"/>`;
  }).join('');
}

/**
 * The whole chart for the bars in view. `spec` = { view (bars in view), off (index of the first), cfg (the timeframe's labels), ms (MACD or null), lanes, byBar, W }.
 * Returns { html, geo }: the SVG contents and what pointer handling needs to find a bar.
 */
function buildChartSvg(spec){
  const { view, off, cfg, ms, lanes, byBar, W } = spec, L = layoutOf(W, lanes.length, !!ms), sc = scaleOf(view, L);
  const html = gridLayer(L, sc) + '<g class="pc-band"></g>' + candleLayer(L, sc) + (ms ? macdLayer(L, sc, ms, off) : '') + dateLabels(L, sc, cfg)
    + eventLanes(L, sc, { lanes, byBar, off }) + `<line class="pc-xh" y1="${L.padT}" y2="${L.H - L.padB}" opacity="0"/>`;
  return { html, geo: { W: L.W, H: L.H, padL: L.padL, step: sc.step, X: sc.X, off, n: sc.n, b: view } };
}

export { bandRects, buildChartSvg };
