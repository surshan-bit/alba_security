import { panelIcon } from './icons.js';
import { marginOfSafety } from '../core/mos.js';
// Valuation panel on the stock detail page.

// A single, merged 6-factor fundamental framework — replaces the earlier dual
// Framework 1 (5-pillar) / Framework 2 (7-factor) setup. Technicals and Macro
// factors were dropped from here since they now live in their own dedicated
// sections (Technical Score, Global & Macro Information) with far more depth than a single
// blended pillar slice ever gave them; the weight freed up by dropping Macro
// went to Governance, which used to be the thinnest factor.
// Deliberately built on the same panel/grid/cell structure as renderTechPanel()
// below, so Fundamental Score and Technical Score read as one consistent design.
// Valuation — a CSV-sourced intrinsic value vs. current price, deliberately NOT derived
// from our own scoring model (unlike Fundamentals/Technical below). Shown first in the
// detail view: it's the first thing to check on any stock.
// Removed 2026-09-30 (schema and rendering both — this app doesn't do forward-looking price
// prediction, and no stock ever populated shareholding-pattern data either): the 12-Month
// Price Target cell (target12m/target12mSources) and the FII Ownership Trend cell
// (fiiOwnership/renderFiiCell) — see Knowledge Base §5.
function valGapMarkup(currentPrice, iv){
  const mos = marginOfSafety(iv, currentPrice);
  if(mos === null) return null;
  const gapPct = -mos;
  const gapBand = gapPct > 15 ? 'fs-avoid' : gapPct > 0 ? 'fs-hold' : gapPct > -15 ? 'fs-mbuy' : 'fs-buy';
  const gapLabel = gapPct >= 0
    ? `${gapPct.toFixed(1)}% above intrinsic value (${gapPct > 15 ? 'overvalued' : 'slightly overvalued'})`
    : `${Math.abs(gapPct).toFixed(1)}% below intrinsic value (${gapPct < -15 ? 'undervalued' : 'slightly undervalued'})`;
  return `Current price ₹${currentPrice.toLocaleString('en-IN')} is <span class="${gapBand}">${gapLabel}</span>.`;
}

function renderValuationPanel(s){
  const v = s.valuation;
  if(!v) return '';
  const hasIv = v.intrinsicValue != null;
  const ivGap = valGapMarkup(v.currentPrice, v.intrinsicValue);
  // Margin of safety sits in the heading, written like the Fundamental Score's: "Valuation · +18.2%" with a tag after it.
  let mosText = '', mosTag = '';
  const mos = marginOfSafety(v.intrinsicValue, v.currentPrice);
  if(mos !== null){
    const g = -mos;
    const band = g > 15 ? 'avoid' : g > 0 ? 'hold' : g > -15 ? 'mbuy' : 'buy';
    mosText = ` &middot; ${mos > 0 ? '+' : mos < 0 ? '−' : ''}${Math.abs(mos).toFixed(1)}%`;
    mosTag = `<span class="badge b-${band}" title="Margin of safety = (Intrinsic Value − Current Price) ÷ Intrinsic Value">Margin of safety</span>`;
  }
  return `
    <div class="val-panel" id="jump-val">
      <div class="val-panel-head">
        <div class="val-panel-title">${panelIcon('val')}Valuation${mosText}</div>
        ${mosTag}
      </div>
      <div class="val-grid">
        <div class="val-cell">
          ${hasIv ? `
          <div class="val-row">
            <div class="val-text">
              <div class="val-cell-value val-iv">Intrinsic value ₹${v.intrinsicValue.toLocaleString('en-IN')}</div>
              <div class="val-cell-sub">${ivGap || ''}</div>
            </div>
          </div>` : `
          <div class="val-cell-sub">No reliable intrinsic-value source found for this stock.</div>`}
        </div>
      </div>
    </div>
  `;
}

export { renderValuationPanel };
