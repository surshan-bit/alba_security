// Shared formatting for the Rocky page: numbers, escaped text and the grid table. Pure functions, no DOM.
import { escapeHtml } from '../core/util.js';

const TIER_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
const num = (v) => typeof v === 'number' && isFinite(v);
const fmt = (v, d = 0) => num(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–';
const e = (s) => escapeHtml(s == null ? '' : String(s));
const list = (a) => Array.isArray(a) ? a : [];

/** @param {{h:string, n?:boolean, f:(r:any)=>string}[]} cols @param {any[]} rows @param {string} empty */
function table(cols, rows, empty){
  if(!rows.length) return '<p class="rky-empty">' + empty + '</p>';
  return '<div class="strat-table-wrap"><table class="strat-table rky-table"><thead><tr>' + cols.map(c => '<th' + (c.n ? ' class="num"' : '') + '>' + c.h + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => '<td' + (c.n ? ' class="num"' : '') + '>' + c.f(r) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}

export { TIER_LABEL, e, fmt, list, num, table };
