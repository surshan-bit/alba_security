// Unit tests for the CSV import engines (no browser, no database): the fundamental scoring engine + apply step
// (src/import/fund-engine.js), the technical import engine (src/import/tech-engine.js) and the shared CSV parser.
// Usage: node tests/engines.js            run all checks (exit 1 on any failure)
//        node tests/engines.js --update   also rewrite tests/engines.golden.json (after reviewing why numbers moved)
// All data here is made up on purpose (symbols like AAA1, values from a fixed pseudo-random sequence).
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const { createData } = require('./lib/data.js');
const D = createData(20261010);
const { TV_HEADER, FUND_HEADER, tvCsv, fundCsv, fundRow, rv } = D;
const rd = f => fs.readFileSync(path.join(root, f), 'utf8');

const { load } = require('./lib/load.js');
const F = load('src/import/fund-engine.js', 'export { AlbaFundEngine };');
const T = load('src/import/tech-engine.js');
const P = load('src/import/csvparse.js');
const Fe = F.AlbaFundEngine, Te = T.AlbaTechEngine;

let passed = 0; const failures = [];
const pending = [];   // async tests: awaited before the summary
function test(name, fn){
  const bad = e => failures.push(name + ": " + String(e.message || e).split("\n").slice(0, 6).join(" | "));
  try { const r = fn(); if(r && typeof r.then === 'function') pending.push(r.then(() => { passed++; }, bad)); else passed++; } catch(e){ bad(e); }
}
const near = (a, b, d = 1e-9) => assert.ok(Math.abs(a - b) <= d, `${a} is not within ${d} of ${b}`);
const throwsMsg = (fn, re) => assert.throws(fn, e => re.test(e.message));

// =========================================================== CSV parsing: three copies must agree
const PARSER_CASES = [
  'a,b,c\n1,2,3\n',
  'a,b\r\n1,2\r\n3,4',                                  // CRLF, no trailing newline
  'a,b\n"x,y","he said ""hi"""\n',                     // quoted comma, escaped quote
  'a,b\n"line1\nline2",z\n',                           // newline inside quotes
  'a,b\n\n   ,  \n1,2\n',                              // blank / whitespace-only rows are dropped
  'a,b\n1,\n,2\n',                                     // empty fields kept
  '',                                                  // nothing
  'a,b\n"unterminated,2\n3,4',                         // unterminated quote swallows the rest (no crash)
  '﻿a,b\n1,2\n',                                  // BOM stays attached to the first header
];
test('csv: the technical engine uses the shared parser (identical rows for tricky inputs)', () => {
  for(const c of PARSER_CASES){
    const a = JSON.stringify(P.parseCSV(c)), d = JSON.stringify(Te.parseCSV(c));
    assert.strictEqual(d, a, 'tech parser differs for ' + JSON.stringify(c));
  }
});
test('csv: quoted commas, escaped quotes, embedded newlines, CRLF, blank rows', () => {
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[1]), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[2]), [['a', 'b'], ['x,y', 'he said "hi"']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[3]), [['a', 'b'], ['line1\nline2', 'z']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[4]), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[5]), [['a', 'b'], ['1', ''], ['', '2']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[6]), []);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[7]), [['a', 'b'], ['unterminated,2\n3,4']]);
});

// =========================================================== Technical engine
test('tech toNum: numbers, thousands separators, percent signs, blanks and NaN markers', () => {
  const t = Te.toNum;
  assert.strictEqual(t('12.5'), 12.5); assert.strictEqual(t('1,234.5'), 1234.5); assert.strictEqual(t('7%'), 7); assert.strictEqual(t(' -3.2 '), -3.2);
  for(const v of ['', '  ', 'NaN', 'nan', 'N/A', 'n/a', '-', null, undefined, 'abc']) assert.strictEqual(t(v), null, JSON.stringify(v));
});
test('tech symbols: normalisation, hyphen/underscore variants, ticker prefix', () => {
  assert.strictEqual(Te.normalizeSymbol(' abc '), 'ABC');
  assert.strictEqual(Te.hyphenVariant('BAJAJ-AUTO'), 'BAJAJ_AUTO'); assert.strictEqual(Te.hyphenVariant('BAJAJ_AUTO'), 'BAJAJ-AUTO'); assert.strictEqual(Te.hyphenVariant('ABC'), null);
  assert.strictEqual(Te.tickerSymbol('abc · Some Industry'), 'ABC'); assert.strictEqual(Te.tickerSymbol('500112'), '500112');
});

const ist = (ticker, val) => ({ ticker, pillars: val === undefined ? undefined : { val } });

test('tech columns: every field found by header text, in any order, with TradingView wording', () => {
  const m = Te.buildColumnMap(TV_HEADER);
  assert.deepStrictEqual(m, { symbol: 0, weekPctChange: 3, monthPctChange: 4, monthMacdSignal: 6, monthMacdLevel: 5, weekMacdSignal: 8, weekMacdLevel: 7, monthRsi: 9, weekRsi: 10 });
  const shuffled = TV_HEADER.slice().reverse(), ms = Te.buildColumnMap(shuffled);
  assert.strictEqual(shuffled[ms.symbol], 'Symbol'); assert.strictEqual(shuffled[ms.weekRsi], 'Relative Strength Index (14) 1 week');
  assert.ok(/signal/i.test(shuffled[ms.monthMacdSignal]) && /month/i.test(shuffled[ms.monthMacdSignal]) && !/signal/i.test(shuffled[ms.monthMacdLevel]));
  const short = Te.buildColumnMap(['Symbol', 'RSI 1 month', 'rsi 1 week']);
  assert.strictEqual(short.monthRsi, 1); assert.strictEqual(short.weekRsi, 2); assert.strictEqual(short.monthMacdLevel, -1);
});

test('tech score: hand-computed composite (all five components present)', () => {
  // month MACD bullish above zero = 1 -> 2.5; week MACD bearish above zero = 0.5 -> 0.75; month RSI 60 -> 2.0; week RSI 50 -> 1.2; valuation 6/10*2 = 1.2
  const csv = tvCsv([['AAA1', 'x', '100', '2.5', '-1', '3', '2', '1', '2', '60', '50']]);
  const r = Te.matchAndScore(csv, [ist('AAA1 · Test', 6)]);
  assert.strictEqual(r.matched.length, 1); assert.strictEqual(r.matched[0].score, 7.65);
  assert.deepStrictEqual(r.matched[0].states, { monthMacd: 'bull_above', weekMacd: 'bear_above', monthRsi: 'strong', weekRsi: 'neutral' });
  assert.strictEqual(r.matched[0].raw.weekPctChange, 2.5); assert.strictEqual(r.matched[0].raw.monthPctChange, -1);
  assert.deepStrictEqual(r.matched[0].missing, []); assert.deepStrictEqual(r.missingColumns, []);
});
test('tech score: MACD states and RSI bands (boundaries included)', () => {
  const score = (ml, ms, wl, ws, mr, wr, val = 5) => Te.matchAndScore(tvCsv([['Q', '', '', '', '', ml, ms, wl, ws, mr, wr]]), [ist('Q', val)]).matched[0];
  assert.strictEqual(score(1, 0, 1, 0, 50, 50).states.monthMacd, 'bull_above');
  assert.strictEqual(score(-1, -2, 1, 0, 50, 50).states.monthMacd, 'bull_below');
  assert.strictEqual(score(1, 2, 1, 0, 50, 50).states.monthMacd, 'bear_above');
  assert.strictEqual(score(-2, -1, 1, 0, 50, 50).states.monthMacd, 'bear_below');
  const zone = r => score(1, 0, 1, 0, r, 50).states.monthRsi;
  assert.deepStrictEqual([70, 69.99, 55, 54.99, 45, 44.99, 30, 29.99, 0].map(zone), ['overbought', 'strong', 'strong', 'neutral', 'neutral', 'weak', 'weak', 'oversold', 'oversold']);
  // all-bullish, RSI 60/60, valuation 10 -> every component at its maximum except overbought-penalty none: (2.5+1.5+2+2+2)/10*10
  assert.strictEqual(score(1, 0, 1, 0, 60, 60, 10).score, 10);
  assert.strictEqual(score(-2, -1, -2, -1, 10, 10, 0).score, 0);
});
test('tech score: a missing component is dropped and the rest are rescaled', () => {
  // week RSI blank: points 2.5 + 0.75 + 2.0 + 1.2 (val 6) = 6.45 over weight 8 -> 8.0625 -> 8.06
  const csv = tvCsv([['AAA1', '', '', '', '', '3', '2', '1', '2', '60', '']]);
  const r = Te.matchAndScore(csv, [ist('AAA1', 6)]).matched[0];
  assert.strictEqual(r.score, 8.06); assert.deepStrictEqual(r.missing, ['weekly RSI']); assert.strictEqual(r.states.weekRsi, null);
  // no indicators at all: only the valuation anchor would be left, which would copy the valuation score as a technical score, so the stock is not scored
  const bare = Te.matchAndScore(tvCsv([['AAA1', '', '', '', '', '', '', '', '', '', '']]), [ist('AAA1', 6)]);
  assert.strictEqual(bare.matched.length, 0); assert.strictEqual(bare.frozen.length, 1); assert.ok(/no technical indicators/.test(bare.frozen[0].reason));
  assert.deepStrictEqual(bare.unmatchedCsvSymbols, []);
  // one indicator is enough to score (weekly RSI 60 = 2.0 points, valuation 6 -> 1.2, over weight 4)
  const one = Te.matchAndScore(tvCsv([['AAA1', '', '', '', '', '', '', '', '', '', '60']]), [ist('AAA1', 6)]).matched[0];
  assert.strictEqual(one.score, 8); assert.strictEqual(one.missing.length, 3);
});
test('tech matching: BSE number via alpha map, hyphen/underscore variants, case, unmatched rows', () => {
  const csv = tvCsv([['ABC', '', '', '', '', '3', '2', '1', '0', '60', '60'], ['BAJAJ_AUTO', '', '', '', '', '3', '2', '1', '0', '60', '60'], ['zzz', '', '', '', '', '3', '2', '1', '0', '60', '60'], ['LONE', '', '', '', '', '', '', '', '', '', '']]);
  const stocks = [ist('500001 · Ind', 5), ist('BAJAJ-AUTO · Ind', 5), ist('ZZZ · Ind', 5), ist('NOPE · Ind', 5)];
  const r = Te.matchAndScore(csv, stocks, { '500001': 'NSE:ABC' });
  assert.deepStrictEqual(r.matched.map(m => m.matchedSymbol), ['ABC', 'BAJAJ-AUTO', 'ZZZ']);   // the file's BAJAJ_AUTO row is indexed under both spellings
  assert.deepStrictEqual(r.unmatchedCsvSymbols, ['LONE']);
  assert.strictEqual(r.matched.find(m => m.stock.ticker.startsWith('NOPE')), undefined);
  // an alpha map entry without an exchange prefix works too, and a numeric ticker with no map entry is simply not matched
  assert.strictEqual(Te.matchAndScore(csv, [ist('500001', 5)], { '500001': 'ABC' }).matched.length, 1);
  assert.strictEqual(Te.matchAndScore(csv, [ist('500001', 5)], { '500001': 'nse: abc ' }).matched.length, 1);   // case and spaces in the map are tolerated
  assert.strictEqual(Te.matchAndScore(csv, [ist('500001', 5)]).matched.length, 0);
});
test('tech matching: a stock without a valuation anchor is frozen, not scored', () => {
  const csv = tvCsv([['AAA1', '', '', '', '', '3', '2', '1', '0', '60', '60']]);
  const r = Te.matchAndScore(csv, [ist('AAA1 · T'), { ticker: 'AAA1 · T', pillars: {} }]);
  assert.strictEqual(r.matched.length, 0); assert.strictEqual(r.frozen.length, 2); assert.ok(/pillars\.val missing/.test(r.frozen[0].reason));
  assert.deepStrictEqual(r.unmatchedCsvSymbols, []);   // the row was used, just not scoreable
});
test('tech: bad files are rejected with a clear message and missing columns are reported', () => {
  throwsMsg(() => Te.matchAndScore('', []), /No data rows/);
  throwsMsg(() => Te.matchAndScore('Symbol\n', []), /No data rows/);
  throwsMsg(() => Te.matchAndScore('Ticker,Price\nABC,1\n', []), /"Symbol" column/);
  const r = Te.matchAndScore('Symbol,RSI 1 month\nAAA1,55\n', [ist('AAA1', 5)]);
  assert.deepStrictEqual(r.missingColumns, ['weekPctChange', 'monthPctChange', 'monthMacdSignal', 'monthMacdLevel', 'weekMacdSignal', 'weekMacdLevel', 'weekRsi']);
  assert.strictEqual(r.matched[0].score, Math.round(((2.0 + 1.0) / 4) * 10 * 100) / 100);   // month RSI 55 = 2.0, valuation 5 -> 1.0, weights 4
});
test('tech: duplicate symbols in the file, thousands separators and percent signs do not break scoring', () => {
  const csv = tvCsv([['AAA1', '', '', '1.5%', '2,000.5', '3', '2', '1', '0', '60', '60'], ['AAA1', '', '', '', '', '-3', '2', '-1', '0', '20', '20']]);
  const r = Te.matchAndScore(csv, [ist('AAA1', 5)]);
  assert.strictEqual(r.matched.length, 1);                 // the last row for a symbol wins, exactly one result per stock
  assert.strictEqual(r.matched[0].states.monthRsi, 'oversold');
});

// =========================================================== Fundamental engine
// 12 companies in "Alpha" group / industry "Widgets", 12 in "Alpha" / "Gadgets" (only 6 of those carry an industry label in the stock list), 11 in group "Beta", 4 in group "Gamma"
const universe = [];
for(let i = 0; i < 12; i++) universe.push(fundRow('WID' + i, 'Alpha', 'Widgets'));
for(let i = 0; i < 12; i++) universe.push(fundRow('GAD' + i, 'Alpha', 'Gadgets'));
for(let i = 0; i < 11; i++) universe.push(fundRow('BET' + i, 'Beta', 'Betas'));
for(let i = 0; i < 4; i++) universe.push(fundRow('GAM' + i, 'Gamma', 'Gammas'));
const csv = fundCsv(universe);
const labelFor = r => r['NSE Code'].startsWith('GAD') && +r['NSE Code'].slice(3) >= 6 ? null : r['Industry'];
const exactMap = new Map(universe.filter(r => labelFor(r)).map(r => [Fe.normSym(r['NSE Code']), labelFor(r)]));

test('csv: the fundamental engine\'s own parser copes with quoted names (comma, quote, newline) and CRLF line ends', () => {
  const rows = [fundRow('QQ1', 'Alpha', 'Widgets', { 'Name': 'Smith, Jones & "Sons"\nLtd' })];
  const text = fundCsv(rows).replace('\n', '\r\n');   // CRLF after the header only; the newline inside the name stays
  const r = Fe.scoreCsv(text, {}).records[0]; assert.strictEqual(r.sym, 'QQ1'); assert.strictEqual(r.name, 'Smith, Jones & "Sons"\nLtd');
});
test('fund helpers: verdict thresholds and symbol normalisation', () => {
  const v = Fe.scoreToVerdict;
  assert.deepStrictEqual([v(10), v(8), v(7.99), v(6), v(5.99), v(5), v(4.99), v(0), v(null)], ['buy', 'buy', 'mbuy', 'mbuy', 'hold', 'hold', 'avoid', 'avoid', null]);
  assert.strictEqual(Fe.normSym(' bajaj_auto '), 'BAJAJ-AUTO'); assert.strictEqual(Fe.normSym(null), '');
});
test('fund columns: found by header text whatever the order; same result when the columns are shuffled', () => {
  const a = Fe.scoreCsv(csv, { exactIndustryBySym: exactMap });
  const shuffled = FUND_HEADER.slice(); for(let i = shuffled.length - 1; i > 0; i--){ const j = (i * 7 + 3) % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const b = Fe.scoreCsv(fundCsv(universe, shuffled), { exactIndustryBySym: exactMap });
  assert.strictEqual(Object.keys(a.columnMap).length, 44);
  assert.deepStrictEqual(a.records.map(r => [r.sym, r.scored.score]), b.records.map(r => [r.sym, r.scored.score]));
});
test('fund columns: similar headers are not confused (TTM vs 3/5-year growth, current vs average ROE, price vs current ratio)', () => {
  const r = Fe.scoreCsv(csv, {}).records[0], row = universe[0];
  near(r.profitGrowthTTM, +row['Profit growth']); near(r.profitGrowth3, +row['Profit growth 3Years']); near(r.profitGrowth5, +row['Profit growth 5Years']);
  near(r.roe, +row['Return on equity']); near(r.avgRoe7, +row['Average return on equity 7Years']); near(r.avgRoe10, +row['Average return on equity 10Years']);
  near(r.roce, +row['Return on capital employed']); near(r.medianRoce10, +row['Median return on capital employed 10Years']); near(r.roic, +row['Return on invested capital']);
  near(r.currentPrice, +row['Current Price']); near(r.currentRatio, +row['Current ratio']); near(r.pe, +row['Price to Earning']); near(r.industryPe, +row['Industry PE']);
  near(r.fcf3, +row['Free cash flow 3years']); near(r.ocf5, +row['Operating cash flow 5years']); near(r.de, +row['Debt to equity']);
  assert.strictEqual(r.nseCode, 'WID0'); assert.strictEqual(r.industryGroup, 'Alpha');
});
test('fund scoring: invariants (score 0-10, verdict matches score, nine factors, weights add up to 10)', () => {
  const { records } = Fe.scoreCsv(csv, { exactIndustryBySym: exactMap });
  assert.strictEqual(records.length, universe.length);
  for(const r of records){
    const s = r.scored; assert.strictEqual(s.factors.length, 9);
    near(s.factors.reduce((a, f) => a + f.weight, 0), 10, 1e-9);
    assert.ok(s.score >= 0 && s.score <= 10, r.sym + ' score ' + s.score);
    assert.strictEqual(s.verdict, Fe.scoreToVerdict(s.score));
    for(const f of s.factors) assert.ok(f.score == null || (f.score >= 0 && f.score <= f.weight + 1e-9), r.sym + ' ' + f.key + ' ' + f.score);
    assert.ok(s.traditionalSubscore >= 0 && s.traditionalSubscore <= 10 && s.buffettSubscore >= 0 && s.buffettSubscore <= 10 && s.valuationSubscore >= 0 && s.valuationSubscore <= 10);
  }
});
test('fund peers: ranked inside the exact industry, then the industry group, then all stocks (needs 10 peers with data)', () => {
  const rec = {}; for(const r of Fe.scoreCsv(csv, { exactIndustryBySym: exactMap }).records) rec[r.sym] = r;
  assert.strictEqual(rec.WID0.scored.moatBasis, 'industry');     // 12 labelled "Widgets"
  assert.strictEqual(rec.GAD7.scored.moatBasis, 'group');        // only 6 "Gadgets" carry a label, so the 24-strong Alpha group is used
  assert.strictEqual(rec.BET0.scored.moatBasis, 'industry');     // 11 "Betas"
  assert.strictEqual(rec.GAM0.scored.moatBasis, 'population');   // 4 stocks: too few for either level
  assert.strictEqual(rec.GAM0.scored.govBasis, 'population');
  // without the symbol->industry map nothing can be ranked at industry level
  for(const r of Fe.scoreCsv(csv, {}).records) assert.notStrictEqual(r.scored.moatBasis, 'industry');
});
test('fund peers: a better stock never ranks below a worse one on the same metric (ties share a rank)', () => {
  const rows = []; for(let i = 0; i < 12; i++) rows.push(fundRow('R' + i, 'Alpha', 'Widgets', { 'Return on capital employed': 10 + i, 'Return on equity': 10 + i, 'OPM': 10 + i, 'Median return on capital employed 10Years': '', 'Average return on equity 7Years': '', 'Average return on equity 10Years': '' }));
  rows.push(fundRow('TIE', 'Alpha', 'Widgets', { 'Return on capital employed': 10, 'Return on equity': 10, 'OPM': 10, 'Median return on capital employed 10Years': '', 'Average return on equity 7Years': '', 'Average return on equity 10Years': '' }));
  const rec = {}; for(const r of Fe.scoreCsv(fundCsv(rows), {}).records) rec[r.sym] = r;
  assert.ok(rec.R11.scored.moatPct > rec.R5.scored.moatPct && rec.R5.scored.moatPct > rec.R0.scored.moatPct);
  assert.strictEqual(rec.TIE.scored.moatPct, rec.R0.scored.moatPct);
  near(rec.R11.scored.moatPct, 100);
});
test('fund scoring: a profit spike far above its multi-year trend is discounted, and the factor says so', () => {
  const base = { 'Profit growth 3Years': 10, 'Profit growth 5Years': 10 };
  const mk = ttm => { const rows = []; for(let i = 0; i < 12; i++) rows.push(fundRow('S' + i, 'Alpha', 'Widgets', Object.assign({}, base, { 'Profit growth': i === 0 ? ttm : 12 }))); return Fe.scoreCsv(fundCsv(rows), {}).records[0].scored.factors.find(f => f.key === 'prof'); };
  assert.strictEqual(mk(12).note, undefined);
  assert.ok(/0\.8x/.test(mk(25).note));      // 2.5x the trend
  assert.ok(/0\.55x/.test(mk(40).note));     // 4x the trend
});
test('fund scoring: sparse data is rescaled over what is present', () => {
  const sparse = fundRow('SPR', 'Alpha', 'Widgets', Object.fromEntries(FUND_HEADER.filter(h => !/^(Name|BSE Code|NSE Code|ISIN Code|Industry|Industry Group|Return on equity)$/.test(h)).map(h => [h, ''])));
  const rec = {}; for(const r of Fe.scoreCsv(fundCsv([...universe.slice(0, 12), sparse]), {}).records) rec[r.sym] = r;
  assert.ok(rec.SPR.scored.score != null && rec.SPR.scored.factors.filter(f => f.score != null).length < 9);
});
test('fund scoring (known quirk): a company with NO usable numbers still gets 0.56 "avoid", because a missing PEG is scored as a neutral 50th percentile', () => {
  const empty = fundRow('EMP', 'Alpha', 'Widgets', Object.fromEntries(FUND_HEADER.filter(h => !/^(Name|BSE Code|NSE Code|ISIN Code|Industry|Industry Group)$/.test(h)).map(h => [h, ''])));
  const r = Fe.scoreCsv(fundCsv([...universe.slice(0, 12), empty]), {}).records.find(x => x.sym === 'EMP');
  assert.deepStrictEqual(r.scored.factors.filter(f => f.score != null).map(f => f.key), ['val']);
  assert.strictEqual(r.scored.score, 0.56); assert.strictEqual(r.scored.verdict, 'avoid');
});
test('fund rows: key on NSE code, fall back to BSE code (leading zeros / decimals tidied), skip rows with neither', () => {
  const rows = [fundRow('AAA', 'Alpha', 'W', { 'BSE Code': '500001.0' }), fundRow('', 'Alpha', 'W', { 'BSE Code': '0532123', 'NSE Code': '' }), fundRow('', 'Alpha', 'W', { 'BSE Code': '', 'NSE Code': '' })];
  const { records } = Fe.scoreCsv(fundCsv(rows), {});
  assert.deepStrictEqual(records.map(r => r.sym), ['AAA', '532123']);
  assert.strictEqual(records[0].bseCode, '500001'); assert.strictEqual(records[1].nseCode, '');
  assert.strictEqual(Fe.scoreCsv(fundCsv([fundRow('X', '', 'W', { 'Industry Group': '' })]), {}).records[0].industryGroup, '(unclassified)');
});
test('fund: bad files are rejected with a clear message', () => {
  throwsMsg(() => Fe.scoreCsv('', {}), /No data rows/);
  throwsMsg(() => Fe.scoreCsv(FUND_HEADER.join(',') + '\n', {}), /No data rows/);
  throwsMsg(() => Fe.scoreCsv(fundCsv([fundRow('', 'A', 'W', { 'BSE Code': '', 'NSE Code': '' })]), {}), /NSE or BSE code/);
});

// ---- the apply step: what actually changes the saved stock list ----
const mkStock = (sym, ind, extra) => Object.assign({ asof: '2026-01-01', name: 'Old ' + sym, ticker: sym + ' · ' + ind, industryGroup: 'OldGroup', score: 1, verdict: 'avoid',
  pillars: { val: 3 }, technical: { score: 5.5, asof: '2026-01-01' }, globalFactors: { scope: 'sector', positive: ['keep me'], negative: [] }, valuation: { note: 'keep', intrinsicValue: 1 },
  fundamentals: { factors: [], total: 10 } }, extra || {});
test('apply: re-scores listed stocks in place, adds new ones with safe defaults, reports the rest', () => {
  const stocks = [mkStock('WID0', 'Widgets'), mkStock('WID1', 'Widgets'), mkStock('GONE', 'Widgets'), mkStock(String(JSON.parse(JSON.stringify(universe[30]['BSE Code']))), 'Gammas')];
  const before = JSON.parse(JSON.stringify(stocks));
  const rows = universe.slice(0, 20).concat([universe[30]]); const csv2 = fundCsv(rows);
  const res = F.albaApplyFundamental(csv2, stocks, '2026-10-10');
  assert.strictEqual(res.csvRows, 21); assert.strictEqual(res.rescored, 3); assert.deepStrictEqual(res.dropped, ['GONE · Widgets']);
  assert.strictEqual(res.onboarded.length, 21 - 3); 
  assert.strictEqual(stocks.length, 4 + 18);                                        // appended, nothing removed
  // the existing, matched stocks
  const w0 = stocks[0]; assert.strictEqual(w0.asof, '2026-10-10'); assert.notStrictEqual(w0.score, 1); assert.strictEqual(w0.verdict, Fe.scoreToVerdict(w0.score)); assert.strictEqual(w0.industryGroup, 'Alpha');
  assert.strictEqual(w0.fundamentals.factors.length, 9); assert.strictEqual(w0.fundamentals.total, 10); near(w0.fundamentals.scoringBreakdown.overallComposite, w0.score);
  assert.strictEqual(w0.valuation.note, 'keep');                                    // merged, not replaced
  assert.strictEqual(w0.valuation.intrinsicValue, +universe[0]['Intrinsic Value']); assert.strictEqual(w0.valuation.asof, '2026-10-10');
  // untouched fields stay as they were
  for(const k of ['name', 'ticker', 'technical', 'globalFactors']) assert.deepStrictEqual(w0[k], before[0][k], k);
  // the valuation anchor that the technical score uses follows the new valuation factor score
  assert.strictEqual(w0.pillars.val, Math.round(w0.fundamentals.factors.find(f => f.key === 'dcf').score * 10 * 10) / 10); assert.notStrictEqual(w0.pillars.val, 3);
  // a stock that is not in the file is left exactly alone
  assert.deepStrictEqual(stocks[2], before[2]);
  // a stock listed by its BSE number matches the file's BSE column
  assert.strictEqual(stocks[3].asof, '2026-10-10');
  // a newly added stock
  const added = stocks[4]; assert.ok(/^[A-Z0-9]+ · /.test(added.ticker)); assert.strictEqual(added.asof, '2026-10-10');
  assert.strictEqual(added.pillars.val, Math.round(added.fundamentals.factors.find(f => f.key === 'dcf').score * 10 * 10) / 10);
  assert.ok(/Newly imported/.test(added.technical.reason)); assert.strictEqual(added.globalFactors.scope, 'sector'); assert.deepStrictEqual(added.globalFactors.positive, []);
  assert.strictEqual(added.screenerConsolidated, undefined);
  assert.deepStrictEqual(res.verdictMix, stocks.reduce((m, s) => (m[s.verdict] = (m[s.verdict] || 0) + 1, m), {}));
});
test('apply: BSE-only companies are onboarded under their BSE number and listed as such', () => {
  const stocks = []; const row = fundRow('', 'Alpha', 'Widgets', { 'NSE Code': '', 'BSE Code': '512345' });
  const res = F.albaApplyFundamental(fundCsv([row, ...universe.slice(0, 11)]), stocks, '2026-10-10');
  assert.ok(res.bseOnly.includes('512345')); assert.ok(res.onboarded.includes('512345')); assert.strictEqual(stocks.find(s => s.ticker.startsWith('512345')).asof, '2026-10-10');
});
test('apply (known quirk): a listed company whose CSV row has no data is "re-scored" to 0.56 / avoid rather than left alone', () => {
  const bad = fundRow('BAD', 'Alpha', 'Widgets', Object.fromEntries(FUND_HEADER.filter(h => !/^(Name|BSE Code|NSE Code|ISIN Code|Industry|Industry Group)$/.test(h)).map(h => [h, ''])));
  const stocks = [mkStock('BAD', 'Widgets')];
  const res = F.albaApplyFundamental(fundCsv([bad, ...universe.slice(0, 11)]), stocks, '2026-10-10');
  assert.strictEqual(res.rescored, 1); assert.strictEqual(stocks[0].score, 0.56); assert.strictEqual(stocks[0].verdict, 'avoid');
});
test('apply: an unclassified industry group in the file does not overwrite the stock\'s own group', () => {
  const stocks = [mkStock('UNC', 'Widgets')]; const rows = [fundRow('UNC', '', 'Widgets', { 'Industry Group': '' }), ...universe.slice(0, 11)];
  F.albaApplyFundamental(fundCsv(rows), stocks, '2026-10-10'); assert.strictEqual(stocks[0].industryGroup, 'OldGroup');
});
test('apply: running the same file twice gives the same list', () => {
  const run = () => { const s = [mkStock('WID0', 'Widgets')]; F.albaApplyFundamental(csv, s, '2026-10-10'); return s; };
  assert.deepStrictEqual(run(), run());
});
test('apply: bad files throw before anything is changed', () => {
  const stocks = [mkStock('WID0', 'Widgets')], before = JSON.parse(JSON.stringify(stocks));
  assert.throws(() => F.albaApplyFundamental('not,a,csv\n', stocks, '2026-10-10')); assert.throws(() => F.albaApplyFundamental('', stocks, '2026-10-10'));
  assert.deepStrictEqual(stocks, before);
});

// =========================================================== Business page: industry changes and news (src/business/calc.js)
{
  const B = load('src/business/calc.js');
  const NOW = Date.UTC(2026, 9, 10, 12), DAYS = 86400;
  const mk = (tk, ind, grp, wk, mo, events) => ({ ticker: tk + ' \u00b7 ' + ind, name: 'Co ' + tk, industryGroup: grp, technical: { raw: { weekPctChange: wk, monthPctChange: mo } }, __events: events });
  const ev = (days, t, sent) => ({ k: 'news', d: new Date(NOW - days * DAYS * 1000).toISOString().slice(0, 10), t, s: sent });
  const list = [mk('A', 'Steel', 'Metals', 2, 10, [ev(2, 'A wins order', 'pos'), ev(20, 'A old news', 'neg')]), mk('B', 'Steel', 'Metals', -4, 6, [ev(3, 'B probe', 'neg')]), mk('C', 'Banks', 'Financials', 1, -2), mk('D', 'Aluminium', 'Metals', null, null)];
  test('business: 1M table is ordered by average change, medians and breadth are right', () => {
    const t = B.industryTable(list, { period: '1M', now: NOW });
    assert.deepStrictEqual(t.map(r => r.name), ['Steel', 'Banks', 'Aluminium']);
    near(t[0].mean, 8); near(t[0].median, 8); assert.strictEqual(t[0].up, 2); assert.strictEqual(t[0].down, 0); assert.strictEqual(t[0].known, 2);
    assert.strictEqual(t[2].mean, null); assert.strictEqual(t[2].known, 0); assert.strictEqual(t[2].count, 1);
  });
  test('business: a stock with no figure is left out of the average, not counted as zero', () => {
    const t = B.industryTable(list, { period: '1W', now: NOW });
    near(t.find(r => r.name === 'Steel').mean, -1); assert.strictEqual(t.find(r => r.name === 'Aluminium').mean, null);
  });
  test('business: grouping by industry group merges industries', () => {
    const t = B.industryTable(list, { by: 'group', period: '1M', now: NOW });
    const m = t.find(r => r.name === 'Metals'); assert.strictEqual(m.count, 3); assert.strictEqual(m.known, 2); near(m.mean, 8);
  });
  test('business: news is limited to the period, newest first, with sentiment counts', () => {
    const w = B.industryTable(list, { period: '1W', now: NOW }).find(r => r.name === 'Steel');
    assert.deepStrictEqual(w.news.map(n => n.t), ['A wins order', 'B probe']); assert.strictEqual(w.pos, 1); assert.strictEqual(w.neg, 1);
    const m = B.industryTable(list, { period: '1M', now: NOW }).find(r => r.name === 'Steel');
    assert.strictEqual(m.news.length, 3);
  });
  test('business: the Analysis-filter matches are counted and averaged on their own, listed first, and nothing is removed', () => {
    const match = new Set([list[1], list[2]]);      // B (Steel, +6) and C (Banks, -2)
    const t = B.industryTable(list, { period: '1M', now: NOW, matchSet: match });
    const steel = t.find(r => r.name === 'Steel');
    assert.strictEqual(steel.count, 2); assert.strictEqual(steel.matches, 1); near(steel.matchMean, 6); near(steel.mean, 8);
    assert.deepStrictEqual(steel.items.map(x => x.stock.name), ['Co B', 'Co A']);        // the match first, although A changed more
    assert.deepStrictEqual(steel.items.map(x => x.match), [true, false]);
    const alu = t.find(r => r.name === 'Aluminium'); assert.strictEqual(alu.matches, 0); assert.strictEqual(alu.matchMean, null);
    assert.deepStrictEqual(t.map(r => r.name), ['Steel', 'Banks', 'Aluminium']);         // industry order unchanged
    const none = B.industryTable(list, { period: '1M', now: NOW });
    assert.ok(none.every(r => r.matches === 0 && r.items.every(x => !x.match)));
  });
  test('business: longer periods use weekly bars (close now vs the last bar at least that many days earlier)', () => {
    const wk = (i, c) => [1000000 + i * 7 * DAYS, c, c, c, c, 1];
    const bars = Array.from({ length: 60 }, (_, i) => wk(i, 100 + i));      // closes 100..159, one per week
    const one = (period, b) => B.industryTable([mk('X', 'Solo', 'G', 0, 0)], { period, now: NOW, barsFor: () => b })[0].mean;
    near(one('3M', bars), (159 / (100 + 59 - 13) - 1) * 100);   // 91 days = 13 weeks back
    assert.strictEqual(one('1Y', bars.slice(0, 30)), null);      // not enough history
    assert.strictEqual(one('6M', undefined), null);
    const t = B.industryTable(list, { period: '3M', now: NOW, barsFor: s => s.name === 'Co A' ? bars : undefined });
    assert.strictEqual(t.find(r => r.name === 'Steel').known, 1);
  });
}

// =========================================================== Scoring-correctness fixes (v1.171)
const scoreOne = (rows, sym) => Fe.scoreCsv(fundCsv(rows), {}).records.find(r => r.nseCode === sym);
const factorOf = (r, key) => r.scored.factors.find(f => f.key === key);
const baseRows = () => { D.setSeed(4242); const rows = []; for(let i = 0; i < 14; i++) rows.push(fundRow('Z' + i, 'Alpha', 'Widgets')); return rows; };
test('fix: a blank current ROCE / ROE counts as missing, not as 0 (no halved value)', () => {
  const withBoth = baseRows(), blanked = baseRows();
  // same company twice: once with ROCE equal to its 10-year median, once with ROCE blank -> the effective ROCE must be the same
  const med = withBoth[0]['Median return on capital employed 10Years'], avg = withBoth[0]['Average return on equity 7Years'];
  withBoth[0]['Return on capital employed'] = med; blanked[0]['Return on capital employed'] = '';
  withBoth[0]['Return on equity'] = avg; blanked[0]['Return on equity'] = '';
  const a = factorOf(scoreOne(withBoth, 'Z0'), 'prof').score, b = factorOf(scoreOne(blanked, 'Z0'), 'prof').score;
  near(a, b, 1e-6);
});
test('fix: a negative debt-to-equity (negative net worth) ranks worst on leverage, not best', () => {
  const zero = baseRows(), neg = baseRows();
  zero[0]['Debt to equity'] = 0; neg[0]['Debt to equity'] = -1.5;
  const f0 = factorOf(scoreOne(zero, 'Z0'), 'fin').score, fn = factorOf(scoreOne(neg, 'Z0'), 'fin').score;
  assert.ok(fn < f0, 'negative D/E scored ' + fn + ' vs D/E 0 at ' + f0);
});
test('fix: a negative P/E gives no own-history valuation gap (same as having no history at all)', () => {
  const withHist = baseRows(), noHist = baseRows();
  withHist[0]['Price to Earning'] = noHist[0]['Price to Earning'] = -20; withHist[0]['Historical PE 5Years'] = 25; noHist[0]['Historical PE 5Years'] = '';
  near(factorOf(scoreOne(withHist, 'Z0'), 'val').score, factorOf(scoreOne(noHist, 'Z0'), 'val').score, 1e-9);
  // a positive P/E still uses the history
  withHist[0]['Price to Earning'] = noHist[0]['Price to Earning'] = 10;
  assert.notStrictEqual(factorOf(scoreOne(withHist, 'Z0'), 'val').score, factorOf(scoreOne(noHist, 'Z0'), 'val').score);
});
test('fix: the technical valuation anchor is refreshed on every fundamental import, not only for new stocks', () => {
  const stocks = [mkStock('WID0', 'Widgets', { pillars: { val: 4 } })];
  F.albaApplyFundamental(fundCsv(universe.slice(0, 14)), stocks, '2026-10-14');
  const dcf = stocks[0].fundamentals.factors.find(f => f.key === 'dcf');
  assert.strictEqual(stocks[0].pillars.val, Math.round(dcf.score * 10 * 10) / 10);
  // no intrinsic value in the file: the old anchor is kept rather than overwritten with 0
  const rows = universe.slice(0, 14).map(r => Object.assign({}, r)); rows[0]['Intrinsic Value'] = '';
  const s2 = [mkStock('WID0', 'Widgets', { pillars: { val: 4 } })];
  F.albaApplyFundamental(fundCsv(rows), s2, '2026-10-14');
  assert.strictEqual(s2[0].pillars.val, 4);
});
{
  const FS = load('src/core/fundscore.js');
  const fac = (key, category, weight, score, extra) => Object.assign({ key, category, weight, score, name: key, metrics: [['x', '1']], note: '' }, extra || {});
  test('fix: a factor with no data (stored as 0) is left out and the score is rescaled over the rest', () => {
    const mk = z => ({ fundamentals: { factors: [fac('fin', 'Traditional', 1, 0.8), fac('dcf', 'Valuation', 1, z)], total: 10 }, score: 0 });
    const s = mk(0); FS.applyFundamentalConfidence(s);
    assert.strictEqual(s.fundamentals.factors[1].excluded, 'not enough data to score this factor'); assert.strictEqual(s.score, 8);
    const t = mk(0.2); FS.applyFundamentalConfidence(t);   // a genuinely low score still counts
    assert.strictEqual(t.fundamentals.factors[1].excluded, undefined); assert.strictEqual(t.score, 5);
  });
}
test('fix: a flat price series has no RSI (not 100)', () => {
  const TECH = load('src/engine/technical.js');
  const flat = Array.from({ length: 40 }, (_, i) => [i, 10, 10, 10, 10, 0]);
  const rising = Array.from({ length: 40 }, (_, i) => [i, 10 + i, 10 + i, 10 + i, 10 + i, 0]);
  assert.strictEqual(TECH.computeTechnical(flat, flat, 5, '2026-10-14').raw.weekRsi, null);
  assert.strictEqual(TECH.computeTechnical(rising, rising, 5, '2026-10-14').raw.weekRsi, 100);
});
test('fix: both technical paths call a 4/10 valuation "fully valued"', () => {
  const TECH = load('src/engine/technical.js');
  assert.strictEqual(TECH.techValLabel(4), 'fully valued'); assert.strictEqual(TECH.techValLabel(3.9), 'expensive / stretched valuation');
});

// ---- v1.181: one set of scoring rules and completed bars only ----
// Weekly bars open on Mondays and monthly bars on the 1st (03:45 UTC = 09:15 IST), like TradingView's. Closes rise for a long
// time, and the LAST bar of each series drops hard, so the in-progress reading differs from the completed one.
const barsAt = (opens, closes) => opens.map((d, i) => [Date.parse(d + 'T03:45:00Z') / 1000, closes[i], closes[i], closes[i], closes[i], 0]);
const mondays = (last, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(last + 'T00:00:00Z') - (n - 1 - i) * 7 * 86400000).toISOString().slice(0, 10));
const firsts = (lastYm, n) => Array.from({ length: n }, (_, i) => { const [y, m] = lastYm.split('-').map(Number), k = y * 12 + m - 1 - (n - 1 - i); return Math.floor(k / 12) + '-' + String(k % 12 + 1).padStart(2, '0') + '-01'; });
const risingThenDrop = n => Array.from({ length: n }, (_, i) => i === n - 1 ? 60 : 100 + i * 2);
const mkBars = () => ({ W: barsAt(mondays('2026-10-12', 60), risingThenDrop(60)), M: barsAt(firsts('2026-10', 40), risingThenDrop(40)) });
test('v1.181: a week and month still in progress are left out of the saved score and shown as provisional', () => {
  const TECH = load('src/engine/technical.js'), { W, M } = mkBars();
  const t = TECH.computeTechnical(W, M, 5, '2026-10-14');   // a Wednesday: this week and October are not finished
  const done = TECH.computeTechnical(W.slice(0, -1), M.slice(0, -1), 5, '2026-10-14');
  assert.strictEqual(t.score, done.score); assert.deepStrictEqual(t.states, done.states);
  assert.deepStrictEqual(t.basis, { week: '2026-10-05', month: '2026-09-01' });
  assert.strictEqual(done.provisional, undefined);
  assert.ok(t.states.weekMacd.startsWith('bull') && t.states.monthMacd.startsWith('bull'));
  assert.ok(t.provisional.states.weekMacd.startsWith('bear') && t.provisional.states.monthMacd.startsWith('bear'));   // the old code scored this reading
  assert.notStrictEqual(t.provisional.score, t.score);
  assert.ok(t.raw.weekPctChange < -40, 'the price change still shows the current move');
});
test('v1.181: a weekly bar counts as finished from Saturday, a monthly bar from the next month', () => {
  const TECH = load('src/engine/technical.js'), { W, M } = mkBars();
  const sat = TECH.computeTechnical(W, M, 5, '2026-10-17');
  assert.deepStrictEqual(sat.basis, { week: '2026-10-12', month: '2026-09-01' }); assert.ok(sat.provisional);   // October is still open
  const fri = TECH.computeTechnical(W, M, 5, '2026-10-16'); assert.strictEqual(fri.basis.week, '2026-10-05');
  const nov = TECH.computeTechnical(W, M, 5, '2026-11-02');
  assert.deepStrictEqual(nov.basis, { week: '2026-10-12', month: '2026-10-01' }); assert.strictEqual(nov.provisional, undefined);
});
test('v1.181: the CSV import and the live refresh score the same readings identically', () => {
  const TECH = load('src/engine/technical.js'), { W, M } = mkBars();
  const t = TECH.computeTechnical(W.slice(0, -1), M.slice(0, -1), 6, '2026-10-14'), r = t.raw;
  const csv = Te.matchAndScore(tvCsv([['Q', '', '', '', '', r.monthMacdLevel, r.monthMacdSignal, r.weekMacdLevel, r.weekMacdSignal, r.monthRsi, r.weekRsi]]), [ist('Q', 6)]).matched[0];
  assert.deepStrictEqual(csv.states, { monthMacd: t.states.monthMacd, weekMacd: t.states.weekMacd, monthRsi: t.states.monthRsi, weekRsi: t.states.weekRsi });
  assert.strictEqual(csv.score, t.score);
});
// ---- v1.182: refresh from TradingView (snapshot readings, no bars) ----
test('v1.182: a TradingView snapshot is scored by the same rules as the CSV import and is marked as a snapshot', () => {
  const TECH = load('src/engine/technical.js');
  const r = { monthMacdLevel: 20.5, monthMacdSignal: 16.8, weekMacdLevel: 8.6, weekMacdSignal: 8.5, monthRsi: 62.7, weekRsi: 58.7, weekPctChange: 3.45, monthPctChange: 3.58 };
  const t = TECH.snapshotTechnical(r, 6, '2026-10-15');
  const csv = Te.matchAndScore(tvCsv([['Q', '', '', '', '', r.monthMacdLevel, r.monthMacdSignal, r.weekMacdLevel, r.weekMacdSignal, r.monthRsi, r.weekRsi]]), [ist('Q', 6)]).matched[0];
  assert.strictEqual(t.score, csv.score); assert.strictEqual(t.states.monthMacd, 'bull_above'); assert.strictEqual(t.states.weekRsi, 'strong');
  assert.strictEqual(t.src, 'snapshot'); assert.strictEqual(t.asof, '2026-10-15'); assert.deepStrictEqual(t.basis, { week: null, month: null });
  assert.strictEqual(t.raw.valuationScore, 6); assert.ok(/in progress/.test(t.reason));
  assert.strictEqual(TECH.snapshotTechnical({}, 6, '2026-10-15'), null);   // nothing to score
  const part = TECH.snapshotTechnical({ weekRsi: 60 }, null, '2026-10-15'); assert.strictEqual(part.score, 10 * 2.0 / 2.0 * 1);   // one component, rescaled
});
test('v1.182: a recent completed-bars score is kept; an older one, a snapshot or an imported one is replaced', () => {
  const TECH = load('src/engine/technical.js');
  const bars = { asof: '2026-10-14', basis: { week: '2026-10-05', month: '2026-09-01' } };
  assert.strictEqual(TECH.techKeepsBarsBlock(bars, '2026-10-15'), true);
  assert.strictEqual(TECH.techKeepsBarsBlock(bars, '2026-10-17'), true);
  assert.strictEqual(TECH.techKeepsBarsBlock(bars, '2026-10-18'), false);   // more than 3 days old
  assert.strictEqual(TECH.techKeepsBarsBlock(Object.assign({}, bars, { src: 'snapshot' }), '2026-10-15'), false);
  assert.strictEqual(TECH.techKeepsBarsBlock({ asof: '2026-10-14' }, '2026-10-15'), false);   // imported from a CSV: no completed-bar dates
  assert.strictEqual(TECH.techKeepsBarsBlock(null, '2026-10-15'), false);
});
test('v1.182: the reason text of a bars-based score is unchanged by the shared helper', () => {
  const TECH = load('src/engine/technical.js'), { W, M } = mkBars();
  const t = TECH.computeTechnical(W.slice(0, -1), M.slice(0, -1), 6, '2026-10-14');
  assert.ok(/^monthly MACD bullish, above zero, weekly MACD bullish, above zero\. monthly RSI [\d.]+ \(\w+\), weekly RSI [\d.]+ \(\w+\)\. Valuation pillar reading of 6\.0\/10 \(reasonably valued\)\.$/.test(t.reason), t.reason);
});

// v1.187: the browser suites are skipped without Playwright on a developer machine, but a missing Playwright must FAIL in CI
{
  const { spawnSync } = require('child_process');
  const run = (ci) => spawnSync(process.execPath, ['-e', "const M = require('module'), o = M._resolveFilename; M._resolveFilename = function(r, ...a){ if(/^playwright/.test(r)) throw new Error('missing'); return o.call(this, r, ...a); }; require('./tests/lib/env.js').chromiumOrSkip('demo suite');"], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: Object.assign({}, process.env, ci ? { CI: 'true' } : { CI: '' }) });
  test('v1.187: without Playwright a suite is skipped on a developer machine', () => { const r = run(false); assert.strictEqual(r.status, 0); assert.match(r.stdout, /demo suite: SKIPPED/); });
  test('v1.187: without Playwright a suite FAILS in CI, so a green check means the browser tests ran', () => { const r = run(true); assert.strictEqual(r.status, 1); assert.match(r.stderr, /demo suite: FAILED/); });
}

// =========================================================== Characterisation: today's exact numbers on the made-up universe
const golden = {};
for(const r of Fe.scoreCsv(csv, { exactIndustryBySym: exactMap }).records){
  const s = r.scored; golden['fund:' + r.sym] = [s.score, s.verdict, s.traditionalSubscore, s.buffettSubscore, s.valuationSubscore, s.moatBasis, s.govBasis, ...s.factors.map(f => f.score == null ? null : Math.round(f.score * 1e6) / 1e6)];
}
{
  D.setSeed(777); const rows = []; const tvStocks = [];
  for(let i = 0; i < 14; i++){ rows.push(['TV' + i, '', '', rv(-5, 5, 2), rv(-10, 10, 2), rv(-3, 3, 3), rv(-3, 3, 3), rv(-3, 3, 3), rv(-3, 3, 3), rv(15, 85, 1), rv(15, 85, 1)]); tvStocks.push(ist('TV' + i + ' · I', +rv(0, 10, 1))); }
  for(const m of Te.matchAndScore(tvCsv(rows), tvStocks).matched) golden['tech:' + m.matchedSymbol] = [m.score, m.states.monthMacd, m.states.weekMacd, m.states.monthRsi, m.states.weekRsi];
}
const goldenFile = path.join(__dirname, 'engines.golden.json');
if(process.argv.includes('--update')){ fs.writeFileSync(goldenFile, JSON.stringify(golden, null, 1) + '\n'); console.log('engines.golden.json updated (' + Object.keys(golden).length + ' entries)'); }
test('golden: the scores for the made-up universe have not moved', () => {
  const want = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  const moved = Object.keys(Object.assign({}, want, golden)).filter(k => JSON.stringify(want[k]) !== JSON.stringify(golden[k]));
  assert.strictEqual(moved.length, 0, moved.length + ' entries differ (e.g. ' + moved.slice(0, 3).join(', ') + '); if intended run: node tests/engines.js --update');
});

// =========================================================== score history (the trend on the stock page)
const H = load('src/history/scorehistory.js', 'export { BUCKETS, SCORE_ENGINE, addPoint, bucketId, bucketOf, pointFor };');
const R = load('src/detail/scoretrend.js', 'export { scoreTrendHtml };');
test('history: a stock always lands in the same one of 64 buckets', () => {
  assert.strictEqual(H.bucketOf('AAA1'), H.bucketOf('AAA1'));
  for(const k of ['AAA1', 'BBB2', '500325', 'X-Y_Z']) assert.ok(H.bucketOf(k) >= 0 && H.bucketOf(k) < H.BUCKETS);
  assert.strictEqual(H.bucketId(5), 'h05');
  assert.strictEqual(H.tickerKey({ ticker: 'AAA1 · Some Co' }), 'AAA1');
});
test('history: addPoint appends, replaces the same date, skips repeats, and drops points over three years old', () => {
  const a = H.addPoint(null, [20261001, 6, 5, 100, 2]);
  assert.deepStrictEqual(a, [[20261001, 6, 5, 100, 2]]);
  assert.strictEqual(H.addPoint(a, [20261008, 6, 5, 100, 2]), null, 'identical to the newest point: nothing to add');
  const b = H.addPoint(a, [20261008, 6.5, 5, 101, 2]);
  assert.strictEqual(b.length, 2);
  const c = H.addPoint(b, [20261008, 7, 5, 101, 2]);
  assert.strictEqual(c.length, 2); assert.strictEqual(c[1][1], 7, 'same date is replaced');
  const old = [[20230901, 5, 5, 1, 1], [20231101, 5, 5, 1, 1]];
  const d = H.addPoint(old, [20261014, 6, 6, 1, 2]);
  assert.deepStrictEqual(d.map(p => p[0]), [20231101, 20261014], 'the point from before the three-year window is dropped');
});
test('history: pointFor rounds, reads the price from the valuation, and skips a stock with no scores', () => {
  assert.deepStrictEqual(H.pointFor({ score: 6.456, technical: { score: 4.2 }, valuation: { currentPrice: 99.999 } }, 20261014), [20261014, 6.46, 4.2, 100, H.SCORE_ENGINE]);
  assert.deepStrictEqual(H.pointFor({ score: 6, technical: null }, 20261014), [20261014, 6, null, null, H.SCORE_ENGINE]);
  assert.strictEqual(H.pointFor({ technical: { score: null } }, 20261014), null);
});
test('history: recordScoreHistory writes one document per bucket, is idempotent, and never throws', async () => {
  const store = new Map(), sets = [];
  const db = { doc: p => ({ get: async () => ({ exists: store.has(p), data: () => store.get(p) }), set: async d => { sets.push(p); store.set(p, JSON.parse(JSON.stringify(d))); } }) };
  const list = ['AAA1', 'BBB2', 'CCC3'].map((k, i) => ({ ticker: k + ' · Co', score: 5 + i, technical: { score: 4 + i }, valuation: { currentPrice: 10 * (i + 1) } }));
  const r1 = await H.recordScoreHistory(db, list, 20261001);
  assert.strictEqual(r1.stocks, 3); assert.ok(!r1.error);
  const buckets = new Set(list.map(s => H.bucketId(H.bucketOf(H.tickerKey(s)))));
  assert.strictEqual(store.size, buckets.size);
  const n = sets.length;
  const r2 = await H.recordScoreHistory(db, list, 20261008);
  assert.strictEqual(r2.stocks, 0); assert.strictEqual(sets.length, n, 'an import that changed nothing writes nothing');
  list[0].score = 7;
  const r3 = await H.recordScoreHistory(db, list, 20261015);
  assert.strictEqual(r3.stocks, 1);
  const doc = store.get('scoreHistory/' + H.bucketId(H.bucketOf('AAA1')));
  assert.deepStrictEqual(doc.stocks.AAA1.map(p => p[0]), [20261001, 20261015]);
  const bad = await H.recordScoreHistory({ doc: () => { throw new Error('db down'); } }, list, 20261016);
  assert.match(bad.error, /db down/);
});
test('history: the trend chart needs two points, marks engine changes, and says so when short', () => {
  assert.match(R.scoreTrendHtml([]), /appears after the next import/);
  assert.match(R.scoreTrendHtml([[20261001, 6, 5, 100, 2]]), /One reading so far/);
  const html = R.scoreTrendHtml([[20261001, 6, 5, 100, 1], [20261008, 6.5, 4, 110, 2], [20261015, 7, null, null, 2]]);
  assert.match(html, /<svg/); assert.match(html, /trend-engine/); assert.match(html, /Fundamental \+1\.00/);
  assert.ok(!/NaN/.test(html));
  assert.ok(!/trend-engine/.test(R.scoreTrendHtml([[20261001, 6, 5, 1, 2], [20261008, 7, 5, 1, 2]])));
});

// =========================================================== trade calls (Trade Log: Hold / trim / add / review)
const G = load('src/tradelog/signals.js');
const base = { buyPrice: 100, price: 105, entryScore: 6.5, score: 6.5, verdict: 'mbuy', intrinsic: 140, rsiWeek: 55, rsiMonth: 55 };
test('trade call: a calm position with a good verdict is Hold, with the reasons listed', () => {
  const s = G.tradeSignal(base);
  assert.strictEqual(s.call, 'hold'); assert.ok(s.reasons.length >= 2);
});
test('trade call: a big gain with stretched RSI is Consider trimming (the OCCL case)', () => {
  const s = G.tradeSignal({ buyPrice: 193.68, price: 232, entryScore: 6.59, score: 6.52, verdict: 'mbuy', intrinsic: 355, rsiWeek: 83.3, rsiMonth: 75.2 });
  assert.strictEqual(s.call, 'trim'); assert.match(s.reasons[0], /Weekly RSI is 83\.3/);
});
test('trade call: a weaker verdict, a falling score, a deep loss or a price above fair value is Review, and beats trimming', () => {
  assert.strictEqual(G.tradeSignal({ ...base, verdict: 'hold' }).call, 'review');
  assert.strictEqual(G.tradeSignal({ ...base, score: 5.3 }).call, 'review');
  assert.strictEqual(G.tradeSignal({ ...base, price: 80 }).call, 'review');
  assert.strictEqual(G.tradeSignal({ ...base, price: 160, rsiWeek: 90 }).call, 'review', 'price above fair value comes first');
});
test('trade call: Consider adding needs a good verdict, a roomy cushion, calm RSI and a price near the buy price', () => {
  assert.strictEqual(G.tradeSignal({ ...base, price: 102, intrinsic: 160 }).call, 'add');
  assert.strictEqual(G.tradeSignal({ ...base, price: 102, intrinsic: 160, rsiWeek: 72 }).call, 'hold');
  assert.strictEqual(G.tradeSignal({ ...base, price: 120, intrinsic: 200 }).call, 'hold', 'too far from the buy price');
});
test('trade call: missing data never crashes and never invents a call', () => {
  const s = G.tradeSignal({});
  assert.strictEqual(s.call, 'hold'); assert.strictEqual(s.gain, null);
  assert.strictEqual(G.factsFor({ buy: { price: 10 } }, null).price, null);
});
const I = load('src/tradelog/ideacall.js');
const SW = load('src/tradelog/swing.js');
const idea = (o) => ({ name: 'X', score: 7.2, verdict: 'buy', valuation: { currentPrice: 100, intrinsicValue: 160 }, technical: { score: 7.5, states: { weekMacd: 'bull_above' }, raw: { weekRsi: 65, monthRsi: 60 } }, ...o });
// Weekly bars [t,o,h,l,c,v] (t = unix seconds, Monday 2026-01-05 onwards) from a list of closes.
const barsOf = (closes) => closes.map((c, i) => [Date.UTC(2026, 0, 5 + 7 * i) / 1000, c, c, c, c, 1000]);
const rising = Array.from({ length: 30 }, (_, i) => 100 * Math.pow(1.05, i % 2 ? i : i - 1));   // choppy climb, ends at its high, moves ~5% a week
const flat = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 0.5 : 0));                      // barely moves
const SAT = '2027-01-02';
test('swing: four checks, one point each, from the weekly bars and weekly indicators', () => {
  const up = SW.swingSetup(idea({}), barsOf(rising), SAT);
  assert.strictEqual(up.pts, 4); assert.strictEqual(up.chance, 31);
  const calm = SW.swingSetup(idea({ technical: { states: { weekMacd: 'bear_below' }, raw: { weekRsi: 40 } } }), barsOf(flat), SAT);
  assert.ok(calm.pts <= 1, 'a flat stock with a weak chart scores little, got ' + calm.pts);
  assert.ok(calm.misses.some(m => /MACD/.test(m)) && calm.misses.some(m => /a week/.test(m)));
  assert.strictEqual(SW.swingSetup(idea({}), barsOf(rising.slice(0, 8)), SAT), null, 'too little history gives no reading');
  assert.strictEqual(SW.swingSetup(idea({}), null, SAT), null);
});
test('swing: a week still in progress is left out of the reading', () => {
  const closes = rising.slice();
  const full = SW.swingSetup(idea({}), barsOf(closes), '2027-01-02');
  const crashed = closes.concat([60]);   // a new bar far below the high, but the week has not finished
  const d = new Date(Date.UTC(2026, 0, 5 + 7 * closes.length) + 2 * 86400000).toISOString().slice(0, 10);   // Wednesday of that week
  assert.strictEqual(SW.swingSetup(idea({}), barsOf(crashed), d).fromHigh, full.fromHigh, 'the forming week does not move the 52-week-high distance');
});
test('ideas: Buy needs a stock worth owning AND a setup of 2 or more; a good company with a poor chart is Wait; a weak overvalued one is Avoid', () => {
  const good = SW.swingSetup(idea({}), barsOf(rising), SAT), poor = SW.swingSetup(idea({ technical: { states: { weekMacd: 'bear_above' }, raw: { weekRsi: 40 } } }), barsOf(flat), SAT);
  assert.strictEqual(I.ideaCall(idea({}), null, good).call, 'buy');
  const wait = I.ideaCall(idea({}), null, poor);
  assert.strictEqual(wait.call, 'hold'); assert.strictEqual(wait.label, 'Wait');
  assert.ok(wait.reasons.some(r => /setup \d\/4/.test(r)));
  assert.strictEqual(I.ideaCall(idea({}), null, null).call, 'hold', 'no weekly bars: the timing cannot be judged, so not a Buy');
  assert.strictEqual(I.ideaCall(idea({ verdict: 'avoid', score: 4, valuation: { currentPrice: 100, intrinsicValue: 80 } }), null, good).call, 'sell');
  assert.strictEqual(I.ideaCall(idea({ verdict: 'hold', score: 6, valuation: { currentPrice: 100, intrinsicValue: 105 } }), null, good).call, 'hold', 'a Hold verdict is not worth owning, however good the chart');
  assert.strictEqual(I.ideaCall(idea({ valuation: { currentPrice: 100, intrinsicValue: 105 } }), null, good).call, 'hold', 'a cushion under 10% is not enough');
  assert.strictEqual(I.ideaCall(idea({ technical: { states: { weekMacd: 'bear_below' }, raw: { weekRsi: 65 } } }), null, good).call, 'hold', 'bearish below zero is never a Buy');
});
test('ideas: a stretched weekly RSI no longer blocks a Buy (replayed history shows it does no worse than average)', () => {
  const s = { pts: 2, of: 4, chance: 25, touch: 56, hits: ['x'], misses: [], fromHigh: -3, move: 6 };
  assert.strictEqual(I.ideaCall(idea({ technical: { states: { weekMacd: 'bull_above' }, raw: { weekRsi: 82, monthRsi: 60 } } }), null, s).call, 'buy');
});
test('ideas: a stock you hold gets its trade call (add is Buy, trim and review are Sell)', () => {
  const tr = { buy: { price: 100, snapshot: { score: 7.2 } } };
  assert.strictEqual(I.ideaCall(idea({ valuation: { currentPrice: 102, intrinsicValue: 160 }, technical: { raw: { weekRsi: 55, monthRsi: 60 } } }), tr, null).label, 'Add more');
  assert.strictEqual(I.ideaCall(idea({ valuation: { currentPrice: 150, intrinsicValue: 300 }, technical: { raw: { weekRsi: 85, monthRsi: 80 } } }), tr, null).call, 'sell');
  assert.strictEqual(I.ideaCall(idea({}), tr, null).held, true);
});
test('ideas: ranking puts Buy first by best setup, then quality, then nearness to the high; Wait next; the weakest Avoid first', () => {
  const mk = (n, call, pts, setup, fromHigh) => ({ s: { name: n }, c: { call, pts, setup, fromHigh } });
  const r = I.rankIdeas([mk('a', 'sell', -1), mk('b', 'hold', 1, 1, -5), mk('c', 'buy', 4, 2, -8), mk('d', 'buy', 4, 3, -9), mk('e', 'sell', -4), mk('f', 'buy', 4, 2, -2), mk('g', 'buy', 5, 2, -9)]).map(x => x.s.name).join('');
  assert.strictEqual(r, 'dgfcbea', 'setup first, then quality, then closer to the high; ties no longer fall back to the alphabet');
});
test('ideas: missing data never crashes', () => { assert.strictEqual(I.ideaCall({}, null, null).call, 'hold'); assert.strictEqual(I.ideaCall({}, null).call, 'hold'); });
test('trade call: history keeps one point a day and lists when the call changed', () => {
  let h = G.addSignalPoint([], 20261001, { call: 'hold', mos: 40, gain: 5 }, { price: 105, score: 6.5, rsiWeek: 55 });
  h = G.addSignalPoint(h, 20261002, { call: 'hold', mos: 39, gain: 6 }, { price: 106, score: 6.5, rsiWeek: 57 });
  h = G.addSignalPoint(h, 20261003, { call: 'trim', mos: 30, gain: 20 }, { price: 120, score: 6.5, rsiWeek: 82 });
  h = G.addSignalPoint(h, 20261003, { call: 'trim', mos: 29, gain: 21 }, { price: 121, score: 6.5, rsiWeek: 83 });
  assert.strictEqual(h.length, 3, 'same day is replaced');
  assert.deepStrictEqual(G.callChanges(h).map(c => c.call), ['trim', 'hold']);
});

// ---- live snapshot (v1.198): one record per batch, merged under each stock's own saved update ----
{
  const L = load('src/overlays/livesnapshot.js');
  const tv = { close: 250.5, 'MACD.macd|1W': 2, 'MACD.signal|1W': 1, 'MACD.macd|1M': 3, 'MACD.signal|1M': 1, 'RSI|1W': 60, 'RSI|1M': 58, 'change|1W': 1.5, 'change|1M': 4, 'average_volume_30d_calc': 50000.4 };
  const stock = { pillars: { val: 6 } };
  const snap = (extra) => Object.assign({ row: { k: 'ABC', y: 'NSE:ABC', c: L.packValues(tv) }, asof: '2026-10-14', at: '2026-10-14T10:00:00.000Z' }, extra);
  test('live snapshot: a row packs in column order and the merge reads the same figures back', () => {
    const c = L.packValues(tv);
    assert.strictEqual(c.length, L.COLS.length);
    assert.strictEqual(L.mergedDoc(stock, undefined, snap()).valuation.currentPrice, tv.close);
    assert.deepStrictEqual(L.packValues({ close: 'x', 'RSI|1W': NaN }).slice(0, 7), [null, null, null, null, null, null, null]);
  });
  test('live snapshot: with no saved update the row gives price, volume and a snapshot score', () => {
    const d = L.mergedDoc(stock, undefined, snap());
    assert.strictEqual(d.valuation.currentPrice, 250.5);
    assert.strictEqual(d.valuation.at, '2026-10-14T10:00:00.000Z');
    assert.strictEqual(d.liquidity.avgVolume, 50000);
    assert.strictEqual(d.technical.src, 'snapshot');
    assert.strictEqual(d.snapAsof, '2026-10-14', 'the day TradingView confirmed the stock, for the Technical data age');
  });
  test('live snapshot: nothing to merge, or a row without a price, leaves the stock record as it is', () => {
    const real = { ticker: 'ABC', globalFactors: { positive: ['x'] } };
    assert.strictEqual(L.mergedDoc(stock, real, undefined), real);
    assert.strictEqual(L.mergedDoc(stock, real, snap({ row: { k: 'ABC', y: 'NSE:ABC', c: L.packValues({}) } })), real);
  });
  test('live snapshot: notes and Global factors in the stock record are kept', () => {
    const real = { ticker: 'ABC', globalFactors: { scope: 's', positive: ['x'], negative: [] } };
    const d = L.mergedDoc(stock, real, snap());
    assert.deepStrictEqual(d.globalFactors, real.globalFactors);
    assert.strictEqual(d.valuation.currentPrice, 250.5);
    assert.strictEqual(real.valuation, undefined, 'the saved record is not changed in place');
  });
  test('live snapshot: a price saved later by a single-stock refresh wins; an earlier or undated one loses', () => {
    const later = { valuation: { currentPrice: 300, asof: '2026-10-14', at: '2026-10-14T11:00:00.000Z' } };
    const earlier = { valuation: { currentPrice: 300, asof: '2026-10-14', at: '2026-10-14T09:00:00.000Z' } };
    const undatedSameDay = { valuation: { currentPrice: 300, asof: '2026-10-14' } };
    const olderDay = { valuation: { currentPrice: 300, asof: '2026-10-13' } };
    const newerDay = { valuation: { currentPrice: 300, asof: '2026-10-15' } };
    assert.strictEqual(L.mergedDoc(stock, later, snap()).valuation.currentPrice, 300);
    assert.strictEqual(L.mergedDoc(stock, earlier, snap()).valuation.currentPrice, 250.5);
    assert.strictEqual(L.mergedDoc(stock, undatedSameDay, snap()).valuation.currentPrice, 250.5);
    assert.strictEqual(L.mergedDoc(stock, olderDay, snap()).valuation.currentPrice, 250.5);
    assert.strictEqual(L.mergedDoc(stock, newerDay, snap()).valuation.currentPrice, 300);
  });
  test('live snapshot: a completed-weeks score from the last 3 days beats the snapshot score, an older or imported one does not', () => {
    const bars = (asof) => ({ valuation: { currentPrice: 1, asof: '2020-01-01' }, technical: { score: 7, asof, basis: { week: '2026-10-09', month: '2026-09-01' }, reason: 'bars' } });
    assert.strictEqual(L.mergedDoc(stock, bars('2026-10-13'), snap()).technical.reason, 'bars');
    assert.strictEqual(L.mergedDoc(stock, bars('2026-10-01'), snap()).technical.src, 'snapshot');
    assert.strictEqual(L.mergedDoc(stock, { technical: { score: 4, asof: '2026-10-14', reason: 'import' } }, snap()).technical.reason, 'import', 'same day, not from a snapshot');
    assert.strictEqual(L.mergedDoc(stock, { technical: { score: 4, asof: '2026-10-14', src: 'snapshot' } }, snap()).technical.src, 'snapshot');
    assert.strictEqual(L.mergedDoc(stock, { technical: { score: 4, asof: '2026-10-20' } }, snap()).technical.score, 4, 'dated later');
  });
  test('live snapshot: a stock with no valuation reading gets the price but no technical score', () => {
    const d = L.mergedDoc({ pillars: {} }, undefined, snap());
    assert.strictEqual(d.valuation.currentPrice, 250.5);
    assert.strictEqual(d.technical, undefined);
  });
  test('live snapshot: the saving side protects a recent completed-weeks block and reports missing prices', () => {
    const keep = { technical: { asof: '2026-10-14', basis: { week: '2026-10-09', month: '2026-09-01' } } };
    assert.strictEqual(L.snapshotUpdate(stock, tv, '2026-10-14', 'NSE:ABC', keep.technical).kept, true);
    assert.ok(L.snapshotUpdate(stock, tv, '2026-10-14', 'NSE:ABC', null).technical);
    assert.ok(L.snapshotUpdate(stock, {}, '2026-10-14', 'NSE:ABC', null).reason);
  });
}

// ---- history plan (v1.200): which stocks need their full history, which only the new bars, which nothing ----
{
  const H = load('src/refresh/historyplan.js', 'export { barsNeeded, monthStartS, weekStartS };');
  const at = iso => Date.parse(iso) / 1000;
  const bars = (w, m) => ({ '1W': w == null ? [] : [[at(w), 1, 1, 1, 1, 1]], '1M': m == null ? [] : [[at(m), 1, 1, 1, 1, 1]] });
  test('history plan: the week starts on Monday and the month on the 1st, in Indian time', () => {
    assert.strictEqual(H.weekStartS(at('2026-10-15T10:00:00Z')), at('2026-10-11T18:30:00Z'), 'Thursday 15 Oct 2026 -> Monday 12 Oct 00:00 IST');
    assert.strictEqual(H.weekStartS(at('2026-10-18T10:00:00Z')), at('2026-10-11T18:30:00Z'), 'Sunday is still the same week');
    assert.strictEqual(H.weekStartS(at('2026-10-11T19:00:00Z')), at('2026-10-11T18:30:00Z'), 'Monday 00:30 IST');
    assert.strictEqual(H.weekStartS(at('2026-10-11T18:00:00Z')), at('2026-10-04T18:30:00Z'), 'Sunday 23:30 IST is still the old week');
    assert.strictEqual(H.monthStartS(at('2026-10-15T10:00:00Z')), at('2026-09-30T18:30:00Z'));
    assert.strictEqual(H.monthStartS(at('2026-10-31T19:00:00Z')), at('2026-10-31T18:30:00Z'), '1 Nov 00:30 IST is already November');
  });
  test('history plan: none, stale and current', () => {
    const now = at('2026-10-15T10:00:00Z');
    assert.strictEqual(H.barsNeeded(null, now), 'none');
    assert.strictEqual(H.barsNeeded(bars(null, null), now), 'none', 'empty bars count as none');
    assert.strictEqual(H.barsNeeded(bars('2026-10-12T03:45:00Z', '2026-10-01T03:45:00Z'), now), 'current', 'saved this week and this month');
    assert.strictEqual(H.barsNeeded(bars('2026-10-11T18:30:00Z', '2026-09-30T18:30:00Z'), now), 'current', 'a bar that opens exactly at the start counts');
    assert.strictEqual(H.barsNeeded(bars('2026-10-05T03:45:00Z', '2026-10-01T03:45:00Z'), now), 'stale', 'last weekly bar is last week: that week has finished');
    assert.strictEqual(H.barsNeeded(bars('2026-10-12T03:45:00Z', '2026-09-01T03:45:00Z'), now), 'stale', 'last monthly bar is last month');
    assert.strictEqual(H.barsNeeded(bars('2026-10-12T03:45:00Z', null), now), 'stale', 'weekly saved but no monthly bars');
  });
  test('history plan: a Saturday run does not chase the week that finished on Friday again', () => {
    const sat = at('2026-10-17T10:00:00Z');
    assert.strictEqual(H.barsNeeded(bars('2026-10-12T03:45:00Z', '2026-10-01T03:45:00Z'), sat), 'current');
    const mon = at('2026-10-19T04:00:00Z');
    assert.strictEqual(H.barsNeeded(bars('2026-10-12T03:45:00Z', '2026-10-01T03:45:00Z'), mon), 'stale', 'Monday: the week has rolled');
  });
  test('history plan: stocks are grouped and keep their order', () => {
    const now = at('2026-10-15T10:00:00Z');
    const data = { a: null, b: bars('2026-10-05T03:45:00Z', '2026-10-01T03:45:00Z'), c: bars('2026-10-12T03:45:00Z', '2026-10-01T03:45:00Z'), d: null, e: bars('2026-09-01T03:45:00Z', '2026-09-01T03:45:00Z') };
    const p = H.planHistory(['a', 'b', 'c', 'd', 'e'], s => data[s], now);
    assert.deepStrictEqual(p, { none: ['a', 'd'], stale: ['b', 'e'], current: ['c'] });
  });
}

(async () => {
await Promise.all(pending);
if(failures.length){ console.error(failures.length + ' engine test(s) FAILED (' + passed + ' passed):\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('engine tests: ' + passed + ' passed');
})();
