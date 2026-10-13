// Trade Log panel: model, cards and table.
import { stockByTickerSymbol, verdictLabel } from '../core/stocks.js';
import { allTrades, getTradeDb } from '../core/store.js';
import { escapeHtml, formatDate, pctChangeSpan } from '../core/util.js';
import { completenessBadge } from '../detail/completeness.js';
import { prefSet } from '../identity/prefs.js';

// Which view the panel shows: 'cards' or 'table'. Only this panel uses it, so it is kept here (the saved choice
// is read once, when the page loads; the Cards / Table buttons change it).
let tlView = 'cards';
try { const v = localStorage.getItem('albaDashboard.tradeView.v1'); if(v === 'table' || v === 'cards') tlView = v; } catch(e){ /* storage unavailable: default view */ }

// ---- Track Record / Trade Log panel ----
// Renders the `tradeLog` collection (see the declaration and db subscription above) as a simple
// table: one row per logged position, its entry verdict/score/data-completeness, and — for an
// open position — its unrealized return against the stock's own live `valuation.currentPrice`
// (matched by ticker via stockByTickerSymbol, so it always reflects whatever the dashboard's
// current data says, not a snapshot), or — for a closed one — its realized return and exit
// verdict/score. A 2+-trade aggregate (average return by entry-verdict bucket) is shown once
// there's enough data for it to mean anything; a single trade just gets its own row, no crash.
function holdingDaysBetween(startIso, endIso){
  const start = new Date(startIso + 'T00:00:00');
  const end = endIso ? new Date(endIso + 'T00:00:00') : new Date();
  if(isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  return Math.max(0, Math.round((end - start) / 86400000));
}
function tradeReturnPct(t){
  // Realized return for a closed trade, else unrealized return against the stock's current live
  // price (null if the stock can't be matched or has no current price on file).
  if(t.status === 'closed' && t.sell && t.sell.realizedReturnPct != null) return t.sell.realizedReturnPct;
  const stock = stockByTickerSymbol.get(t.ticker);
  const livePrice = stock && stock.valuation && stock.valuation.currentPrice;
  if(livePrice == null || !t.buy || !t.buy.price) return null;
  return ((livePrice - t.buy.price) / t.buy.price) * 100;
}
function tlSetView(v){
  tlView = v;
  prefSet('albaDashboard.tradeView.v1', v);
  renderTradeLogPanel();
}
const tlInr = (n) => n == null ? '—' : '₹' + n.toLocaleString('en-IN', {maximumFractionDigits: 2});
function tlScoreCell(snap){
  const sc = snap && snap.score != null ? snap.score.toFixed(2) : '—';
  const v = snap && snap.verdict;
  return v ? `${sc} <span class="badge b-${v}" style="padding:1px 8px;font-size:.66rem;">${verdictLabel[v] || v}</span>` : sc;
}
// Everything a trade's card or table row needs, computed once per trade (the markup builders
// below only format it). A trade counts as closed only when it has a sell record.
function tlTradeModel(t){
  const buy = t.buy || {};
  const bs = buy.snapshot || {};
  const isClosed = t.status === 'closed' && !!t.sell;
  const sell = isClosed ? t.sell : null;
  const live = stockByTickerSymbol.get(t.ticker);
  const livePx = live && live.valuation && live.valuation.currentPrice != null ? live.valuation.currentPrice : null;
  const curPx = isClosed ? sell.price : livePx;
  const qty = buy.quantity || 0;
  const ret = tradeReturnPct(t);
  const id = escapeHtml(t._id || '');
  return {
    t, buy, sell, isClosed, curPx,
    name: escapeHtml(t.name || t.ticker || ''),
    ticker: escapeHtml(t.ticker || ''),
    boughtOn: escapeHtml(formatDate(buy.date)),
    qtyText: buy.quantity != null ? buy.quantity : '—',
    invested: (buy.price && qty) ? buy.price * qty : null,
    pnl: (curPx != null && buy.price) ? (curPx - buy.price) * qty : null,
    statusBadge: isClosed ? '<span class="completeness-badge complete">Closed</span>' : '<span class="completeness-badge incomplete">Open</span>',
    returnCell: ret != null ? pctChangeSpan(ret) : '<span class="analysis-lb-empty">n/a</span>',
    held: isClosed && sell.holdingDays != null ? sell.holdingDays : holdingDaysBetween(buy.date, isClosed ? sell.date : null),
    entryScore: tlScoreCell(bs),
    entryBadge: bs.fundamentalFactorsTotal != null
      ? completenessBadge({complete: bs.fundamentalFactorsComplete, total: bs.fundamentalFactorsTotal}, 'factors')
      : '<span class="analysis-lb-empty">—</span>',
    exitScore: isClosed ? tlScoreCell(sell.snapshot) : '<span class="analysis-lb-empty">—</span>',
    actions: `<div class="tl-row-actions">${isClosed ? '' : `<button type="button" class="refresh-btn" data-tl-sell="${id}">Sell</button>`}<button type="button" class="refresh-btn tl-danger" data-tl-remove="${id}">Remove</button></div>`
  };
}
function tlCardHtml(m){
  const pnlHtml = m.pnl != null ? ` &middot; <span class="${m.pnl >= 0 ? 'chg-up' : 'chg-down'}">${m.pnl >= 0 ? '+' : '&minus;'}${tlInr(Math.abs(m.pnl))}</span>` : '';
  return `
      <div class="tl-card">
        <div class="tl-card-top">
          <div><div class="tl-card-name">${m.name}</div><div class="tl-card-tk">${m.ticker}</div></div>
          ${m.statusBadge}
        </div>
        <div><div class="tl-card-retval">${m.returnCell}</div><div class="tl-card-retlbl">${m.isClosed ? 'Realized return' : 'Unrealized return'}${pnlHtml}</div></div>
        <dl class="tl-card-grid">
          <div><dt>Bought</dt><dd>${m.boughtOn}</dd></div>
          <div><dt>Buy price &times; qty</dt><dd>${tlInr(m.buy.price)} &times; ${m.qtyText}</dd></div>
          <div><dt>Invested</dt><dd>${tlInr(m.invested)}</dd></div>
          <div><dt>${m.isClosed ? 'Sold at' : 'Current price'}</dt><dd>${tlInr(m.curPx)}${m.isClosed ? `<br><span class="row-ticker">${escapeHtml(formatDate(m.sell.date))}</span>` : ''}</dd></div>
          <div><dt>Held</dt><dd>${m.held != null ? m.held + ' days' : '—'}</dd></div>
          <div><dt>Entry score</dt><dd>${m.entryScore}</dd></div>
          <div><dt>Data at entry</dt><dd>${m.entryBadge}</dd></div>
          ${m.isClosed ? `<div><dt>Exit score</dt><dd>${m.exitScore}</dd></div>` : ''}
        </dl>
        ${m.actions}
      </div>`;
}
function tlRowHtml(m){
  return `
      <tr>
        <td><span class="analysis-lb-name">${m.name}</span><span class="analysis-lb-ticker">${m.ticker}</span></td>
        <td>${m.boughtOn}<br><span class="row-ticker">${tlInr(m.buy.price)} &times; ${m.qtyText}</span></td>
        <td>${m.statusBadge}</td>
        <td>${m.entryScore}</td>
        <td>${m.entryBadge}</td>
        <td>${m.returnCell}</td>
        <td>${m.held != null ? m.held + 'd' : '—'}</td>
        <td>${m.exitScore}</td>
        <td>${m.actions}</td>
      </tr>`;
}
function renderTradeLogPanel(){
  document.querySelectorAll('.tl-view-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tl-view') === tlView));
  const el = document.getElementById('tradeLogPanelBody');
  if(!el) return;
  if(!getTradeDb()){
    el.innerHTML = `<p class="upload-hint">Your trade log needs a signed-in view — open this dashboard directly on claude.ai (signed in to your organization) to see and log your own trades.</p>`;
    return;
  }
  const trades = allTrades();
  if(trades.length === 0){
    el.innerHTML = `<p class="upload-hint">No trades logged yet. Use &ldquo;+ Add trade&rdquo; above to record a real position bought based on this dashboard's verdicts; its score, verdict and data completeness are frozen at that moment.</p>`;
    return;
  }
  const models = trades
    .sort((a, b) => ((b.buy && b.buy.date) || '').localeCompare((a.buy && a.buy.date) || ''))
    .map(tlTradeModel);

  // Aggregate by entry-verdict bucket — withheld below 2 trades since an "average" of one trade
  // would just restate that trade's own return and imply more signal than exists yet.
  let aggregateHtml = '';
  if(models.length >= 2){
    const byVerdict = new Map();
    models.forEach(m => {
      const v = m.buy.snapshot && m.buy.snapshot.verdict;
      const ret = tradeReturnPct(m.t);
      if(!v || ret == null) return;
      if(!byVerdict.has(v)) byVerdict.set(v, []);
      byVerdict.get(v).push(ret);
    });
    if(byVerdict.size){
      const chips = Array.from(byVerdict.entries()).map(([v, rets]) => {
        const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
        return `<span class="data-chip">${verdictLabel[v] || v}: <b>${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%</b> avg (${rets.length} trade${rets.length === 1 ? '' : 's'})</span>`;
      }).join('');
      aggregateHtml = `<div class="data-chips" style="margin:0 0 14px;">${chips}</div>`;
    }
  }

  let listHtml;
  if(tlView === 'cards'){
    listHtml = `<div class="tl-cards">${models.map(tlCardHtml).join('')}</div>`;
  } else {
    const returnHead = models.some(m => m.isClosed) ? 'Return' : 'Unrealized';
    listHtml = `
    <div class="help-table-wrap">
      <table class="help-table">
        <thead><tr><th>Stock</th><th>Buy date / price &times; qty</th><th>Status</th><th>Entry score</th><th>Data at entry</th><th>${returnHead}</th><th>Held</th><th>Exit score</th><th></th></tr></thead>
        <tbody>${models.map(tlRowHtml).join('')}</tbody>
      </table>
    </div>`;
  }
  el.innerHTML = aggregateHtml + listHtml;
}


export { holdingDaysBetween, renderTradeLogPanel, tlSetView };
