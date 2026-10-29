// Unit tests for the CSV import engines (no browser, no database): the fundamental scoring engine + apply step
// (src/import/fund-engine.js), the technical score engine (src/engine/technical.js) and the shared CSV parser.
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
const F = load('src/import/fund-engine.js', 'export { FundEngine };');
const P = load('src/import/csvparse.js');
const Fe = F.FundEngine;

let passed = 0; const failures = [];
const pending = [];   // async tests: awaited before the summary
function test(name, fn){
  const bad = e => failures.push(name + ": " + String(e.message || e).split("\n").slice(0, 6).join(" | "));
  try { const r = fn(); if(r && typeof r.then === 'function') pending.push(r.then(() => { passed++; }, bad)); else passed++; } catch(e){ bad(e); }
}
const near = (a, b, d = 1e-9) => assert.ok(Math.abs(a - b) <= d, `${a} is not within ${d} of ${b}`);
const throwsMsg = (fn, re) => assert.throws(fn, e => re.test(e.message));

// =========================================================== CSV parsing: the shared parser and the fundamental engine's own copy must agree
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
test('csv: quoted commas, escaped quotes, embedded newlines, CRLF, blank rows', () => {
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[1]), [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[2]), [['a', 'b'], ['x,y', 'he said "hi"']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[3]), [['a', 'b'], ['line1\nline2', 'z']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[4]), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[5]), [['a', 'b'], ['1', ''], ['', '2']]);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[6]), []);
  assert.deepStrictEqual(P.parseCSV(PARSER_CASES[7]), [['a', 'b'], ['unterminated,2\n3,4']]);
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
test('fund columns: FII holding and the 1, 3 and 5 year returns are read when present, and an older file without them still imports', () => {
  const extra = ['Return over 1year', 'Return over 3years', 'Return over 5years', 'FII holding', 'Change in FII holding'];
  const hdr = FUND_HEADER.concat(extra), over = { 'Return over 1year': '-9.88', 'Return over 3years': '11.19', 'Return over 5years': '26.37', 'FII holding': '1.03', 'Change in FII holding': '-0.41' };
  const rows = universe.slice(0, 3).map((r, i) => Object.assign({}, r, i === 0 ? over : { 'FII holding': '' }));
  const r = Fe.scoreCsv(fundCsv(rows, hdr), {}).records;
  near(r[0].fiiHolding, 1.03); near(r[0].ret1, -9.88); near(r[0].ret3, 11.19); near(r[0].ret5, 26.37);
  near(r[0].fiiChange, -0.41); assert.notStrictEqual(r[0].fiiHolding, r[0].fiiChange, 'the quarter change is not mistaken for the holding');
  assert.strictEqual(r[1].fiiHolding, null);   // a blank cell is empty, not 0
  near(r[0].fiiChange3, +universe[0]['Change in FII holding 3Years']);   // the 3-year change column is not mistaken for the holding itself
  const old = Fe.scoreCsv(csv, {}).records[0];
  assert.strictEqual(old.fiiHolding, null); assert.strictEqual(old.fiiChange, null); assert.strictEqual(old.ret1, null);
});
test('fund columns: Industry Group listed before Industry still maps both (real export order)', () => {
  const swap = h => { const a = h.slice(); const i = a.indexOf('Industry'), j = a.indexOf('Industry Group'); a[i] = 'Industry Group'; a[j] = 'Industry'; return a; };
  const hdr = swap(FUND_HEADER), row = universe[0];
  const csvSwapped = [hdr.join(','), hdr.map(h => h === 'Industry Group' ? 'Grp' : h === 'Industry' ? 'Ind' : row[h]).join(',')].join('\n');
  const r = Fe.scoreCsv(csvSwapped, {}).records[0];
  assert.strictEqual(r.industryGroup, 'Grp'); assert.strictEqual(r.industry, 'Ind');
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
test('fund scoring: a profit spike far above its multi-year trend is discounted once (in Growth), and the factor says so', () => {
  const base = { 'Profit growth 3Years': 10, 'Profit growth 5Years': 10 };
  const mk = ttm => { const rows = []; for(let i = 0; i < 12; i++) rows.push(fundRow('S' + i, 'Alpha', 'Widgets', Object.assign({}, base, { 'Profit growth': i === 0 ? ttm : 12 }))); return Fe.scoreCsv(fundCsv(rows), {}).records[0].scored.factors.find(f => f.key === 'growth'); };
  assert.strictEqual(mk(12).note, undefined);
  assert.ok(/0\.8x/.test(mk(25).note));      // 2.5x the trend
  assert.ok(/0\.55x/.test(mk(40).note));     // 4x the trend
});
test('fund scoring: a TTM spike does not touch Profit or Predict (it is discounted once, in Growth)', () => {
  const rows = []; for(let i = 0; i < 12; i++) rows.push(fundRow('S' + i, 'Alpha', 'Widgets', { 'Profit growth 3Years': 10, 'Profit growth 5Years': 10, 'Profit growth': 12 }));
  const get = ttm => { const rs = rows.map((r, i) => i ? r : Object.assign({}, r, { 'Profit growth': ttm })); const f = Fe.scoreCsv(fundCsv(rs), {}).records[0].scored.factors; return k => f.find(x => x.key === k).score; };
  const calm = get(12), spike = get(40);
  assert.strictEqual(spike('prof'), calm('prof'));
  assert.strictEqual(spike('predict'), 0.68 * 0.9);   // 3yr and 5yr alone, with the two-window haircut
});
test('fund scoring: capex-heavy company (negative FCF, positive operating cash flow) is judged on ROIC, not CROIC', () => {
  const rows = []; for(let i = 0; i < 12; i++) rows.push(fundRow('S' + i, 'Alpha', 'Widgets'));
  const get = over => { const rs = rows.map((r, i) => i ? r : Object.assign({}, r, over)); return Fe.scoreCsv(fundCsv(rs), {}).records[0].scored.factors.find(x => x.key === 'reinvest').score; };
  const cash = { 'Free cash flow 3years': -50, 'Operating cash flow 3years': 100, 'Return on invested capital': 30 };
  assert.strictEqual(get(Object.assign({ 'CROIC': -5 }, cash)), get(Object.assign({ 'CROIC': 30 }, cash)));
  assert.ok(get({ 'CROIC': -5, 'Free cash flow 3years': 50, 'Operating cash flow 3years': 100, 'Return on invested capital': 30 }) < get(Object.assign({ 'CROIC': -5 }, cash)));   // healthy FCF keeps the negative CROIC
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
  const res = F.applyFundamental(csv2, stocks, '2026-10-10');
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
  // a stock that is not in the file keeps all its data and is only marked inactive
  assert.deepStrictEqual(stocks[2], Object.assign({}, before[2], { active: false })); assert.deepStrictEqual(res.inactive, ['GONE · Widgets']);
  // a stock listed by its BSE number matches the file's BSE column
  assert.strictEqual(stocks[3].asof, '2026-10-10');
  // a newly added stock
  const added = stocks[4]; assert.ok(/^[A-Z0-9]+ · /.test(added.ticker)); assert.strictEqual(added.asof, '2026-10-10');
  assert.strictEqual(added.pillars.val, Math.round(added.fundamentals.factors.find(f => f.key === 'dcf').score * 10 * 10) / 10);
  assert.ok(/Newly imported/.test(added.technical.reason)); assert.strictEqual(added.globalFactors.scope, 'sector'); assert.deepStrictEqual(added.globalFactors.positive, []);
  assert.strictEqual(added.screenerConsolidated, undefined);
  assert.deepStrictEqual(res.verdictMix, stocks.reduce((m, s) => (m[s.verdict] = (m[s.verdict] || 0) + 1, m), {}));
});
const C = load('src/import/fund-check.js');
const W9 = [1.8, 1.8, 1.125, 1.125, 0.9, 0.9, 0.675, 0.675, 1.0];
const chkStock = (i, extra) => Object.assign({ ticker: 'C' + i + ' · T', score: 7, verdict: 'mbuy', pillars: { val: 7 }, valuation: { intrinsicValue: 100, currentPrice: 80 },
  fundamentals: { factors: W9.map(w => ({ weight: w, score: w * 0.7 })) } }, extra || {});
const chkList = extra => Array.from({ length: 2000 }, (_, i) => (i === 0 ? chkStock(0, extra) : chkStock(i)));
test('integrity check: a stock with no Intrinsic Value may have no valuation anchor (pillars.val)', () => {
  const noIv = { pillars: {}, valuation: { intrinsicValue: null, currentPrice: 51.09 } };
  const r = C.fiCheck(chkList(noIv), new Map()); assert.deepStrictEqual(r.hard, []);
  const r2 = C.fiCheck(chkList({ pillars: {}, valuation: { currentPrice: 51.09 } }), new Map()); assert.deepStrictEqual(r2.hard, []);   // no valuation figures at all
});
test('integrity check: a stock that HAS a valuation but no pillars.val is still a hard failure', () => {
  const r = C.fiCheck(chkList({ pillars: {} }), new Map());
  assert.strictEqual(r.hard.length, 1); assert.ok(/1 stocks with a non-numeric pillars\.val: C0/.test(r.hard[0]));
  const r2 = C.fiCheck(chkList({ pillars: { val: 'x' } }), new Map()); assert.ok(/non-numeric pillars\.val/.test(r2.hard[0]));
});
test('apply + check: a new ticker with a blank Intrinsic Value is added without a valuation anchor and passes the check', () => {
  const noIv = fundRow('NOIV', 'Alpha', 'Widgets', { 'Intrinsic Value': '', Graham: '' });
  const stocks = [];
  const res = F.applyFundamental(fundCsv([noIv, ...universe.slice(0, 11)]), stocks, '2026-10-10');
  const s = stocks.find(x => x.ticker.startsWith('NOIV'));
  assert.ok(s); assert.ok(res.onboarded.includes('NOIV')); assert.deepStrictEqual(s.pillars, {}); assert.ok(!(s.valuation.intrinsicValue > 0));
  assert.ok(!C.fiCheck(stocks.concat(chkList()), new Map()).hard.some(m => /pillars\.val/.test(m)));
});
const PM = load('src/prices/periodmove.js');
const istMs = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 330 * 60000;   // an India-time moment as epoch ms
test('period move: the week starts on Monday and the month on the 1st, India time', () => {
  const tue = istMs(2026, 10, 20, 14, 0);                                          // Tuesday 20 Oct, 14:00 IST
  assert.strictEqual(PM.periodStartSec('W', tue), istMs(2026, 10, 19, 0, 0) / 1000);
  assert.strictEqual(PM.periodStartSec('M', tue), istMs(2026, 10, 1, 0, 0) / 1000);
  assert.strictEqual(PM.periodStartSec('W', istMs(2026, 10, 19, 7, 30)), istMs(2026, 10, 19, 0, 0) / 1000);   // Monday before the open
  assert.strictEqual(PM.periodStartSec('W', istMs(2026, 10, 18, 10, 0)), istMs(2026, 10, 12, 0, 0) / 1000);   // Sunday: still the week that ended
  assert.strictEqual(PM.periodStartSec('W', istMs(2026, 10, 1, 9, 0)), istMs(2026, 9, 28, 0, 0) / 1000);     // the Monday can fall in the month before
});
test('period move: last week move needs the bar of last week bar', () => {
  const now = istMs(2026, 10, 21, 12, 0), ws = istMs(2026, 10, 19, 0, 0) / 1000, wk = 7 * 86400;
  const bars = [[ws - 2 * wk, 0, 0, 0, 100, 1], [ws - wk, 0, 0, 0, 90, 1], [ws + 3600, 0, 0, 0, 95, 1]];
  assert.strictEqual(PM.lastWeekMove(bars, now), -10);
  assert.strictEqual(PM.lastWeekMove(bars.slice(0, 1), now), null);                // last week's bar missing: stale, not guessed
  assert.strictEqual(PM.lastWeekMove(undefined, now), null);
});
test('period move: price against the last close before the period, ignoring the bar of the period itself', () => {
  const ws = istMs(2026, 10, 19, 0, 0) / 1000;
  const bars = [[ws - 14 * 86400, 0, 0, 0, 48.6, 1], [ws - 7 * 86400, 0, 0, 0, 51.72, 1], [ws + 3600, 0, 0, 0, 60, 1]];   // two finished weeks and this week's bar
  assert.strictEqual(PM.periodMove(55, bars, ws), 6.34);
  assert.strictEqual(PM.periodMove(51.72, bars, ws), 0);                           // a stock that did not trade this week: 0.00%, not last week's +6.42%
  assert.strictEqual(PM.periodMove(46.548, bars, ws), -10);
});
test('period move: a split or bonus (bars on another scale) falls back to TradingView\'s figure, nothing else does', () => {
  assert.strictEqual(PM.checkedMove(-80.13, 1.7), 1.7);                              // BANSALWIRE: saved bars from before the split
  assert.strictEqual(PM.checkedMove(-80.62, -3.08), -3.08);
  assert.strictEqual(PM.checkedMove(-45, -42), -45);                                 // a real big move: both agree, kept
  assert.strictEqual(PM.checkedMove(0, -13.04), 0);                                  // did not trade this period: TradingView shows its last candle, 0.00% is right
  assert.strictEqual(PM.checkedMove(-12, 3), -12);                                   // below the jump size
  assert.strictEqual(PM.checkedMove(-60, null), -60); assert.strictEqual(PM.checkedMove(-60, undefined), -60); assert.strictEqual(PM.checkedMove(-60, NaN), -60);
  assert.strictEqual(PM.checkedMove(null, 5), null);
  assert.strictEqual(PM.checkedMove(150, 2.4567), 2.46);
});
test('period move: the plotted bar of the period in progress follows the price, and never changes the saved bars', () => {
  const ws = istMs(2026, 10, 19, 0, 0) / 1000, wk = 7 * 86400;
  const saved = [[ws - 2 * wk + 33300, 48, 50, 47, 48.6, 10], [ws - wk + 33300, 49, 53, 48, 51.72, 20], [ws + 33300, 51.72, 55, 50, 52, 30]];   // the last bar is this week's, saved earlier
  const before = JSON.stringify(saved);
  const f = PM.followPrice(saved, 56, ws, 8 * 86400);                                         // price above the bar's high: close follows, high stretches
  assert.deepStrictEqual(f[2], [ws + 33300, 51.72, 56, 50, 56, 30]); assert.strictEqual(f.length, 3);
  assert.deepStrictEqual(PM.followPrice(saved, 49, ws, 8 * 86400)[2], [ws + 33300, 51.72, 55, 49, 49, 30]);   // below the low
  assert.strictEqual(JSON.stringify(saved), before);                               // a copy: the saved bars are untouched
  assert.strictEqual(PM.periodMove(56, f, ws), 8.28);                              // the plotted bar's move (56 / 51.72) is the same figure as the grid's
  const old = saved.slice(0, 2);                                                   // no bar for this week yet
  assert.strictEqual(PM.followPrice(old, 51.72, ws, 8 * 86400), old);                          // price unchanged: no trade, no bar
  const g = PM.followPrice(old, 53, ws, 8 * 86400); assert.strictEqual(g.length, 3); assert.deepStrictEqual(g[2], [ws + 33300, 51.72, 53, 51.72, 53, 0]);
  assert.strictEqual(old.length, 2);
  assert.strictEqual(PM.followPrice([], 50, ws, 8 * 86400).length, 0); assert.strictEqual(PM.followPrice(saved, 0, ws, 8 * 86400), saved); assert.strictEqual(PM.followPrice(undefined, 50, ws, 8 * 86400), undefined);
  const stale = [[ws - 4 * wk + 33300, 40, 42, 39, 41, 5], [ws - 3 * wk + 33300, 41, 44, 40, 43, 6]];      // last bar three weeks old: bars are stale, nothing is invented
  assert.strictEqual(PM.followPrice(stale, 60, ws, 8 * 86400), stale);
  assert.strictEqual(PM.followPrice(old, 53, ws, 8 * 86400).length, 3);                                    // the previous week's bar is within the gap
});
test('period move: nothing to report without a price or a bar before the period', () => {
  const ws = 1000;
  assert.strictEqual(PM.periodMove(50, [], ws), null); assert.strictEqual(PM.periodMove(50, undefined, ws), null);
  assert.strictEqual(PM.periodMove(50, [[2000, 0, 0, 0, 40, 1]], ws), null);       // only a bar of the period itself
  assert.strictEqual(PM.periodMove(0, [[500, 0, 0, 0, 40, 1]], ws), null); assert.strictEqual(PM.periodMove(NaN, [[500, 0, 0, 0, 40, 1]], ws), null);
  assert.strictEqual(PM.periodMove(50, [[500, 0, 0, 0, 0, 1], [600, 0, 0, 0, NaN, 1]], ws), null);               // closes that are not usable
});
test('apply: a stock in the file is active, one missing from it is marked inactive, and it comes back when it returns', () => {
  const stocks = [mkStock('KEEP', 'Widgets'), mkStock('GONE', 'Widgets', { active: undefined })];
  const keep = fundRow('KEEP', 'Alpha', 'Widgets');
  const res = F.applyFundamental(fundCsv([keep, ...universe.slice(0, 11)]), stocks, '2026-10-10');
  assert.strictEqual(stocks[0].active, undefined); assert.strictEqual(stocks[1].active, false);
  assert.deepStrictEqual(res.inactive, [stocks[1].ticker]);
  const again = F.applyFundamental(fundCsv([keep, fundRow('GONE', 'Alpha', 'Widgets'), ...universe.slice(0, 11)]), stocks, '2026-10-11');
  assert.strictEqual(stocks[1].active, undefined); assert.deepStrictEqual(again.inactive, []);
});
test('apply: BSE-only companies are onboarded under their BSE number and listed as such', () => {
  const stocks = []; const row = fundRow('', 'Alpha', 'Widgets', { 'NSE Code': '', 'BSE Code': '512345' });
  const res = F.applyFundamental(fundCsv([row, ...universe.slice(0, 11)]), stocks, '2026-10-10');
  assert.ok(res.bseOnly.includes('512345')); assert.ok(res.onboarded.includes('512345')); assert.strictEqual(stocks.find(s => s.ticker.startsWith('512345')).asof, '2026-10-10');
});
test('apply (known quirk): a listed company whose CSV row has no data is "re-scored" to 0.56 / avoid rather than left alone', () => {
  const bad = fundRow('BAD', 'Alpha', 'Widgets', Object.fromEntries(FUND_HEADER.filter(h => !/^(Name|BSE Code|NSE Code|ISIN Code|Industry|Industry Group)$/.test(h)).map(h => [h, ''])));
  const stocks = [mkStock('BAD', 'Widgets')];
  const res = F.applyFundamental(fundCsv([bad, ...universe.slice(0, 11)]), stocks, '2026-10-10');
  assert.strictEqual(res.rescored, 1); assert.strictEqual(stocks[0].score, 0.56); assert.strictEqual(stocks[0].verdict, 'avoid');
});
test('apply: an unclassified industry group in the file does not overwrite the stock\'s own group', () => {
  const stocks = [mkStock('UNC', 'Widgets')]; const rows = [fundRow('UNC', '', 'Widgets', { 'Industry Group': '' }), ...universe.slice(0, 11)];
  F.applyFundamental(fundCsv(rows), stocks, '2026-10-10'); assert.strictEqual(stocks[0].industryGroup, 'OldGroup');
});
test('apply: running the same file twice gives the same list', () => {
  const run = () => { const s = [mkStock('WID0', 'Widgets')]; F.applyFundamental(csv, s, '2026-10-10'); return s; };
  assert.deepStrictEqual(run(), run());
});
test('apply: bad files throw before anything is changed', () => {
  const stocks = [mkStock('WID0', 'Widgets')], before = JSON.parse(JSON.stringify(stocks));
  assert.throws(() => F.applyFundamental('not,a,csv\n', stocks, '2026-10-10')); assert.throws(() => F.applyFundamental('', stocks, '2026-10-10'));
  assert.deepStrictEqual(stocks, before);
});

// =========================================================== Analysis column sort (src/analysis/state.js)
{
  const S = load('src/analysis/state.js');
  test('sort: a saved column and direction are kept; an unknown column or direction falls back', () => {
    assert.deepStrictEqual(S.cleanSort('weekRsi', 'asc', null, { col: 'mos', dir: 'desc' }), { col: 'weekRsi', dir: 'asc' });
    assert.deepStrictEqual(S.cleanSort('weekRsi', 'sideways', null, { col: 'mos', dir: 'desc' }), { col: 'weekRsi', dir: 'desc' });
    assert.deepStrictEqual(S.cleanSort('nope', 'asc', null, { col: 'mos', dir: 'desc' }), { col: 'mos', dir: 'desc' });
    assert.deepStrictEqual(S.cleanSort(undefined, undefined, undefined, { col: 'mos', dir: 'desc' }), { col: 'mos', dir: 'desc' });
  });
  test('sort: every reading of the old Sort by menu maps to a column and direction', () => {
    const old = { mos_desc: ['mos', 'desc'], mos_asc: ['mos', 'asc'], score_desc: ['score', 'desc'], weekRsi_desc: ['weekRsi', 'desc'], weekRsi_asc: ['weekRsi', 'asc'], monthRsi_desc: ['monthRsi', 'desc'], monthRsi_asc: ['monthRsi', 'asc'], weekChg_desc: ['weekChg', 'desc'], monthChg_desc: ['monthChg', 'desc'], price_desc: ['price', 'desc'], research_old: ['triggered', 'desc'], research_new: ['triggered', 'asc'], name_asc: ['stock', 'asc'] };
    Object.keys(old).forEach(k => assert.deepStrictEqual(S.cleanSort(undefined, undefined, k, null), { col: old[k][0], dir: old[k][1] }, k));
    assert.strictEqual(S.cleanSort(undefined, undefined, 'bogus_desc', null), null);
  });
}

// =========================================================== Analysis "View" (src/analysis/state.js)
{
  // What the screen starts with when the saved filters are loaded: a saved View is kept, a "Group by" saved before v1.276 becomes the same kind of industry view, anything else is Stocks.
  const viewFor = (saved) => {
    const had = Object.prototype.hasOwnProperty.call(global, 'localStorage'), old = global.localStorage;
    global.localStorage = { getItem: () => saved === undefined ? null : JSON.stringify(saved), setItem(){}, removeItem(){} };
    try { return load('src/analysis/state.js').analysisFilters.view; } finally { if(had) global.localStorage = old; else delete global.localStorage; }
  };
  test('view: nothing saved starts on Stocks', () => { assert.strictEqual(viewFor(undefined), 'stocks'); });
  test('view: a saved View is kept', () => { assert.strictEqual(viewFor({ view: 'group' }), 'group'); assert.strictEqual(viewFor({ view: 'industry' }), 'industry'); });
  test('view: a Group by saved before v1.276 becomes the matching industry view', () => {
    assert.strictEqual(viewFor({ groupBy: 'industry' }), 'industry'); assert.strictEqual(viewFor({ groupBy: 'group' }), 'group'); assert.strictEqual(viewFor({ groupBy: 'none' }), 'stocks');
  });
  test('view: an unknown value falls back to Stocks', () => { assert.strictEqual(viewFor({ view: 'bogus', groupBy: 'bogus' }), 'stocks'); });
}

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
  F.applyFundamental(fundCsv(universe.slice(0, 14)), stocks, '2026-10-14');
  const dcf = stocks[0].fundamentals.factors.find(f => f.key === 'dcf');
  assert.strictEqual(stocks[0].pillars.val, Math.round(dcf.score * 10 * 10) / 10);
  // no intrinsic value in the file: the old anchor is kept rather than overwritten with 0
  const rows = universe.slice(0, 14).map(r => Object.assign({}, r)); rows[0]['Intrinsic Value'] = '';
  const s2 = [mkStock('WID0', 'Widgets', { pillars: { val: 4 } })];
  F.applyFundamental(fundCsv(rows), s2, '2026-10-14');
  assert.strictEqual(s2[0].pillars.val, 4);
});
{
  const FS = load('src/core/fundscore.js');
  const fac = (key, category, weight, score, extra) => Object.assign({ key, category, weight, score, name: key, metrics: [['x', '1']], note: '' }, extra || {});
  test('fix: a factor with no data (stored as 0) counts as neutral, not left out and not worst', () => {
    const mk = z => ({ fundamentals: { factors: [fac('fin', 'Traditional', 1, 0.8), fac('dcf', 'Valuation', 1, z)], total: 10 }, score: 0 });
    const s = mk(0); FS.applyFundamentalConfidence(s);
    assert.strictEqual(s.fundamentals.factors[1].excluded, 'not enough data to score this factor'); assert.strictEqual(s.score, 6.5);
    const t = mk(0.2); FS.applyFundamentalConfidence(t);   // a genuinely low score still counts
    assert.strictEqual(t.fundamentals.factors[1].excluded, undefined); assert.strictEqual(t.score, 5);
  });
  test('fix: the data integrity check recomputes the same score, neutral factors included', () => {
    const s = { fundamentals: { factors: [fac('fin', 'Traditional', 1, 0.8), fac('dcf', 'Valuation', 1, 0)], total: 10 }, score: 0 }; FS.applyFundamentalConfidence(s);
    assert.strictEqual(s.score, 6.5); assert.strictEqual(FS.expectedScore(s.fundamentals.factors), s.score);
  });
}
test('fix: a flat price series has no RSI (not 100)', () => {
  const TECH = load('src/engine/technical.js');
  const flat = Array.from({ length: 40 }, (_, i) => [i, 10, 10, 10, 10, 0]);
  const rising = Array.from({ length: 40 }, (_, i) => [i, 10 + i, 10 + i, 10 + i, 10 + i, 0]);
  assert.strictEqual(TECH.computeTechnical(flat, flat, 5, '2026-10-14').raw.weekRsi, null);
  assert.strictEqual(TECH.computeTechnical(rising, rising, 5, '2026-10-14').raw.weekRsi, 100);
});
test('fix: a 4/10 valuation is called "fully valued"', () => {
  const TECH = load('src/engine/technical.js', 'export { techValLabel as valLabel };');
  assert.strictEqual(TECH.valLabel(4), 'fully valued'); assert.strictEqual(TECH.valLabel(3.9), 'expensive / stretched valuation');
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
// ---- v1.182: refresh from TradingView (snapshot readings, no bars) ----
test('v1.182: a TradingView snapshot is scored by the engine rules and is marked as a snapshot', () => {
  const TECH = load('src/engine/technical.js');
  const r = { monthMacdLevel: 20.5, monthMacdSignal: 16.8, weekMacdLevel: 8.6, weekMacdSignal: 8.5, monthRsi: 62.7, weekRsi: 58.7, weekPctChange: 3.45, monthPctChange: 3.58 };
  const t = TECH.snapshotTechnical(r, 6, '2026-10-15');
  assert.strictEqual(t.score, 9.2);   // 2.5 + 1.5 + 2 + 2 + 1.2 over a weight of 10
   assert.strictEqual(t.states.monthMacd, 'bull_above'); assert.strictEqual(t.states.weekRsi, 'strong');
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

// ---- v1.258: Technical Score 3 = the Technical Score without the valuation point ----
test('v1.258: Tech 3 ignores the valuation pillar; the Tech score does not', () => {
  const TECH = load('src/engine/technical.js');
  const r = { monthMacdLevel: 5, monthMacdSignal: 3, weekMacdLevel: 5, weekMacdSignal: 3, monthRsi: 20, weekRsi: 20 };   // both MACDs bullish above zero, both RSIs oversold
  const rich = TECH.snapshotTechnical(r, 10, '2026-10-24'), poor = TECH.snapshotTechnical(r, 0, '2026-10-24');
  assert.strictEqual(rich.score, 6); assert.strictEqual(poor.score, 4);   // the Tech score moves with valuation: (4 + 2) / 10 and 4 / 10
  assert.strictEqual(TECH.techScore3(rich), 5); assert.strictEqual(TECH.techScore3(poor), 5);   // 4 / 8: the same either way
  assert.strictEqual(TECH.techScore3(Object.assign({}, rich, { states: Object.assign({}, rich.states, { valuation: null }) })), 5);
});
test('v1.258: Tech 3 leaves out a missing component and rescales; with no reading it has no score', () => {
  const TECH = load('src/engine/technical.js');
  assert.strictEqual(TECH.techScore3({ states: { weekRsi: 'strong' } }), 10);   // 2 of 2
  assert.strictEqual(TECH.techScore3({ states: { monthMacd: 'bull_above', weekRsi: 'oversold' } }), 5.56);   // (2.5 + 0) of (2.5 + 2.0) = 5.56 out of 10
  assert.strictEqual(TECH.techScore3({ states: { valuation: 'attractively valued' } }), null);   // a valuation label alone is no technical reading
  assert.strictEqual(TECH.techScore3({ score: 7 }), null); assert.strictEqual(TECH.techScore3(null), null);
});

// ---- v1.259: MACD for every bar, for the price charts ----
{
  const closes = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.4);
  test('v1.259: the MACD series ends on the same figures as the saved MACD state, and needs 35 bars', () => {
    const TECH = load('src/engine/technical.js', 'export { techMacd };');
    const s = TECH.techMacdSeries(closes), last = TECH.techMacd(closes);
    assert.strictEqual(s.macd.length, 80); assert.strictEqual(s.signal.length, 80); assert.strictEqual(s.from, 33);
    assert.strictEqual(s.macd[79], last.level); assert.strictEqual(s.signal[79], last.signal);
    assert.ok(Math.abs(s.hist[79] - (last.level - last.signal)) < 1e-12);
    assert.strictEqual(TECH.techMacdSeries(closes.slice(0, 34)), null); assert.notStrictEqual(TECH.techMacdSeries(closes.slice(0, 35)), null);
    assert.strictEqual(TECH.techMacdSeries(null), null);
  });
  test('v1.259: a bar\'s MACD does not depend on later bars (no look-ahead)', () => {
    const TECH = load('src/engine/technical.js', 'export { techMacd };');
    const s = TECH.techMacdSeries(closes);
    for(const i of [34, 40, 55, 79]){ const p = TECH.techMacd(closes.slice(0, i + 1)); assert.strictEqual(s.macd[i], p.level); assert.strictEqual(s.signal[i], p.signal); }
  });
}

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
const goldenFile = path.join(__dirname, 'engines.golden.json');
if(process.argv.includes('--update')){ fs.writeFileSync(goldenFile, JSON.stringify(golden, null, 1) + '\n'); console.log('engines.golden.json updated (' + Object.keys(golden).length + ' entries)'); }
test('golden: the scores for the made-up universe have not moved', () => {
  const want = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  const moved = Object.keys(Object.assign({}, want, golden)).filter(k => JSON.stringify(want[k]) !== JSON.stringify(golden[k]));
  assert.strictEqual(moved.length, 0, moved.length + ' entries differ (e.g. ' + moved.slice(0, 3).join(', ') + '); if intended run: node tests/engines.js --update');
});

// =========================================================== saved text is never drawn as markup
test('escaping: safeText turns raw < and > into text and never escapes twice', () => {
  const U = load('src/core/util.js');
  assert.strictEqual(U.safeText('<b>a</b> &amp; &lt;x'), '&lt;b&gt;a&lt;/b&gt; &amp; &lt;x');
  assert.strictEqual(U.safeText(null), '');
});

// =========================================================== score history (recorded by each import)
const H = load('src/history/scorehistory.js', 'export { BUCKETS, SCORE_ENGINE, addPoint, bucketId, bucketOf, pointFor, tickerKey };');
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
const I = load('src/tradelog/ideacall.js', 'export { fiiNote };');
const NW = load('src/tradelog/nextweek.js', 'export { weekFeatures, modelProb };');
const idea = (o) => ({ name: 'X', score: 7.2, verdict: 'buy', valuation: { currentPrice: 100, intrinsicValue: 160 }, ...o });
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'nextweek-fixture.json'), 'utf8'));
const FEATURES = ['r1', 'r2', 'r4', 'r8', 'r13', 'r26', 'r52', 'vol8', 'vol26', 'dhi52', 'dlo52', 'rngpos', 'rsi', 'macdh', 'volr', 'sma10d', 'sma40d'];
// Weekly bars [t,o,h,l,c,v] (t = unix seconds, Monday 2026-01-05 onwards) from a list of closes.
const barsOf = (closes) => closes.map((c, i) => [Date.UTC(2026, 0, 5 + 7 * i) / 1000, c, c * 1.01, c * 0.99, c, 1e6]);
test('next week (v1.289): the in-app features and score match the Python that trained the model, for five real stocks', () => {
  assert.strictEqual(FIXTURE.length, 5);
  for(const o of FIXTURE){
    const w = NW.weekFeatures(o.bars);
    assert.ok(w, 'features computed');
    FEATURES.forEach((k, i) => assert.ok(Math.abs(w.x[i] - o.features[k]) <= 1e-9 * (Math.abs(o.features[k]) + 1e-9), k + ' differs: ' + w.x[i] + ' vs ' + o.features[k]));
    assert.ok(Math.abs(w.turn - o.features.turn) <= 1e-9 * o.features.turn, 'weekly traded value');
    assert.ok(Math.abs(NW.modelProb(w.x) - o.p) < 1e-9, 'score ' + NW.modelProb(w.x) + ' vs ' + o.p);
  }
});
test('next week (v1.289): the ranking among a strategy\'s stocks, thin flag and too-little-history are handled; the forming week is left out', () => {
  const rr = NW.rankReads([{ p: 0.5 }, { p: 0.7 }, null, { p: 0.4 }, { p: 0.6 }], ['up', 'up', 'up', 'up', 'up']);
  assert.deepStrictEqual(rr.map(x => x && x.pct), [100 / 3, 100, null, 0, 200 / 3], 'rank among the four scored stocks, lowest 0 and highest 100');
  const two = NW.rankReads([{ p: 0.5 }, { p: 0.7 }, { p: 0.4 }, { p: 0.6 }, { p: 0.9 }], ['up', 'down', 'up', 'down', 'mixed']);
  assert.deepStrictEqual(two.slice(0, 4).map(x => x.pct), [100, 100, 0, 0], 'each stock is ranked only against stocks of its own trend');
  assert.strictEqual(two[4].pct, undefined, 'a mixed trend has no rank'); assert.strictEqual(two[4].trend, 'mixed');
  assert.ok(two[0].base > two[1].base, 'the Upward base rate is higher than the Downward one');
  assert.strictEqual(rr[1].topPct, 1); assert.strictEqual(rr[3].topPct, 100);
  assert.ok(rr[1].up > rr[3].up && rr[1].beat > rr[3].beat, 'the top band rose and beat the median more often than the bottom one in the tests');
  assert.strictEqual(NW.rankReads([{ p: 0.5 }], ['up'])[0].pct, 50, 'one stock alone has no rank'); assert.deepStrictEqual(NW.rankReads([null], ['up']), [null]);
  const walk = Array.from({ length: 100 }, (_, i) => 100 + 10 * Math.sin(i / 3) + i * 0.2);
  const SAT = '2028-06-03';
  const r = load('src/tradelog/nextweek.js').nextWeekRead(barsOf(walk), SAT);
  assert.ok(r && r.p > 0 && r.p < 1 && typeof r.facts.fromHigh === 'number');
  assert.strictEqual(r.thin, false, 'a traded value of crores is not thin');
  const thin = load('src/tradelog/nextweek.js').nextWeekRead(barsOf(walk).map(b => b.slice(0, 5).concat([10])), SAT);
  assert.strictEqual(thin.thin, true);
  assert.strictEqual(load('src/tradelog/nextweek.js').nextWeekRead(barsOf(walk.slice(0, 70)), SAT), null, 'fewer than 80 weeks gives no reading');
  assert.strictEqual(load('src/tradelog/nextweek.js').nextWeekRead(null, SAT), null);
  const bars = barsOf(walk), forming = bars.concat([[Date.UTC(2026, 0, 5 + 7 * bars.length) / 1000, 40, 41, 39, 40, 1e6]]);
  const wed = new Date(Date.UTC(2026, 0, 5 + 7 * bars.length) + 2 * 86400000).toISOString().slice(0, 10);
  const thu = new Date(Date.UTC(2026, 0, 5 + 7 * bars.length) + 3 * 86400000).toISOString().slice(0, 10), sat = new Date(Date.UTC(2026, 0, 5 + 7 * bars.length) + 5 * 86400000).toISOString().slice(0, 10);
  const rThu = load('src/tradelog/nextweek.js').nextWeekRead(forming, thu), rWed = load('src/tradelog/nextweek.js').nextWeekRead(forming, wed), rSat = load('src/tradelog/nextweek.js').nextWeekRead(forming, sat);
  assert.strictEqual(rWed.partial, true, 'on any weekday the week so far is used (as of today)'); assert.strictEqual(rThu.partial, true);
  assert.notStrictEqual(rWed.p, load('src/tradelog/nextweek.js').nextWeekRead(bars, wed).p, 'the week so far moves the score');
  assert.strictEqual(rSat.partial, false, 'from Saturday the week is finished and counts as it is'); assert.strictEqual(rSat.p, rThu.p, 'the finished week counts the same as the week so far when no more days are added');
});
// A reading as nextWeekRead returns it, for the call rules.
const nwr = (pct, o) => ({ p: 0.4 + pct / 400, pct, topPct: Math.max(1, Math.round(100 - pct)), trend: 'up', base: 50.7, up: 40 + pct / 5, beat: 45 + pct / 8, turn: 5e7, thin: false, facts: { week: 2, month: 4, half: 12, fromHigh: -8, swing: 5 }, ...o });
const TODAY = '2026-10-28';
test('ideas (v1.289): Buy is the top 10% of two-week scores, Avoid the bottom 10%, Wait the rest; no reading is Wait', () => {
  assert.strictEqual(I.ideaCall(idea({}), null, nwr(95), TODAY).call, 'buy');
  assert.strictEqual(I.ideaCall(idea({}), null, nwr(90), TODAY).call, 'buy', 'the edge itself is a Buy');
  assert.strictEqual(I.ideaCall(idea({}), null, nwr(89), TODAY).call, 'hold');
  assert.strictEqual(I.ideaCall(idea({}), null, nwr(50), TODAY).call, 'hold');
  assert.strictEqual(I.ideaCall(idea({}), null, nwr(10), TODAY).call, 'sell');
  assert.strictEqual(I.ideaCall(idea({}), null, nwr(11), TODAY).call, 'hold');
  const b = I.ideaCall(idea({}), null, nwr(97), TODAY);
  assert.strictEqual(b.label, 'Buy'); assert.strictEqual(b.reasons[0], 'Top 3% of the Upward stocks in this strategy today');
  assert.ok(/^In 5 years of tests, stocks ranked like this were higher after 2 weeks \d+% of the time \(all Upward stocks: 51%\)$/.test(b.reasons[1]), b.reasons[1]);
  assert.ok(b.reasons.some(x => x === 'Priced 38% below its fair value'), 'the margin of safety in plain words'); assert.ok(b.reasons.every(x => x.length < 130), 'each line is short: ' + b.reasons.map(x => x.length));
  assert.ok(b.reasons.some(x => x === 'Price: last week +2.0%, 4 weeks +4.0%, 26 weeks +12.0%') && b.reasons.includes('8% below its 52-week high'));
  const none = I.ideaCall(idea({}), null, null, TODAY); assert.strictEqual(none.call, 'hold'); assert.ok(/no weekly price history/.test(none.reasons[0]));
  const q = (o) => I.ideaCall(idea(o), null, nwr(95), TODAY);
  const av = q({ verdict: 'avoid', score: 3 });
  assert.strictEqual(av.call, 'hold'); assert.ok(av.reasons.includes('held back: its Fundamental verdict is Avoid'));
  const rich = q({ valuation: { currentPrice: 120, intrinsicValue: 100 } });
  assert.strictEqual(rich.call, 'hold'); assert.ok(rich.reasons.some(x => /held back: it trades at or above fair value \(margin of safety -20\.0%\)/.test(x)));
  assert.strictEqual(q({ valuation: { currentPrice: 100, intrinsicValue: 100 } }).call, 'hold', 'a margin of safety of exactly zero is not above zero');
  assert.strictEqual(q({ verdict: 'hold', score: 5.2 }).call, 'buy', 'a Hold verdict is fine; only Avoid is held back');
  assert.strictEqual(q({ valuation: {} }).call, 'buy', 'no intrinsic value saved: the margin-of-safety check is skipped');
  assert.strictEqual(I.ideaCall(idea({ verdict: 'avoid', valuation: { currentPrice: 200, intrinsicValue: 100 } }), null, nwr(5), TODAY).call, 'sell', 'the bottom of the ranking is Avoid whatever the quality');
});
test('ideas (v1.289): quality, results within 7 days, very thin trading and clearly negative news hold a Buy back; missing figures never do', () => {
  const held = (o) => I.ideaCall(idea(o), null, nwr(95), TODAY);
  const r2 = held({ liquidity: { nextResults: '2026-10-30' } });
  assert.strictEqual(r2.call, 'hold'); assert.ok(r2.reasons.includes('held back: results due in 2 days (2026-10-30)'));
  assert.ok(held({ liquidity: { nextResults: '2026-10-28' } }).reasons.some(x => /results due today/.test(x)));
  assert.strictEqual(held({ liquidity: { nextResults: '2026-11-04' } }).call, 'hold', 'seven days is still inside the window');
  assert.strictEqual(held({ liquidity: { nextResults: '2026-11-05' } }).call, 'buy', 'eight days out is not');
  assert.strictEqual(held({ liquidity: { nextResults: '2026-10-20' } }).call, 'buy', 'a date already past is ignored');
  assert.strictEqual(I.ideaCall(idea({ liquidity: { nextResults: '2026-10-30' } }), null, nwr(95), undefined).call, 'buy', 'without today the date check is skipped');
  const thin = held({ liquidity: { avgVolume: 10000 } });   // 10,000 shares at 100 = 10 lakh a day
  assert.strictEqual(thin.call, 'hold'); assert.ok(thin.reasons.some(x => /held back: very thin trading/.test(x)));
  assert.strictEqual(held({ liquidity: { avgVolume: 100000 } }).call, 'buy', '1 crore a day is not thin');
  const day = new Date().toISOString().slice(0, 10), ev = (...ss) => ss.map((x, i) => ({ k: 'news', d: day, t: 'n' + i, s: x }));
  const neg = held({ __events: ev('neg', 'neg', 'pos') });
  assert.strictEqual(neg.call, 'hold'); assert.ok(neg.reasons.some(x => /held back: recent news leans negative \(2 negative, 1 positive\)/.test(x)));
  assert.strictEqual(held({ __events: ev('neg', 'neg', 'pos', 'pos') }).call, 'buy', 'level news counts for nothing');
  assert.strictEqual(held({ __events: ev('neg') }).call, 'buy', 'one item is not enough');
  const pos = held({ __events: ev('pos', 'pos') }); assert.strictEqual(pos.call, 'buy'); assert.ok(pos.reasons.some(x => /news is positive/.test(x)));
  assert.strictEqual(held({}).call, 'buy', 'no figures saved yet: nothing to hold it back');
  assert.strictEqual(I.ideaCall(idea({ liquidity: { nextResults: '2026-10-30' } }), null, nwr(50), TODAY).reasons.some(x => /held back/.test(x)), false, 'only a would-be Buy is told it was held back');
  const cap = (cr) => I.ideaCall(idea({ liquidity: { marketCap: cr } }), null, nwr(95), TODAY);
  assert.strictEqual(cap(150000).cap, 'large'); assert.strictEqual(cap(50000).cap, 'mid'); assert.strictEqual(cap(14000).cap, 'small');
  assert.strictEqual(cap(14000).cap, 'small'); assert.strictEqual(I.ideaCall(idea({}), null, nwr(95), TODAY).cap, null);
  assert.ok(I.ideaCall(idea({}), null, nwr(95, { thin: true }), TODAY).reasons.some(x => /Trades thinly/.test(x)));
});
test('ideas (v1.289): a stock you hold keeps its trade call and is never gated', () => {
  const tr = { buy: { price: 100, snapshot: { score: 7.2 } } };
  assert.strictEqual(I.ideaCall(idea({ valuation: { currentPrice: 102, intrinsicValue: 160 }, technical: { raw: { weekRsi: 55, monthRsi: 60 } } }), tr, nwr(5), TODAY).label, 'Add more');
  assert.strictEqual(I.ideaCall(idea({ valuation: { currentPrice: 150, intrinsicValue: 300 }, technical: { raw: { weekRsi: 85, monthRsi: 80 } } }), tr, nwr(95), TODAY).call, 'sell');
  const h = I.ideaCall(idea({ liquidity: { nextResults: '2026-10-30' } }), tr, nwr(95), TODAY);
  assert.strictEqual(h.held, true); assert.ok(!h.reasons.some(x => /held back/.test(x)));
  assert.strictEqual(I.ideaCall(idea({}), tr, null).held, true);
});
test('ideas (v1.289): ranking is Buy, then Wait, then Avoid; the highest score leads Buy and Wait, the lowest leads Avoid; a stock with no score goes last', () => {
  const mk = (n, call, p) => ({ s: { name: n }, c: { call, p } });
  const r = I.rankIdeas([mk('a', 'sell', 0.4), mk('b', 'hold', 0.5), mk('c', 'buy', 0.55), mk('d', 'buy', 0.6), mk('e', 'sell', 0.35), mk('f', 'hold', null), mk('g', 'hold', 0.52), mk('h', 'sell', null)]).map(x => x.s.name).join('');
  assert.strictEqual(r, 'dcgbfeah');
  const mt = (n, call, trend, held) => ({ s: { name: n }, c: { call, trend, held } });
  const list = [mt('a', 'buy', 'up'), mt('b', 'buy', 'up', true), mt('c', 'hold', 'up'), mt('d', 'buy', 'up'), mt('e', 'buy', 'up'), mt('f', 'buy', 'up'), mt('g', 'buy', 'up'), mt('h', 'buy', 'up'), mt('i', 'buy', 'down'), mt('j', 'buy', 'down')];
  assert.strictEqual(I.topBuys(list, 'up').map(x => x.s.name).join(''), 'adefg', 'five Buys of the trend, skipping stocks you hold and non-Buys, in the order given');
  assert.strictEqual(I.topBuys(list, 'down').map(x => x.s.name).join(''), 'ij', 'the Downward list has its own Buys');
  assert.strictEqual(I.topBuys(list, 'up', 2).length, 2); assert.strictEqual(I.topBuys([], 'up').length, 0);
});
test('ideas (v1.289): the trend comes from weekly and monthly MACD; a mixed or unknown trend is never a Buy; a Downward Buy says it is a bounce', () => {
  const t = (wl, ws, ml, ms) => ({ technical: { raw: { weekMacdLevel: wl, weekMacdSignal: ws, monthMacdLevel: ml, monthMacdSignal: ms } } });
  assert.strictEqual(I.trendOf(t(2, 1, 5, 4)), 'up'); assert.strictEqual(I.trendOf(t(1, 2, 4, 5)), 'down');
  assert.strictEqual(I.trendOf(t(2, 1, 4, 5)), 'mixed'); assert.strictEqual(I.trendOf(t(1, 2, 5, 4)), 'mixed');
  assert.strictEqual(I.trendOf(t(1, 1, 4, 5)), 'mixed', 'level equal to signal is neither up nor down');
  assert.strictEqual(I.trendOf(t(null, 1, 4, 5)), null); assert.strictEqual(I.trendOf({}), null); assert.strictEqual(I.trendOf(null), null);
  const mixed = I.ideaCall(idea({}), null, nwr(97, { trend: 'mixed', up: undefined, beat: undefined }), TODAY);
  assert.strictEqual(mixed.call, 'hold'); assert.ok(mixed.reasons.some(x => /disagree/.test(x)));
  const unk = I.ideaCall(idea({}), null, nwr(97, { trend: null }), TODAY);
  assert.strictEqual(unk.call, 'hold'); assert.ok(unk.reasons.some(x => /trend is unknown/.test(x)));
  const down = I.ideaCall(idea({}), null, nwr(97, { trend: 'down', base: 45.3 }), TODAY);
  assert.strictEqual(down.call, 'buy'); assert.ok(down.reasons.some(x => /Bounce-back pick/.test(x)) && /Downward stocks/.test(down.reasons[1]));
  assert.strictEqual(down.trend, 'down');
});
test('ideas (v1.289): FII selling or buying last quarter is a note, never a block; it needs 0.5 points and 10% of the earlier holding', () => {
  const v = (h, c, c3) => ({ valuation: { fiiHolding: h, fiiChange: c, fiiChange3: c3 } });
  assert.strictEqual(I.fiiNote(v(5.86, -1.17, 2.96)), 'FII selling: holding down 1.2 points last quarter (7.0% to 5.9%)');
  assert.ok(/down over 3 years too/.test(I.fiiNote(v(5.86, -1.17, -3))));
  assert.ok(/^FII buying: holding up 1.2 points last quarter \(8.8% to 10.0%\), up over 3 years too/.test(I.fiiNote(v(10, 1.2, 2))));
  assert.strictEqual(I.fiiNote(v(19.65, 1.57, 2)), null, '1.57 points of 18.1 is under 10%');
  assert.strictEqual(I.fiiNote(v(55.65, 0.9, 1)), null, '0.9 points of 54.7 is under 10%');
  assert.strictEqual(I.fiiNote(v(0.71, -0.18, 0)), null, 'under 0.5 points');
  assert.ok(I.fiiNote(v(3, -0.5, 0)), 'the edge counts'); assert.strictEqual(I.fiiNote(v(5, null, 0)), null); assert.strictEqual(I.fiiNote({}), null); assert.strictEqual(I.fiiNote(v(1, 1, 0)), null, 'nothing was held before');
  const c = I.ideaCall(idea({ valuation: { currentPrice: 100, intrinsicValue: 120, fiiHolding: 5.86, fiiChange: -1.17 } }), null, nwr(97, { trend: 'down', base: 45.3 }), TODAY);
  assert.strictEqual(c.call, 'buy', 'FII selling does not hold a Buy back'); assert.ok(c.reasons.some(x => /FII selling/.test(x)));
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
  test('live snapshot: market cap comes back in rupees crore, next to the volume (v1.286)', () => {
    const withCap = Object.assign({}, tv, { market_cap_basic: 15000000000 });
    const d = L.mergedDoc(stock, undefined, { row: { k: 'ABC', y: 'NSE:ABC', c: L.packValues(withCap) }, asof: '2026-10-14', at: '2026-10-14T10:00:00.000Z' });
    assert.strictEqual(d.liquidity.marketCap, 1500, '1,500 crore');
    assert.strictEqual(d.liquidity.avgVolume, 50000);
    const row = (o) => ({ row: { k: 'ABC', y: 'NSE:ABC', c: L.packValues(Object.assign({ close: 10 }, o)) }, asof: '2026-10-14', at: '2026-10-14T10:00:00.000Z' });
    assert.strictEqual(L.mergedDoc(stock, undefined, row({ market_cap_basic: 0 })).liquidity, undefined, 'no cap and no volume gives nothing');
    assert.deepStrictEqual(L.mergedDoc(stock, undefined, row({ market_cap_basic: 20000000 })).liquidity, { marketCap: 2, asof: '2026-10-14' }, 'a cap alone is kept');
    assert.strictEqual(L.mergedDoc(stock, undefined, snap()).liquidity.marketCap, undefined, 'a row saved before v1.286 has no market cap');
  });
  test('live snapshot: the next results date comes back as an India-time date (v1.287)', () => {
    const d = L.mergedDoc(stock, undefined, { row: { k: 'ABC', y: 'NSE:ABC', c: L.packValues(Object.assign({}, tv, { earnings_release_next_date: 1793361600 })) }, asof: '2026-10-14', at: '2026-10-14T10:00:00.000Z' });
    assert.strictEqual(d.liquidity.nextResults, '2026-10-30');
    assert.strictEqual(L.mergedDoc(stock, undefined, snap()).liquidity.nextResults, undefined, 'a row without it has none');
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
  const H = load('src/refresh/historyplan.js', 'export { barsNeeded };');
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
  // bars from the batch call (v1.206): real CASTROL figures, week of 12 Oct finished and week of 19 Oct in progress
  const WK = c => ({ o: c[0], h: c[1], l: c[2], c: c[3], v: c[4] });
  const row = (cur, prev, kind) => { const k = kind === 'W' ? '1W' : '1M', r = {}; ['open', 'high', 'low', 'close', 'volume'].forEach((n, i) => { r[n + '|' + k] = cur[i]; r[n + '[1]|' + k] = prev[i]; }); return r; };
  test('batch bars: a saved bar that has finished is replaced and the new week is added', () => {
    const t1 = at('2026-10-12T03:45:00Z'), now = at('2026-10-20T04:00:00Z');
    const stored = [[at('2026-10-05T03:45:00Z'), 199.05, 201.5, 193.59, 194.67, 10286701], [t1, 196.6, 197, 195, 196, 5000000]];
    const r = row([197.69, 199.72, 196.05, 196.79, 2266126], [196.6, 198.93, 192.8, 197.74, 9274407], 'W');
    const out = H.alignBars(stored, H.batchBars(r, 'W'), 'W', now);
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out[1], [t1, 196.6, 198.93, 192.8, 197.74, 9274407], 'the saved bar takes the finished figures and keeps its own time');
    assert.deepStrictEqual(out[2], [H.weekStartS(now) + 33300, 197.69, 199.72, 196.05, 196.79, 2266126]);
  });
  test('batch bars: the bar in progress is refreshed in place', () => {
    const t = at('2026-10-19T03:45:00Z'), now = at('2026-10-20T04:00:00Z');
    const stored = [[at('2026-10-12T03:45:00Z'), 196.6, 198.93, 192.8, 197.74, 9274407], [t, 197.69, 198, 196.5, 197, 1000]];
    const r = row([197.69, 199.72, 196.05, 196.79, 2266126], [196.6, 198.93, 192.8, 197.74, 9274407], 'W');
    const out = H.alignBars(stored, H.batchBars(r, 'W'), 'W', now);
    assert.strictEqual(out.length, 2); assert.deepStrictEqual(out[1], [t, 197.69, 199.72, 196.05, 196.79, 2266126]);
  });
  test('batch bars: before the new week has a bar, the newest bar stays the saved one', () => {
    const t = at('2026-10-12T03:45:00Z'), now = at('2026-10-19T02:00:00Z');   // Monday before the open
    const stored = [[at('2026-10-05T03:45:00Z'), 199.05, 201.5, 193.59, 194.67, 10286701], [t, 196.6, 197, 195, 196, 5000000]];
    const r = row([196.6, 198.93, 192.8, 197.74, 9274407], [199.05, 201.5, 193.59, 194.67, 10286701], 'W');
    const out = H.alignBars(stored, H.batchBars(r, 'W'), 'W', now);
    assert.strictEqual(out.length, 2); assert.deepStrictEqual(out[1], [t, 196.6, 198.93, 192.8, 197.74, 9274407]);
  });
  test('batch bars: monthly bars follow the month', () => {
    const t = at('2026-09-01T03:45:00Z'), now = at('2026-10-20T04:00:00Z');
    const stored = [[at('2026-08-03T03:45:00Z'), 185.54, 195, 184.1, 184.49, 68127746], [t, 184.74, 190, 184.2, 189, 3000000]];
    const r = row([200.31, 201.5, 192.8, 196.79, 24652464], [184.74, 203.4, 184.2, 200.52, 75200472], 'M');
    const out = H.alignBars(stored, H.batchBars(r, 'M'), 'M', now);
    assert.strictEqual(out.length, 3); assert.strictEqual(out[1][4], 200.52); assert.strictEqual(out[2][1], 200.31);
  });
  test('batch bars: a stock that did not trade this week keeps its newest bar (real AMALGAM figures)', () => {
    const now = at('2026-10-20T04:00:00Z');
    const stored = [[at('2026-09-28T03:45:00Z'), 136.5, 136.5, 134.5, 134.5, 10], [at('2026-10-05T03:45:00Z'), 133.2, 133.2, 133.2, 133.2, 15], [at('2026-10-12T03:45:00Z'), 131.9, 131.9, 131.9, 131.9, 4824]];
    const r = row([131.9, 131.9, 131.9, 131.9, 4824], [133.2, 133.2, 133.2, 133.2, 30], 'W');   // TradingView's current bar is still the week of 12 Oct: no bar for this week exists
    const out = H.alignBars(stored, H.batchBars(r, 'W'), 'W', now);
    assert.strictEqual(out.length, 3); assert.deepStrictEqual(out[2], [stored[2][0], 131.9, 131.9, 131.9, 131.9, 4824]);
  });
  test('batch bars: a saved week that only looks like the current one is not overwritten', () => {
    // the saved newest bar opens at 131.9 and TradingView's current bar also opens at 131.9, but its previous bar (133.2) is not the bar saved before
    const now = at('2026-10-20T04:00:00Z');
    const stored = [[at('2026-10-05T03:45:00Z'), 140, 141, 139, 140.5, 20], [at('2026-10-12T03:45:00Z'), 131.9, 133.2, 131.9, 133.2, 30]];
    const r = row([131.9, 131.9, 131.9, 131.9, 4824], [133.2, 133.2, 133.2, 133.2, 30], 'W');
    assert.strictEqual(H.alignBars(stored, H.batchBars(r, 'W'), 'W', now), null);
  });
  test('batch bars: a finished bar cannot have a smaller range than the same bar saved while forming', () => {
    const now = at('2026-10-20T04:00:00Z'), L = [at('2026-10-12T03:45:00Z'), 196.6, 199.9, 190, 196, 5000000];
    const r = row([197.69, 199.72, 196.05, 196.79, 2266126], [196.6, 198.93, 192.8, 197.74, 9274407], 'W');   // prev bar's high 198.93 is below the saved high 199.9
    assert.strictEqual(H.alignBars([L], H.batchBars(r, 'W'), 'W', now), null);
  });
  // recent bars in chunks (v1.208)
  const R = load('src/prices/recent.js', 'export { mergeRecent };');
  const bk = (t, c) => [at(t), 1, 2, 0.5, c, 10];
  test('recent bars: the stock\'s own bars before the first recent bar are kept, the recent bars replace the rest', () => {
    const full = [bk('2026-09-14T03:45:00Z', 1), bk('2026-09-21T03:45:00Z', 2), bk('2026-09-28T03:45:00Z', 3), bk('2026-10-05T03:45:00Z', 4)];
    const recent = [bk('2026-09-28T03:45:00Z', 33), bk('2026-10-05T03:45:00Z', 44), bk('2026-10-12T03:45:00Z', 55)];
    const out = R.mergeRecent(full, recent, H.weekBucket);
    assert.deepStrictEqual(out.map(b => b[4]), [1, 2, 33, 44, 55]);
    assert.deepStrictEqual(R.mergeRecent(full, [], H.weekBucket), full, 'nothing recent: the stock\'s own bars');
    assert.deepStrictEqual(R.mergeRecent([], recent, H.weekBucket), [], 'a stock with no bars of its own is not given a partial history');
  });
  test('recent bars: a recent row older than the stock\'s own save is ignored, a newer one is laid on top', () => {
    R.setRecentFromDocs([{ id: 'c001', data: { at: '2026-10-20T04:00:00Z', rows: [{ k: 'ABC', w: [bk('2026-10-12T03:45:00Z', 5), bk('2026-10-19T03:45:00Z', 6)], m: [] }] } }]);
    const own = { '1W': [bk('2026-10-05T03:45:00Z', 4), bk('2026-10-12T03:45:00Z', 50)], '1M': [bk('2026-10-01T03:45:00Z', 9)] };
    const older = R.withRecent('ABC', own, '2026-10-20T05:00:00Z');
    assert.strictEqual(older.bars['1W'].length, 2, 'the stock\'s own save is newer: used as it is');
    const newer = R.withRecent('ABC', own, '2026-10-15T05:00:00Z');
    assert.deepStrictEqual(newer.bars['1W'].map(b => b[4]), [4, 5, 6]);
    assert.strictEqual(newer.fetched, '2026-10-20T04:00:00.000Z');
    assert.strictEqual(newer.bars['1M'].length, 1, 'no recent monthly bars: the stock\'s own');
    assert.strictEqual(R.withRecent('ZZZ', own, null).bars, own, 'a stock without a recent row');
  });
  test('recent bars: the lag counts the weekly bars beyond the stock\'s own documents', () => {
    R.setRecentFromDocs([]);
    R.withRecent('LAG', { '1W': [bk('2026-10-05T03:45:00Z', 1), bk('2026-10-12T03:45:00Z', 2)], '1M': [] }, '2026-10-15T00:00:00Z');
    assert.strictEqual(R.lagOf('LAG', [bk('2026-10-05T03:45:00Z', 1), bk('2026-10-12T03:45:00Z', 2), bk('2026-10-19T03:45:00Z', 3), bk('2026-10-26T03:45:00Z', 4)]), 2);
    R.noteFullSaved('LAG', '1W', [bk('2026-10-26T03:45:00Z', 4)]);
    assert.strictEqual(R.lagOf('LAG', [bk('2026-10-26T03:45:00Z', 4)]), 0);
  });
  test('batch bars: anything unclear is left to the one-by-one fetch', () => {
    const now = at('2026-10-20T04:00:00Z'), L = [at('2026-10-12T03:45:00Z'), 196.6, 197, 195, 196, 5000000];
    const good = row([197.69, 199.72, 196.05, 196.79, 2266126], [196.6, 198.93, 192.8, 197.74, 9274407], 'W');
    assert.ok(H.alignBars([L], H.batchBars(good, 'W'), 'W', now));
    assert.strictEqual(H.alignBars([[at('2026-09-28T03:45:00Z'), 196.6, 197, 195, 196, 1]], H.batchBars(good, 'W'), 'W', now), null, 'two weeks behind');
    assert.strictEqual(H.alignBars([[L[0], 98.3, 99, 97, 98, 1]], H.batchBars(good, 'W'), 'W', now), null, 'opens differ (a split): refetch in full');
    assert.strictEqual(H.alignBars([L], H.batchBars(row([196.6, 199.72, 196.05, 196.79, 1], [196.6, 198.93, 192.8, 197.74, 1], 'W'), 'W'), 'W', now), null, 'both bars open alike: cannot tell which is which');
    const missing = Object.assign({}, good); delete missing['volume|1W'];
    assert.strictEqual(H.batchBars(missing, 'W'), null, 'a missing number');
    assert.strictEqual(H.alignBars([L], null, 'W', now), null, 'no answer for the stock');
    assert.ok(WK([1, 2, 3, 4, 5]).v === 5);
  });
  test('history plan: stocks are grouped and keep their order', () => {
    const now = at('2026-10-15T10:00:00Z');
    const data = { a: null, b: bars('2026-10-05T03:45:00Z', '2026-10-01T03:45:00Z'), c: bars('2026-10-12T03:45:00Z', '2026-10-01T03:45:00Z'), d: null, e: bars('2026-09-01T03:45:00Z', '2026-09-01T03:45:00Z') };
    const p = H.planHistory(['a', 'b', 'c', 'd', 'e'], s => data[s], now);
    assert.deepStrictEqual(p, { none: ['a', 'd'], stale: ['b', 'e'], current: ['c'] });
  });
}

// ---- Technical Score 2 (v1.203: every stock with at least 60 finished weeks) ----
{
  const T2 = load('src/engine/techscore2.js', 'export { computeTech2 };');
  const wk0 = Date.parse('2024-01-01T00:00:00Z') / 1000;
  const mk = (n, f, vol = 1000000) => { const out = []; let px = 100; for(let i = 0; i < n; i++){ px = f(i, px); out.push([wk0 + i * 604800, px, px * 1.02, px * 0.98, px, vol]); } return out; };
  const rising = n => mk(n, (i, px) => (i === n - 1 ? px * 1.03 : px * 1.004));
  const drop = () => mk(120, (i, px) => (i < 100 ? px * 1.004 : px * 0.97));
  test('tech score 2: every stock with enough bars gets a score on a 0-10 scale, whatever its trend', () => {
    for(const b of [rising(120), drop(), mk(120, (i, px) => px * 0.995), mk(120, (i, px) => px, 1000)]){
      const r = T2.computeTech2(b);
      assert.ok(r && typeof r.score === 'number' && r.score >= 0 && r.score <= 10, JSON.stringify(r));
    }
    assert.strictEqual(T2.computeTech2(rising(120)).week, '2026-04-13', 'the week it rests on');
  });
  test('tech score 2: the same history scores higher when the last week rose than when it fell', () => {
    const base = f => mk(120, (i, px) => (i === 119 ? px * f : px * 1.004));
    assert.ok(T2.computeTech2(base(1.05)).score > T2.computeTech2(base(0.95)).score);
  });
  test('tech score 2: a stronger recent run scores higher than a weaker one', () => {
    const weak = T2.computeTech2(mk(120, (i, px) => (i === 119 ? px * 1.012 : px * 1.0005)));
    const strong = T2.computeTech2(mk(120, (i, px) => (i === 119 ? px * 1.08 : px * 1.012)));
    assert.ok(strong.score > weak.score, weak.score + ' < ' + strong.score);
  });
  test('tech score 2: the saved records hold one row per stock with enough bars, 250 to a record', () => {
    const list = [];
    for(let i = 0; i < 300; i++) list.push({ ticker: 'S' + i, name: 'S' + i });
    const barsOf = s => (s.ticker === 'S5' ? rising(30) : (s.ticker === 'S6' ? undefined : (s.ticker === 'S7' ? drop() : rising(120))));
    const out = T2.buildTech2Chunks(list, barsOf, '2026-10-16');
    assert.deepStrictEqual(out.map(c => [c.id, c.doc.rows.length]), [['c001', 250], ['c002', 48]], '300 stocks, two with no usable bars');
    const all = out.flatMap(c => c.doc.rows), s7 = all.find(r => r.k === 'S7'), s1 = all.find(r => r.k === 'S1');
    assert.ok(!all.some(r => r.k === 'S5' || r.k === 'S6'));
    assert.ok(typeof s7.s === 'number' && typeof s1.s === 'number' && s1.w === '2026-04-13');
    assert.strictEqual(out[0].doc.asof, '2026-10-16');
  });
  test('tech score 2: too few bars gives nothing, and a week still in progress is left out', () => {
    assert.strictEqual(T2.computeTech2(rising(59)), null);
    const b = rising(120), last = b[119][0];
    const day = new Date((last + 2 * 86400) * 1000).toISOString().slice(0, 10);   // Wednesday of the last bar's week
    const r = T2.computeTech2(b, day);
    assert.strictEqual(r.week, new Date((b[118][0] + 19800) * 1000).toISOString().slice(0, 10), 'built on the previous, finished week');
  });
}

// =========================================================== News page logic (src/news/model.js)
{
  const N = load('src/news/model.js', 'export { shiftDate };');
  test('news: tiles keep only quotes with a price, in order, and colour a rise in a "bad" tile red', () => {
    const tiles = N.buildTiles({ 'NSE:NIFTY': { close: 24500.5, change: 0.4 }, 'NSE:INDIAVIX': { close: 14.2, change: 5 }, 'TVC:GOLD': { close: 2400, change: 1 }, 'SP:SPX': {} });
    assert.deepStrictEqual(tiles.map(x => x.id), ['nifty', 'vix', 'gold']);
    assert.strictEqual(N.tileView(tiles[0]).tone, 'up');
    assert.strictEqual(N.tileView(tiles[1]).tone, 'down');
    assert.strictEqual(N.tileView(tiles[2]).tone, '');
    assert.strictEqual(N.tileView(tiles[0]).value, '24,501');
    assert.strictEqual(N.tileView(tiles[1]).change, '+5.00%');
  });
  test('news: the reading is cut to three clean lines', () => {
    assert.deepStrictEqual(N.cleanReading({ lines: ['<b>a</b>  b', '', 'c', 'd', 'e'] }), ['a b', 'c', 'd']);
    assert.deepStrictEqual(N.cleanReading(null), []);
    assert.ok(N.readingPrompt(N.buildTiles({ 'NSE:NIFTY': { close: 1, change: 1 } }), [{ date: '2026-10-28', title: 'RBI' }]).includes('2026-10-28: RBI'));
  });
  test('news: calendar groups by IST date, filters by importance, and finds the next big event', () => {
    const rows = [{ date: '2026-10-29T08:00:00Z', title: 'B', importance: 0 }, { date: '2026-10-28T20:00:00Z', title: 'A', importance: 1 }, { date: '2026-10-28T09:00:00Z', title: 'C', importance: -1 }, { date: '2026-10-30T09:00:00Z', title: 'D', importance: 1 }];
    const g = N.groupCalendar(rows, 0);
    assert.deepStrictEqual(g.map(x => [x.date, x.rows.map(r => r.title)]), [['2026-10-29', ['A', 'B']], ['2026-10-30', ['D']]]);
    assert.strictEqual(N.groupCalendar(rows, -1).length, 3);
    assert.deepStrictEqual(N.nextBigEvents(rows, Date.parse('2026-10-28T10:00:00Z'), 1), [{ date: '2026-10-29', title: 'A' }]);
    assert.strictEqual(N.shortDate('2026-10-05'), '5 Oct');
    assert.strictEqual(N.calValue(4, '%'), '4%');
    assert.strictEqual(N.calValue(null, '%'), '');
  });
  test('news: calendar rows from TradingView keep India medium+, others high only, with shown values and safe links', () => {
    const src = [{ date: '2026-11-12T10:30:00.000Z', title: 'Inflation Rate YoY', country: 'IN', importance: 0, forecast: null, previous: 5.54, unit: '%', source: 'MOSPI', source_url: 'http://www.mospi.gov.in/' },
      { date: '2026-11-06T13:30:00.000Z', title: 'Non Farm Payrolls', country: 'US', importance: 1, previous: 29, actual: 31, source_url: 'javascript:alert(1)' },
      { date: '2026-11-05T13:30:00.000Z', title: 'Minor', country: 'US', importance: 0 }, { title: 'No date', importance: 1 }];
    const inr = N.buildCalendar(src, 'IN'), us = N.buildCalendar(src, 'US');
    assert.deepStrictEqual(inr.map(r => r.title), ['Minor', 'Non Farm Payrolls', 'Inflation Rate YoY']);
    assert.strictEqual(inr.find(r => r.title === 'Inflation Rate YoY').url, 'https://www.mospi.gov.in/');
    assert.ok(!('forecast' in inr.find(r => r.title === 'Inflation Rate YoY')));
    assert.deepStrictEqual(us.map(r => r.title), ['Non Farm Payrolls']);
    assert.ok(!('url' in us[0]) && us[0].actual === 31 && us[0].previous === 29);
  });
  test('news: upcoming and recent stock events are selected and filtered', () => {
    const items = [{ ticker: 'A', type: 'results', date: '2026-10-30' }, { ticker: 'B', type: 'dividend', date: '2026-12-20' }, { ticker: 'C', type: 'results', date: '2026-10-01' }, { ticker: 'D', type: 'weird', date: '2026-10-30' }, { ticker: 'E', type: 'board', date: 'soon' }];
    const up = N.upcomingItems(items, '2026-10-24');
    assert.deepStrictEqual(up.map(x => x.ticker), ['A', 'B']);
    assert.deepStrictEqual(N.filterItems(up, { type: 'all', upto: 30 }, '2026-10-24').map(x => x.ticker), ['A']);
    assert.deepStrictEqual(N.filterItems(up, { type: 'dividend', upto: 0 }, '2026-10-24').map(x => x.ticker), ['B']);
    const rec = N.recentItems([{ ticker: 'A', name: 'Aa', events: [{ k: 'earn', d: '2026-10-20', t: 'x' }, { k: 'news', d: '2026-10-22', t: 'y' }, { k: 'earn', d: '2026-08-01', t: 'old' }, { k: 'trade', d: '2026-10-21', t: 'z' }, { k: 'corp', d: '2026-10-30', t: 'future' }] }], '2026-10-24', 30);
    assert.deepStrictEqual(rec.map(x => [x.type, x.date]), [['news', '2026-10-22'], ['results', '2026-10-20']]);
    assert.strictEqual(N.shiftDate('2026-03-01', -1), '2026-02-28');
  });
}

(async () => {
await Promise.all(pending);
if(failures.length){ console.error(failures.length + ' engine test(s) FAILED (' + passed + ' passed):\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('engine tests: ' + passed + ' passed');
})();
