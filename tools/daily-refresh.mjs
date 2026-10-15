// Daily TradingView refresh, run by a scheduled Claude task (no browser needed). Repo-only: not published to the artifact.
// It does the same job as the "Refresh all stocks" button (src/refresh/tvrefresh.js) using the same scoring code
// (src/engine/technical.js), but the TradingView calls and the database writes are made by Claude's tools, so this script only
// plans the calls and builds the writes from files.
//
//   node tools/daily-refresh.mjs plan  --data DIR --work DIR [--limit N] [--runs DIR] [--tracked-only]
//       DIR/stockData/c*.json, DIR/stockMeta/bseAlpha.json, DIR/stockUpdates/*.json (exports of the database collections)
//       writes WORK/batches.json (symbols, 50 per call, tracked picks first), WORK/skipped.json
//   node tools/daily-refresh.mjs apply --data DIR --work DIR --versions FILE [--today YYYY-MM-DD]
//       reads WORK/res-<n>.json (the "data" object of each TradingView batch answer, n = batch number from 0),
//       FILE = {"<stockUpdates doc id>": version, ...} for every existing document,
//       writes WORK/docs/<id>.json and WORK/writes-<k>.json (up to 50 writes each, for the database batch call) and prints a summary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), mode = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DATA = opt('data'), WORK = opt('work');
if(!['plan', 'apply'].includes(mode) || !DATA || !WORK){ console.error('usage: daily-refresh.mjs plan|apply --data DIR --work DIR ...'); process.exit(2); }
fs.mkdirSync(WORK, { recursive: true });

// the scoring engine is plain ES module code without imports; a copy with .mjs lets node load it
const here = path.dirname(fileURLToPath(import.meta.url));
fs.copyFileSync(path.join(here, '..', 'src', 'engine', 'technical.js'), path.join(WORK, 'technical.mjs'));
const eng = await import(pathToFileURL(path.join(WORK, 'technical.mjs')).href);

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const tickerOf = s => String(s.ticker).split('·')[0].trim();
const docIdOf = s => (tickerOf(s).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_') || 'x');
const dirFiles = d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => path.join(d, f)) : [];

const stocks = [];
for(const f of dirFiles(path.join(DATA, 'stockData')).sort()) stocks.push(...(readJson(f).stocks || []));
const bse = fs.existsSync(path.join(DATA, 'stockMeta', 'bseAlpha.json')) ? readJson(path.join(DATA, 'stockMeta', 'bseAlpha.json')) : {};
const updates = new Map();
for(const f of dirFiles(path.join(DATA, 'stockUpdates'))) updates.set(path.basename(f, '.json'), readJson(f));

// same rule as src/refresh/tvrefresh.js (snapshotSymbol)
function symbolOf(s){
  const key = tickerOf(s);
  if(!/^\d+$/.test(key)) return 'NSE:' + key.replace(/[-&]/g, '_');
  return bse[key] ? 'BSE:' + String(bse[key]).replace(/^BSE:/, '') : null;
}

if(mode === 'plan'){
  const tracked = new Set();
  for(const f of dirFiles(opt('runs', path.join(DATA, 'runs')))) for(const p of (readJson(f).picks || [])) tracked.add(String(p.sym));
  const skipped = [], list = [];
  for(const s of stocks){
    const sym = symbolOf(s);
    if(!sym) skipped.push({ sym: tickerOf(s), name: s.name, reason: 'BSE-only stock with no TradingView symbol saved yet' }); else list.push({ s, sym });
  }
  list.sort((a, b) => (tracked.has(tickerOf(b.s)) ? 1 : 0) - (tracked.has(tickerOf(a.s)) ? 1 : 0));
  const only = args.includes('--tracked-only') ? list.filter(x => tracked.has(tickerOf(x.s))) : list;
  const use = opt('limit') ? only.slice(0, Number(opt('limit'))) : only;
  const batches = [];
  for(let i = 0; i < use.length; i += 50) batches.push(use.slice(i, i + 50).map(x => x.sym));
  fs.writeFileSync(path.join(WORK, 'batches.json'), JSON.stringify(batches));
  fs.writeFileSync(path.join(WORK, 'skipped.json'), JSON.stringify(skipped, null, 1));
  console.log(JSON.stringify({ stocks: stocks.length, planned: use.length, batches: batches.length, tracked: tracked.size, skippedNoSymbol: skipped.length }));
  process.exit(0);
}

// ---- apply ----
const today = opt('today') || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const versions = readJson(opt('versions', path.join(WORK, 'versions.json')));
const bySym = new Map(stocks.map(s => [symbolOf(s), s]).filter(x => x[0]));
const rows = {};
for(const f of fs.readdirSync(WORK).filter(f => /^res-\d+\.json$/.test(f))) Object.assign(rows, readJson(path.join(WORK, f)));
fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
const writes = [], report = { updated: 0, scored: 0, kept: 0, noPrice: [], noValuation: 0, noIndicators: 0, missingVersion: [] };
for(let [sym, row] of Object.entries(rows)){
  const s = bySym.get(sym); if(!s) continue;
  if(Array.isArray(row)){ const c = ['close', 'MACD.macd|1W', 'MACD.signal|1W', 'MACD.macd|1M', 'MACD.signal|1M', 'RSI|1W', 'RSI|1M', 'change|1W', 'change|1M']; row = Object.fromEntries(c.map((k, i) => [k, row[i]])); }
  const id = docIdOf(s);
  const px = row && typeof row.close === 'number' && row.close > 0 ? row.close : null;
  if(px == null){ report.noPrice.push(sym); continue; }
  const doc = { valuation: { currentPrice: px, asof: today, source: 'TradingView (' + sym + ')' } };
  const pv = s.pillars && typeof s.pillars.val === 'number' ? s.pillars.val : null;
  // the technical block in force: the saved update when it is at least as new as the stock's own, else the stock's own
  const up = updates.get(id), cur = up && up.technical && String(up.technical.asof) >= String((s.technical || {}).asof || '') ? up.technical : s.technical;
  if(pv == null) report.noValuation++;
  else if(eng.techKeepsBarsBlock(cur, today)) report.kept++;
  else {
    const t = eng.snapshotTechnical({ monthMacdLevel: row['MACD.macd|1M'], monthMacdSignal: row['MACD.signal|1M'], weekMacdLevel: row['MACD.macd|1W'], weekMacdSignal: row['MACD.signal|1W'],
      monthRsi: row['RSI|1M'], weekRsi: row['RSI|1W'], weekPctChange: row['change|1W'], monthPctChange: row['change|1M'] }, pv, today);
    if(t){ doc.technical = t; report.scored++; } else report.noIndicators++;
  }
  const exists = updates.has(id);
  if(exists && versions[id] == null){ report.missingVersion.push(id); continue; }
  if(!exists) doc.ticker = tickerOf(s);
  fs.writeFileSync(path.join(WORK, 'docs', id + '.json'), JSON.stringify(doc));
  const w = { op: exists ? 'update' : 'set', collection: 'stockUpdates', doc_id: id, file_path: path.resolve(WORK, 'docs', id + '.json') };
  if(exists) w.if_version = versions[id];
  writes.push(w); report.updated++;
}
for(let i = 0; i * 50 < writes.length; i++) fs.writeFileSync(path.join(WORK, 'writes-' + i + '.json'), JSON.stringify(writes.slice(i * 50, i * 50 + 50)));
report.writeFiles = Math.ceil(writes.length / 50);
report.noPrice = report.noPrice.length ? report.noPrice : 0;
console.log(JSON.stringify(report));
