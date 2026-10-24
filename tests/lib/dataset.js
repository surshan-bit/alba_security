// A made-up stock database big enough for the import code to accept (it refuses fewer than 2,000 stocks): about 2,000 companies
// scored by the real fundamental engine from a made-up screener.in table, most with a technical block scored by the real technical
// engine rules, split into ~190 KB chunk documents exactly as the page stores them. Nothing here is real company data.
const { createData } = require('./data.js');
const { load } = require('./load.js');
const F = load('src/import/fund-engine.js', 'export { FundEngine };');
const E = load('src/engine/technical.js', 'export { techComposite as composite, techMacdStateOf as macdState, techRsiState as rsiState };');

const sid = id => String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_') || 'x';
const symOf = s => s.ticker.split('·')[0].trim();
function canon(o){
  if(Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
  if(o && typeof o === 'object') return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  return JSON.stringify(o);
}

function buildDataset(){
  const D = createData(424242);
  const rows = [];
  const GROUPS = 40, PER = 50;                                    // 40 industry groups x 50 companies, two industries each
  for(let g = 0; g < GROUPS; g++) for(let k = 0; k < PER; k++){
    const i = g * PER + k;
    rows.push(D.fundRow('C' + String(i).padStart(4, '0'), 'Group' + String(g).padStart(2, '0'), 'Ind' + String(g).padStart(2, '0') + (k % 2 ? 'a' : 'b')));
  }
  // four BSE-only companies; the first two are made to look excellent so they qualify for the watchlists
  const GREAT = { 'Return on capital employed': 60, 'Return on equity': 55, 'OPM': 60, 'Median return on capital employed 10Years': 60, 'Average return on equity 7Years': 55, 'Debt to equity': 0, 'Interest Coverage': 90, 'Quick ratio': 4, 'Current ratio': 4, 'Altman Z Score': 12, 'Piotroski score': 9, 'PEG Ratio': 0.1, 'Price to Earning': 7, 'Industry PE': 30, 'Pledged percentage': 0, 'Profit growth': 30, 'Profit growth 3Years': 29, 'Profit growth 5Years': 30, 'Sales growth 3Years': 40, 'Intrinsic Value': 2000, 'Current Price': 100, 'Free cash flow 3years': 100, 'Operating cash flow 3years': 200 };
  for(let k = 0; k < 4; k++) rows.push(D.fundRow('', 'Group00', 'Ind00a', Object.assign({ 'NSE Code': '', 'BSE Code': String(512340 + k), 'Name': 'Bse Only ' + k, 'ISIN Code': 'INE00' + (512340 + k) + '1' }, k < 2 ? GREAT : {})));
  const apply = (rs, asof) => { const stocks = []; F.applyFundamental(D.fundCsv(rs), stocks, asof); return stocks; };
  // give three of the Strong/Good companies the awkward symbol shapes the watchlist code has to handle
  let stocks = apply(rows, '2026-09-01');
  const good = stocks.map((s, i) => [s, i]).filter(([s]) => (s.verdict === 'buy' || s.verdict === 'mbuy') && !/^\d/.test(symOf(s)));
  const special = ['BAJAJ-AUTO', 'J&KBANK', 'KLBRENG-B'];
  good.slice(0, 3).forEach(([s], k) => { const row = rows.find(r => r['NSE Code'] === symOf(s)); row['NSE Code'] = special[k]; });
  stocks = apply(rows, '2026-09-01');
  // technical blocks for most stocks, scored by the real technical engine rules from made-up MACD and RSI readings
  D.setSeed(99);
  stocks.filter((_, i) => i % 9 !== 0).forEach(s => {
    const [price, weekPct, monthPct, monthLvl, monthSig, weekLvl, weekSig, monthRsi, weekRsi] = [D.rv(50, 900, 2), D.rv(-5, 5, 2), D.rv(-10, 10, 2), D.rv(-3, 3, 3), D.rv(-3, 3, 3), D.rv(-3, 3, 3), D.rv(-3, 3, 3), D.rv(15, 85, 1), D.rv(15, 85, 1)].map(Number);
    if(!s.pillars || s.pillars.val == null) return;   // no valuation anchor: not scored
    const states = { monthMacd: E.macdState(monthLvl, monthSig), weekMacd: E.macdState(weekLvl, weekSig), monthRsi: E.rsiState(monthRsi), weekRsi: E.rsiState(weekRsi) };
    const raw = { monthMacdLevel: monthLvl, monthMacdSignal: monthSig, weekMacdLevel: weekLvl, weekMacdSignal: weekSig, weekPctChange: weekPct, monthPctChange: monthPct, monthRsi, weekRsi };
    s.technical = { asof: '2026-09-01', score: E.composite(states, s.pillars.val), states: Object.assign({}, states, { valuation: 'reasonably valued' }), raw: Object.assign({}, raw, { valuationScore: s.pillars.val }), reason: 'made-up seed reading' };
  });
  stocks.forEach((s, i) => { if(i % 7 === 0) s.globalFactors = { scope: 'sector', sectorLabel: 'x', asof: '2026-09-01', positive: ['made-up positive'], negative: [] }; });
  // chunk documents of about 190 KB, indexed the way stockMeta/main indexes them
  const chunks = {}, ids = []; let cur = [], curBytes = 0, n = 0;
  const flush = () => { if(!cur.length) return; n++; const cid = 'c' + String(n).padStart(3, '0'); ids.push(cid); chunks[cid] = { chunk: n, count: cur.length, stocks: cur }; cur = []; curBytes = 0; };
  for(const s of stocks){ const b = JSON.stringify(s).length + 1; if(curBytes + b > 190000) flush(); cur.push(s); curBytes += b; }
  flush();
  const index = {}; for(const cid of ids) for(const s of chunks[cid].stocks) index[sid(symOf(s))] = cid;
  const meta = { version: 5, updatedAt: '2026-09-01T00:00:00Z', count: stocks.length, chunks: ids, index };
  const bseAlpha = { '512340': 'ALPHAONE', '512341': 'ALPHATWO' };
  const docs = { 'stockMeta/main': meta, 'stockMeta/bseAlpha': bseAlpha, 'stockMeta/isinSymbol': isinSymbols(stocks, bseAlpha) };
  for(const cid of ids) docs['stockData/' + cid] = chunks[cid];
  return { D, rows, stocks, meta, chunks, docs, bseAlpha, fundCsv: rs => D.fundCsv(rs || rows), tvCsv: D.tvCsv, symOf };
}

// The TradingView symbol saved for each stock's ISIN (what the page resolves once by search): NSE:<ticker>, or BSE:<alpha> for a BSE-only stock that has one.
function isinSymbols(stocks, alpha){
  const m = {};
  for(const s of stocks){ const k = symOf(s); if(!s.isin) continue; if(!/^\d+$/.test(k)) m[s.isin] = 'NSE:' + k.replace(/-/g, '_'); else if(alpha[k]) m[s.isin] = 'BSE:' + alpha[k]; }
  return m;
}

// A tiny database (the anonymised sample used by the other tests): below the 2,000-stock minimum on purpose.
function buildSmall(fixtureStocks){
  const chunk = { chunk: 1, count: fixtureStocks.length, stocks: fixtureStocks };
  const index = {}; fixtureStocks.forEach(s => { index[sid(symOf(s))] = 'c001'; });
  return { docs: { 'stockMeta/main': { version: 3, updatedAt: '2026-09-01T00:00:00Z', count: fixtureStocks.length, chunks: ['c001'], index }, 'stockData/c001': chunk, 'stockMeta/bseAlpha': {} } };
}

module.exports = { buildDataset, buildSmall, canon, symOf, sid, F };
