// How a scored stock is written into the stock list: the Fundamental factor cards (each factor's numbers and its plain-language note), the valuation block
// and the Technical composite's valuation pillar. Pure: takes a record the engine scored (src/import/fund-engine.js) and returns plain data; no page, no network.
import { finApplies } from '../core/finsector.js';

const n = v => v != null && Number.isFinite(v);
const f = (v, d) => n(v) ? v.toFixed(d) : 'n/a';
const xx = (v, d = 2) => n(v) ? v.toFixed(d) + 'x' : 'n/a';
const pc = (v, d = 1) => n(v) ? v.toFixed(d) + '%' : 'n/a';
const cr = v => n(v) ? '₹' + v.toFixed(1) + ' Cr' : 'n/a';
const px = v => !n(v) ? 'n/a' : v.toFixed(1);
const px0 = v => !n(v) ? 'n/a' : v.toFixed(0);
const ordN = p => p == null ? 'n/a' : ord(p);
function ord(p) { const k = Math.round(p), m = k % 100, s = (m >= 11 && m <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th'); return k + s; }

const NAMES = {
  fin: ['Traditional', 'Financial Health &amp; Balance Sheet'], prof: ['Traditional', 'Profitability &amp; Capital Efficiency'],
  growth: ['Traditional', 'Growth &amp; Cash Flow Generation'], val: ['Traditional', 'Valuation Metrics (vs. industry)'],
  moat: ['Buffett', 'Moat &amp; Competitive Advantage'], gov: ['Buffett', 'Management &amp; Governance'],
  predict: ['Buffett', 'Earnings Predictability'], reinvest: ['Buffett', 'Capital Reinvestment Efficiency'],
  dcf: ['Valuation', 'Valuation &amp; Margin of Safety (Screener.in Intrinsic Value)'],
};

function peerText(basis, industry, group) {
  if (basis == null) basis = 'industry';
  // returns {chip, moatWhere, govWhere}
  if (basis === 'industry') return { chip: industry, moatWhere: `the same industry (${industry})`, govWhere: industry };
  if (basis === 'group') return { chip: `${group} group`, moatWhere: `the same industry group (${group}), since ${industry} has fewer than 10 peers`, govWhere: `the ${group} group (${industry} has fewer than 10 peers)` };
  return { chip: 'all stocks', moatWhere: null, govWhere: null };
}

function finText({ r, fa, scored, industry, group }) {
  let metrics, note;
    const all = [['D/E', xx(r.de), 'de'], ['Interest coverage', xx(r.interestCoverage), 'interestCoverage'], ['Quick ratio', xx(r.quickRatio), 'quickRatio'], ['Altman Z', f(r.altmanZ, 2), 'altmanZ'],
      ['Current ratio', xx(r.currentRatio), 'currentRatio'], ['Avg debtor days 3yr', f(r.avgDebtorDays3, 1), 'avgDebtorDays3']];
    metrics = all.filter(m => finApplies(r, m[2])).map(m => [m[0], m[1]]).concat([['Contingent liabilities', cr(r.contingentLiabilities)]]);
    const flag = n(r.contingentLiabilities) && r.contingentLiabilities > 0 ? ` Contingent liabilities of ${cr(r.contingentLiabilities)} noted as a risk flag (not scored).` : '';
    if (fa.na) note = `Left out of the score: debt, liquidity, distress-model and debtor figures do not describe ${r.finKind === 'insurer' ? 'an insurer' : 'a bank'}.` + flag;
    else if (r.finKind === 'lender') note = `Scored against other lenders on debt compared with the owners' money (${xx(r.de)}) and interest cover (${xx(r.interestCoverage)}); liquidity, distress-model and debtor figures are left out.` + flag;
    else note = `Mechanically scored from screener.in data: balance-sheet profile (D/E ${xx(r.de)}, interest coverage ${xx(r.interestCoverage)}, Altman Z ${f(r.altmanZ, 2)}, current ratio ${xx(r.currentRatio)}).` + flag;
  return { metrics, note };
}

function profText({ r, fa, scored, industry, group }) {
  let metrics, note;
    metrics = [['ROCE', pc(r.roce)], ['ROE', pc(r.roe)], ['OPM', pc(r.opm)], ['Median ROCE 10yr', pc(r.medianRoce10)], ['Avg ROE 7yr', pc(r.avgRoe7)]];
    note = `Mechanically scored: capital efficiency blending current-year and multi-year-average ROCE/ROE with OPM (ROCE ${pc(r.roce)}, ROE ${pc(r.roe)}, OPM ${pc(r.opm)}).` + eqText(fa.note);
  return { metrics, note };
}

function growthText({ r, fa, scored, industry, group }) {
  let metrics, note;
    metrics = [['Sales growth 3yr', pc(r.salesGrowth3)], ['Profit growth 3yr', pc(r.profitGrowth3)], ['Profit growth TTM', pc(r.profitGrowthTTM)], ['FCF 3yr', cr(r.fcf3)], ['OCF 3yr', cr(r.ocf3)]];
    note = `Mechanically scored: top-line/bottom-line growth trend (3yr sales ${pc(r.salesGrowth3)}, 3yr profit ${pc(r.profitGrowth3)}).` + eqText(fa.note) + cfText(fa.note);
  return { metrics, note };
}

function valText({ r, fa, scored, industry, group }) {
  let metrics, note;
    metrics = [['P/E', xx(r.pe)], ['Industry P/E', xx(r.industryPe)], ['PEG', f(r.peg, 2)], ['Historical PE 5yr', xx(r.histPe5)]];
    note = `Mechanically scored vs industry: P/E ${xx(r.pe)} vs industry ${xx(r.industryPe)}, PEG ${f(r.peg, 2)}, and own 5yr-historical-PE comparison.`;
  return { metrics, note };
}

function moatText({ r, fa, scored, industry, group }) {
  let metrics, note;
    const pct = scored.moatPct, p = peerText(pct == null ? null : scored.moatBasis, industry, group);
    metrics = [['Industry-relative capital efficiency percentile', `${ordN(pct)} (${p.chip})`]];
    note = 'Data-driven mechanical proxy (pending individual research): scored from this company\'s own ROCE/ROE/OPM ranked against ' +
      (p.moatWhere ? `peers in ${p.moatWhere}` : `all stocks, since ${industry} and its industry group have fewer than 10 peers`) + ` — ${ordN(pct)} percentile. Not a substitute for researched moat analysis.`;
  return { metrics, note };
}

function govText({ r, fa, scored, industry, group }) {
  let metrics, note;
    const pct = scored.piotroskiPct, p = peerText(pct == null ? null : scored.govBasis, industry, group);
    metrics = [['Piotroski F-Score percentile', `${ordN(pct)} (${p.chip})`], ['Promoter pledge', pc(r.pledgePct)], ['Promoter holding', pc(r.promoterHolding, 2)], ['Promoter holding change', pc(r.promoterHoldingChange)],
      ['FII holding', pc(r.fiiHolding, 2)], ['FII change last quarter', pc(r.fiiChange, 2)], ['FII change 3yr', pc(r.fiiChange3, 2)], ['DII change 3yr', pc(r.diiChange3, 2)]];
    note = 'Data-driven mechanical proxy (pending individual research): based on Piotroski F-Score ranked against ' +
      (p.govWhere ? `peers in ${p.govWhere}` : `all stocks (${industry} and its group have fewer than 10 peers)`) +
      ` (${ordN(pct)} percentile), adjusted for promoter pledge (${pc(r.pledgePct)}), promoter-holding change, and institutional (FII/DII) conviction where available.`;
  return { metrics, note };
}

function predictText({ r, fa, scored, industry, group }) {
  let metrics, note;
    metrics = [['Profit growth TTM', pc(r.profitGrowthTTM)], ['3yr avg', pc(r.profitGrowth3)], ['5yr avg', pc(r.profitGrowth5)]];
    note = 'Mechanically scored on consistency of profit growth across TTM/3yr/5yr windows.';
  return { metrics, note };
}

function reinvestText({ r, fa, scored, industry, group }) {
  let metrics, note;
    const croic = scored.reinvestCroic;
    metrics = [[croic ? 'CROIC' : 'ROIC', pc(croic ? r.croic : r.roic)]];
    note = croic ? `Mechanically scored from CROIC (Cash Return on Invested Capital) as a proxy for reinvestment efficiency — ${pc(r.croic)}.`
      : `Mechanically scored from Return on Invested Capital (ROIC) as a proxy for reinvestment efficiency — ${pc(r.roic)}; CROIC is unavailable or held down by capex while operating cash flow is positive.`;
  return { metrics, note };
}

function dcfText({ r, fa, scored, industry, group }) {
  let metrics, note;
    const mos = scored.mosPct;
    metrics = [['Intrinsic Value (Screener.in)', px0(r.intrinsicValue)], ['Current price', px(r.currentPrice)], ['Margin of safety', n(mos) ? mos.toFixed(1) + '%' : 'n/a'], ['Graham Number', px0(r.graham)], ['NCAVPS', px(r.ncavps)]];
    note = `Mechanically scored: Screener.in's own Intrinsic Value estimate ₹${px0(r.intrinsicValue)} vs current price ₹${px(r.currentPrice)} (${n(mos) ? mos.toFixed(1) + '%' : 'n/a'} margin of safety, ranked against the current dataset).` +
      (n(r.graham) ? ` Cross-check: Graham Number ₹${px0(r.graham)}` + (n(r.intrinsicValue) && r.intrinsicValue > 0 && Math.abs(r.graham - r.intrinsicValue) / r.intrinsicValue > 0.3 ? ' (diverges notably from Intrinsic Value — informational only, not scored).' : '.') : '');
  return { metrics, note };
}

const FACTOR_TEXT = { fin: finText, prof: profText, growth: growthText, val: valText, moat: moatText, gov: govText, predict: predictText, reinvest: reinvestText, dcf: dcfText };

function buildFactor(key, r, scored, place) {
  const fa = scored.factors.find(x => x.key === key);
  const { metrics, note } = FACTOR_TEXT[key]({ r, fa, scored, industry: place.industry, group: place.group });
  const kindFields = key === 'fin' && r.finKind ? { sector: r.finKind, ...(fa.na ? { na: fa.na } : {}) } : {};
  return { category: NAMES[key][0], key, metrics, name: NAMES[key][1], note, score: fa.score == null ? 0 : fa.score, weight: fa.weight, ...kindFields };
}
// discount sentences derived from the engine's own notes
function eqText(en) { if (!en) return ''; if (en.includes('0.55x')) return ' (TTM growth far above multi-year trend — cyclical-spike discount applied)'; if (en.includes('0.8x')) return ' (TTM growth notably ahead of multi-year trend — mild discount applied)'; return ''; }
function cfText(en) { if (!en) return ''; if (en.includes('0.75x') || en.includes('0.85x')) return ' (growth not cash-backed — FCF/OCF discount applied)'; return ''; }

function buildFundamentals(r, industry, group) {
  const sc = r.scored;
  const factors = ['fin', 'prof', 'growth', 'val', 'moat', 'gov', 'predict', 'reinvest', 'dcf'].map(k => buildFactor(k, r, sc, { industry, group }));
  return { factors, scoringBreakdown: { buffettSubscore: sc.buffettSubscore, overallComposite: sc.score, traditionalSubscore: sc.traditionalSubscore, valuationSubscore: sc.valuationSubscore }, total: 10 };
}
// Technical composite's valuation pillar = the valuation factor score x10, kept in step with every fundamental import.
function pillarVal(r) { const sc = r.scored.factors.find(x => x.key === 'dcf').score; return sc == null ? null : Math.round(sc * 10 * 10) / 10; }
function pillarsFor(r) { const v = pillarVal(r); return v == null ? null : { val: v }; }
function valuationBlock(r, asof) {
  const v = { asof, currentPrice: r.currentPrice, grahamNumber: r.graham, intrinsicValue: r.intrinsicValue,
    intrinsicValueSource: 'Screener.in Intrinsic Value estimate (from uploaded fundamentals CSV) — the single source of truth for intrinsic value across this app.', ncavps: r.ncavps };
  // Holding and return figures from the CSV; kept as they were when this file does not have the column.
  const extra = { profitGrowth: r.profitGrowthTTM, promoterHolding: r.promoterHolding, fiiHolding: r.fiiHolding, fiiChange: r.fiiChange, fiiChange3: r.fiiChange3, diiChange3: r.diiChange3, ret1y: r.ret1, ret3y: r.ret3, ret5y: r.ret5 };
  Object.keys(extra).forEach(k => { if(extra[k] != null) v[k] = extra[k]; });
  return v;
}

export { buildFundamentals, pillarsFor, valuationBlock };
