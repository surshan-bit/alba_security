// Technical Score import engine: TradingView CSV to technical fields.
import { parseCSV } from './csvparse.js';
import { techBlock, techMissing } from '../engine/technical.js';

// ====================================================================================================
// TECHNICAL IMPORT, IN THE PAGE (added 2026-10-09). "Import data" in the Technical Score section no longer
// opens a Claude chat: the uploaded TradingView Growth List (kept in the asset store + technicalCsvUploadLog)
// is scored here with the shared Technical Score engine (engine/technical.js: monthly MACD 2.5, weekly MACD 1.5,
// monthly RSI 2.0, weekly RSI 2.0, valuation pillar 2.0, rescaled over the components present), the current price and
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

    const missing = techMissing(csvRow);
    // Nothing but the valuation pillar would be left, and that would just copy the fundamental valuation score as a technical score.
    if (missing.length === 4) { frozen.push({ stock: s, reason: 'no technical indicators for this stock in the file, so there is nothing to score' }); continue; }

    // Scored by the shared engine (engine/technical.js), the same rules as the bar-based refresh.
    const block = techBlock(csvRow, pillarsVal, null, 'not in this export');
    matched.push({ stock: s, matchedSymbol, score: block.score, states: block.states, raw: block.raw, reason: block.reason, missing });
  }

  const uniqueCsvRows = new Set(symbolIndex.values());
  const unmatchedCsvSymbols = [];
  for (const row of uniqueCsvRows) { if (!usedCsvRows.has(row)) unmatchedCsvSymbols.push(row.sym); }

  return { matched, frozen, unmatchedCsvSymbols, missingColumns };
}


return { parseCSV, buildColumnMap, buildSymbolIndex, matchAndScore, tickerSymbol, hyphenVariant, normalizeSymbol, toNum };
})();

export { AlbaTechEngine };
