// The industry detail page: the stock detail page's counterpart for a group of stocks. Roll-up of the members' scores,
// their Global & Macro notes, weekly / monthly average % change charts with news tags, the combined news timeline and the stocks.
import { detailEl } from '../core/dom.js';
import { stockIndex, stocks, verdictLabel } from '../core/stocks.js';
import { escapeHtml, tickerIndustry } from '../core/util.js';
import { panelIcon } from '../detail/icons.js';
import { scoreBand } from '../list/metrics.js';
import { ensureAllPriceBars, pcTickerKey, priceHistoryByTicker } from '../prices/store.js';
import { EVENT_GROUPS, eventsByBar } from '../prices/events.js';
import { analysisLbCell, analysisRowContext, columnHeaderHtml, stockGridColumnIds } from '../analysis/columns.js';
import { industryFactors, industryGlobal, industryNews, industrySeries } from './calc.js';
import { bindJumpSpy } from '../detail/jumpnav.js';
import { newsItemHtml } from '../business/newsitem.js';

const IST = 19800;
const NEWS_SHOWN = 30;
const sign = (v, d) => (v >= 0 ? '+' : '') + v.toFixed(d);
const fmtD = (t, o) => new Date((t + IST) * 1000).toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, o));

// The stocks of one industry (by = 'industry': the fine label, 'group': the wider Industry Group).
function membersOf(by, name){
  return stocks.filter(s => (by === 'group' ? (s.industryGroup || '—') : tickerIndustry(s)) === name);
}

function scoreCell(label, v, n, total){
  return `<div class="fund-cell"><div class="fund-cell-head"><div class="fund-cell-label">${label}</div>${v === null ? '<div class="fund-cell-score fs-pending">n/a</div>' : `<div class="fund-cell-score ${scoreBand(v)}">${v.toFixed(2)}<span class="fund-cell-max">/10</span></div>`}</div>${v === null ? '' : `<div class="fund-cell-bar"><i class="${scoreBand(v)}" style="width:${Math.max(0, Math.min(100, v * 10))}%"></i></div>`}<div class="fund-cell-note">Average of ${n} of ${total} stocks.</div></div>`;
}
function factorsHtml(f){
  const av = f.score === null ? '' : ' &middot; ' + f.score.toFixed(2) + '/10';
  const verd = ['buy', 'mbuy', 'hold', 'avoid'].map(k => `<span class="badge b-${k}" title="Stocks rated ${verdictLabel[k]} by the Fundamental Score">${verdictLabel[k]} ${f.verdicts[k]}</span>`).join(' ');
  const mosCell = f.mos === null ? '<div class="fund-cell-score fs-pending">n/a</div>' : `<div class="fund-cell-score ${f.mos >= 15 ? 'fs-buy' : f.mos >= 0 ? 'fs-mbuy' : f.mos >= -15 ? 'fs-hold' : 'fs-avoid'}">${sign(f.mos, 1)}%</div>`;
  const cells = [
    scoreCell('Fundamental Score', f.score, f.scoreN, f.count),
    scoreCell('Technical Score', f.tech, f.techN, f.count),
    `<div class="fund-cell"><div class="fund-cell-head"><div class="fund-cell-label">Margin of safety</div>${mosCell}</div><div class="fund-cell-note">Average of ${f.mosN} of ${f.count} stocks; ${f.undervalued} trade below intrinsic value.</div></div>`
  ].concat(f.factors.map(x => scoreCell(escapeHtml(x.name), x.avg, x.n, f.count)));
  return `<div class="tech-panel" id="jump-ind-factors"><div class="tech-panel-head"><div class="tech-panel-title">${panelIcon('fund')}Industry Factors${av}</div><span class="completeness-badge complete">${f.count} stock${f.count === 1 ? '' : 's'}</span></div>
    <p class="peers-sub">The average of the stocks in this group. Factors count only the stocks that have a reliable score for them.</p>
    <div class="fund-verdicts">${verd}</div>
    <div class="fund-grid">${cells.join('')}</div></div>`;
}

function globalHtml(g){
  const item = (f) => {
    const src = f.source ? `<span class="global-item-source">Source: ${/^https?:\/\//i.test(f.url) ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(f.source)} ↗</a>` : escapeHtml(f.source)}</span>` : '';
    const who = f.stocks.length > 1 ? `<span class="global-item-source">Applies to ${f.stocks.length} stocks: ${escapeHtml(f.stocks.slice(0, 4).join(', '))}${f.stocks.length > 4 ? ', …' : ''}</span>` : `<span class="global-item-source">${escapeHtml(f.stocks[0])}</span>`;
    return `<li class="global-item">${f.text}${who}${src}</li>`;
  };
  const col = (cls, title, list) => `<div class="global-col"><div class="global-col-title ${cls}">${title}</div><ul class="global-list">${list.length ? list.slice(0, 8).map(item).join('') : '<li class="global-item">None identified.</li>'}</ul>${list.length > 8 ? `<p class="upload-hint">Showing 8 of ${list.length}.</p>` : ''}</div>`;
  const head = `<div class="global-panel-head"><div class="global-panel-title">${panelIcon('global')}Global &amp; Macro Information</div></div>`;
  if(!g.researched) return `<div class="global-panel" id="jump-ind-global">${head}<p class="global-panel-sub">None of the stocks in this group has been researched for Global &amp; Macro yet. Open a stock and use its Refresh button, then choose Fundamental.</p></div>`;
  return `<div class="global-panel" id="jump-ind-global">${head}<p class="global-panel-sub">Collected from the ${g.researched} researched stock${g.researched === 1 ? '' : 's'} in this group. Notes with the same wording are joined.</p>
    <div class="global-cols" style="--n:${Math.max(1, g.positive.length, g.negative.length)}">${col('pos', '&#9650; Positive / tailwind', g.positive)}${col('neg', '&#9660; Negative / risk', g.negative)}</div></div>`;
}

function newsHtml(news){
  const glyph = { news: '⚡', earn: 'E', corp: 'C' };
  const list = news.length ? '<ul class="biz-news ind-timeline">' + news.slice(0, NEWS_SHOWN).map(n => newsItemHtml(n, `<span class="pc-evk pc-evk-${n.k}${n.k === 'news' && n.s ? ' s-' + n.s : ''}">${glyph[n.k]}</span>`)).join('') + '</ul>' + (news.length > NEWS_SHOWN ? `<p class="upload-hint">Showing the newest ${NEWS_SHOWN} of ${news.length}.</p>` : '') : '<p class="upload-hint">No news saved for the stocks in this group. Headlines come from Refresh Fundamental Info, or the Refresh news button on the Explorer page.</p>';
  return `<div class="tech-panel" id="jump-ind-news"><div class="tech-panel-head"><div class="tech-panel-title">${panelIcon('global')}News timeline</div><span class="completeness-badge complete">${news.length} item${news.length === 1 ? '' : 's'}</span></div>${list}</div>`;
}

function stocksHtml(members){
  const cols = stockGridColumnIds().filter(id => id !== 'industry');
  const rows = members.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).map((s, k) => {
    const idx = stockIndex.get(s), ctx = analysisRowContext(s, k, idx);
    return `<tr class="strat-row" data-idx="${idx}" tabindex="0">${cols.map(id => analysisLbCell(id, ctx)).join('')}</tr>`;
  }).join('');
  return `<div class="tech-panel" id="jump-ind-stocks"><div class="tech-panel-head"><div class="tech-panel-title">${panelIcon('peers')}Stocks</div><span class="completeness-badge complete">${members.length}</span></div>
    <div class="peers-scroll strat-table-wrap"><table class="strat-table peers-table"><thead><tr>${cols.map(columnHeaderHtml).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

// ---- Weekly / monthly average % change charts, with news, results and company events as tags under the bars ----
const CHARTS = [
  { k: 'W', int: '1W', title: 'Weekly', ranges: [['6M', 26], ['1Y', 52], ['All', 9999]], def: 1, span: 7 * 86400, lbl: { day: 'numeric', month: 'short' } },
  { k: 'M', int: '1M', title: 'Monthly', ranges: [['1Y', 12], ['3Y', 36], ['5Y', 60], ['All', 9999]], def: 1, span: 31 * 86400, lbl: { month: 'short', year: '2-digit' } }
];
const LANE = 14;

function drawChart(panel, c, series, byBar, lanes, state){
  const W = panel.querySelector('.pc-chart').clientWidth || 320, evH = lanes.length ? lanes.length * LANE + 4 : 0;
  const H = 220 + evH, padL = 6, padR = 44, padT = 10, padB = 22 + evH;
  const n = Math.min(series.length, c.ranges[state.range][1]), off = series.length - n, b = series.slice(off);
  const ph = H - padT - padB, pw = W - padL - padR, step = pw / n, bw = Math.max(1.2, Math.min(18, step * .64));
  const ext = Math.max(0.5, ...b.map(r => Math.abs(r[1]))), hi = ext * 1.08;
  const X = i => padL + step * (i + .5), Y = v => padT + (hi - v) / (2 * hi) * ph, y0 = Y(0), f = v => +v.toFixed(2);
  let g = '';
  [-1, -.5, 0, .5, 1].forEach(m => { const v = m * ext; g += `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" class="pc-grid"/><text x="${W - padR + 6}" y="${Y(v) + 4}">${sign(v, ext < 5 ? 1 : 0)}%</text>`; });
  b.forEach((r, i) => {
    const y = Y(r[1]), x = X(i);
    g += `<rect x="${f(x - bw / 2)}" y="${f(Math.min(y, y0))}" width="${f(bw)}" height="${f(Math.max(1, Math.abs(y - y0)))}" fill="${r[1] >= 0 ? 'var(--buy)' : 'var(--avoid)'}" rx="${bw > 6 ? 1.5 : 0}"/>`;
  });
  const every = Math.max(1, Math.round(n / (W < 520 ? 4 : 8)));
  b.forEach((r, i) => { if(i % every === 0) g += `<text x="${X(i)}" y="${H - 5}" text-anchor="middle">${fmtD(r[0], c.lbl)}</text>`; });
  const ts = Math.max(11, Math.min(14, step - 1));
  lanes.forEach((ln, li) => {
    const y = H - 22 - evH + 2 + li * LANE;
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y + LANE - 1}" y2="${y + LANE - 1}" class="pc-grid"/>`;
    byBar.forEach((list, gi) => {
      if(gi < off) return;
      const here = list.filter(e => e.group === ln.id); if(!here.length) return;
      const x = X(gi - off), pos = here.some(e => e.s === 'pos'), neg = here.some(e => e.s === 'neg');
      const cls = ln.id === 'news' ? ' s-' + (pos && neg ? 'mix' : pos ? 'pos' : neg ? 'neg' : here.every(e => e.s === 'neu') ? 'neu' : '') : '';
      g += `<g class="pc-ev pc-evk-${ln.id}${cls}">` + (ln.id === 'news' ? `<circle cx="${f(x)}" cy="${y + LANE / 2 - .5}" r="${f(ts / 2)}"/>` : `<rect x="${f(x - ts / 2)}" y="${y + LANE / 2 - .5 - ts / 2}" width="${f(ts)}" height="${f(ts)}" rx="2"/>`) + `<text x="${f(x)}" y="${y + LANE / 2 + 3}" text-anchor="middle">${here.length > 1 ? here.length : ln.glyph}</text></g>`;
    });
  });
  g += `<line class="pc-xh" y1="${padT}" y2="${H - padB}" opacity="0"/>`;
  const svg = panel.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.innerHTML = g;
  state.geo = { W, padL, step, X, off, n, b };
}

function bindChart(panel, c, series, events, state){
  const shown = new Set(EVENT_GROUPS.filter(g => g.id !== 'trade' && g.id !== 'res' && events.some(e => e.group === g.id)).map(g => g.id));
  const lanes = () => EVENT_GROUPS.filter(g => shown.has(g.id));
  let byBar = new Map();
  const redraw = () => { byBar = eventsByBar(events, series, c.span, shown); drawChart(panel, c, series, byBar, lanes(), state); };
  panel.querySelectorAll('.pc-pill').forEach(btn => /** @type {HTMLElement} */ (btn).onclick = () => {
    state.range = +/** @type {HTMLElement} */ (btn).dataset.i;
    panel.querySelectorAll('.pc-pill').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
    redraw();
  });
  const ch = panel.querySelector('.pc-chart'), tip = /** @type {HTMLElement} */ (panel.querySelector('.pc-tip'));
  ch.addEventListener('pointermove', (e) => {
    const G = state.geo, rect = ch.getBoundingClientRect(); if(!G) return;
    const px = (/** @type {PointerEvent} */ (e).clientX - rect.left) * (G.W / rect.width);
    const i = Math.max(0, Math.min(G.n - 1, Math.floor((px - G.padL) / G.step))), r = G.b[i];
    const xh = panel.querySelector('.pc-xh'); xh.setAttribute('x1', String(G.X(i))); xh.setAttribute('x2', String(G.X(i))); xh.setAttribute('opacity', '1');
    const label = c.k === 'W' ? 'Week of ' + fmtD(r[0], { day: 'numeric', month: 'short', year: 'numeric' }) : fmtD(r[0], { month: 'long', year: 'numeric' });
    const evs = (byBar.get(G.off + i) || []).slice().sort((a, z) => z.t - a.t);
    tip.innerHTML = `<b>${label}</b><div class="r"><span>Average change</span><span>${sign(r[1], 2)}%</span></div><div class="r"><span>Stocks counted</span><span>${r[2]}</span></div>` +
      (evs.length ? '<div class="evs">' + evs.slice(0, 5).map(e => `<div class="ev"><span class="pc-evk pc-evk-${e.group}${e.group === 'news' && e.s ? ' s-' + e.s : ''}">${EVENT_GROUPS.find(x => x.id === e.group).glyph}</span><span>${escapeHtml(e.text)}<small>${escapeHtml(e.d + (e.src ? ' · ' + e.src : ''))}</small></span></div>`).join('') + (evs.length > 5 ? `<div class="ev more">+${evs.length - 5} more</div>` : '') + '</div>' : '');
    const tw = tip.offsetWidth, xx = G.X(i) * (rect.width / G.W);
    tip.style.left = Math.max(0, Math.min(rect.width - tw, xx + 14 + tw > rect.width ? xx - tw - 14 : xx + 14)) + 'px'; tip.style.top = '6px'; tip.style.opacity = '1';
  });
  ch.addEventListener('pointerleave', () => { tip.style.opacity = '0'; panel.querySelector('.pc-xh').setAttribute('opacity', '0'); });
  redraw();
  return { redraw, shown, events };
}

function chartsHtml(){
  return `<div class="tech-panel" id="jump-ind-charts"><div class="tech-panel-head"><div class="tech-panel-title">${panelIcon('tech')}Average % change</div></div>
    <p class="peers-sub">Each bar is the average change of the stocks in this group over that week or month. Tags below the bars mark news (⚡), results (E) and company events (C) of these stocks; a number means several on that bar.</p>
    <div class="pc-panels" id="indCharts"><p class="upload-hint">Loading price history…</p></div></div>`;
}
function initCharts(members, events){
  const root = document.getElementById('indCharts');
  if(!root) return;
  ensureAllPriceBars().then(ok => {
    if(!root.isConnected) return;
    const live = members.filter(s => priceHistoryByTicker[pcTickerKey(s)]);
    if(!ok || !live.length){ root.innerHTML = '<p class="upload-hint biz-warn">Price history is not available for these stocks yet.</p>'; return; }
    root.innerHTML = '';
    const ctl = [];
    CHARTS.forEach(c => {
      const series = industrySeries(live.map(s => priceHistoryByTicker[pcTickerKey(s)][c.int]), c.k);
      const panel = document.createElement('div'); panel.className = 'pc-panel';
      if(series.length < 2){ panel.innerHTML = `<div class="pc-ph"><div class="pc-ptitle">${c.title}</div></div><p class="upload-hint">Not enough price history.</p>`; root.appendChild(panel); return; }
      const last = series[series.length - 1];
      panel.innerHTML = `<div class="pc-ph"><div class="pc-ptitle">${c.title}<small>${series.length} bars</small></div><div class="pc-psum"><span class="${last[1] >= 0 ? 'chg-up' : 'chg-down'}">${sign(last[1], 2)}% latest</span></div><div class="pc-pills" role="group" aria-label="${c.title} range">${c.ranges.map((r, i) => `<button type="button" class="pc-pill" data-i="${i}" aria-pressed="${i === c.def}">${r[0]}</button>`).join('')}</div></div>
        <div class="pc-chart"><svg role="img" aria-label="${c.title} average % change chart"></svg><div class="pc-tip"></div></div>`;
      root.appendChild(panel);
      ctl.push(bindChart(panel, c, series, events, { range: c.def, geo: null }));
    });
    let rz; const ro = new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { if(root.isConnected) ctl.forEach(x => x.redraw()); }, 80); });
    ro.observe(root);
  });
}

// Everything the page needs for one industry; the events used for the chart tags are the news, results and company events of its stocks.
function renderIndustryDetail(by, name, backLabel, openStock){
  const members = membersOf(by, name), news = industryNews(members);
  const events = news.map(n => ({ t: Date.parse(n.d + 'T00:00:00+05:30') / 1000, d: n.d, k: n.k, group: n.k, text: n.t, src: n.src || n.stock, s: n.s }));
  const links = [['jump-ind-factors', 'Industry Factors'], ['jump-ind-global', 'Global & Macro'], ['jump-ind-charts', '% change'], ['jump-ind-news', 'News'], ['jump-ind-stocks', 'Stocks']];
  detailEl.innerHTML = `
    <div class="detail-back-bar"><button type="button" class="detail-back" id="detailBackBtn" title="Back (Esc)">&larr; Back to ${escapeHtml(backLabel)}<span class="detail-back-key">Esc</span></button></div>
    <div class="detail-top"><div class="detail-title"><div class="detail-title-text"><div class="detail-name">${escapeHtml(name)}</div><div class="detail-ticker">${by === 'group' ? 'Industry group' : 'Industry'} &middot; ${members.length} stock${members.length === 1 ? '' : 's'}</div></div></div></div>
    <nav class="detail-jump" aria-label="Jump to section"><div class="detail-jump-who"><span class="detail-jump-name">${escapeHtml(name)}</span></div><span class="detail-jump-label">Jump to</span>${links.map(l => `<a href="#" data-jump="${l[0]}">${l[1]}</a>`).join('')}</nav>
    ${factorsHtml(industryFactors(members))}
    ${globalHtml(industryGlobal(members))}
    ${chartsHtml()}
    ${newsHtml(news)}
    ${stocksHtml(members)}`;
  bindJumpSpy(detailEl);
  detailEl.querySelectorAll('.detail-jump a[data-jump]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    const el = document.getElementById(/** @type {HTMLElement} */ (a).dataset.jump);
    if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  detailEl.querySelectorAll('tr.strat-row[data-idx]').forEach(tr => {
    const open = () => openStock(Number(/** @type {HTMLElement} */ (tr).dataset.idx));
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if(/** @type {KeyboardEvent} */ (e).key === 'Enter') open(); });
  });
  initCharts(members, events);
}

export { renderIndustryDetail };
