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
  return `Current price ₹${currentPrice.toLocaleString('en-IN')} is <span class="${gapBand}" style="font-weight:600;">${gapLabel}</span>.`;
}

// The valuation strip inside the stock header card: margin of safety, intrinsic value, price and the one-line reading.
function renderValuationStrip(s){
  const v = s.valuation;
  if(!v) return '';
  const mos = marginOfSafety(v.intrinsicValue, v.currentPrice), ivGap = valGapMarkup(v.currentPrice, v.intrinsicValue);
  if(v.intrinsicValue == null || mos === null) return `<div class="detail-val" id="jump-val"><div class="dv-gap">No reliable intrinsic-value source found for this stock.</div></div>`;
  const g = -mos, band = g > 15 ? 'avoid' : g > 0 ? 'hold' : g > -15 ? 'mbuy' : 'buy';
  const sign = mos > 0 ? '+' : mos < 0 ? '−' : '';
  return `<div class="detail-val" id="jump-val">
    <div class="dv-mos fs-${band}" title="Margin of safety = (Intrinsic Value − Current Price) ÷ Intrinsic Value">${sign}${Math.abs(mos).toFixed(1)}%<small>Margin of safety</small></div>
    <div class="dv-nums"><div><span>Intrinsic value</span><b>₹${v.intrinsicValue.toLocaleString('en-IN')}</b></div><div><span>Price</span><b>${typeof v.currentPrice === 'number' ? '₹' + v.currentPrice.toLocaleString('en-IN') : '–'}</b></div></div>
    <div class="dv-gap">${ivGap || ''}</div>
  </div>`;
}

export { renderValuationStrip };
