// "Score trend" panel on the stock page: the Fundamental and Technical score (0-10) over time, with the price as a
// faint line behind them. The history is recorded by each import (src/history/scorehistory.js); until a stock has
// two points there is nothing to draw, and the panel says so.
import { escapeHtml, tickerKey } from '../core/util.js';
import { loadScoreHistory, ymdToDate } from '../history/scorehistory.js';
import { panelIcon } from './icons.js';

// The panel is hidden for now (v1.194). Set to true to bring it back: the score history keeps being recorded by every import, so
// the trend returns with everything saved in the meantime.
const SHOW_SCORE_TREND = false;
const W = 640, H = 200, PL = 30, PR = 10, PT = 10, PB = 22;
const fmtDate = n => ymdToDate(n).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function renderScoreTrendPanel(s){
  return `<div class="trend-panel" id="jump-trend" data-trend-key="${escapeHtml(tickerKey(s))}">
    <div class="trend-head"><div class="trend-title">${panelIcon('fund')}Score trend</div></div>
    <div class="trend-body"><div class="trend-note">Loading the score history…</div></div>
  </div>`;
}

// The chart for a list of points [ymd, fund, tech, price, engine]; pure, so it can be tested.
function scoreTrendHtml(points){
  const pts = (points || []).filter(p => Array.isArray(p) && p.length >= 4);
  if(pts.length < 2){
    return `<div class="trend-note">${pts.length ? 'One reading so far (' + fmtDate(pts[0][0]) + '). ' : ''}The trend appears after the next import: every Fundamental or Technical import adds a point, and about three years are kept.</div>`;
  }
  const t0 = ymdToDate(pts[0][0]).getTime(), t1 = ymdToDate(pts[pts.length - 1][0]).getTime(), span = Math.max(1, t1 - t0);
  const x = p => PL + (ymdToDate(p[0]).getTime() - t0) / span * (W - PL - PR);
  const y = v => PT + (1 - v / 10) * (H - PT - PB);
  const prices = pts.map(p => p[3]).filter(v => v != null), pmin = Math.min(...prices), pmax = Math.max(...prices);
  const py = v => PT + (1 - (pmax === pmin ? 0.5 : (v - pmin) / (pmax - pmin))) * (H - PT - PB);
  const line = (idx, fy, cls) => {
    let d = '', pen = false;
    for(const p of pts){ if(p[idx] == null){ pen = false; continue; } d += (pen ? 'L' : 'M') + x(p).toFixed(1) + ' ' + fy(p[idx]).toFixed(1); pen = true; }
    return d ? `<path class="${cls}" d="${d}" fill="none"/>` : '';
  };
  const dots = (idx, cls, label) => pts.filter(p => p[idx] != null).map(p => `<circle class="${cls}" cx="${x(p).toFixed(1)}" cy="${y(p[idx]).toFixed(1)}" r="3"><title>${label} ${p[idx].toFixed(2)} · ${fmtDate(p[0])}</title></circle>`).join('');
  let grid = '';
  for(const g of [0, 2.5, 5, 7.5, 10]) grid += `<line class="trend-grid" x1="${PL}" x2="${W - PR}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/><text class="trend-axis" x="${PL - 5}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end">${g}</text>`;
  let marks = '';
  for(let i = 1; i < pts.length; i++) if(pts[i][4] !== pts[i - 1][4]) marks += `<line class="trend-engine" x1="${x(pts[i]).toFixed(1)}" x2="${x(pts[i]).toFixed(1)}" y1="${PT}" y2="${H - PB}"><title>Scoring rules changed on ${fmtDate(pts[i][0])}</title></line>`;
  const axis = `<text class="trend-axis" x="${PL}" y="${H - 6}">${fmtDate(pts[0][0])}</text><text class="trend-axis" x="${W - PR}" y="${H - 6}" text-anchor="end">${fmtDate(pts[pts.length - 1][0])}</text>`;
  const last = pts[pts.length - 1], first = pts[0];
  const mv = idx => (first[idx] != null && last[idx] != null) ? (last[idx] - first[idx] >= 0 ? '+' : '') + (last[idx] - first[idx]).toFixed(2) : null;
  const sum = [mv(1) && 'Fundamental ' + mv(1), mv(2) && 'Technical ' + mv(2)].filter(Boolean).join(' · ');
  return `<div class="trend-legend"><span class="tl-fund">Fundamental</span><span class="tl-tech">Technical</span>${prices.length > 1 ? '<span class="tl-price">Price (own scale)</span>' : ''}${marks ? '<span class="tl-engine">Scoring rules changed</span>' : ''}</div>
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score trend over time">${grid}${marks}${line(3, py, 'trend-price')}${line(1, y, 'trend-fund')}${line(2, y, 'trend-tech')}${dots(1, 'trend-fund-dot', 'Fundamental')}${dots(2, 'trend-tech-dot', 'Technical')}${axis}</svg>
    <div class="trend-note">${pts.length} readings, ${fmtDate(first[0])} to ${fmtDate(last[0])}${sum ? '. Change over the period: ' + sum : ''}.</div>`;
}

// Fills the panel once the history arrives; does nothing if another stock was opened meanwhile.
function initScoreTrend(s){
  const key = tickerKey(s);
  const fill = html => { const panel = Array.from(document.querySelectorAll('#jump-trend')).find(e => e.getAttribute('data-trend-key') === key); const el = panel && panel.querySelector('.trend-body'); if(el) el.innerHTML = html; };
  loadScoreHistory(s).then(p => fill(scoreTrendHtml(p)), () => fill('<div class="trend-note">The score history could not be loaded.</div>'));
}

export { SHOW_SCORE_TREND, initScoreTrend, renderScoreTrendPanel };
