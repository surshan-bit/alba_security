// Text of the price chart's hover tooltip: prices, change, MACD and the events of the bar under the pointer. Pure: numbers in, markup out.
import { escapeHtml } from '../core/util.js';

const IST_OFFSET_SEC = 19800;
const MAX_TIP_EVENTS = 5;
const TIP_GAP_PX = 14;

/** Date of a unix-seconds time in India time, formatted for en-GB with the given Intl options. */
function fmtDate(t, opts){ return new Date((t + IST_OFFSET_SEC) * 1000).toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, opts)); }
/** @param {number} n */
function rupees(n){ return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
/** Share volume in Indian units (K, L = lakh, Cr = crore). */
function volumeText(v){ return v >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : v >= 1e5 ? (v / 1e5).toFixed(2) + ' L' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v); }
function pctText(v){ return v === null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }

/** Heading of the tooltip: the week or month a bar covers. */
function tipLabel(k, bar){ return k === '1W' ? 'Week of ' + fmtDate(bar[0], { day: 'numeric', month: 'short', year: 'numeric' }) : fmtDate(bar[0], { month: 'long', year: 'numeric' }); }

/** Percent change of a bar's close from the previous close (or its own open for the first bar). */
function changePct(bar, prev){ return (bar[4] / (prev && prev[4] > 0 ? prev[4] : bar[1]) - 1) * 100; }

const row = (name, value) => `<div class="r"><span>${name}</span><span>${value}</span></div>`;

/** Open, high, low, close, change and volume of a bar, then `extra` (MACD and events). */
function tooltipHtml(label, bar, chg, extra){
  return `<b>${label}</b>${row('Open', rupees(bar[1]))}${row('High', rupees(bar[2]))}${row('Low', rupees(bar[3]))}${row('Close', rupees(bar[4]))}${row('Change', (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%')}${row('Volume', volumeText(bar[5]))}${extra}`;
}

/** MACD, signal and histogram of the hovered bar `j` (nothing for a stock with no MACD; a note while the averages are still warming up). */
function macdTipHtml(ms, j){
  if(!ms) return '';
  return row('MACD', ms.macd[j].toFixed(2)) + row('Signal', ms.signal[j].toFixed(2)) + row('Histogram', ms.hist[j].toFixed(2)) + (j < ms.from ? row('MACD still warming up', '') : '');
}

/** Events of the hovered bar, newest first, at most five; `groups` supplies the glyph of an event kind. `react` is how the price moved after news. */
function eventTipHtml(list, react, per, groups){
  if(!list || !list.length) return '';
  const sorted = list.slice().sort((a, b) => b.t - a.t), more = sorted.length - MAX_TIP_EVENTS;
  const glyphFor = (e) => e.k === 'news' ? '⚡' : (e.glyph || groups.find((x) => x.id === e.group).glyph);
  const item = (e) => `<div class="ev"><span class="pc-evk pc-evk-${e.group}${e.k === 'sell' ? ' sell' : ''}${e.group === 'news' && e.s ? ' s-' + e.s : ''}">${glyphFor(e)}</span><span>${escapeHtml(e.text)}<small>${escapeHtml(e.d + (e.src ? ' · ' + e.src : ''))}</small></span></div>`;
  const moved = react && list.some((e) => e.group === 'news') ? `<div class="evmove">Price: ${per} ${pctText(react.same)}, next ${per} ${pctText(react.next)}</div>` : '';
  return '<div class="evs">' + sorted.slice(0, MAX_TIP_EVENTS).map(item).join('') + (more > 0 ? `<div class="ev more">+${more} more</div>` : '') + moved + '</div>';
}

/** Left edge (px) of the tooltip: beside the pointer, flipped to its other side when it would overflow, never outside the chart. */
function tipLeft(chartWidth, tipWidth, pointerX){
  return Math.max(0, Math.min(chartWidth - tipWidth, pointerX + TIP_GAP_PX + tipWidth > chartWidth ? pointerX - tipWidth - TIP_GAP_PX : pointerX + TIP_GAP_PX));
}

export { changePct, eventTipHtml, fmtDate, macdTipHtml, tipLabel, tipLeft, tooltipHtml };
