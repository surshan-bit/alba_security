// Peers panel and peer grouping.
import { panelIcon } from './icons.js';
import { stocks } from '../core/stocks.js';
import { escapeHtml, tickerIndustry } from '../core/util.js';
import { analysisLbCell, analysisRowContext, columnHeaderHtml, stockGridColumnIds } from '../analysis/columns.js';
import { NO_SORT } from '../ui/gridsort.js';

// Industry Peers — the stocks the Fundamental Score ranked this one against (added 2026-10-06).
// Peer group = `industryGroup` (the fundamentals CSV's "Industry Group" column, set on every stock
// by the Fundamental Score CSV refresh). Financial Health, Profitability, Growth, Valuation and
// Capital Reinvestment Efficiency rank within it, except groups under PEER_MIN_GROUP_SIZE members,
// which fall back to the whole universe (see Knowledge Base §3 / the fundamental-score-csv-refresh
// skill) — noted on the panel when that applies.
const PEER_MIN_GROUP_SIZE = 10;
let peerGroupCache = null;
function peerGroups(){
  if(peerGroupCache) return peerGroupCache;
  const g = new Map();
  stocks.forEach((p, i) => {
    if(!p.industryGroup) return;
    if(!g.has(p.industryGroup)) g.set(p.industryGroup, []);
    g.get(p.industryGroup).push(i);
  });
  for(const arr of g.values()){
    arr.sort((a, b) => {
      const sa = stocks[a].score, sb = stocks[b].score;
      if(sa == null && sb == null) return stocks[a].name.localeCompare(stocks[b].name);
      if(sa == null) return 1;
      if(sb == null) return -1;
      return sb - sa || stocks[a].name.localeCompare(stocks[b].name);
    });
  }
  peerGroupCache = g;
  return g;
}
const plural = (n) => (n === 1 ? '' : 's');
const EMPTY_PEERS = `<div class="tech-panel jump-target" id="peersPanel"><div class="tech-panel-head"><div class="tech-panel-title">${panelIcon('peers')}Industry Peers</div></div><div class="peers-empty">Peer group not available for this stock.</div></div>`;
// The peer rows: one per stock sharing the industry, the open stock marked.
function peerRowsHtml(members, selfIdx, cols){
  return members.map((i, k) => {
    const self = i === selfIdx, ctx = analysisRowContext(stocks[i], k, i);
    return `<tr data-idx="${i}" class="strat-row${self ? ' peers-self' : ''}" tabindex="0">${cols.map(id => analysisLbCell(id, ctx)).join('')}</tr>`;
  }).join('');
}
// What the Fundamental Score ranked this stock against: its exact peers, the wider group, or all stocks.
function peersBasis(members, groupMembers, group){
  if(members.length >= PEER_MIN_GROUP_SIZE) return `The Fundamental Score ranks this stock against these ${members.length} peers.`;
  if(groupMembers.length >= PEER_MIN_GROUP_SIZE) return `Only ${members.length} stock${plural(members.length)} share${members.length === 1 ? 's' : ''} this exact industry (fewer than ${PEER_MIN_GROUP_SIZE}), so the Fundamental Score ranks against the wider ${escapeHtml(group)} group of ${groupMembers.length} stocks instead.`;
  return `Both this industry and ${escapeHtml(group)} have fewer than ${PEER_MIN_GROUP_SIZE} stocks, so the Fundamental Score ranks against all stocks instead.`;
}
function peersLead(members, rank, industry, group){
  return members.length > 1
    ? `Stocks in the same industry (${escapeHtml(industry)}) and group (${escapeHtml(group)}). It sits #${rank} of ${members.length} here. Tap a row to open that stock.`
    : `No other stock shares the industry ${escapeHtml(industry)} in ${escapeHtml(group)}.`;
}
function renderPeersPanel(s, selfIdx){
  const group = s.industryGroup;
  const groupMembers = group ? (peerGroups().get(group) || []) : [];
  if(!group || groupMembers.length === 0) return EMPTY_PEERS;
  // Shown peers = exact match on BOTH levels: same Industry Group AND same specific industry
  // (changed 2026-10-06 — previously the whole Industry Group was listed). The score itself still
  // ranks against the wider group, which the note below states.
  const industry = tickerIndustry(s);
  const members = groupMembers.filter(i => tickerIndustry(stocks[i]) === industry);
  const cols = stockGridColumnIds().filter(id => id !== 'industry');   // the columns set in Analysis; every peer shares the industry, so that one is left out
  const lead = peersLead(members, members.indexOf(selfIdx) + 1, industry, group), basis = peersBasis(members, groupMembers, group);
  return `
    <div class="tech-panel jump-target" id="peersPanel">
      <div class="tech-panel-head">
        <div class="tech-panel-title">${panelIcon('peers')}Industry Peers &middot; ${escapeHtml(industry)}</div>
        <span class="completeness-badge complete">${members.length} stock${plural(members.length)}</span>
      </div>
      <p class="peers-sub">${lead} ${basis}</p>
      <div class="peers-scroll strat-table-wrap">
        <table class="strat-table peers-table" data-cols="${cols.join(',')}">
          <thead><tr>${cols.map(id => columnHeaderHtml(id, NO_SORT)).join('')}</tr></thead>
          <tbody>${peerRowsHtml(members, selfIdx, cols)}</tbody>
        </table>
      </div>
      <div class="peers-hint">Swipe the table sideways to see all columns.</div>
    </div>`;
}

function setPeerGroupCache(v){ peerGroupCache = v; }

export { renderPeersPanel, setPeerGroupCache };
