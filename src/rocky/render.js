// The Rocky page: the paper-trading swing agent's ledger. Everything here is read from the `rocky` collection (see store.js).
import { escapeHtml } from '../core/util.js';
import { rocky } from './store.js';

const CAPITAL = 1000000;
const MAX_POS = 8;
const num = (v) => typeof v === 'number' && isFinite(v);
const fmt = (v, d = 0) => num(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–';
const pct = (v) => num(v) ? '<span class="' + (v >= 0 ? 'rky-up' : 'rky-dn') + '">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</span>' : '–';
const e = (s) => escapeHtml(s == null ? '' : String(s));
const list = (a) => Array.isArray(a) ? a : [];

/** @param {{h:string, n?:boolean, f:(r:any)=>string}[]} cols @param {any[]} rows @param {string} empty */
function table(cols, rows, empty){
  if(!rows.length) return '<p class="rky-empty">' + empty + '</p>';
  return '<div class="strat-table-wrap"><table class="strat-table rky-table"><thead><tr>' + cols.map(c => '<th' + (c.n ? ' class="num"' : '') + '>' + c.h + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => '<td' + (c.n ? ' class="num"' : '') + '>' + c.f(r) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}
const stock = (r) => '<b>' + e(r.k) + '</b>' + (r.n ? '<br><span class="rky-sub">' + e(r.n) + '</span>' : '');

// Equity curve (agent, solid) with Nifty (dashed) rebased to the agent's equity on the first day that has a Nifty close.
function curveSvg(pts){
  if(pts.length < 2) return '<p class="rky-empty">The curve starts drawing after the second daily run.</p>';
  const base = pts.find(p => num(p[2]));
  const nf = base ? pts.map(p => num(p[2]) ? p[2] / base[2] * base[1] : null) : [];
  const all = pts.map(p => p[1]).concat(nf.filter(x => x != null));
  const lo = Math.min(...all, CAPITAL), hi = Math.max(...all, CAPITAL), W = 600, H = 150;
  const x = (i) => 8 + i * (W - 16) / (pts.length - 1), y = (a) => H - 12 - (a - lo) / ((hi - lo) || 1) * (H - 24);
  const line = (vals, cls) => { let d = '', pen = false; vals.forEach((a, i) => { if(a == null){ pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(a).toFixed(1); pen = true; }); return '<path class="' + cls + '" d="' + d + '" fill="none" vector-effect="non-scaling-stroke"/>'; };
  const leg = '<p class="rky-sub"><span class="rky-key rky-key-agent"></span> Rocky' + (base ? ' &nbsp; <span class="rky-key rky-key-nifty"></span> Nifty, rebased to Rocky on ' + e(base[0]) : ' &nbsp; The Nifty line appears once two runs have a Nifty close') + '</p>';
  return '<svg class="rky-curve" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Equity curve"><line class="rky-base" x1="0" x2="' + W + '" y1="' + y(CAPITAL) + '" y2="' + y(CAPITAL) + '"/>' + (base ? line(nf, 'rky-nifty') : '') + line(pts.map(p => p[1]), 'rky-agent') + '</svg>' + leg;
}

function kpis(st, pk, wt){
  const curve = list(st.curve), eq = curve.length ? curve[curve.length - 1][1] : CAPITAL, ret = (eq / CAPITAL - 1) * 100;
  const cl = list(st.closed), wins = cl.filter(c => c.ret > 0).length, m = st.metrics || {}, rg = pk && pk.regime;
  const tiles = [
    ['Paper equity', '₹' + fmt(eq)], ['Return since start', pct(ret)], ['Open positions', list(st.open).length + ' / ' + MAX_POS],
    ['Closed trades', String(cl.length)], ['Hit rate', cl.length ? fmt(wins / cl.length * 100) + '%' : '–'], ['Weights version', wt ? 'v' + wt.v : 'v0'],
    ['Market regime', rg ? (rg.on ? '<span class="rky-up">Risk-on</span>' : '<span class="rky-dn">Risk-off</span>') + (num(rg.breadth) ? ' <span class="rky-sub">' + fmt(rg.breadth * 100) + '% up</span>' : '') : '–'],
    ['Alpha vs Nifty', pct(m.alpha)], ['Nifty return', pct(m.niftyRet)], ['Max drawdown', pct(m.maxDD)], ['Current drawdown', pct(m.curDD)],
    ['Expectancy / trade', pct(m.expectancy)], ['Avg win / avg loss', num(m.avgWin) && num(m.avgLoss) ? m.avgWin.toFixed(1) + '% / ' + m.avgLoss.toFixed(1) + '%' : '–']
  ];
  return '<div class="rky-tiles">' + tiles.map(t => '<div class="rky-tile"><b>' + t[0] + '</b><span>' + t[1] + '</span></div>').join('') + '</div>';
}

function picksHtml(pk){
  if(!pk) return '<p class="rky-empty">No picks yet.</p>';
  const rg = pk.regime, off = rg && !rg.on;
  const empty = off ? 'Risk-off: fewer than ' + fmt((rg.min || 0) * 100) + '% of stocks are up over the last month, so Rocky opens no new positions. Staying in cash is a valid call.' : 'No stock passes all the checks today. Staying in cash is a valid call.';
  const picks = table([
    { h: 'Stock', f: stock }, { h: 'Group', f: r => e(r.g) }, { h: 'Close ₹', n: true, f: r => fmt(r.close, 2) }, { h: 'Score', n: true, f: r => num(r.score) ? r.score.toFixed(2) : '–' },
    { h: 'MoS %', n: true, f: r => fmt(r.mos) }, { h: 'Wk RSI', n: true, f: r => fmt(r.rsiW) }, { h: 'Stop / Target', n: true, f: r => num(r.stop) ? fmt(r.stop, 2) + ' / ' + fmt(r.target, 2) : '–' }
  ], list(pk.picks), empty);
  const note = '<p class="rky-sub">' + e(pk.universe) + ' stocks scored, ' + e(pk.blocked) + ' blocked by risk checks (downtrend, results within 7 days, falling knife, Avoid verdict, thin trading).</p>';
  const gated = list(pk.gated);
  const gt = gated.length ? '<h3 class="rky-h3">Passed the checks, failed the 1:3 gate</h3>' + table([
    { h: 'Stock', f: stock }, { h: 'Score', n: true, f: r => num(r.score) ? r.score.toFixed(2) : '–' }, { h: 'Close ₹', n: true, f: r => fmt(r.close, 2) },
    { h: 'Stop / Target', n: true, f: r => fmt(r.stop, 2) + ' / ' + fmt(r.target, 2) }, { h: 'Why rejected', f: r => e(r.why) }
  ], gated, '') : '';
  return picks + note + gt;
}

function learnHtml(wt, ln){
  let h = '';
  if(wt && wt.w){
    const mx = Math.max(...Object.values(wt.w).filter(num), 1);
    h += Object.entries(wt.w).map(([k, v]) => '<div class="rky-bar"><span>' + e(k) + '</span><i data-css="--w:' + (num(v) ? Math.round(v / mx * 60) : 0) + '%"></i><span class="rky-mono">' + e(v) + '</span></div>').join('');
  }
  if(ln) h += '<p class="rky-sub">Last review ' + e(ln.d) + ': ' + e(ln.note || ('hit rate ' + ln.hit + '%, average ' + ln.avg + '% per trade, weights updated')) + '</p>';
  if(wt && list(wt.hist).length) h += wt.hist.slice(-3).map(x => '<p class="rky-sub">' + e(x.d) + ': ' + Object.entries(x.ch || {}).map(([k, v]) => e(k) + ' ' + e(v[0]) + '→' + e(v[1])).join(', ') + '</p>').join('');
  return h || '<p class="rky-empty">No learning data yet.</p>';
}

const RULES = 'Rules: ₹10 lakh paper capital, 1% risk per trade, max 8 positions (2 per industry group). Stop 4.5–9% by volatility, target 3 times the stop distance (1:3 reward to risk), and a stock is only taken if its 40-week high leaves room for that target or it is already within 3% of the high. New positions may run up to 70 days. No new entries while fewer than 60% of stocks are up over the month. Costs and slippage of 0.5% round trip are charged. Exits are checked on daily closes, so real fills could be worse. Weights change only after 20 or more closed trades. This is a paper ledger: no real orders are ever placed and nothing here is advice. The agent graduates to real-money ideas only if it beats the market after costs over a meaningful number of trades.';

function rockyHtml(){
  if(rocky.noDb) return '<p class="rky-empty">Sign in to view Rocky.</p>';
  if(!rocky.ready) return '<p class="upload-hint">Loading…</p>';
  const st = rocky.state;
  if(!st) return '<p class="rky-empty">Rocky has not run yet. The first scheduled run will fill this page.</p>';
  const pk = rocky.picks, cl = list(st.closed);
  const stamp = pk ? 'Run ' + e(pk.asof) + ' · data as of ' + e(pk.dataAsof || '?') : '';
  return '<div class="rky-head"><div class="rky-sub">Paper-trading swing agent on your Positive MoS list. Protect capital first, then capture the big multi-week moves. No real orders are ever placed.</div><div class="rky-stamp">' + stamp + '</div></div>' +
    kpis(st, pk, rocky.weights) +
    '<h2 class="rky-sec">Equity curve (₹)</h2>' + curveSvg(list(st.curve)) +
    '<h2 class="rky-sec">Today\'s picks</h2>' + picksHtml(pk) +
    '<h2 class="rky-sec">Open paper positions</h2>' + table([
      { h: 'Stock', f: stock }, { h: 'Opened', f: r => e(r.d) }, { h: 'Qty', n: true, f: r => fmt(r.q) }, { h: 'Entry', n: true, f: r => fmt(r.entry, 2) }, { h: 'Last', n: true, f: r => fmt(r.last, 2) },
      { h: 'P&amp;L', n: true, f: r => num(r.last) && num(r.entry) && r.entry ? pct((r.last / r.entry - 1) * 100) : '–' }, { h: 'Stop / Target', n: true, f: r => fmt(r.stop, 2) + ' / ' + fmt(r.target, 2) }
    ], list(st.open), 'No open positions.') +
    '<h2 class="rky-sec">Closed trades</h2>' + table([
      { h: 'Stock', f: r => '<b>' + e(r.k) + '</b>' }, { h: 'Held', f: r => e(r.d) + ' → ' + e(r.xd) }, { h: 'Exit', f: r => e(r.why) }, { h: 'Return', n: true, f: r => pct(r.ret) }, { h: 'P&amp;L ₹', n: true, f: r => fmt(r.pnl) }
    ], cl.slice().reverse().slice(0, 25), 'No closed trades yet. Learning starts after 20.') +
    '<h2 class="rky-sec">Learning</h2>' + learnHtml(rocky.weights, rocky.learn) +
    '<p class="rky-note">' + RULES + '</p>';
}

export { rockyHtml };
