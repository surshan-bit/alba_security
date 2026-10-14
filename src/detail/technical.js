// Technical Score panel and its plain-English takeaways.
import { panelIcon } from './icons.js';
import { verdictLabel } from '../core/stocks.js';
import { scoreBand } from '../list/metrics.js';
import { renderPriceChartMount } from '../prices/chart.js';
import { formatDate } from '../core/util.js';

// ---- Technical Score, translated into plain business language ----
// The underlying signal is still a technical-analysis composite (MACD trend + RSI momentum +
// valuation), but a business reader has no use for "MACD bearish, above zero" or an RSI reading
// of "54.2" — what they actually want to know is: is the price trending up or down, is that trend
// gaining or losing steam, and is a reversal more likely than usual right now. These helpers derive
// that plain-English read from the same categorical states (`t.states.*`) the composite score is
// itself built from — no stored data is reinterpreted or guessed at, and nothing here can go stale
// relative to the score, since it's recomputed from the same fields on every render.
// Short categorical "Tech Rating" label for a single timeframe's MACD state — added 2026-10-06
// for the Analysis section leaderboard's "Tech Rating W"/"Tech Rating M" columns, which need a
// quick glanceable label. Derived from the same categorical state the composite score uses,
// so it can never drift out of sync with it.
function techRatingInfo(macdState){
  switch(macdState){
    case 'bull_above': return {label:'Bullish', cls:'b-buy'};
    case 'bull_below': return {label:'Turning Up', cls:'b-mbuy'};
    case 'bear_above': return {label:'Weakening', cls:'b-hold'};
    case 'bear_below': return {label:'Bearish', cls:'b-avoid'};
    default: return null;
  }
}
// Technical Score — a momentum-based read on the stock, distinct from the fundamentals-driven
// score above and expressed here in plain business language rather than the underlying
// MACD/RSI technical-analysis terms (see the helpers above). CHANGED (2026-09-29): this is now
// a plain 0-10 composite score only — the old Strong Buy/Buy/Overbought/Sell/Strong Sell
// bucket classification and its three hard-gate overrides have been removed for simplicity.
// A stock with no score on file (t.score == null) is shown as "insufficient data" — this
// covers both new stocks TradingView/CSV can't yet resolve and any older stock record still
// carrying the pre-2026-09-29 `bucket: 'insufficient_data'` shape (which never had a score).
// One timeframe's figures on a single line: change, rating, RSI. It is shown in the header of that timeframe's price chart.
function techTimeframeSummary(pct, macdState, rsi){
  const rating = techRatingInfo(macdState);
  const hasRsi = typeof rsi === 'number' && isFinite(rsi), r = hasRsi ? Math.max(0, Math.min(100, rsi)) : 0;
  const dir = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat');
  const arrow = dir === 'up' ? '&#9650;' : dir === 'down' ? '&#9660;' : '&#9644;';
  const zone = !hasRsi ? '' : rsi >= 70 ? 'hot' : rsi <= 30 ? 'cold' : '';
  const cell = (cls, title, key, body) => `<div class="pcs-cell ${cls}" title="${title}"><span class="pcs-key">${key}</span>${body}</div>`;
  return '<div class="pcs">'
    + cell('pcs-chg ' + dir, 'Price change over the period', 'Change', `<span class="pcs-val"><i class="pcs-arrow">${arrow}</i>${pct != null ? Math.abs(pct).toFixed(2) + '%' : 'n/a'}</span>`)
    + cell('pcs-rsi ' + zone, 'Relative Strength Index (momentum, 0-100): above 70 is stretched, below 30 is oversold', 'RSI', `<span class="pcs-val">${hasRsi ? rsi.toFixed(1) : '&mdash;'}</span>${hasRsi ? `<span class="pcs-gauge" aria-hidden="true"><i style="left:${r}%"></i></span>` : ''}`)
    + cell('pcs-sig ' + (rating ? 'sig-' + rating.cls.slice(2) : ''), 'Trend signal from the MACD', 'Signal', `<span class="pcs-val"><i class="pcs-dot"></i>${rating ? rating.label : '&mdash;'}</span>`)
    + '</div>';
}
// Which bars the score was read from. The bar-based refresh scores completed weeks and months only and keeps the reading with
// the week / month in progress as `provisional`; a TradingView export's readings always include the bars in progress.
function techBasisNote(t){
  const b = t.basis;
  if(!b) return '';
  let text;
  if(b.source === 'bars'){
    const month = b.month ? new Date(b.month + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '';
    text = 'Completed bars only' + (b.week ? ': weeks to the week of ' + formatDate(b.week) : '') + (month ? (b.week ? ', months to ' : ': months to ') + month : '') + '.';
    if(t.provisional && typeof t.provisional.score === 'number') text += ' With the week / month in progress: ' + t.provisional.score.toFixed(2) + ' (provisional).';
  } else if(b.source === 'csv') text = 'From the TradingView export: its readings include the week and month still in progress.';
  else return '';
  return `<div class="tech-basis">${text}</div>`;
}
function renderTechPanel(s){
  const t = s.technical;
  if(!t){
    return `<div class="tech-panel" id="jump-tech"><div class="tech-panel-title">${panelIcon('tech')}Technical Score</div><div class="tech-empty">Not available for this stock.</div></div>`;
  }
  if(t.score == null){
    return `
      <div class="tech-panel" id="jump-tech">
        <div class="tech-panel-head">
          <div class="tech-panel-title">${panelIcon('tech')}Technical Score</div>
          <span class="tech-badge tb-insufficient_data">Insufficient Data</span>
        </div>
        <div class="tech-empty">This stock doesn't have enough recent price history yet to read its momentum trend.</div>
      </div>
    `;
  }
  const r = t.raw;
  const bandKey = scoreBand(t.score).replace('fs-', '');
  const sums = { '1W': techTimeframeSummary(r.weekPctChange, t.states.weekMacd, r.weekRsi), '1M': techTimeframeSummary(r.monthPctChange, t.states.monthMacd, r.monthRsi) };
  // With no price history on file there is no chart to carry the figures, so they are shown as plain lines instead.
  const chartHtml = renderPriceChartMount(s, sums);
  return `
    <div class="tech-panel" id="jump-tech">
      <div class="tech-panel-head">
        <div class="tech-panel-title">${panelIcon('tech')}Technical Score &middot; ${t.score.toFixed(2)}/10</div>
        <span class="badge b-${bandKey}">${verdictLabel[bandKey] || ''}</span>
      </div>
      ${techBasisNote(t)}${t.newsNote ? `<div class="tech-news-note"><span class="tech-news-label">What happened</span><span>${t.newsNote}</span></div>` : ''}
      ${chartHtml || `<div class="tech-fallback"><div class="pc-psum"><b>Weekly</b>${sums['1W']}</div><div class="pc-psum"><b>Monthly</b>${sums['1M']}</div></div>`}
    </div>
  `;
}

export { renderTechPanel, techRatingInfo };
