// Fundamental Score panel: the header, the Strengths / Watch-outs box and the factor cards, grouped by category.
import { panelIcon } from './icons.js';
import { verdictLabel } from '../core/stocks.js';
import { scoreBand } from '../list/metrics.js';
import { completenessBadge, fundamentalCompleteness } from './completeness.js';
import { setFundRenderStock } from './fundmetrics.js';
import { renderFundOverallSummary } from './fundsummary.js';
import { fundCellHasPoints, renderFundFactorCell } from './fundcell.js';

// Factors carry an optional `category` ("Traditional" | "Buffett" | "Valuation") once a stock's
// fundamentals have been run through the combined equity-research framework comparison (see
// CASTROLIND, 29 Sep 2026). When present, each category is rendered as its own labeled
// subsection with its own subscore right next to its factor cards, instead of one flat grid
// with a separate summary block floating above it — that's more scannable and keeps a
// factor's score next to the group it actually belongs to. Stocks without `category` on their
// factors (i.e. the original 6-factor model) fall straight through to a single flat grid.
const FUND_CATEGORY_META = {
  Traditional: { label:'Traditional Analysis', subscoreKey:'traditionalSubscore' },
  Buffett:     { label:'Buffett-Style Analysis', subscoreKey:'buffettSubscore' },
  Valuation:   { label:'Valuation &amp; Margin of Safety (Screener.in Intrinsic Value)', subscoreKey:'valuationSubscore' }
};

// v1.309: cards with written points take the whole row (metrics beside the points); the others go two to a row, and one left over takes the row too.
function renderFundGrid(factors){
  const wide = factors.map(fundCellHasPoints);
  for(let i = 0; i < factors.length; ){
    if(wide[i]){ i++; continue; }
    let j = i; while(j < factors.length && !wide[j]) j++;
    if((j - i) % 2 === 1) wide[j - 1] = true;
    i = j;
  }
  return `<div class="fund-grid">${factors.map((f, i) => renderFundFactorCell(f, wide[i])).join('')}</div>`;
}

function renderFundamentals(s){
  setFundRenderStock(s);
  const m = s.fundamentals;
  if(!m){
    return `<div class="fund-panel" id="jump-fund"><div class="fund-panel-title">${panelIcon('fund')}Fundamental Score</div><div class="tech-empty">The fundamentals breakdown hasn't been added for this stock yet.</div></div>`;
  }
  const sb = m.scoringBreakdown;
  const hasCategories = sb && m.factors.some(f => f.category && FUND_CATEGORY_META[f.category]);

  let body;
  if(hasCategories){
    const catOrder = ['Traditional','Buffett','Valuation'];
    const grouped = catOrder
      .map(cat => ({ cat, meta: FUND_CATEGORY_META[cat], factors: m.factors.filter(f => f.category === cat) }))
      .filter(g => g.factors.length);
    const uncategorized = m.factors.filter(f => !f.category || !FUND_CATEGORY_META[f.category]);
    body = grouped.map(g => {
      const subscore = sb[g.meta.subscoreKey], hasSub = typeof subscore === 'number';
      const band = hasSub ? scoreBand(subscore) : 'fs-pending';
      return `
        <div class="fund-subsection" data-cat="${g.cat}">
          <div class="fund-subsection-head">
            <div class="fund-subsection-title">${g.meta.label}</div>
            ${hasSub ? `<div class="fund-cell-score ${band}">${subscore.toFixed(1)}<span class="fund-cell-max">/10</span></div>` : '<div class="fund-cell-score fs-pending">Not scored</div>'}
          </div>
          ${hasSub ? `<div class="fund-cell-bar"><i class="${band}" style="width:${Math.round(subscore*10)}%"></i></div>` : ''}
          ${renderFundGrid(g.factors)}
        </div>
      `;
    }).join('') + (uncategorized.length ? `${renderFundGrid(uncategorized)}` : '');
  } else {
    body = `${renderFundGrid(m.factors)}`;
  }

  return `
    <div class="fund-panel" id="jump-fund">
      <div class="fund-panel-head">
        <div class="fund-panel-title">${panelIcon('fund')}Fundamental Score &middot; ${s.score.toFixed(2)}/10</div>
        <div class="fund-panel-head-right">
          <span class="badge b-${s.verdict}">${verdictLabel[s.verdict]}</span>
          ${completenessBadge(fundamentalCompleteness(s), 'factors')}
          <a href="#" class="help-tab-link" id="howCalculatedLink">How is this calculated? →</a>
        </div>
      </div>
      ${renderFundOverallSummary(s)}
      ${body}
    </div>
  `;
}


export { renderFundamentals };
