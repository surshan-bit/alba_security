// Fundamental Score engine: turns a screener.in CSV row into factor scores.
import { parseCSV } from './csvparse.js';
import { marginOfSafety } from '../core/mos.js';
import { financialKind, KIND_WORD, finApplies, finFactorNotApplicable } from '../core/finsector.js';
import { buildFundamentals, pillarsFor, valuationBlock } from './fund-text.js';

// ---- Fundamental Score engine v3 ----
// ---- Generic O(n log n) percentile-rank engine ----
function percentileRanks(entries) {
  const n = entries.length;
  const result = new Map();
  if (n === 0) return result;
  const sorted = entries.slice().sort((a, b) => a.value - b.value);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && sorted[j].value === sorted[i].value) j++;
    const pct = (j / n) * 100; // count of population <= this value, as a %
    for (let k = i; k < j; k++) result.set(sorted[k].id, pct);
    i = j;
  }
  return result;
}

function groupBy(records, keyFn) {
  const groups = new Map();
  for (const r of records) {
    const k = keyFn(r);
    let arr = groups.get(k);
    if (!arr) { arr = []; groups.set(k, arr); }
    arr.push(r);
  }
  return groups;
}

const MIN_GROUP_SIZE = 10;

/** Exact-industry key (v3): Industry Group + the dashboard's specific industry label. null when no label is known for the record. */
const narrowKey = r => (r.exactIndustry ? r.industryGroup + '||' + r.exactIndustry : null);
const normSym = x => String(x || '').trim().toUpperCase().replace(/_/g, '-');

/**
 * Industry-relative percentiles with hierarchical fallback (v3): exact industry -> Industry Group -> all stocks.
 * A level is used only when it has >= MIN_GROUP_SIZE entries WITH DATA for this metric. Population sort is computed once.
 * basisOut (optional Map) receives which level each record was ranked at: 'industry' | 'group' | 'population'.
 */
function relativePercentiles(records, metricFn, groupKeyFn, basisOut) {
  const entries = [];
  for (const r of records) {
    const v = metricFn(r);
    if (v != null && Number.isFinite(v)) entries.push({ id: r, value: v });
  }
  const populationRanks = percentileRanks(entries);
  const broadRanks = new Map();
  for (const [k, ge] of groupBy(entries, e => groupKeyFn(e.id))) if (ge.length >= MIN_GROUP_SIZE) broadRanks.set(k, percentileRanks(ge));
  const narrowRanks = new Map();
  for (const [k, ge] of groupBy(entries.filter(e => narrowKey(e.id) != null), e => narrowKey(e.id))) if (ge.length >= MIN_GROUP_SIZE) narrowRanks.set(k, percentileRanks(ge));
  const out = new Map();
  for (const e of entries) {
    const nk = narrowKey(e.id), bk = groupKeyFn(e.id);
    let ranks, basis;
    if (nk != null && narrowRanks.has(nk)) { ranks = narrowRanks.get(nk); basis = 'industry'; }
    else if (broadRanks.has(bk)) { ranks = broadRanks.get(bk); basis = 'group'; }
    else { ranks = populationRanks; basis = 'population'; }
    out.set(e.id, ranks.get(e.id));
    if (basisOut) basisOut.set(e.id, basis);
  }
  return out;
}

function populationPercentiles(records, metricFn) {
  const entries = [];
  for (const r of records) {
    const v = metricFn(r);
    if (v != null && Number.isFinite(v)) entries.push({ id: r, value: v });
  }
  return percentileRanks(entries);
}

// ---- Small helpers ----
function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || /^(nan|n\/a|-)$/i.test(s)) return null;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sum(list) { return list.reduce((a, b) => a + b, 0); }

/** Graceful partial-data weighted average (skill section 5): renormalize over whichever parts are present; null only when none are. */
function weightedPartial(weight, parts) {
  let coefSum = 0, weighted = 0, any = false;
  for (const { coef, pct } of parts) {
    if (pct == null) continue;
    any = true; coefSum += coef; weighted += coef * pct;
  }
  if (!any || coefSum === 0) return null;
  return weight * (weighted / coefSum) / 100;
}

function interpolateCurve(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    if (x <= x1) { const t = (x - x0) / (x1 - x0); return y0 + t * (y1 - y0); }
  }
  return curve[curve.length - 1][1];
}

// Header phrases -> field name, matched by substring (case-insensitive) — robust to column reordering.
const COLUMN_MATCHERS = [
  ['name', ['name']], ['bseCode', ['bse', 'code']], ['nseCode', ['nse', 'code']], ['isin', ['isin']],
  ['industryGroup', ['industry', 'group']], ['industry', ['industry'], ['group', 'industry pe']],
  ['currentPrice', ['current', 'price']], ['intrinsicValue', ['intrinsic', 'value']], ['bookValue', ['book', 'value']],
  ['profitGrowthTTM', ['profit', 'growth'], ['3years', '5years']],
  ['profitGrowth3', ['profit', 'growth', '3years']], ['profitGrowth5', ['profit', 'growth', '5years']],
  ['salesGrowth3', ['sales', 'growth', '3years']],
  ['roic', ['return', 'invested', 'capital'], ['average']], ['roce', ['return', 'capital', 'employed'], ['median']],
  ['roe', ['return', 'on', 'equity'], ['average']], ['opm', ['opm']],
  ['pe', ['price', 'earning']], ['industryPe', ['industry', 'pe']], ['peg', ['peg']],
  ['pledgePct', ['pledged']], ['interestCoverage', ['interest', 'coverage']], ['de', ['debt', 'equity']],
  ['promoterHoldingChange', ['promoter', 'holding', 'change']], ['piotroski', ['piotroski']], ['quickRatio', ['quick', 'ratio']],
  ['altmanZ', ['altman']], ['currentRatio', ['current', 'ratio']], ['contingentLiabilities', ['contingent']],
  ['avgRoe7', ['average', 'return', 'equity', '7years']], ['avgRoe10', ['average', 'return', 'equity', '10years']],
  ['medianRoce10', ['median', 'return', 'capital', 'employed', '10years']],
  ['fcf3', ['free', 'cash', 'flow', '3years']], ['fcf5', ['free', 'cash', 'flow', '5years']],
  ['ocf3', ['operating', 'cash', 'flow', '3years']], ['ocf5', ['operating', 'cash', 'flow', '5years']],
  ['croic', ['croic']], ['graham', ['graham']],
  ['fiiChange3', ['fii', 'holding', '3years']], ['diiChange3', ['dii', 'holding', '3years']],
  ['histPe5', ['historical', 'pe', '5years']], ['avgDebtorDays3', ['debtor', 'days', '3years']],
  ['ncavps', ['ncavps']], ['numShareholders', ['number', 'shareholders']],
  // Optional columns added later (an older export without them still imports; the fields are then empty).
  ['promoterHolding', ['promoter', 'holding'], ['change']], ['fiiHolding', ['fii', 'holding'], ['change', '3years']], ['fiiChange', ['fii', 'holding', 'change'], ['3years']],
  ['ret1', ['return', 'over', '1year']], ['ret3', ['return', 'over', '3years']], ['ret5', ['return', 'over', '5years']],
];

function buildColumnMap(headerRow) {
  const header = headerRow.map(h => h.trim().toLowerCase());
  const map = {};
  for (const [field, must, mustNot] of /** @type {[string, string[], string[]?][]} */ (COLUMN_MATCHERS)) {
    if (map[field] !== undefined) continue;
    const idx = header.findIndex(h => must.every(p => h.includes(p)) && !(mustNot && mustNot.some(p => h.includes(p))));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

function extractRecords(rows, colMap) {
  const get = (r, field) => (colMap[field] !== undefined ? r[colMap[field]] : undefined);
  const records = /** @type {any[]} */ ([]);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const nseCode = (get(r, 'nseCode') || '').trim();
    const bseRaw = (get(r, 'bseCode') || '').trim();
    const bseNum = bseRaw ? parseInt(bseRaw, 10) : NaN;
    const bseCode = !isNaN(bseNum) ? String(bseNum) : bseRaw;
    const sym = (nseCode || bseCode || '').trim().toUpperCase();
    if (!sym) continue;
    records.push({
      sym, name: (get(r, 'name') || '').trim(), bseCode, nseCode, isin: (get(r, 'isin') || '').trim(),
      industryGroup: (get(r, 'industryGroup') || '').trim() || '(unclassified)', industry: (get(r, 'industry') || '').trim(),
      currentPrice: toNum(get(r, 'currentPrice')), intrinsicValue: toNum(get(r, 'intrinsicValue')), bookValue: toNum(get(r, 'bookValue')),
      profitGrowthTTM: toNum(get(r, 'profitGrowthTTM')), profitGrowth3: toNum(get(r, 'profitGrowth3')), profitGrowth5: toNum(get(r, 'profitGrowth5')),
      salesGrowth3: toNum(get(r, 'salesGrowth3')), roic: toNum(get(r, 'roic')), roce: toNum(get(r, 'roce')), roe: toNum(get(r, 'roe')), opm: toNum(get(r, 'opm')),
      pe: toNum(get(r, 'pe')), industryPe: toNum(get(r, 'industryPe')), peg: toNum(get(r, 'peg')), pledgePct: toNum(get(r, 'pledgePct')),
      interestCoverage: toNum(get(r, 'interestCoverage')), de: toNum(get(r, 'de')), promoterHoldingChange: toNum(get(r, 'promoterHoldingChange')),
      piotroski: toNum(get(r, 'piotroski')), quickRatio: toNum(get(r, 'quickRatio')), altmanZ: toNum(get(r, 'altmanZ')), currentRatio: toNum(get(r, 'currentRatio')),
      contingentLiabilities: toNum(get(r, 'contingentLiabilities')), avgRoe7: toNum(get(r, 'avgRoe7')), avgRoe10: toNum(get(r, 'avgRoe10')),
      medianRoce10: toNum(get(r, 'medianRoce10')), fcf3: toNum(get(r, 'fcf3')), fcf5: toNum(get(r, 'fcf5')), ocf3: toNum(get(r, 'ocf3')), ocf5: toNum(get(r, 'ocf5')),
      croic: toNum(get(r, 'croic')), graham: toNum(get(r, 'graham')), fiiChange3: toNum(get(r, 'fiiChange3')), diiChange3: toNum(get(r, 'diiChange3')),
      histPe5: toNum(get(r, 'histPe5')), avgDebtorDays3: toNum(get(r, 'avgDebtorDays3')), ncavps: toNum(get(r, 'ncavps')), numShareholders: toNum(get(r, 'numShareholders')),
      promoterHolding: toNum(get(r, 'promoterHolding')), fiiHolding: toNum(get(r, 'fiiHolding')), fiiChange: toNum(get(r, 'fiiChange')), ret1: toNum(get(r, 'ret1')), ret3: toNum(get(r, 'ret3')), ret5: toNum(get(r, 'ret5')),
    });
  }
  return records;
}

// ---- Derived per-record values used by more than one factor ----
// A blank current figure must not be treated as 0 (null + 30 = 30 in JS would halve the value): use whichever side exists.
function roceEffective(r) { return r.roce != null && r.medianRoce10 != null ? (r.roce + r.medianRoce10) / 2 : (r.roce != null ? r.roce : r.medianRoce10); }
// Negative D/E means negative net worth, which is the worst balance sheet, not the best: rank it last.
function deRankValue(r) { return r.de == null ? null : (r.de < 0 ? 1e9 : r.de); }
function roeAvg(r) { return r.avgRoe7 != null ? r.avgRoe7 : r.avgRoe10; }
function roeEffective(r) { const avg = roeAvg(r); return r.roe != null && avg != null ? (r.roe + avg) / 2 : (r.roe != null ? r.roe : avg); }
function relPe(r) { return (r.pe != null && r.pe > 0 && r.industryPe != null) ? r.industryPe / r.pe : null; }
// A negative P/E (loss-making) is not a cheap multiple, so it gives no own-history gap.
function ownHistGap(r) { if (r.histPe5 == null || r.histPe5 <= 0 || r.pe == null || r.pe <= 0) return null; return ((r.histPe5 - r.pe) / r.histPe5) * 100; }
// CROIC is cash-based, so heavy capex makes it negative even when operating cash flow is healthy: then ROIC is the fairer read.
function capexDragsCroic(r) { const fcf = r.fcf3 != null ? r.fcf3 : r.fcf5, ocf = r.ocf3 != null ? r.ocf3 : r.ocf5; return fcf != null && ocf != null && fcf < 0 && ocf > 0 && r.roic != null; }
function useCroic(r) { return r.croic != null && !capexDragsCroic(r); }
function reinvestMetric(r) { return useCroic(r) ? r.croic : r.roic != null ? r.roic : r.croic; }
function marginOfSafetyPct(r) { return marginOfSafety(r.intrinsicValue, r.currentPrice); }
const groupKey = r => r.industryGroup;
// False when a Financial Health figure does not describe this kind of company (a bank's current ratio, a lender's Altman Z...).

// ---- Verdict thresholds (section 6) ----
function scoreToVerdict(score) {
  if (score == null) return null;
  if (score >= 8.0) return 'buy';
  if (score >= 6.0) return 'mbuy';
  if (score >= 5.0) return 'hold';
  return 'avoid';
}

// ---- Main entry point ----
// A symbol listed twice (the same NSE or BSE code on two rows) is read once, from its first row: two stocks with one ticker would break the data.
function dedupeBySymbol(allRecords) {
  const seenSym = new Set(), duplicates = /** @type {string[]} */ ([]);
  const records = allRecords.filter(r => { const k = normSym(r.sym); if (seenSym.has(k)) { duplicates.push(r.sym); return false; } seenSym.add(k); return true; });
  return { records, duplicates };
}

// v3: attach each record's exact industry label (symbol -> label map built from the dashboard's own ticker fields; keys normalised with normSym).
// Banks, insurers and lenders: the Financial Health figures that mean nothing for them are skipped (see core/finsector.js).
function attachIndustries(records, opts) {
  const exactMap = opts && opts.exactIndustryBySym;
  for (const r of records) r.exactIndustry = exactMap ? (exactMap.get(normSym(r.sym)) || null) : null;
  for (const r of records) r.finKind = financialKind(r);
}

// Every metric ranked against its peers (see relativePercentiles). piotBasis records the peer level the Piotroski rank came from.
function buildPercentiles(records, piotBasis) {
  const pct = {
    deInv: relativePercentiles(records, r => { const d = finApplies(r, 'de') ? deRankValue(r) : null; return d == null ? null : -d; }, groupKey),
    intCov: relativePercentiles(records, r => (finApplies(r, 'interestCoverage') ? r.interestCoverage : null), groupKey),
    quick: relativePercentiles(records, r => (finApplies(r, 'quickRatio') ? r.quickRatio : null), groupKey),
    altmanZ: relativePercentiles(records, r => (finApplies(r, 'altmanZ') ? r.altmanZ : null), groupKey),
    currentRatio: relativePercentiles(records, r => (finApplies(r, 'currentRatio') ? r.currentRatio : null), groupKey),
    debtorDaysInv: relativePercentiles(records, r => (finApplies(r, 'avgDebtorDays3') && r.avgDebtorDays3 != null ? -r.avgDebtorDays3 : null), groupKey),
    roceEff: relativePercentiles(records, roceEffective, groupKey),
    roeEff: relativePercentiles(records, roeEffective, groupKey),
    opm: relativePercentiles(records, r => r.opm, groupKey),
    sales3: relativePercentiles(records, r => r.salesGrowth3, groupKey),
    profit3: relativePercentiles(records, r => r.profitGrowth3, groupKey),
    profitTTM: relativePercentiles(records, r => r.profitGrowthTTM, groupKey),
    relPe: relativePercentiles(records, relPe, groupKey),
    pegInv: relativePercentiles(records, r => (r.peg != null && r.peg > 0 ? -r.peg : null), groupKey),
    ownHist: relativePercentiles(records, ownHistGap, groupKey),
    roceRaw: relativePercentiles(records, r => r.roce, groupKey),
    roeRaw: relativePercentiles(records, r => r.roe, groupKey),
    piotroski: relativePercentiles(records, r => r.piotroski, groupKey, piotBasis),
    reinvest: relativePercentiles(records, reinvestMetric, groupKey),
    mos: populationPercentiles(records, marginOfSafetyPct),
  };
  return pct;
}

// The Moat rank: the average of the ROCE, ROE and OPM ranks. moatBasis records the peer level each rank came from.
function buildMoatPct(records, pct, moatBasis) {
  const moatInputs = new Map();
  for (const r of records) {
    const parts = [pct.roceRaw.get(r), pct.roeRaw.get(r), pct.opm.get(r)].filter(v => v != null);
    if (parts.length) moatInputs.set(r, sum(parts) / parts.length);
  }
  return relativePercentiles(records, r => (moatInputs.has(r) ? moatInputs.get(r) : null), groupKey, moatBasis);
}

// Scores every record from the rank tables { pct, moatPct, moatBasis, piotBasis }.
function scoreAll(records, { pct, moatPct, moatBasis, piotBasis }) {
  for (const r of records) {
    r.scored = scoreOne(r, pct, moatPct);
    // v3 extras for the dashboard's moat/governance wording: the percentile used and which peer level it was ranked at.
    r.scored.moatPct = moatPct.get(r) != null ? moatPct.get(r) : null;
    r.scored.moatBasis = moatBasis.get(r) || null;
    r.scored.piotroskiPct = pct.piotroski.get(r) != null ? pct.piotroski.get(r) : null;
    r.scored.govBasis = piotBasis.get(r) || null;
    r.scored.reinvestCroic = useCroic(r);
  }
}

function scoreCsv(csvText, opts) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) throw new Error('No data rows found.');
  const colMap = buildColumnMap(rows[0]);
  const { records, duplicates } = dedupeBySymbol(extractRecords(rows, colMap));
  if (records.length === 0) throw new Error('No rows had an NSE or BSE code to key off.');
  attachIndustries(records, opts);
  const moatBasis = new Map(), piotBasis = new Map();
  const pct = buildPercentiles(records, piotBasis);
  const moatPct = buildMoatPct(records, pct, moatBasis);
  scoreAll(records, { pct, moatPct, moatBasis, piotBasis });
  return { records, columnMap: colMap, duplicates };
}

// ---- One stock's score: nine factors (weights add up to 10), each built by its own function, then added up ----

// A bank or insurer has no applicable figure here: the factor is left out (na) and its weight shared by the others (see totalScore).
function finFactor(r, pct) {
  const na = finFactorNotApplicable(r.finKind);
  const score = na ? null : weightedPartial(1.8, [
    { coef: 0.35, pct: pct.deInv.get(r) }, { coef: 0.55, pct: pct.intCov.get(r) }, { coef: 0.35, pct: pct.quick.get(r) },
    { coef: 0.35, pct: pct.altmanZ.get(r) }, { coef: 0.20, pct: pct.currentRatio.get(r) }, { coef: 0.20, pct: pct.debtorDaysInv.get(r) },
  ]);
  return { key: 'fin', label: 'Financial Health & Balance Sheet', weight: 1.8, score, na: na ? KIND_WORD[r.finKind] : undefined };
}

// A recent profit spike far above the multi-year trend is discounted (in Growth, and left out of Predictability so it is not punished twice).
function earningsQuality(r) {
  const trend = [r.profitGrowth3, r.profitGrowth5].filter(v => v != null);
  const trendAvg = trend.length ? sum(trend) / trend.length : null;
  if (trendAvg == null || trendAvg <= 0 || r.profitGrowthTTM == null) return { discount: 1.0, note: '' };
  const ratio = r.profitGrowthTTM / trendAvg;
  if (ratio >= 3.5) return { discount: 0.55, note: ' (0.55x earnings-quality discount — TTM far above multi-year trend)' };
  if (ratio >= 2.0) return { discount: 0.8, note: ' (0.8x earnings-quality discount — TTM notably ahead of trend)' };
  return { discount: 1.0, note: '' };
}

function profFactor(r, pct) {
  const score = weightedPartial(1.8, [
    { coef: 0.654, pct: pct.roceEff.get(r) }, { coef: 0.514, pct: pct.roeEff.get(r) }, { coef: 0.631, pct: pct.opm.get(r) },
  ]);
  return { key: 'prof', label: 'Profitability & Capital Efficiency', weight: 1.8, score };
}

// Growth is worth less when it is not backed by cash: both cash figures present and not both positive x0.75; only one present and not positive x0.85.
function cashFlowAdjustment(r) {
  const fcf = r.fcf3 != null ? r.fcf3 : r.fcf5;
  const ocf = r.ocf3 != null ? r.ocf3 : r.ocf5;
  const fcfPresent = fcf != null, ocfPresent = ocf != null;
  if (fcfPresent && ocfPresent) {
    const mult = (fcf > 0 && ocf > 0) ? 1.0 : 0.75;
    return { mult, note: mult < 1 ? ' (0.75x — growth not cash-backed)' : '' };
  }
  if (fcfPresent !== ocfPresent) {
    const mult = (fcfPresent ? fcf : ocf) <= 0 ? 0.85 : 1.0;
    return { mult, note: mult < 1 ? ' (0.85x — partial cash-flow evidence only)' : '' };
  }
  return { mult: 1.0, note: '' };
}

function growthFactor(r, pct, quality) {
  let score = weightedPartial(1.125, [
    { coef: 0.3977, pct: pct.sales3.get(r) }, { coef: 0.3200, pct: pct.profit3.get(r) }, { coef: 0.6896, pct: pct.profitTTM.get(r) },
  ]);
  let cashNote = '';
  if (score != null) {
    const cash = cashFlowAdjustment(r);
    score = score * quality.discount * cash.mult;
    cashNote = cash.note;
  }
  const note = `${quality.note}${cashNote}`.trim();
  return { key: 'growth', label: 'Growth & Cash Flow Generation', weight: 1.125, score, note: (quality.note || cashNote) ? note : undefined };
}

function valFactor(r, pct) {
  const pegPct = (r.peg != null && r.peg > 0) ? pct.pegInv.get(r) : 50;   // a missing or non-positive PEG counts as the middle
  const score = weightedPartial(1.125, [
    { coef: 0.764, pct: pct.relPe.get(r) }, { coef: 0.511, pct: pegPct }, { coef: 0.35, pct: pct.ownHist.get(r) },
  ]);
  return { key: 'val', label: 'Valuation Metrics vs. Industry', weight: 1.125, score };
}

// A factor that is a straight share of its weight: weight x percentile / 100, or none when there is no percentile.
function shareFactor(key, label, weight, percentile) {
  return { key, label, weight, score: percentile != null ? weight * percentile / 100 : null };
}

// Governance: the Piotroski percentile, less a penalty for pledged shares and a falling promoter holding, adjusted a little by what funds did.
function govFactor(r, pct) {
  const piotPct = pct.piotroski.get(r);
  let score = null;
  if (piotPct != null) {
    const base = 0.9 * piotPct / 100;
    const penalty = 0.00214 * (r.pledgePct || 0) + 0.00424 * Math.max(0, -(r.promoterHoldingChange || 0));
    const fiiDiiParts = [r.fiiChange3, r.diiChange3].filter(v => v != null);
    const fiiDii = fiiDiiParts.length ? sum(fiiDiiParts) : 0;
    score = clamp(base - penalty + clamp(fiiDii * 0.003, -0.05, 0.05), 0, 0.9);
  }
  return { key: 'gov', label: 'Management & Governance', weight: 0.9, score };
}

// Predictability: the steadier the profit growth across the windows, the higher the score (a curve over the spread between the best and worst window).
function predictFactor(r, quality) {
  const points = [quality.discount < 1 ? null : r.profitGrowthTTM, r.profitGrowth3, r.profitGrowth5].filter(v => v != null);
  let score = null, note;
  if (points.length >= 2) {
    const dispersion = Math.max(...points) - Math.min(...points);
    let raw = interpolateCurve([[2,0.68],[11,0.5],[18,0.55],[25,0.5],[34,0.4],[43,0.38],[56,0.34],[74,0.29],[108,0.2],[180,0.12],[2818,0.03]], dispersion);
    if (points.length === 2) { raw *= 0.9; note = '0.9x haircut — only 2 of 3 growth windows available'; }
    score = clamp(raw, 0, 0.675);
  }
  return { key: 'predict', label: 'Earnings Predictability', weight: 0.675, score, note };
}

// The ten factors add up to 10; factors that do not apply (na) are not counted as zero: the weights that do apply are scaled up to make 10 again.
function totalScore(factors) {
  const present = factors.filter(f => f.score != null).map(f => f.score);
  const naWeight = sum(factors.filter(f => f.na).map(f => f.weight));
  return present.length ? Math.round(sum(present) * (10 / (10 - naWeight)) * 100) / 100 : null;
}

// The three sub-scores on the stock page: Traditional (fin, prof, growth, val), Buffett-style (moat, gov, predict, reinvest) and Valuation (dcf).
function subScores(factors, score) {
  if (score == null) return { traditionalSubscore: null, buffettSubscore: null, valuationSubscore: null };
  const by = k => (factors.find(f => f.key === k).score || 0);
  const tradWeight = 5.85 - sum(factors.filter(f => f.na && ['fin', 'prof', 'growth', 'val'].includes(f.key)).map(f => f.weight));
  return {
    traditionalSubscore: Math.round(((by('fin') + by('prof') + by('growth') + by('val')) / tradWeight) * 10 * 100) / 100,
    buffettSubscore: Math.round(((by('moat') + by('gov') + by('predict') + by('reinvest')) / 3.15) * 10 * 100) / 100,
    valuationSubscore: Math.round((by('dcf') / 1.0) * 10 * 100) / 100,
  };
}

function scoreOne(r, pct, moatPct) {
  const quality = earningsQuality(r);
  const factors = [
    finFactor(r, pct), profFactor(r, pct), growthFactor(r, pct, quality), valFactor(r, pct),
    shareFactor('moat', 'Moat & Competitive Advantage', 0.9, moatPct.get(r)),
    govFactor(r, pct), predictFactor(r, quality),
    shareFactor('reinvest', 'Capital Reinvestment Efficiency', 0.675, pct.reinvest.get(r)),
    shareFactor('dcf', 'Valuation & Margin of Safety', 1.0, pct.mos.get(r)),
  ];
  const score = totalScore(factors);
  return { factors, score, verdict: scoreToVerdict(score), ...subScores(factors, score), mosPct: marginOfSafetyPct(r) };
}
const FundEngine = { normSym, scoreCsv, scoreToVerdict };

// ---- Applying the engine to the stock list ----
// Mutates `stocks` in place (new tickers are appended). Returns what happened. New tickers get safe defaults:
// no screenerConsolidated flag (the page then links to the consolidated Screener.in page) and no BSE chart mapping.
const symOf = s => normSym(s.ticker.split('·')[0].trim());
const indOf = s => (s.ticker.split('·')[1] || '').trim();

// Each stock is rescored from its record in the file. In the file = active. A stock missing from the file is marked inactive (kept in the data, hidden and not refreshed); one in the file but unscored stays as it was.
function rescoreKnown(stocks, records, asof) {
  const byNse = new Map(), byBse = new Map();
  for (const r of records) { if (r.nseCode) byNse.set(normSym(r.nseCode), r); if (r.bseCode) byBse.set(normSym(r.bseCode), r); }
  const used = new Set(), dropped = [], inactive = [];
  let rescored = 0;
  for (const s of stocks) {
    const sym = symOf(s);
    const r = byNse.get(sym) || byBse.get(sym);
    if (r) delete s.active; else { s.active = false; inactive.push(s.ticker); }
    if (!r || r.scored.score == null) { dropped.push(s.ticker); continue; }
    used.add(r);
    s.score = r.scored.score; s.verdict = r.scored.verdict; if (r.industryGroup !== '(unclassified)') s.industryGroup = r.industryGroup;
    s.fundamentals = buildFundamentals(r, indOf(s) || r.industry, r.industryGroup);
    s.valuation = { ...(s.valuation || {}), ...valuationBlock(r, asof) };
    const pillars = pillarsFor(r);
    if (pillars) s.pillars = { ...(s.pillars || {}), ...pillars };
    if (r.isin) s.isin = r.isin;
    s.asof = asof; rescored++;
  }
  return { used, rescored, dropped, inactive };
}

// A ticker in the file that is not in the stock list yet: new tickers get safe defaults (no Technical Signal history, no sector notes).
function newStock(r, code, industry, asof) {
  return {
    asof, name: r.name, isin: r.isin || undefined, ticker: `${code} · ${industry}`, industryGroup: r.industryGroup, score: r.scored.score, verdict: r.scored.verdict,
    pillars: pillarsFor(r) || {},
    technical: { reason: 'Newly imported in the fresh full-universe data load; no Technical Signal history yet. Will be computed from the next Growth List CSV / TradingView refresh.', asof },
    globalFactors: { scope: 'sector', sectorLabel: industry, asof, positive: [], negative: [] },
    fundamentals: buildFundamentals(r, industry, r.industryGroup), valuation: valuationBlock(r, asof),
  };
}

function onboardNew(stocks, records, used, asof) {
  const onboarded = [], bseOnly = [];
  for (const r of records) {
    if (used.has(r)) continue;
    const code = r.nseCode || r.bseCode;
    if (!code || r.scored.score == null) continue;
    stocks.push(newStock(r, code, r.industry || r.industryGroup, asof));
    onboarded.push(code);
    if (/^\d+$/.test(code)) bseOnly.push(code);
  }
  return { onboarded, bseOnly };
}

function applyFundamental(csvText, stocks, asof){
  const exact = new Map(stocks.map(s => [symOf(s), indOf(s)]));
  const { records, duplicates } = FundEngine.scoreCsv(csvText, { exactIndustryBySym: exact });
  const { used, rescored, dropped, inactive } = rescoreKnown(stocks, records, asof);
  const { onboarded, bseOnly } = onboardNew(stocks, records, used, asof);
  const verdictMix = {}; for(const s of stocks) verdictMix[s.verdict] = (verdictMix[s.verdict] || 0) + 1;
  return { csvRows: records.length, duplicates, rescored, onboarded, bseOnly, dropped, inactive, verdictMix };
}

export { applyFundamental };
