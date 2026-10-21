// Fundamental Score engine: turns a screener.in CSV row into factor scores.
import { parseCSV } from './csvparse.js';

// ---- Fundamental Score engine v3, ported unchanged from the saved devTools script `fundamental_engine` ----
const AlbaFundEngine = (function(){
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
  ['industryGroup', ['industry', 'group']], ['industry', ['industry']],
  ['currentPrice', ['current', 'price']], ['intrinsicValue', ['intrinsic', 'value']], ['bookValue', ['book', 'value']],
  ['profitGrowthTTM', ['profit', 'growth'], ['3years', '5years']],
  ['profitGrowth3', ['profit', 'growth', '3years']], ['profitGrowth5', ['profit', 'growth', '5years']],
  ['salesGrowth3', ['sales', 'growth', '3years']],
  ['roic', ['return', 'invested', 'capital'], ['average']], ['roce', ['return', 'capital', 'employed'], ['median']],
  ['roe', ['return', 'on', 'equity'], ['average']], ['opm', ['opm']],
  ['pe', ['price', 'earning']], ['industryPe', ['industry', 'pe']], ['peg', ['peg']],
  ['pledgePct', ['pledged']], ['interestCoverage', ['interest', 'coverage']], ['de', ['debt', 'equity']],
  ['promoterHoldingChange', ['promoter', 'holding']], ['piotroski', ['piotroski']], ['quickRatio', ['quick', 'ratio']],
  ['altmanZ', ['altman']], ['currentRatio', ['current', 'ratio']], ['contingentLiabilities', ['contingent']],
  ['avgRoe7', ['average', 'return', 'equity', '7years']], ['avgRoe10', ['average', 'return', 'equity', '10years']],
  ['medianRoce10', ['median', 'return', 'capital', 'employed', '10years']],
  ['fcf3', ['free', 'cash', 'flow', '3years']], ['fcf5', ['free', 'cash', 'flow', '5years']],
  ['ocf3', ['operating', 'cash', 'flow', '3years']], ['ocf5', ['operating', 'cash', 'flow', '5years']],
  ['croic', ['croic']], ['graham', ['graham']],
  ['fiiChange3', ['fii', 'holding', '3years']], ['diiChange3', ['dii', 'holding', '3years']],
  ['histPe5', ['historical', 'pe', '5years']], ['avgDebtorDays3', ['debtor', 'days', '3years']],
  ['ncavps', ['ncavps']], ['numShareholders', ['number', 'shareholders']],
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
function reinvestMetric(r) { return r.croic != null ? r.croic : r.roic; }
function marginOfSafetyPct(r) { if (r.intrinsicValue == null || r.intrinsicValue <= 0 || r.currentPrice == null) return null; return ((r.intrinsicValue - r.currentPrice) / r.intrinsicValue) * 100; }
const groupKey = r => r.industryGroup;

// ---- Verdict thresholds (section 6) ----
function scoreToVerdict(score) {
  if (score == null) return null;
  if (score >= 8.0) return 'buy';
  if (score >= 6.0) return 'mbuy';
  if (score >= 5.0) return 'hold';
  return 'avoid';
}

// ---- Main entry point ----
function scoreCsv(csvText, opts) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) throw new Error('No data rows found.');
  const colMap = buildColumnMap(rows[0]);
  const records = extractRecords(rows, colMap);
  if (records.length === 0) throw new Error('No rows had an NSE or BSE code to key off.');
  // v3: attach each record's exact industry label (symbol -> label map built from the dashboard's own ticker fields; keys normalised with normSym).
  const exactMap = opts && opts.exactIndustryBySym;
  for (const r of records) r.exactIndustry = exactMap ? (exactMap.get(normSym(r.sym)) || null) : null;
  const moatBasis = new Map(), piotBasis = new Map();

  const pct = {
    deInv: relativePercentiles(records, r => { const d = deRankValue(r); return d == null ? null : -d; }, groupKey),
    intCov: relativePercentiles(records, r => r.interestCoverage, groupKey),
    quick: relativePercentiles(records, r => r.quickRatio, groupKey),
    altmanZ: relativePercentiles(records, r => r.altmanZ, groupKey),
    currentRatio: relativePercentiles(records, r => r.currentRatio, groupKey),
    debtorDaysInv: relativePercentiles(records, r => (r.avgDebtorDays3 != null ? -r.avgDebtorDays3 : null), groupKey),
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

  const moatInputs = new Map();
  for (const r of records) {
    const parts = [pct.roceRaw.get(r), pct.roeRaw.get(r), pct.opm.get(r)].filter(v => v != null);
    if (parts.length) moatInputs.set(r, parts.reduce((a, b) => a + b, 0) / parts.length);
  }
  const moatPct = relativePercentiles(records, r => (moatInputs.has(r) ? moatInputs.get(r) : null), groupKey, moatBasis);

  for (const r of records) {
    r.scored = scoreOne(r, pct, moatPct);
    // v3 extras for the dashboard's moat/governance wording: the percentile used and which peer level it was ranked at.
    r.scored.moatPct = moatPct.get(r) != null ? moatPct.get(r) : null;
    r.scored.moatBasis = moatBasis.get(r) || null;
    r.scored.piotroskiPct = pct.piotroski.get(r) != null ? pct.piotroski.get(r) : null;
    r.scored.govBasis = piotBasis.get(r) || null;
  }
  return { records, columnMap: colMap };
}

function scoreOne(r, pct, moatPct) {
  const factors = [];
  const finScore = weightedPartial(1.8, [
    { coef: 0.35, pct: pct.deInv.get(r) }, { coef: 0.55, pct: pct.intCov.get(r) }, { coef: 0.35, pct: pct.quick.get(r) },
    { coef: 0.35, pct: pct.altmanZ.get(r) }, { coef: 0.20, pct: pct.currentRatio.get(r) }, { coef: 0.20, pct: pct.debtorDaysInv.get(r) },
  ]);
  factors.push({ key: 'fin', label: 'Financial Health & Balance Sheet', weight: 1.8, score: finScore });

  const trend = [r.profitGrowth3, r.profitGrowth5].filter(v => v != null);
  const trendAvg = trend.length ? trend.reduce((a, b) => a + b, 0) / trend.length : null;
  let eqDiscount = 1.0, eqNote = '';
  if (trendAvg != null && trendAvg > 0 && r.profitGrowthTTM != null) {
    const ratio = r.profitGrowthTTM / trendAvg;
    if (ratio >= 3.5) { eqDiscount = 0.55; eqNote = ' (0.55x earnings-quality discount — TTM far above multi-year trend)'; }
    else if (ratio >= 2.0) { eqDiscount = 0.8; eqNote = ' (0.8x earnings-quality discount — TTM notably ahead of trend)'; }
  }

  let profScore = weightedPartial(1.8, [
    { coef: 0.654, pct: pct.roceEff.get(r) }, { coef: 0.514, pct: pct.roeEff.get(r) }, { coef: 0.631, pct: pct.opm.get(r) },
  ]);
  if (profScore != null) profScore *= eqDiscount;
  factors.push({ key: 'prof', label: 'Profitability & Capital Efficiency', weight: 1.8, score: profScore, note: eqNote || undefined });

  let growthScore = weightedPartial(1.125, [
    { coef: 0.3977, pct: pct.sales3.get(r) }, { coef: 0.3200, pct: pct.profit3.get(r) }, { coef: 0.6896, pct: pct.profitTTM.get(r) },
  ]);
  let cfNote = '';
  if (growthScore != null) {
    growthScore *= eqDiscount;
    const fcf = r.fcf3 != null ? r.fcf3 : r.fcf5;
    const ocf = r.ocf3 != null ? r.ocf3 : r.ocf5;
    const fcfPresent = fcf != null, ocfPresent = ocf != null;
    let cfMult = 1.0;
    if (fcfPresent && ocfPresent) { cfMult = (fcf > 0 && ocf > 0) ? 1.0 : 0.75; if (cfMult < 1) cfNote = ' (0.75x — growth not cash-backed)'; }
    else if (fcfPresent !== ocfPresent) { const only = fcfPresent ? fcf : ocf; cfMult = only <= 0 ? 0.85 : 1.0; if (cfMult < 1) cfNote = ' (0.85x — partial cash-flow evidence only)'; }
    growthScore *= cfMult;
  }
  factors.push({ key: 'growth', label: 'Growth & Cash Flow Generation', weight: 1.125, score: growthScore, note: (eqNote || cfNote) ? `${eqNote}${cfNote}`.trim() : undefined });

  const pegPct = (r.peg != null && r.peg > 0) ? pct.pegInv.get(r) : (r.peg == null || r.peg <= 0 ? 50 : null);
  const valScore = weightedPartial(1.125, [
    { coef: 0.764, pct: pct.relPe.get(r) }, { coef: 0.511, pct: pegPct }, { coef: 0.35, pct: pct.ownHist.get(r) },
  ]);
  factors.push({ key: 'val', label: 'Valuation Metrics vs. Industry', weight: 1.125, score: valScore });

  const moatP = moatPct.get(r);
  factors.push({ key: 'moat', label: 'Moat & Competitive Advantage', weight: 0.9, score: moatP != null ? 0.9 * moatP / 100 : null });

  const piotPct = pct.piotroski.get(r);
  let govScore = null;
  if (piotPct != null) {
    const base = 0.9 * piotPct / 100;
    const penalty = 0.00214 * (r.pledgePct || 0) + 0.00424 * Math.max(0, -(r.promoterHoldingChange || 0));
    const fiiDiiParts = [r.fiiChange3, r.diiChange3].filter(v => v != null);
    const fiiDii = fiiDiiParts.length ? fiiDiiParts.reduce((a, b) => a + b, 0) : 0;
    const convictionAdj = clamp(fiiDii * 0.003, -0.05, 0.05);
    govScore = clamp(base - penalty + convictionAdj, 0, 0.9);
  }
  factors.push({ key: 'gov', label: 'Management & Governance', weight: 0.9, score: govScore });

  const growthPts = [r.profitGrowthTTM, r.profitGrowth3, r.profitGrowth5].filter(v => v != null);
  let predictScore = null, predictNote;
  if (growthPts.length >= 2) {
    const dispersion = Math.max(...growthPts) - Math.min(...growthPts);
    let raw = interpolateCurve([[2,0.68],[11,0.5],[18,0.55],[25,0.5],[34,0.4],[43,0.38],[56,0.34],[74,0.29],[108,0.2],[180,0.12],[2818,0.03]], dispersion);
    if (growthPts.length === 2) { raw *= 0.9; predictNote = '0.9x haircut — only 2 of 3 growth windows available'; }
    predictScore = clamp(raw, 0, 0.675);
  }
  factors.push({ key: 'predict', label: 'Earnings Predictability', weight: 0.675, score: predictScore, note: predictNote });

  const reinvestP = pct.reinvest.get(r);
  factors.push({ key: 'reinvest', label: 'Capital Reinvestment Efficiency', weight: 0.675, score: reinvestP != null ? 0.675 * reinvestP / 100 : null });

  const mosP = pct.mos.get(r);
  factors.push({ key: 'dcf', label: 'Valuation & Margin of Safety', weight: 1.0, score: mosP != null ? 1.0 * mosP / 100 : null });

  const presentScores = factors.filter(f => f.score != null).map(f => f.score);
  const score = presentScores.length ? Math.round(presentScores.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  const verdict = scoreToVerdict(score);
  const by = k => (factors.find(f => f.key === k).score || 0);
  const traditionalSubscore = score != null ? Math.round(((by('fin') + by('prof') + by('growth') + by('val')) / 5.85) * 10 * 100) / 100 : null;
  const buffettSubscore = score != null ? Math.round(((by('moat') + by('gov') + by('predict') + by('reinvest')) / 3.15) * 10 * 100) / 100 : null;
  const valuationSubscore = score != null ? Math.round((by('dcf') / 1.0) * 10 * 100) / 100 : null;
  return { factors, score, verdict, traditionalSubscore, buffettSubscore, valuationSubscore, mosPct: marginOfSafetyPct(r) };
}
return { normSym, scoreCsv, scoreToVerdict };
})();

// ---- Applying the engine to the stock list: ported unchanged from the saved script `apply_fundamental` ----
// Mutates `stocks` in place (new tickers are appended). Returns what happened. New tickers get safe defaults:
// no screenerConsolidated flag (the page then links to the consolidated Screener.in page) and no BSE chart mapping.
function albaApplyFundamental(csvText, stocks, asof){
  const E = AlbaFundEngine;
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

function buildFactor(key, r, sc, industry, group, scored) {
  const fa = scored.factors.find(x => x.key === key);
  let metrics, note;
  if (key === 'fin') {
    metrics = [['D/E', xx(r.de)], ['Interest coverage', xx(r.interestCoverage)], ['Quick ratio', xx(r.quickRatio)], ['Altman Z', f(r.altmanZ, 2)],
      ['Current ratio', xx(r.currentRatio)], ['Avg debtor days 3yr', f(r.avgDebtorDays3, 1)], ['Contingent liabilities', cr(r.contingentLiabilities)]];
    note = `Mechanically scored from screener.in data: balance-sheet profile (D/E ${xx(r.de)}, interest coverage ${xx(r.interestCoverage)}, Altman Z ${f(r.altmanZ, 2)}, current ratio ${xx(r.currentRatio)}).` +
      (n(r.contingentLiabilities) && r.contingentLiabilities > 0 ? ` Contingent liabilities of ${cr(r.contingentLiabilities)} noted as a risk flag (not scored).` : '');
  } else if (key === 'prof') {
    metrics = [['ROCE', pc(r.roce)], ['ROE', pc(r.roe)], ['OPM', pc(r.opm)], ['Median ROCE 10yr', pc(r.medianRoce10)], ['Avg ROE 7yr', pc(r.avgRoe7)]];
    note = `Mechanically scored: capital efficiency blending current-year and multi-year-average ROCE/ROE with OPM (ROCE ${pc(r.roce)}, ROE ${pc(r.roe)}, OPM ${pc(r.opm)}).` + eqText(fa.note);
  } else if (key === 'growth') {
    metrics = [['Sales growth 3yr', pc(r.salesGrowth3)], ['Profit growth 3yr', pc(r.profitGrowth3)], ['Profit growth TTM', pc(r.profitGrowthTTM)], ['FCF 3yr', cr(r.fcf3)], ['OCF 3yr', cr(r.ocf3)]];
    note = `Mechanically scored: top-line/bottom-line growth trend (3yr sales ${pc(r.salesGrowth3)}, 3yr profit ${pc(r.profitGrowth3)}).` + eqText(fa.note) + cfText(fa.note);
  } else if (key === 'val') {
    metrics = [['P/E', xx(r.pe)], ['Industry P/E', xx(r.industryPe)], ['PEG', f(r.peg, 2)], ['Historical PE 5yr', xx(r.histPe5)]];
    note = `Mechanically scored vs industry: P/E ${xx(r.pe)} vs industry ${xx(r.industryPe)}, PEG ${f(r.peg, 2)}, and own 5yr-historical-PE comparison.`;
  } else if (key === 'moat') {
    const pct = scored.moatPct, p = peerText(pct == null ? null : scored.moatBasis, industry, group);
    metrics = [['Industry-relative capital efficiency percentile', `${ordN(pct)} (${p.chip})`]];
    note = 'Data-driven mechanical proxy (pending individual research): scored from this company\'s own ROCE/ROE/OPM ranked against ' +
      (p.moatWhere ? `peers in ${p.moatWhere}` : `all stocks, since ${industry} and its industry group have fewer than 10 peers`) + ` — ${ordN(pct)} percentile. Not a substitute for researched moat analysis.`;
  } else if (key === 'gov') {
    const pct = scored.piotroskiPct, p = peerText(pct == null ? null : scored.govBasis, industry, group);
    metrics = [['Piotroski F-Score percentile', `${ordN(pct)} (${p.chip})`], ['Promoter pledge', pc(r.pledgePct)], ['Promoter holding change', pc(r.promoterHoldingChange)],
      ['FII change 3yr', pc(r.fiiChange3, 2)], ['DII change 3yr', pc(r.diiChange3, 2)]];
    note = 'Data-driven mechanical proxy (pending individual research): based on Piotroski F-Score ranked against ' +
      (p.govWhere ? `peers in ${p.govWhere}` : `all stocks (${industry} and its group have fewer than 10 peers)`) +
      ` (${ordN(pct)} percentile), adjusted for promoter pledge (${pc(r.pledgePct)}), promoter-holding change, and institutional (FII/DII) conviction where available.`;
  } else if (key === 'predict') {
    metrics = [['Profit growth TTM', pc(r.profitGrowthTTM)], ['3yr avg', pc(r.profitGrowth3)], ['5yr avg', pc(r.profitGrowth5)]];
    note = 'Mechanically scored on consistency of profit growth across TTM/3yr/5yr windows.';
  } else if (key === 'reinvest') {
    const useCroic = n(r.croic);
    metrics = [[useCroic ? 'CROIC' : 'ROIC', pc(useCroic ? r.croic : r.roic)]];
    note = useCroic ? `Mechanically scored from CROIC (Cash Return on Invested Capital) as a proxy for reinvestment efficiency — ${pc(r.croic)}.`
      : `Mechanically scored from Return on Invested Capital (ROIC, CROIC unavailable) as a proxy for reinvestment efficiency — ${pc(r.roic)}.`;
  } else if (key === 'dcf') {
    const mos = scored.mosPct;
    metrics = [['Intrinsic Value (Screener.in)', px0(r.intrinsicValue)], ['Current price', px(r.currentPrice)], ['Margin of safety', n(mos) ? mos.toFixed(1) + '%' : 'n/a'], ['Graham Number', px0(r.graham)], ['NCAVPS', px(r.ncavps)]];
    note = `Mechanically scored: Screener.in's own Intrinsic Value estimate ₹${px0(r.intrinsicValue)} vs current price ₹${px(r.currentPrice)} (${n(mos) ? mos.toFixed(1) + '%' : 'n/a'} margin of safety, ranked against the current dataset).` +
      (n(r.graham) ? ` Cross-check: Graham Number ₹${px0(r.graham)}` + (n(r.intrinsicValue) && r.intrinsicValue > 0 && Math.abs(r.graham - r.intrinsicValue) / r.intrinsicValue > 0.3 ? ' (diverges notably from Intrinsic Value — informational only, not scored).' : '.') : '');
  }
  return { category: NAMES[key][0], key, metrics, name: NAMES[key][1], note, score: fa.score == null ? 0 : fa.score, weight: fa.weight };
}
// discount sentences derived from the engine's own notes
function eqText(en) { if (!en) return ''; if (en.includes('0.55x')) return ' (TTM growth far above multi-year trend — cyclical-spike discount applied)'; if (en.includes('0.8x')) return ' (TTM growth notably ahead of multi-year trend — mild discount applied)'; return ''; }
function cfText(en) { if (!en) return ''; if (en.includes('0.75x') || en.includes('0.85x')) return ' (growth not cash-backed — FCF/OCF discount applied)'; return ''; }

function buildFundamentals(r, industry, group) {
  const sc = r.scored;
  const factors = ['fin', 'prof', 'growth', 'val', 'moat', 'gov', 'predict', 'reinvest', 'dcf'].map(k => buildFactor(k, r, sc, industry, group, sc));
  return { factors, scoringBreakdown: { buffettSubscore: sc.buffettSubscore, overallComposite: sc.score, traditionalSubscore: sc.traditionalSubscore, valuationSubscore: sc.valuationSubscore }, total: 10 };
}
// Technical composite's valuation pillar = the valuation factor score x10, kept in step with every fundamental import.
function pillarVal(r) { const sc = r.scored.factors.find(x => x.key === 'dcf').score; return sc == null ? null : Math.round(sc * 10 * 10) / 10; }
function pillarsFor(r) { const v = pillarVal(r); return v == null ? null : { val: v }; }
function valuationBlock(r, old) {
  const v = { asof, currentPrice: r.currentPrice, grahamNumber: r.graham, intrinsicValue: r.intrinsicValue,
    intrinsicValueSource: 'Screener.in Intrinsic Value estimate (from uploaded fundamentals CSV) — the single source of truth for intrinsic value across this app.', ncavps: r.ncavps };
  return v;
}

const symOf = s => E.normSym(s.ticker.split('·')[0].trim());
const indOf = s => (s.ticker.split('·')[1] || '').trim();
const exact = new Map(stocks.map(s => [symOf(s), indOf(s)]));
const { records } = E.scoreCsv(csvText, { exactIndustryBySym: exact });
const byNse = new Map(), byBse = new Map();
for (const r of records) { if (r.nseCode) byNse.set(E.normSym(r.nseCode), r); if (r.bseCode) byBse.set(E.normSym(r.bseCode), r); }
const used = new Set(); let rescored = 0; const dropped = [];
for (const s of stocks) {
  const sym = symOf(s); const r = byNse.get(sym) || byBse.get(sym);
  if (!r || r.scored.score == null) { dropped.push(s.ticker); continue; }
  used.add(r);
  s.score = r.scored.score; s.verdict = r.scored.verdict; if (r.industryGroup !== '(unclassified)') s.industryGroup = r.industryGroup;
  s.fundamentals = buildFundamentals(r, indOf(s) || r.industry, r.industryGroup);
  s.valuation = { ...(s.valuation || {}), ...valuationBlock(r) };
  { const pv = pillarsFor(r); if (pv) s.pillars = { ...(s.pillars || {}), ...pv }; }
  if (r.isin) s.isin = r.isin;
  s.asof = asof; rescored++;
}
const onboarded = [], needScreenerCheck = [], bseOnly = [];
for (const r of records) {
  if (used.has(r)) continue;
  const code = r.nseCode || r.bseCode; if (!code || r.scored.score == null) continue;
  const industry = r.industry || r.industryGroup;
    stocks.push({
    asof, name: r.name, isin: r.isin || undefined, ticker: `${code} · ${industry}`, industryGroup: r.industryGroup, score: r.scored.score, verdict: r.scored.verdict,
    pillars: pillarsFor(r) || {},
    technical: { reason: 'Newly imported in the fresh full-universe data load; no Technical Signal history yet. Will be computed from the next Growth List CSV / TradingView refresh.', asof },
    globalFactors: { scope: 'sector', sectorLabel: industry, asof, positive: [], negative: [] },
    fundamentals: buildFundamentals(r, industry, r.industryGroup), valuation: valuationBlock(r),
  });
  onboarded.push(code); needScreenerCheck.push(code); if (/^\d+$/.test(code)) bseOnly.push(code);
}
  const verdictMix = {}; for(const s of stocks) verdictMix[s.verdict] = (verdictMix[s.verdict] || 0) + 1;
  return { csvRows: records.length, rescored, onboarded, bseOnly, dropped, verdictMix };
}

export { albaApplyFundamental };
