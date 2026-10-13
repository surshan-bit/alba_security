// Technical Score import engine: TradingView CSV to technical fields.
import { parseCSV } from './csvparse.js';

// ====================================================================================================
// TECHNICAL IMPORT, IN THE PAGE (added 2026-10-09). "Import data" in the Technical Score section no longer
// opens a Claude chat: the uploaded TradingView Growth List (kept in the asset store + technicalCsvUploadLog)
// is scored here with the same composite the saved scripts used (monthly MACD 2.5, weekly MACD 1.5, monthly
// RSI 2.0, weekly RSI 2.0, valuation pillar 2.0, rescaled over the components present), the current price and
// margin of safety are refreshed from the Price column, and the result is written with the shared
// backup / progress / verify / rollback / Restore machinery from fundimport.js.
// Uses the same lock document as the fundamental import, so the two can never write at the same time.
// ====================================================================================================
const AlbaTechEngine = (function(){
function toNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || /^(nan|n\/a|-)$/i.test(s)) return null;
  const n = parseFloat(s.replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(sym) { return String(sym || '').trim().toUpperCase(); }

/** The one other form a symbol might appear in (BAJAJ-AUTO vs BAJAJ_AUTO). */
function hyphenVariant(sym) {
  if (sym.includes('-')) return sym.replace(/-/g, '_');
  if (sym.includes('_')) return sym.replace(/_/g, '-');
  return null;
}

// Column detection — TradingView's export column set/order varies week to week, so every
// column is matched by header text, not position. A column that can't be found just means
// that component is unavailable for every row (handled gracefully below); check
// `missingColumns` in the result against the real header before trusting a run.
function hasAll(h, words) { return words.every(w => h.includes(w)); }
function hasNone(h, words) { return !words.some(w => h.includes(w)); }

function buildColumnMap(headerRow) {
  const header = headerRow.map(h => h.trim().toLowerCase().replace('moving average convergence divergence', 'macd'));
  const find = (pred) => header.findIndex(pred);
  return {
    symbol: find(h => h === 'symbol' || h.includes('symbol')),
    weekPctChange: find(h => hasAll(h, ['price change', '1 week'])),
    monthPctChange: find(h => hasAll(h, ['price change', '1 month'])),
    monthMacdSignal: find(h => hasAll(h, ['macd', 'signal', 'month'])),
    monthMacdLevel: find(h => hasAll(h, ['macd', 'month']) && hasNone(h, ['signal'])),
    weekMacdSignal: find(h => hasAll(h, ['macd', 'signal', 'week'])),
    weekMacdLevel: find(h => hasAll(h, ['macd', 'week']) && hasNone(h, ['signal'])),
    monthRsi: find(h => (h.includes('relative strength') || h.includes('rsi')) && h.includes('month')),
    weekRsi: find(h => (h.includes('relative strength') || h.includes('rsi')) && h.includes('week')),
  };
}

const OPTIONAL_COLUMNS = ['weekPctChange', 'monthPctChange', 'monthMacdSignal', 'monthMacdLevel', 'weekMacdSignal', 'weekMacdLevel', 'monthRsi', 'weekRsi'];

function buildSymbolIndex(rows, colMap) {
  const get = (r, field) => (colMap[field] !== undefined && colMap[field] !== -1 ? r[colMap[field]] : undefined);
  const index = new Map();
  for (let i = 1, n = rows.length; i < n; i++) {
    const r = rows[i];
    const sym = normalizeSymbol(get(r, 'symbol'));
    if (!sym) continue;
    const data = {
      sym,
      weekPctChange: toNum(get(r, 'weekPctChange')), monthPctChange: toNum(get(r, 'monthPctChange')),
      monthMacdLevel: toNum(get(r, 'monthMacdLevel')), monthMacdSignal: toNum(get(r, 'monthMacdSignal')),
      weekMacdLevel: toNum(get(r, 'weekMacdLevel')), weekMacdSignal: toNum(get(r, 'weekMacdSignal')),
      monthRsi: toNum(get(r, 'monthRsi')), weekRsi: toNum(get(r, 'weekRsi')),
    };
    index.set(sym, data);
    const variant = hyphenVariant(sym);
    if (variant && !index.has(variant)) index.set(variant, data);
  }
  return index;
}

function macdFraction(level, signal) {
  if (level == null || signal == null) return null;
  const bullish = level > signal, aboveZero = level > 0;
  if (bullish && aboveZero) return 1;
  if (!bullish && aboveZero) return 0.5;
  if (bullish && !aboveZero) return 1 / 3;
  return 0;
}
function macdStateLabel(level, signal) {
  if (level == null || signal == null) return null;
  const bullish = level > signal, aboveZero = level > 0;
  return `${bullish ? 'bull' : 'bear'}_${aboveZero ? 'above' : 'below'}`;
}
function rsiPoints(rsi) {
  if (rsi == null) return null;
  if (rsi >= 70) return 0.8; if (rsi >= 55) return 2.0; if (rsi >= 45) return 1.2; if (rsi >= 30) return 0.4; return 0.0;
}
function rsiZoneLabel(rsi) {
  if (rsi == null) return null;
  if (rsi >= 70) return 'overbought'; if (rsi >= 55) return 'strong'; if (rsi >= 45) return 'neutral'; if (rsi >= 30) return 'weak'; return 'oversold';
}

function technicalComposite(row, pillarsVal) {
  const components = [];
  const monthMacdFrac = macdFraction(row.monthMacdLevel, row.monthMacdSignal);
  if (monthMacdFrac != null) components.push({ weight: 2.5, points: 2.5 * monthMacdFrac });
  const weekMacdFrac = macdFraction(row.weekMacdLevel, row.weekMacdSignal);
  if (weekMacdFrac != null) components.push({ weight: 1.5, points: 1.5 * weekMacdFrac });
  const monthRsiPts = rsiPoints(row.monthRsi);
  if (monthRsiPts != null) components.push({ weight: 2.0, points: monthRsiPts });
  const weekRsiPts = rsiPoints(row.weekRsi);
  if (weekRsiPts != null) components.push({ weight: 2.0, points: weekRsiPts });
  components.push({ weight: 2.0, points: (pillarsVal / 10) * 2.0 });
  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const totalPoints = components.reduce((a, c) => a + c.points, 0);
  return Math.round((totalPoints / totalWeight) * 10 * 100) / 100;
}

function tickerSymbol(ticker) { return normalizeSymbol(String(ticker).split('·')[0]); }

function matchAndScore(csvText, stocks, bseAlphaMap) {
  bseAlphaMap = bseAlphaMap || {};
  const rows = parseCSV(csvText);
  if (rows.length < 2) throw new Error('No data rows found.');
  const colMap = buildColumnMap(rows[0]);
  if (colMap.symbol === -1) throw new Error('Could not find a "Symbol" column.');
  const missingColumns = OPTIONAL_COLUMNS.filter(f => colMap[f] === -1);

  const symbolIndex = buildSymbolIndex(rows, colMap);
  const usedCsvRows = new Set();
  const matched = [];
  const frozen = [];

  for (const s of stocks) {
    const rawSym = tickerSymbol(s.ticker);
    const isBseNumeric = /^\d+$/.test(rawSym);
    let csvRow = symbolIndex.get(rawSym);
    let matchedSymbol = csvRow ? rawSym : null;

    if (!csvRow && isBseNumeric && bseAlphaMap[rawSym]) {
      const alpha = bseAlphaMap[rawSym];
      const alphaSym = normalizeSymbol(alpha.includes(':') ? alpha.split(':')[1] : alpha);
      csvRow = symbolIndex.get(alphaSym);
      if (csvRow) matchedSymbol = alphaSym;
    }
    if (!csvRow) {
      const variant = hyphenVariant(rawSym);
      if (variant) { const v = symbolIndex.get(variant); if (v) { csvRow = v; matchedSymbol = variant; } }
    }
    if (!csvRow) continue;

    usedCsvRows.add(csvRow);
    const pillarsVal = s.pillars && s.pillars.val != null ? s.pillars.val : null;
    if (pillarsVal == null) { frozen.push({ stock: s, reason: 'pillars.val missing — no valuation anchor to rescale around' }); continue; }

    const missing = [];
    if (macdFraction(csvRow.monthMacdLevel, csvRow.monthMacdSignal) == null) missing.push('monthly MACD');
    if (macdFraction(csvRow.weekMacdLevel, csvRow.weekMacdSignal) == null) missing.push('weekly MACD');
    if (csvRow.monthRsi == null) missing.push('monthly RSI');
    if (csvRow.weekRsi == null) missing.push('weekly RSI');

    matched.push({
      stock: s, matchedSymbol, score: technicalComposite(csvRow, pillarsVal),
      states: {
        monthMacd: macdStateLabel(csvRow.monthMacdLevel, csvRow.monthMacdSignal),
        weekMacd: macdStateLabel(csvRow.weekMacdLevel, csvRow.weekMacdSignal),
        monthRsi: rsiZoneLabel(csvRow.monthRsi), weekRsi: rsiZoneLabel(csvRow.weekRsi),
      },
      raw: {
        monthMacdLevel: csvRow.monthMacdLevel, monthMacdSignal: csvRow.monthMacdSignal,
        weekMacdLevel: csvRow.weekMacdLevel, weekMacdSignal: csvRow.weekMacdSignal,
        weekPctChange: csvRow.weekPctChange, monthPctChange: csvRow.monthPctChange,
        monthRsi: csvRow.monthRsi, weekRsi: csvRow.weekRsi,
      },
      missing,
    });
  }

  const uniqueCsvRows = new Set(symbolIndex.values());
  const unmatchedCsvSymbols = [];
  for (const row of uniqueCsvRows) { if (!usedCsvRows.has(row)) unmatchedCsvSymbols.push(row.sym); }

  return { matched, frozen, unmatchedCsvSymbols, missingColumns };
}


return { parseCSV, buildColumnMap, buildSymbolIndex, matchAndScore, tickerSymbol, hyphenVariant, normalizeSymbol, toNum };
})();

export { AlbaTechEngine };
