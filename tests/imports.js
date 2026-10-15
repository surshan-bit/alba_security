// Import-flow tests in real Chromium: the parts of the CSV imports and the watchlist sync that touch the page and the database.
// Everything runs through the real buttons on the Data Refresh page against a stand-in database (with live listeners and
// injectable failures), an asset store and a fake TradingView watchlist service. The stock database is made up (~2,000 companies
// scored by the real engines, see tests/lib/dataset.js). Each scenario checks both what the person sees and what ended up in the
// database, and the new stock list is compared with what the engines produce for the same file (an independent oracle).
// Playwright is optional locally (SKIPPED if missing) but required in CI. Usage: node tests/imports.js   or   npm run imports   [--only <text>]
const fs = require('fs'), path = require('path');
const { chromiumOrSkip, startServer, openPage } = require('./lib/env.js');
const chromium = chromiumOrSkip('import tests');
const { buildDataset, buildSmall, canon, symOf, sid, F, T } = require('./lib/dataset.js');

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const srv = startServer(); const DS = buildDataset(); const D = DS.D;
const SMALL = buildSmall(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stocks.json'), 'utf8')).stocks);
let base, browser; const problems = []; let checks = 0, scenarios = 0;
const ok = (cond, msg) => { checks++; if(!cond) problems.push(msg); return !!cond; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' — expected ' + JSON.stringify(b).slice(0, 160) + ' but got ' + JSON.stringify(a).slice(0, 160));
const indiaDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const clone = x => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- page helpers
async function goto(page, k){ await page.evaluate(k => document.querySelector('.nav-item[data-section="' + k + '"]').click(), k); await page.waitForTimeout(150); }
async function startScenario(name, o){
  o = o || {};
  const seedName = o.seedName || 'main';
  if(!srv.seeds.has(seedName + '|' + JSON.stringify(Object.keys(o.docs || {})))){ /* seeds are keyed below */ }
  const key = (o.small ? 'small' : 'main') + '-' + name.replace(/\W+/g, '_');
  srv.seeds.set(key, JSON.stringify({ docs: Object.assign({}, o.small ? SMALL.docs : DS.docs, o.docs || {}) }));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  const { page } = await openPage(ctx, base, Object.assign({ seedUrl: base + '/__seed/' + key + '.json', assets: true, tv: true, section: 'refreshlog' }, o.cfg || {}), name, errs);
  await page.waitForFunction(() => window.__alba && window.__alba.stocks && document.querySelector('.app-section.active'), null, { timeout: 90000 });
  await goto(page, 'refreshlog');
  if(o.nonOwner) await page.waitForFunction(() => /Only the owner/.test((document.getElementById('importFundamentalDataBtn') || {}).title || ''), null, { timeout: 10000 });
  else if(o.noAssets) await page.waitForTimeout(800);
  else await page.waitForFunction(() => { const b = document.getElementById('importFundamentalDataBtn'); return b && !b.disabled; }, null, { timeout: 30000 });
  return { page, ctx, errs, name };
}
async function runScenario(name, opts, fn){
  if(only && !name.includes(only)) return;
  scenarios++; let s;
  try {
    s = await startScenario(name, opts);
    await fn(s.page, s);
    const uncaught = s.errs.filter(e => /pageerror/.test(e));
    ok(uncaught.length === 0, name + ': uncaught errors in the page: ' + uncaught.slice(0, 2).join(' | '));
  } catch(e){ problems.push(name + ': test crashed: ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); checks++; }
  finally { if(s && s.ctx) await s.ctx.close().catch(() => {}); }
}
const PFX = { fund: '', tech: 'ti_', wl: 'wl_' };
const BTN = { fund: '#importFundamentalDataBtn', tech: '#importTechnicalDataBtn', wl: '#refreshWatchlistBtn' };
const RESULT_SEL = p => `#${p}fiResult.fi-result-ok, #${p}fiResult.fi-result-err, #${p}fiResult.fi-result-warn`;
async function result(page, kind){
  const p = PFX[kind];
  return page.evaluate(p => {
    const r = document.getElementById(p + 'fiResult');
    return { cls: (/fi-result-(ok|err|warn)/.exec(r.className) || [])[1] || '', lines: Array.from(r.children).map(d => d.textContent), text: r.textContent,
      steps: Array.from(document.querySelectorAll('#' + p + 'fiSteps li')).map(li => [/fi-(pending|running|done|error)/.exec(li.className)[1], li.querySelector('.fi-label').textContent, li.querySelector('.fi-detail').textContent]),
      pct: document.getElementById(p + 'fiPct').textContent, prompt: (document.querySelector('#' + p + 'fiPrompt .fi-prompt-msg') || {}).textContent || null };
  }, p);
}
async function waitResult(page, kind, timeout){ await page.waitForSelector(RESULT_SEL(PFX[kind]), { timeout: timeout || 240000 }); return result(page, kind); }
// The Technical CSV import is hidden in the product (v1.199); the tests show it again to drive it.
async function showTechCsv(page){ await page.evaluate(() => { const e = document.getElementById('techCsvOption'); if(e) e.hidden = false; }); }
async function run(page, kind){ if(kind === 'tech') await showTechCsv(page); await page.click(BTN[kind]); return waitResult(page, kind); }
async function waitPrompt(page, kind){ await page.waitForSelector(`#${PFX[kind]}fiPrompt .fi-prompt-msg`, { timeout: 240000 }); return result(page, kind); }
const answer = (page, kind, yes) => page.click(`#${PFX[kind]}fiPrompt ${yes ? '.fi-btn-primary' : 'button:not(.fi-btn-primary)'}`);
async function upload(page, which, name, text){
  const col = which === 'fund' ? 'fundamentalCsvUploadLog' : 'technicalCsvUploadLog';
  await page.setInputFiles(which === 'fund' ? '#fundamentalCsvInput' : '#technicalCsvInput', { name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.waitForFunction(([col, name]) => { for(const [k, v] of window.__store) if(k.startsWith(col + '/') && v.filename === name) return true; return false; }, [col, name], { timeout: 30000 });
  await page.waitForTimeout(100);
}
async function readDb(page){
  const json = await page.evaluate(() => JSON.stringify(Object.fromEntries(Array.from(window.__store).filter(([k]) => /^(stockData|stockMeta|backupLog|importJobs|fundamentalCsvUploadLog|technicalCsvUploadLog|watchlistSyncLog|stockUpdates|refreshRunLog|liveSnapshot)\//.test(k)))));
  const all = JSON.parse(json), meta = all['stockMeta/main'], stocks = new Map(), chunkDocs = {};
  for(const cid of meta.chunks){ const d = all['stockData/' + cid]; chunkDocs[cid] = d; if(d) for(const s of d.stocks) stocks.set(symOf(s), s); }
  const col = c => Object.entries(all).filter(([k]) => k.startsWith(c + '/')).map(([k, v]) => Object.assign({ id: k.slice(c.length + 1) }, v)).sort((a, b) => String(a.createdAt || a.uploadedAt || a.startedAt || a.id).localeCompare(String(b.createdAt || b.uploadedAt || b.startedAt || b.id)));
  return { all, meta, stocks, chunkDocs, backups: col('backupLog'), fundLog: col('fundamentalCsvUploadLog'), techLog: col('technicalCsvUploadLog'), wlLog: col('watchlistSyncLog'), job: all['importJobs/fundamental'], wlJob: all['importJobs/watchlist'] };
}
// how a stock list differs from what was expected
function diffStocks(actual, expectedList){
  const exp = new Map(expectedList.map(s => [symOf(s), s])), out = { missing: [], extra: [], differ: [] };
  for(const [k, s] of exp){ const a = actual.get(k); if(!a) out.missing.push(k); else if(canon(a) !== canon(s)) out.differ.push(k); }
  for(const k of actual.keys()) if(!exp.has(k)) out.extra.push(k);
  return out;
}
const sameStocks = (actual, expectedList, msg) => { const d = diffStocks(actual, expectedList); return ok(!d.missing.length && !d.extra.length && !d.differ.length, `${msg}: ${d.missing.length} missing, ${d.extra.length} extra, ${d.differ.length} differ (e.g. ${[...d.missing, ...d.extra, ...d.differ].slice(0, 4).join(', ')})`); };

// ---------------------------------------------------------------- made-up files
const rowsCopy = () => DS.rows.map(r => Object.assign({}, r));
// a changed screener.in export: 5 companies gone, 3 new, 20 with new numbers
function fundFileChanged(){
  const rows = rowsCopy(); const dropped = rows.splice(100, 5).map(r => r['NSE Code']);
  for(let i = 0; i < 20; i++) Object.assign(rows[300 + i * 7], { 'Return on equity': D.rv(5, 40, 1), 'OPM': D.rv(5, 40, 1), 'Debt to equity': D.rv(0, 1.5, 2), 'Profit growth': D.rv(0, 60, 1) });
  const added = ['NEWA', 'NEWB', 'NEWC'].map((s, i) => D.fundRow(s, 'Group0' + (i + 1), 'Ind0' + (i + 1) + 'a'));
  return { csv: DS.fundCsv(rows.concat(added)), dropped, added: added.map(r => r['NSE Code']) };
}
// a file that turns the whole market upside down: most scores move by a point or more
function fundFileShaken(){ const rows = rowsCopy(); rows.forEach((r, i) => { if(i % 2 === 0) Object.assign(r, { 'Return on capital employed': D.rv(1, 60, 1), 'Return on equity': D.rv(1, 60, 1), 'OPM': D.rv(1, 60, 1), 'Debt to equity': D.rv(0, 3, 2), 'Interest Coverage': D.rv(0.2, 60, 1), 'Profit growth': D.rv(-30, 90, 1), 'Piotroski score': Math.floor(D.rnd() * 10) }); }); return DS.fundCsv(rows); }
const expectFund = (csv, rawStocks, asof) => { const list = clone(rawStocks); const res = F.albaApplyFundamental(csv, list, asof); return { list, res }; };
const symbolFor = s => symOf(s);
// a TradingView Growth List for the made-up stocks: every dashboard stock except `skipEvery`-th ones, plus a few the dashboard does not track
function techFile(o){
  o = o || {}; const rows = []; D.setSeed(o.seed || 31337);
  DS.stocks.forEach((s, i) => {
    if(o.limit && i >= o.limit) return;
    const sym = /^\d/.test(symbolFor(s)) ? ({ '512340': 'ALPHAONE', '512341': 'ALPHATWO' }[symbolFor(s)] || null) : symbolFor(s).replace(/-/g, '_');
    if(!sym || i % 11 === 5) return;
    const row = [sym, 'desc', D.rv(50, 900, 2), D.rv(-5, 5, 2), D.rv(-10, 10, 2), D.rv(-3, 3, 3), D.rv(-3, 3, 3), D.rv(-3, 3, 3), D.rv(-3, 3, 3), D.rv(15, 85, 1), D.rv(15, 85, 1)];
    if(o.blankWeekRsi && i % (o.blankWeekRsi === 'many' ? 50 : 100) === 3) row[10] = '';
    rows.push(row);
  });
  rows.push(['ZZNOTTRACKED1', '', '10', '', '', '', '', '', '', '', ''], ['ZZNOTTRACKED2', '', '10', '', '', '', '', '', '', '', '']);
  return { csv: DS.tvCsv(rows, o.header), rows };
}

// ================================================================ scenarios
async function main(){
  base = await srv.listen(); browser = await chromium.launch();
  try {
    await uploadScenarios(); await fundScenarios(); await techScenarios(); await watchlistScenarios(); await tvRefreshScenarios();
  } finally { await browser.close(); srv.close(); }
  if(problems.length){ console.error('import tests FAILED (' + problems.length + ' problems, ' + checks + ' checks, ' + scenarios + ' scenarios):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('import tests: ' + checks + ' checks passed in ' + scenarios + ' scenarios');
}
// ---------------------------------------------------------------- 1. choosing a file: preview and storage
async function uploadScenarios(){
  await runScenario('upload: a screener.in file is previewed, stored and recorded', {}, async page => {
    const { csv, dropped, added } = fundFileChanged();
    await upload(page, 'fund', 'screener-export.csv', csv);
    const prev = await page.evaluate(() => Array.from(document.querySelectorAll('#fundamentalUploadResult .diff-stat')).map(d => d.textContent));
    // 2004 companies - 5 gone + 3 new = 2002 rows; 3 are new; the 5 removed ones are "not in file"
    eq(prev, ['2002In file', '1999Already scored', '3New', '5Not in file'], 'fund preview counts');
    const db = await readDb(page);
    eq(db.fundLog.length, 1, 'one fundamental upload record');
    const rec = db.fundLog[0];
    ok(rec.status === 'uploaded' && rec.filename === 'screener-export.csv' && rec.rowCount === 2002 && rec.newCount === 3 && rec.droppedCount === 5, 'upload record fields: ' + JSON.stringify(rec));
    ok((await page.evaluate(id => window.__uploads.includes(id), rec.assetId)), 'the file went into the asset store');
    ok(page.blobs.get(rec.assetId) === csv, 'the stored file is exactly the file chosen');
    ok(added.length === 3 && dropped.length === 5, 'test file shape');
  });
  await runScenario('upload: a TradingView Growth List is previewed, stored and recorded', {}, async page => {
    const { csv, rows } = techFile();
    await upload(page, 'tech', 'growth-list.csv', csv);
    const prev = await page.evaluate(() => Array.from(document.querySelectorAll('#technicalUploadResult .diff-stat')).map(d => d.textContent));
    const existing = new Set(DS.stocks.map(x => symOf(x).toUpperCase())), inFile = rows.length;
    const unmatched = rows.filter(r => !existing.has(r[0].toUpperCase())).length, matched = new Set(rows.filter(r => existing.has(r[0].toUpperCase())).map(r => r[0].toUpperCase()));
    eq(prev, [inFile + 'In file', (inFile - unmatched) + 'Will update', unmatched + 'Not tracked (skipped)', (existing.size - matched.size) + 'Not in file'], 'technical preview counts');
    const db = await readDb(page); eq(db.techLog.length, 1, 'one technical upload record');
    ok(db.techLog[0].status === 'uploaded' && db.techLog[0].rowCount === inFile, 'tech record: ' + JSON.stringify(db.techLog[0]));
    ok(page.blobs.get(db.techLog[0].assetId) === csv, 'the stored Growth List is exactly the file chosen');
    ok(inFile - unmatched > 1500, 'test file has plenty of tracked rows');
  });
  await runScenario('upload: files that are not what they claim are refused and nothing is saved', {}, async page => {
    await page.setInputFiles('#fundamentalCsvInput', { name: 'wrong.csv', mimeType: 'text/csv', buffer: Buffer.from('Symbol,Price\nABC,1\n') });
    await page.waitForFunction(() => /Couldn't process/.test(document.getElementById('fundamentalUploadResult').textContent));
    ok(/NSE Code.*BSE Code.*ISIN Code/.test(await page.evaluate(() => document.getElementById('fundamentalUploadResult').textContent)), 'fundamental: names the columns it wanted');
    await page.setInputFiles('#fundamentalCsvInput', { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('NSE Code,Name\n') });
    await page.waitForFunction(() => /No data rows/.test(document.getElementById('fundamentalUploadResult').textContent));
    await page.setInputFiles('#technicalCsvInput', { name: 'wrong2.csv', mimeType: 'text/csv', buffer: Buffer.from('Ticker,Price\nABC,1\n') });
    await page.waitForFunction(() => /Symbol/.test(document.getElementById('technicalUploadResult').textContent) && /Couldn't process/.test(document.getElementById('technicalUploadResult').textContent));
    await page.setInputFiles('#fundamentalCsvInput', { name: 'nocodes.csv', mimeType: 'text/csv', buffer: Buffer.from('NSE Code,BSE Code\n,\n,\n') });
    await page.waitForFunction(() => /Couldn't process/.test(document.getElementById('fundamentalUploadResult').textContent) && /No data rows|no rows had/.test(document.getElementById('fundamentalUploadResult').textContent));
    await page.waitForTimeout(300);
    const db = await readDb(page);
    ok(db.fundLog.length === 0 && db.techLog.length === 0 && (await page.evaluate(() => window.__uploads.length)) === 0, 'nothing is stored for a refused file');
  });
  await runScenario('upload: without file storage the preview still works, nothing is saved, and the page says so', { noAssets: true, cfg: { assets: false } }, async page => {
    await page.setInputFiles('#fundamentalCsvInput', { name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(fundFileChanged().csv) });
    await page.waitForFunction(() => document.querySelectorAll('#fundamentalUploadResult .diff-stat').length === 4, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    ok((await page.evaluate(() => document.querySelectorAll('#fundamentalUploadResult .diff-stat').length)) === 4, 'the preview is shown');
    ok(await page.evaluate(() => document.getElementById('importFundamentalDataBtn').disabled), 'Import stays disabled when file storage is missing');
  });
  // each upload history keeps only the 3 most recent records: the oldest is removed from the page and from the database
  const oldRec = (name, at) => ({ assetId: 'old-' + name, url: '/_blob/old-' + name, filename: name, sizeBytes: 10, uploadedAt: at, rowCount: 1, newCount: 0, droppedCount: 0, status: 'processed' });
  const hist = (col, names) => Object.fromEntries(names.map((n, i) => { const at = '2020-01-0' + (i + 1) + 'T00:00:00.000Z'; return [col + '/' + sid(at), oldRec(n, at)]; }));
  await runScenario('upload: each upload history keeps only the 3 most recent records', { docs: Object.assign(hist('fundamentalCsvUploadLog', ['f1.csv', 'f2.csv', 'f3.csv']), hist('technicalCsvUploadLog', ['t1.csv', 't2.csv', 't3.csv'])) }, async page => {
    eq((await readDb(page)).fundLog.map(r => r.filename), ['f1.csv', 'f2.csv', 'f3.csv'], 'the seeded fundamental history');
    await upload(page, 'fund', 'new-screener.csv', fundFileChanged().csv);
    await upload(page, 'tech', 'new-growth.csv', techFile().csv);
    await page.waitForFunction(() => { let f = 0, t = 0; for(const k of window.__store.keys()){ if(k.startsWith('fundamentalCsvUploadLog/')) f++; if(k.startsWith('technicalCsvUploadLog/')) t++; } return f === 3 && t === 3; }, null, { timeout: 10000 }).catch(() => {});
    const db = await readDb(page);
    eq(db.fundLog.map(r => r.filename), ['f2.csv', 'f3.csv', 'new-screener.csv'], 'fundamental history after an upload: the oldest record is gone');
    eq(db.techLog.map(r => r.filename), ['t2.csv', 't3.csv', 'new-growth.csv'], 'technical history after an upload: the oldest record is gone');
  });
}
// ---------------------------------------------------------------- 2. fundamental import, failures
const allDone = r => r.steps.length === 6 && r.steps.every(x => x[0] === 'done');
const fmtIn = n => n.toLocaleString('en-IN');
async function fundScenarios(){
  await runScenario('fund import: full cycle (import, repeat import), with no backup taken', {}, async page => {
    const f = fundFileChanged();
    await upload(page, 'fund', 'may.csv', f.csv);
    const orig = await readDb(page); const flatOrig = JSON.stringify([].concat(...orig.meta.chunks.map(c => orig.chunkDocs[c].stocks)));
    eq(orig.meta.version, 5, 'starting version');
    const rec0 = orig.fundLog[0], asof = indiaDay(rec0.uploadedAt);
    const exp = expectFund(f.csv, DS.stocks, asof);
    ok(exp.res.rescored === 1999 && exp.res.onboarded.length === 3 && exp.res.dropped.length === 5, 'oracle counts: ' + JSON.stringify([exp.res.rescored, exp.res.onboarded.length, exp.res.dropped.length]));

    // ---- import
    const r = await run(page, 'fund');
    ok(r.cls === 'ok', 'import ends green, got ' + r.cls + ': ' + r.text.slice(0, 200));
    ok(allDone(r) && r.pct === '100%', 'all six steps done at 100%: ' + JSON.stringify(r.steps.map(x => x[0])) + ' ' + r.pct);
    ok(r.lines[0] === 'Import complete.', 'first line: ' + r.lines[0]);
    ok(r.text.includes(`${fmtIn(exp.res.rescored)} stocks rescored · 3 new · 5 not in the file`), 'summary line: ' + r.lines[1]);
    ok(/Strong 2 → \d+ · Good 184 → \d+/.test(r.text), 'verdict mix line: ' + r.lines[2]);
    ok(/New: NEWA, NEWB, NEWC/.test(r.text), 'new tickers are listed');
    const a = await readDb(page);
    eq(a.meta.version, 6, 'version bumped once'); eq(a.meta.count, 2007, 'count = old + new'); eq(a.stocks.size, 2007, 'stocks stored');
    sameStocks(a.stocks, exp.list, 'imported list equals what the engine produces');
    // untouched stocks are byte-for-byte what they were; the five missing from the file are left alone
    for(const code of f.dropped) ok(canon(a.stocks.get(code)) === canon(DS.stocks.find(s => symOf(s) === code)), 'a stock not in the file is left unchanged: ' + code);
    ok(JSON.stringify(Object.keys(a.meta.index).sort()) === JSON.stringify([...a.stocks.keys()].map(sid).sort()), 'the index lists every stock exactly once');
    ok(a.meta.chunks.every(c => a.chunkDocs[c] && a.chunkDocs[c].count === a.chunkDocs[c].stocks.length && JSON.stringify(a.chunkDocs[c]).length < 240000), 'every chunk is consistent and under the size limit');
    const writes = await page.evaluate(() => window.__sets.filter(p => p.startsWith('stockData/')));
    const changedChunks = c0 => a.meta.chunks.filter(c => !c0.chunkDocs[c] || canon(c0.chunkDocs[c]) !== canon(a.chunkDocs[c]));
    ok(writes.length === changedChunks(orig).length && changedChunks(orig).every(c => writes.includes('stockData/' + c)), `exactly the changed chunks were written (${writes.length} writes, ${changedChunks(orig).length} changed; every stock's date moved, so all of them)`);
    eq(a.backups.length, 0, 'no backup is taken'); ok(!(await page.evaluate(() => window.__sets.some(p => /^backupLog\//.test(p)))) && !(await page.evaluate(() => document.getElementById('fiBackups'))), 'nothing is written to the backup log and the page has no backups list');
    // upload record + lock
    const rec = a.fundLog[0]; ok(rec.status === 'processed' && /^Imported in the page: 1999 rescored, 3 new, 5 left unchanged/.test(rec.processedNote), 'upload record marked processed: ' + rec.status + ' ' + (rec.processedNote || '').slice(0, 80));
    ok(a.job.status === 'done' && a.job.finishedAt, 'lock released: ' + JSON.stringify(a.job));
    ok(await page.evaluate(() => !document.getElementById('importFundamentalDataBtn').disabled && document.getElementById('importFundamentalDataBtn').textContent === 'Import data'), 'the button is usable again');
    const cached = await page.evaluate(() => new Promise(res => { const r = indexedDB.open('albaStockCache', 1); r.onsuccess = () => { const q = r.result.transaction('kv', 'readonly').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }; r.onerror = () => res(null); }));
    ok(Array.isArray(cached) && cached.join() === 'v6', 'the new list is saved in the browser cache under the new version, so the reload is quick: ' + JSON.stringify(cached));
    const lf = await page.evaluate(() => document.getElementById('fundamentalLastFile').innerText);
    ok(/may\.csv/.test(lf) && /Imported/.test(lf) && !/not imported/i.test(lf), 'the last-file card says the file was imported: ' + lf.replace(/\s+/g, ' ').slice(0, 160));

    // ---- the same file again: the three new companies now count as peers, so some ranks move once; the engine output is the oracle
    await upload(page, 'fund', 'may-again.csv', f.csv);
    const exp2 = expectFund(f.csv, exp.list, asof);
    const r2 = await run(page, 'fund'); ok(r2.cls === 'ok', 'second import ok: ' + r2.text.slice(0, 120));
    const a2 = await readDb(page);
    sameStocks(a2.stocks, exp2.list, 'second import equals the engine output run on the first result');
    const writes2 = (await page.evaluate(() => window.__sets.filter(p => p.startsWith('stockData/')))).slice(writes.length);
    const changed2 = a2.meta.chunks.filter(c => canon(a.chunkDocs[c]) !== canon(a2.chunkDocs[c]));
    ok(changed2.length > 0 && changed2.length < a2.meta.chunks.length && writes2.length === changed2.length && changed2.every(c => writes2.includes('stockData/' + c)), `only the chunks that changed were rewritten (${writes2.length} of ${a2.meta.chunks.length})`);
    eq(a2.meta.version, 7, 'second import bumps the version');

    // ---- and a third time: nothing at all changes
    await upload(page, 'fund', 'may-third.csv', f.csv);
    const r3 = await run(page, 'fund');
    ok(r3.cls === 'ok' && /the file produced no changes/.test(r3.text), 'a repeat of a repeat reports no changes: ' + r3.lines[0]);
    const a2b = await readDb(page);
    eq(a2b.meta.version, 7, 'no version bump when nothing changed');
    eq(await page.evaluate(() => window.__sets.filter(p => p.startsWith('stockData/')).length), writes.length + writes2.length, 'no chunk is written');
    sameStocks(a2b.stocks, exp2.list, 'data unchanged');
  });

  // ---- a write fails halfway: everything is put back
  const half = async (name, rules, want, expectMeta) => runScenario(name, { cfg: { rules } }, async page => {
    await upload(page, 'fund', 'may.csv', fundFileChanged().csv);
    const before = await readDb(page);
    const r = await run(page, 'fund');
    ok(r.cls === 'err' && want.test(r.text), name + ': message "' + r.text.slice(0, 260) + '"');
    ok(/The previous data is back in place\./.test(r.text), name + ': says the old data is back');
    ok(r.steps.some(x => x[0] === 'error') && !r.steps.every(x => x[0] === 'done'), name + ': a step is marked failed');
    const after = await readDb(page);
    ok(before.meta.chunks.every(c => canon(after.chunkDocs[c]) === canon(before.chunkDocs[c])), name + ': every chunk is exactly as before');
    sameStocks(after.stocks, DS.stocks, name + ': stock list as before');
    eq(after.meta.version, expectMeta, name + ': index version');
    ok(after.job.status === 'failed' && after.job.error, name + ': lock marked failed: ' + JSON.stringify(after.job));
    ok(after.fundLog[0].status === 'uploaded', name + ': the file stays "uploaded", not processed');
    ok(await page.evaluate(() => !document.getElementById('importFundamentalDataBtn').disabled), name + ': button usable again');
  });
  await half('fund import: second chunk write refused', [{ op: 'set', prefix: 'stockData/', nth: 2, error: { code: 'not_granted', message: 'write refused' } }], /Could not save the stock data \(not_granted: write refused\)\. Your previous data was put back\./, 5);
  await half('fund import: the index cannot be published', [{ op: 'set', path: 'stockMeta/main', error: { code: 'not_granted', message: 'index refused' } }], /Could not publish the new data \(not_granted: index refused\)\. Your previous data was put back\./, 5);
  await half('fund import: someone else changes the data meanwhile', [{ op: 'set', prefix: 'stockData/', nth: 1, bumpMeta: true }], /changed by someone else while this import was running \(version 5 → 105\)/, 105);

  await runScenario('fund import: checking the saved data fails after publishing', { cfg: { rules: [{ op: 'get', prefix: 'stockData/', after: 106, error: { code: 'not_granted', message: 'read-back refused' } }] } }, async page => {
    await upload(page, 'fund', 'may.csv', fundFileChanged().csv);
    const r = await run(page, 'fund'); const a = await readDb(page);
    ok(r.cls === 'err' && /read-back refused/.test(r.text), 'verify failure is reported: ' + r.text.slice(0, 200));
    ok(a.meta.version === 6, 'the new data is live (published before the check)');
    ok(!/No changes were published/.test(r.text) && /The new data had already been saved when this failed, so it is live\./.test(r.text), 'the message must not claim nothing was published when it was: "' + r.lines.slice(-1)[0] + '"');
  });

  // v1.199: the Technical CSV import is hidden, the TradingView refresh is the only visible route
  await runScenario('technical: the CSV import is hidden and the refresh options are shown', {}, async page => {
    const v = await page.evaluate(() => ({ csv: document.getElementById('techCsvOption').offsetParent === null, snap: document.getElementById('tvSnapshotBtn').offsetParent !== null, hist: document.getElementById('tvHistoryBtn').offsetParent !== null, backups: !!document.getElementById('fiBackups') || !!document.getElementById('ti_fiBackups') }));
    ok(v.csv && v.snap && v.hist && !v.backups, 'CSV hidden, refresh and history shown, no backups list: ' + JSON.stringify(v));
  });

  // ---- guards
  await runScenario('fund import: only the owner can import', { nonOwner: true, cfg: { owner: false } }, async page => {
    const s = await page.evaluate(() => ({ dis: ['importFundamentalDataBtn', 'importTechnicalDataBtn', 'refreshWatchlistBtn'].map(i => document.getElementById(i).disabled), titles: ['importFundamentalDataBtn', 'importTechnicalDataBtn', 'refreshWatchlistBtn'].map(i => document.getElementById(i).title), bk: !document.getElementById('fiBackups') }));
    eq(s.dis, [true, true, true], 'all three buttons disabled'); ok(s.titles.every(t => /Only the owner/.test(t)), 'each explains why: ' + s.titles.join(' | ')); ok(s.bk, 'there is no backups list');
    await page.evaluate(() => { for(const i of ['importFundamentalDataBtn', 'importTechnicalDataBtn', 'refreshWatchlistBtn']) document.getElementById(i).click(); }); await page.waitForTimeout(400);
    ok(await page.evaluate(() => ['fundImportPanel', 'ti_fundImportPanel', 'wl_fundImportPanel'].every(i => document.getElementById(i).hidden)), 'nothing starts');
    ok(!(await page.evaluate(() => window.__sets.some(p => /^(stockData|stockMeta|backupLog|importJobs|fundamentalCsvUploadLog|technicalCsvUploadLog)\//.test(p)))), 'nothing is written');
  });
  await runScenario('fund import: no file has been uploaded', {}, async page => {
    const r = await run(page, 'fund');
    ok(r.cls === 'err' && /there is no uploaded file waiting\. Use "Browse CSV…"/.test(r.text) && r.steps[0][0] === 'error', 'message: ' + r.text.slice(0, 200));
    const a = await readDb(page); ok(a.job.status === 'failed' && a.meta.version === 5 && a.backups.length === 0, 'nothing touched, lock released');
  });
  await runScenario('fund import: the stored file cannot be read', { docs: { 'fundamentalCsvUploadLog/2026-10-10T00_00_00_000Z': { assetId: 'ghost', url: '/_blob/ghost', filename: 'ghost.csv', uploadedAt: '2026-10-10T00:00:00.000Z', status: 'uploaded', rowCount: 3 } } }, async page => {
    const r = await run(page, 'fund'); ok(r.cls === 'err' && /could not read the stored file "ghost\.csv" \(404\)/.test(r.text), 'message: ' + r.text.slice(0, 200));
  });
  await runScenario('fund import: a file with the wrong layout is stopped before anything is read', {}, async page => {
    await upload(page, 'fund', 'short.csv', 'Name,NSE Code,ISIN Code\nA,AAA,INE1\nB,BBB,INE2\n');
    const r = await run(page, 'fund'); ok(r.cls === 'err' && /does not match the expected 44-column screener\.in layout\. Missing: .* … \+\d+/.test(r.text), 'message: ' + r.text.slice(0, 260));
    const a = await readDb(page); ok(a.backups.length === 0 && a.meta.version === 5, 'nothing backed up or written');
  });
  await runScenario('fund import: another import is already running', { docs: { 'importJobs/fundamental': { status: 'running', startedAt: new Date().toISOString() } } }, async page => {
    await upload(page, 'fund', 'may.csv', fundFileChanged().csv);
    const r = await run(page, 'fund'); ok(r.cls === 'err' && /another import is already running \(started/.test(r.text), 'message: ' + r.text.slice(0, 200));
    const a = await readDb(page); ok(a.job.status === 'running' && a.meta.version === 5, "the other import's lock is left alone");
  });
  await runScenario('fund import: a long-running import that is still sending heartbeats is respected', { docs: { 'importJobs/fundamental': { status: 'running', startedAt: new Date(Date.now() - 30 * 60000).toISOString(), heartbeatAt: new Date(Date.now() - 20000).toISOString() } } }, async page => {
    await upload(page, 'fund', 'may.csv', fundFileChanged().csv);
    const r = await run(page, 'fund'); ok(r.cls === 'err' && /another import is already running \(started .*last active/.test(r.text), 'message: ' + r.text.slice(0, 220));
  });
  await runScenario('fund import: an import started by this same tab before a reload is interrupted at once', {}, async page => {
    const tab = await page.evaluate(() => window.sessionStorage.getItem('albaJobTab'));
    ok(!!tab, 'the tab has an id');
    await page.evaluate(t => window.__setDoc('importJobs/fundamental', { status: 'running', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), owner: t }), tab);
    await upload(page, 'fund', 'may.csv', fundFileChanged().csv);
    const r = await run(page, 'fund'); ok(r.cls === 'ok', 'the import goes ahead straight away: ' + r.text.slice(0, 160));
  });
  await runScenario('fund import: an interrupted import (no heartbeat for minutes) is shown on the card and can be run again', { docs: { 'importJobs/fundamental': { status: 'running', startedAt: new Date(Date.now() - 10 * 60000).toISOString(), heartbeatAt: new Date(Date.now() - 5 * 60000).toISOString() } } }, async page => {
    await page.waitForFunction(() => /was interrupted/.test((document.getElementById('fundamentalLastFile') || {}).innerText || ''), null, { timeout: 15000 });
    await upload(page, 'fund', 'may.csv', fundFileChanged().csv);
    const r = await run(page, 'fund'); ok(r.cls === 'ok', 'the import goes ahead: ' + r.text.slice(0, 160));
    ok(await page.evaluate(() => !/was interrupted/.test(document.getElementById('fundamentalLastFile').innerText)), 'the interrupted notice is gone afterwards');
  });
  await runScenario('fund import: a lock with no activity for over 3 minutes is treated as abandoned', { docs: { 'importJobs/fundamental': { status: 'running', startedAt: new Date(Date.now() - 30 * 60000).toISOString() } } }, async page => {
    await upload(page, 'fund', 'may.csv', fundFileChanged().csv);
    const r = await run(page, 'fund'); ok(r.cls === 'ok', 'the import goes ahead: ' + r.text.slice(0, 160));
    ok((await readDb(page)).job.status === 'done', 'lock is now done');
  });
  await runScenario('fund import: too few stocks in the result is refused', { small: true }, async page => {
    await upload(page, 'fund', 'tiny.csv', DS.fundCsv(DS.rows.slice(0, 12)));
    const r = await run(page, 'fund');
    ok(r.cls === 'err' && /integrity check failed, nothing was written:\n?• only \d+ stocks in the result/.test(r.text.replace(/\n/g, '\n')) || (r.cls === 'err' && /integrity check failed, nothing was written/.test(r.text) && /only \d+ stocks in the result/.test(r.text)), 'message: ' + r.text.slice(0, 260));
    ok(r.steps.find(x => x[1] === 'Run integrity checks')[0] === 'error', 'the check step is the failed one');
    const a = await readDb(page); ok(a.meta.version === 3 && !(await page.evaluate(() => window.__sets.some(p => p.startsWith('stockData/')))), 'no stock data written');
    ok(a.fundLog[0].status === 'uploaded' && a.fundLog[0].lastAttempt && a.fundLog[0].lastAttempt.outcome === 'failed', 'the failed attempt is recorded on the file: ' + JSON.stringify(a.fundLog[0].lastAttempt));
    const lf = await page.evaluate(() => document.getElementById('fundamentalLastFile').innerText);
    ok(/tiny\.csv/.test(lf) && /last attempt failed/.test(lf) && /only \d+ stocks/.test(lf), 'the last-file card shows the failure: ' + lf.replace(/\s+/g, ' ').slice(0, 200));
  });
  await runScenario('fund import: a file that moves many scores asks first (cancel, then go ahead)', {}, async page => {
    const csv = fundFileShaken(); await upload(page, 'fund', 'shaken.csv', csv);
    const rec = (await readDb(page)).fundLog[0], exp = expectFund(csv, DS.stocks, indiaDay(rec.uploadedAt));
    const moved = exp.list.filter((s, i) => Math.abs(s.score - DS.stocks[i].score) >= 1.0).length;
    ok(moved > 40, 'test file really moves more than 40 stocks (' + moved + ')');
    await page.click(BTN_FUND); const p1 = await waitPrompt(page, 'fund');
    ok(new RegExp(moved + ' stocks moved by 1\\.0 point or more').test(p1.prompt) && /Nothing has been written yet\.$/.test(p1.prompt), 'the warning: ' + p1.prompt);
    await answer(page, 'fund', false);
    const c = await waitResult(page, 'fund'); ok(c.cls === 'warn' && c.lines[0] === 'Import cancelled before anything was written.', 'cancel result: ' + c.lines[0]);
    let a = await readDb(page); ok(a.meta.version === 5 && !(await page.evaluate(() => window.__sets.some(p => p.startsWith('stockData/')))), 'cancelling writes nothing'); ok(a.job.status === 'failed', 'lock released'); eq(a.fundLog[0].status, 'uploaded', 'file still waiting');
    await page.click(BTN_FUND); await waitPrompt(page, 'fund'); await answer(page, 'fund', true);
    const g = await waitResult(page, 'fund'); ok(g.cls === 'ok', 'second time, "Import anyway" goes through: ' + g.text.slice(0, 120));
    a = await readDb(page); sameStocks(a.stocks, exp.list, 'imported list equals the engine output'); eq(a.meta.version, 6, 'version bumped');
  });
}
const BTN_FUND = '#importFundamentalDataBtn';
// ---------------------------------------------------------------- 3. technical import
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
// an upload record that already exists when the page opens; the test then puts the file text into page.blobs under `id`
const seedRec = (which, id, name) => ({ [(which === 'fund' ? 'fundamentalCsvUploadLog/' : 'technicalCsvUploadLog/') + id]: { assetId: id, url: '/_blob/' + id, filename: name, uploadedAt: new Date().toISOString(), status: 'uploaded', rowCount: 1, newCount: 0, droppedCount: 0, sizeBytes: 10 } });
const csvRows = csv => { const rows = T.AlbaTechEngine.parseCSV(csv), h = rows[0].map(x => x.trim().toLowerCase()); return { rows, sym: h.indexOf('symbol'), price: h.indexOf('price') }; };
async function techScenarios(){
  // v1.185: the website keeps files in a private store with no public link; imports must read them through assets.read()
  await runScenario('private file store: an import reads the file through read(), never through a /_blob/ link', { cfg: { privateAssets: true } }, async page => {
    const file = techFile({}); await upload(page, 'tech', 'growth.csv', file.csv);
    const rec = (await readDb(page)).techLog[0]; ok(rec.url === null && !!rec.assetId, 'the upload record holds no public link: ' + JSON.stringify(rec.url));
    const r = await run(page, 'tech'); ok(r.cls === 'ok', 'the technical import ends green: ' + r.cls + ' ' + r.text.slice(0, 200));
    ok(page.blobRequests.length === 0, 'no /_blob/ link was used: ' + page.blobRequests.join(','));
  });
  await runScenario('tech import: full cycle with prices, kept readings and BSE symbols', {}, async page => {
    const file = techFile({ blankWeekRsi: true }); await upload(page, 'tech', 'growth.csv', file.csv);
    const orig = await readDb(page); const rec0 = orig.techLog[0], asof = indiaDay(rec0.uploadedAt);
    // the oracle: engine matches, then which of them keep their old reading because a component is missing
    const m = T.AlbaTechEngine.matchAndScore(file.csv, clone(DS.stocks), DS.bseAlpha);
    const COMP = { 'monthly MACD': 'monthMacd', 'weekly MACD': 'weekMacd', 'monthly RSI': 'monthRsi', 'weekly RSI': 'weekRsi' };
    const origBySym = new Map(DS.stocks.map(s => [symOf(s), s]));
    const kept = m.matched.filter(x => { const o = origBySym.get(symOf(x.stock)).technical; return x.missing.length && o && o.states && x.missing.some(c => o.states[COMP[c]] != null); }).map(x => symOf(x.stock));
    const matchedSyms = new Map(m.matched.map(x => [symOf(x.stock), x]));
    ok(m.matched.length > 1700 && kept.length > 10 && kept.length <= 25, `test file shape: ${m.matched.length} matched, ${kept.length} kept`);
    const r = await run(page, 'tech');
    ok(r.cls === 'ok', 'technical import ends green: ' + r.cls + ' ' + r.text.slice(0, 240));
    ok(r.steps.length === 6 && r.steps.every(x => x[0] === 'done') && r.pct === '100%', 'six steps done: ' + JSON.stringify(r.steps.map(x => x[0])));
    ok(r.lines[0] === 'Import complete.', 'first line: ' + r.lines[0]);
    ok(r.text.includes(`${fmtIn(m.matched.length - kept.length)} stocks rescored · ${kept.length} kept as they were (curated)`), 'summary: ' + r.lines[1]);
    ok(/Average technical score \d\.\d\d → \d\.\d\d\./.test(r.text), 'average line'); ok(/No new BSE symbols needed\./.test(r.text), 'BSE line: ' + r.text.slice(-300));
    ok(/Kept \(a component is missing from the file but was present before\): /.test(r.text), 'kept stocks are listed');
    const a = await readDb(page);
    eq(a.meta.version, 6, 'version bumped'); eq(a.meta.count, 2004, 'no stock added or removed (technical import never adds stocks)');
    // every stock: matched ones carry the engine's score, kept ones are untouched, unmatched ones are untouched
    let bad = [], priced = 0;
    const csvInfo = csvRows(file.csv), priceBySym = new Map(csvInfo.rows.slice(1).map(x => [x[csvInfo.sym].toUpperCase(), Math.round(parseFloat(x[csvInfo.price]) * 100) / 100]));
    for(const [sym, st] of a.stocks){
      const o = origBySym.get(sym), mm = matchedSyms.get(sym);
      if(canon({ score: st.score, verdict: st.verdict, pillars: st.pillars, globalFactors: st.globalFactors, name: st.name, ticker: st.ticker }) !== canon({ score: o.score, verdict: o.verdict, pillars: o.pillars, globalFactors: o.globalFactors, name: o.name, ticker: o.ticker })) bad.push('fundamental fields changed: ' + sym);
      if(!mm){ if(canon(st) !== canon(o)) bad.push('not in file but changed: ' + sym); continue; }
      if(kept.includes(sym)){ if(canon(st.technical) !== canon(o.technical)) bad.push('kept reading changed: ' + sym); }
      else if(!(st.technical && st.technical.score === mm.score && st.technical.asof === asof && canon(st.technical.states.monthMacd) === canon(mm.states.monthMacd) && canon(st.technical.states.weekRsi) === canon(mm.states.weekRsi))) bad.push('wrong technical block: ' + sym);
      const u = symOf(st).toUpperCase(), price = [...new Set([mm.matchedSymbol, u, u.replace(/-/g, '_'), u.replace(/_/g, '-')])].map(x => priceBySym.get(x)).find(x => x != null);
      if(price != null && o.valuation && o.valuation.intrinsicValue > 0){
        priced++;
        const mos = (o.valuation.intrinsicValue - price) / o.valuation.intrinsicValue * 100, dcf = st.fundamentals.factors.find(f => f.key === 'dcf');
        if(st.valuation.currentPrice !== price || st.valuation.asof !== asof || st.valuation.intrinsicValue !== o.valuation.intrinsicValue) bad.push('price not refreshed (or intrinsic value touched): ' + sym);
        if(dcf.metrics.find(x => x[0] === 'Current price')[1] !== String(price) || dcf.metrics.find(x => x[0] === 'Margin of safety')[1] !== f1(mos) + '%') bad.push('margin of safety text wrong: ' + sym);
      }
    }
    ok(bad.length === 0, `${bad.length} stocks wrong after the import (${priced} prices checked): ${bad.slice(0, 5).join('; ')}`);
    ok(r.text.includes(`${fmtIn(priced)} current prices and margins of safety refreshed.`), 'price line should say ' + priced + ' but lines are: ' + r.lines.map(l => l.slice(0, 90)).join(' | '));
    // bookkeeping
    const csvRuns = Object.entries(a.all).filter(([k]) => k.startsWith('refreshRunLog/csv-')).map(([, v]) => v);
    ok(csvRuns.length === 1 && csvRuns[0].kind === 'csv' && csvRuns[0].trigger === 'manual' && csvRuns[0].saved > 0 && csvRuns[0].saved + csvRuns[0].kept === csvRuns[0].planned && csvRuns[0].error === null && csvRuns[0].durationMs >= 0, 'the import leaves one run record: ' + JSON.stringify(csvRuns));
    const csvTxt = await page.evaluate(() => document.getElementById('lastRuns_csv').innerText); ok(/Last 2 runs/.test(csvTxt) && /manual/.test(csvTxt) && /saved/.test(csvTxt), 'and the Last 2 runs list shows it: ' + csvTxt.replace(/\s+/g, ' '));
    ok(a.techLog[0].status === 'processed' && /^Imported in the page: /.test(a.techLog[0].processedNote), 'upload record processed');
    ok(a.job.status === 'done' && a.job.kind === 'technical', 'lock released: ' + JSON.stringify(a.job));
    // BSE-only stocks without a TradingView symbol were looked up once and the misses remembered
    const tried = a.all['stockMeta/bseLookupTried']; ok(tried && Object.keys(tried).sort().join() === '512342,512343', 'misses remembered: ' + JSON.stringify(tried));
    eq(a.all['stockMeta/bseAlpha'], DS.bseAlpha, 'no symbol map change when nothing was found');
    // the Fundamental panel is not disturbed by a technical run
    ok(await page.evaluate(() => document.getElementById('fundImportPanel').hidden), 'the other panel stays closed');
    // a second import of the same file changes nothing
    await upload(page, 'tech', 'growth-again.csv', file.csv);
    const r2 = await run(page, 'tech'); ok(r2.cls === 'ok' && /the file produced no changes/.test(r2.text), 'repeat: ' + r2.lines[0]);
    eq((await readDb(page)).meta.version, 6, 'no version bump on a repeat');
  });

  const seedBad = async (name, text, fn) => runScenario('tech import: ' + name, { docs: seedRec('tech', 'bad1', 'bad.csv') }, async page => { page.blobs.set('bad1', text); await fn(page); });
  const header = 'Symbol,Price,Price change % 1 week,Price change % 1 month,"Moving Average Convergence Divergence Level (12, 26) 1 month","Moving Average Convergence Divergence Signal (12, 26) 1 month","Moving Average Convergence Divergence Level (12, 26) 1 week","Moving Average Convergence Divergence Signal (12, 26) 1 week",Relative Strength Index (14) 1 month,Relative Strength Index (14) 1 week';
  await seedBad('a file without a Symbol column is refused', 'Ticker,Price\nABC,1\nDEF,2\n', async page => { const r = await run(page, 'tech'); ok(r.cls === 'err' && /the file has no "Symbol" column, so it does not look like a TradingView export\./.test(r.text) && /No changes were published/.test(r.text), r.text.slice(0, 220)); eq((await readDb(page)).backups.length, 0, 'no backup yet'); });
  await seedBad('a file with only a header is refused', header + '\n', async page => { const r = await run(page, 'tech'); ok(r.cls === 'err' && /the file has no data rows\./.test(r.text), r.text.slice(0, 200)); });
  await seedBad('a file without the technical columns is refused', 'Symbol,Price\nABC,1\nDEF,2\n', async page => { const r = await run(page, 'tech'); ok(r.cls === 'err' && /missing most of the MACD \/ RSI columns \(monthMacdSignal, monthMacdLevel, weekMacdSignal, weekMacdLevel, monthRsi, weekRsi\)\. Re-export/.test(r.text), r.text.slice(0, 260)); });
  await seedBad('a file where no symbol matches any stock is refused', header + '\nQQQ1,10,1,1,1,0,1,0,50,50\nQQQ2,10,1,1,1,0,1,0,50,50\n', async page => {
    const r = await run(page, 'tech'); ok(r.cls === 'err' && /integrity check failed, nothing was written/.test(r.text) && /no stock in the file matched a stock on the dashboard/.test(r.text), r.text.slice(0, 260));
    const a = await readDb(page); eq(a.meta.version, 5, 'nothing written'); ok(a.job.status === 'failed', 'lock released as failed');
  });
  // pressing Import while the new file is still being saved must import that new file, not the older one that is still waiting
  await runScenario('tech import: Import pressed while a new upload is still being saved uses the new file', { docs: seedRec('tech', 'old1', 'old.csv') }, async page => {
    page.blobs.set('old1', techFile({ seed: 11 }).csv);
    const fresh = techFile({ seed: 22 });
    await page.evaluate(() => { window.__uploadDelay = 1500; });
    await page.setInputFiles('#technicalCsvInput', { name: 'today.csv', mimeType: 'text/csv', buffer: Buffer.from(fresh.csv) });
    await page.waitForFunction(() => /Will update/.test(document.getElementById('technicalUploadResult').textContent), null, { timeout: 30000 });
    const r = await run(page, 'tech');
    ok(r.cls === 'ok', 'the import ends green: ' + r.text.slice(0, 200));
    const db = await readDb(page);
    const done = db.techLog.filter(x => x.status === 'processed').map(x => x.filename);
    eq(done, ['today.csv'], 'the new file is the one imported');
    ok(db.techLog.some(x => x.filename === 'old.csv' && x.status === 'uploaded'), 'the older file is left alone');
  });
  // a same-day saved update (from a Live Data refresh) must not hide the price and readings the file just brought
  {
    const f = techFile({ seed: 5 }), mm = T.AlbaTechEngine.matchAndScore(f.csv, clone(DS.stocks), DS.bseAlpha);
    const priced = mm.matched.filter(x => !x.missing.length && x.stock.valuation && x.stock.valuation.intrinsicValue > 0).slice(0, 2).map(x => symOf(x.stock));
    const today = indiaDay(new Date().toISOString());
    const upd = (sym, day) => ({ ['stockUpdates/' + sym]: { ticker: sym, asof: day, valuation: { asof: day, currentPrice: 1.11, source: 'test' }, technical: { asof: day, score: 1, reason: 'old' }, globalFactors: { scope: 's', asof: day, positive: ['x'], negative: [] } } });
    await runScenario('tech import: an update saved earlier the same day gives way to the file; a later-dated one stays', { docs: Object.assign({}, seedRec('tech', 'u1', 'u.csv'), upd(priced[0], today), upd(priced[1], '2099-01-01')) }, async page => {
      page.blobs.set('u1', f.csv);
      const r = await run(page, 'tech');
      ok(r.cls === 'ok', 'import ends green: ' + r.text.slice(0, 160));
      ok(r.steps.some(x => x[1] === 'Verify and finish' && x[0] === 'done'), 'the last step ends done');
      ok(/1 earlier saved price/.test(r.text), 'the result says an earlier update was replaced: ' + r.text.slice(-260));
      const all = (await readDb(page)).all;
      const a = all['stockUpdates/' + priced[0]], b = all['stockUpdates/' + priced[1]];
      ok(a && !a.valuation && !a.technical && a.globalFactors, 'the same-day update lost its price and technical block and kept its global factors: ' + JSON.stringify(a).slice(0, 160));
      ok(b && b.valuation && b.technical, 'the later-dated update is left alone');
    });
  }
  await runScenario('tech import: no file has been uploaded', {}, async page => { const r = await run(page, 'tech'); ok(r.cls === 'err' && /there is no uploaded file waiting\. Use "Browse CSV…" to upload the TradingView Growth List export first\./.test(r.text), r.text.slice(0, 200)); });
  await runScenario('tech import: another import holds the lock', { docs: { 'importJobs/fundamental': { status: 'running', startedAt: new Date().toISOString() } } }, async page => {
    await upload(page, 'tech', 'growth.csv', techFile().csv); const r = await run(page, 'tech'); ok(r.cls === 'err' && /another import is already running/.test(r.text), r.text.slice(0, 200));
    ok((await readDb(page)).job.status === 'running', "the other lock is left alone");
  });
  await runScenario('tech import: a partial file asks first (cancel, then go ahead)', {}, async page => {
    const file = techFile({ limit: 900 }); await upload(page, 'tech', 'partial.csv', file.csv);
    await showTechCsv(page); await page.click(BTN_TECH); const p = await waitPrompt(page, 'tech');
    ok(/^Only \d+ dashboard stocks matched a row in the file \(normally about 2,100\)\. That can mean a partial export or the wrong file\. Nothing has been written yet\.$/.test(p.prompt), 'warning: ' + p.prompt);
    await answer(page, 'tech', false); const c = await waitResult(page, 'tech');
    ok(c.cls === 'warn' && c.lines[0] === 'Import cancelled before anything was written.', 'cancel: ' + c.lines[0]);
    let a = await readDb(page); ok(a.meta.version === 5 && a.job.status === 'failed', 'nothing written, lock released'); eq(a.techLog[0].status, 'uploaded', 'file still waiting');
    await showTechCsv(page); await page.click(BTN_TECH); await waitPrompt(page, 'tech'); await answer(page, 'tech', true); const g = await waitResult(page, 'tech');
    ok(g.cls === 'ok', 'import anyway: ' + g.text.slice(0, 100)); a = await readDb(page); eq(a.meta.version, 6, 'version bumped'); eq(a.techLog[0].status, 'processed', 'file processed');
  });
  await runScenario('tech import: many readings kept because the file lacks a column asks first', {}, async page => {
    await upload(page, 'tech', 'growth.csv', techFile({ blankWeekRsi: 'many' }).csv);
    await showTechCsv(page); await page.click(BTN_TECH); const p = await waitPrompt(page, 'tech');
    ok(/^\d+ stocks have a component missing from this file that they had before, so their previous reading was kept\. Nothing has been written yet\.$/.test(p.prompt) && parseInt(p.prompt, 10) > 25, 'warning: ' + p.prompt);
    await answer(page, 'tech', false); const c = await waitResult(page, 'tech'); ok(c.cls === 'warn', 'cancel');
    ok((await readDb(page)).meta.version === 5, 'nothing written');
  });
  await runScenario('tech import: a BSE-only stock gets its TradingView symbol from an exact-name search', { cfg: { tvSearch: {
      'Bse Only 2': [{ symbol: 'BSE:ALPHATHREE', exchange: 'BSE', type: 'stock', description: 'Bse Only 2 Ltd' }],
      'Bse Only 3': [{ symbol: 'BSE:NEARMISS', exchange: 'BSE', type: 'stock', description: 'Bse Only 3 Industries' }] } } }, async page => {
    const file = techFile(); const extra = '\nALPHATHREE,desc,321.5,1,2,0.5,0.2,0.4,0.1,58,52'; await upload(page, 'tech', 'growth.csv', file.csv.trimEnd() + extra + '\n');
    const r = await run(page, 'tech'); ok(r.cls === 'ok' && /1 new BSE symbol\(s\) found and saved\./.test(r.text), 'result: ' + r.text.slice(-260));
    const a = await readDb(page);
    eq(a.all['stockMeta/bseAlpha'], Object.assign({}, DS.bseAlpha, { '512342': 'ALPHATHREE' }), 'the new symbol is saved for next time');
    eq(Object.keys(a.all['stockMeta/bseLookupTried']), ['512343'], 'the near miss is remembered, the hit is not');
    const st = a.stocks.get('512342'); ok(st.technical.asof === indiaDay(a.techLog[0].uploadedAt) && st.technical.score != null && st.valuation.currentPrice === 321.5, 'the stock was scored from the matched row and priced: ' + JSON.stringify(st.technical.asof) + ' ' + st.valuation.currentPrice);
  });
  await runScenario('tech import: a failed write is rolled back', { cfg: { rules: [{ op: 'set', prefix: 'stockData/', nth: 3, error: { code: 'not_granted', message: 'write refused' } }] } }, async page => {
    await upload(page, 'tech', 'growth.csv', techFile().csv); const before = await readDb(page);
    const r = await run(page, 'tech'); ok(r.cls === 'err' && /Could not save the stock data \(not_granted: write refused\)\. Your previous data was put back\./.test(r.text) && /The previous data is back in place\./.test(r.text), r.text.slice(0, 260));
    const a = await readDb(page); ok(before.meta.chunks.every(c => canon(a.chunkDocs[c]) === canon(before.chunkDocs[c])) && a.meta.version === 5, 'every chunk and the index are as before'); sameStocks(a.stocks, DS.stocks, 'stock list as before');
    ok(a.job.status === 'failed' && a.job.kind === 'technical' && a.techLog[0].status === 'uploaded', 'lock failed, file still waiting');
  });
}
const BTN_TECH = '#importTechnicalDataBtn';
// ---------------------------------------------------------------- 4. TradingView watchlist sync
const WL = ['Alba Securities', 'Alba - Green', 'Alba - Orange', 'Alba - Red'];
const WL_CONFIRMED = { 'KLBRENG-B': 'NSE:KLBRENG_B', 'NAM-INDIA': 'NSE:NAM_INDIA', 'J&KBANK': 'NSE:J&KBANK', 'GVT&D': 'NSE:GVT&D' };
// the four lists the sync should produce from the stock list (written out independently of the page's code)
function wlExpect(stocks, alpha){
  const lists = Object.fromEntries(WL.map(n => [n, []])); let strong = 0, good = 0; const left = [];
  for(const s of stocks){
    if(s.verdict !== 'buy' && s.verdict !== 'mbuy') continue;
    const code = symOf(s); let sym;
    if(/^\d+$/.test(code)){ if(!alpha[code]){ left.push(code); continue; } sym = 'BSE:' + alpha[code]; }
    else if(WL_CONFIRMED[code]) sym = WL_CONFIRMED[code]; else if(/[-&]/.test(code)) sym = 'NSE:' + code.replace(/[-&]/g, '_'); else sym = 'NSE:' + code;
    if(s.verdict === 'buy') strong++; else good++;
    lists['Alba Securities'].push(sym);
    const v = s.valuation || {};
    if(typeof v.intrinsicValue === 'number' && v.intrinsicValue > 0 && typeof v.currentPrice === 'number'){ const mos = (v.intrinsicValue - v.currentPrice) / v.intrinsicValue * 100; lists[mos >= 0 ? 'Alba - Green' : mos >= -25 ? 'Alba - Orange' : 'Alba - Red'].push(sym); }
  }
  return { lists, strong, good, left };
}
const WLX = wlExpect(DS.stocks, DS.bseAlpha);
const tvList = (id, name, symbols, extra) => Object.assign({ id: String(id), name, type: 'custom', symbols }, extra || {});
const own = () => [tvList(1, 'My Own List', ['NSE:AAA', 'NSE:BBB']), { id: '2', name: null, type: 'colored', color: 'red', symbols: ['NSE:ZZZ'] }];
const tvState = page => page.evaluate(() => JSON.parse(JSON.stringify({ lists: window.__tv.lists, calls: window.__tv.calls })));
const callsOf = (st, tool) => st.calls.filter(c => c[0] === tool);
const setOf = a => [...new Set(a)].sort();
async function watchlistScenarios(){
  ok(WLX.strong + WLX.good > 150 && WLX.lists['Alba - Green'].length > 50 && WLX.lists['Alba - Orange'].length > 3 && WLX.lists['Alba - Red'].length > 0, 'test data has stocks for all four lists: ' + WL.map(n => WLX.lists[n].length).join('/'));
  await runScenario('watchlist sync: first sync creates the four lists and leaves other lists alone', { cfg: { tvLists: own() } }, async page => {
    const r = await run(page, 'wl');
    ok(r.cls === 'warn' || r.cls === 'ok', 'finishes: ' + r.cls + ' ' + r.text.slice(0, 200));
    ok(r.steps.length === 6 && r.steps.every(x => x[0] === 'done') && r.pct === '100%', 'six steps done: ' + JSON.stringify(r.steps.map(x => x[0])));
    ok(r.lines[0] === 'Sync complete.' && r.cls === 'ok', 'first line: ' + r.lines[0]);
    const total = WL.reduce((a, n) => a + WLX.lists[n].length, 0);
    ok(r.text.includes(`${WLX.strong} Strong + ${WLX.good} Good stocks qualify · ${total} added · 0 removed in total.`), 'totals line: ' + r.lines.slice(-3).join(' | '));
    ok(WL.every((n, i) => r.lines.includes(`${n}: ${WLX.lists[n].length} symbols (+${WLX.lists[n].length} / −0)`)), 'per-list lines: ' + r.lines.join(' | ').slice(0, 300));
    ok(/Symbols with - or & that were not checked beforehand: BAJAJ-AUTO\./.test(r.text), 'unchecked symbols named');
    const st = await tvState(page);
    for(const n of WL){ const l = st.lists.filter(x => x.name === n); ok(l.length === 1 && l[0].type === 'custom' && JSON.stringify(setOf(l[0].symbols)) === JSON.stringify(setOf(WLX.lists[n])), `${n}: exactly one list holding the right ${WLX.lists[n].length} symbols (found ${l.length}/${l[0] && l[0].symbols.length})`); }
    ok(WLX.lists['Alba Securities'].includes('BSE:ALPHAONE') && WLX.lists['Alba Securities'].includes('NSE:BAJAJ_AUTO') && WLX.lists['Alba Securities'].includes('NSE:J&KBANK') && WLX.lists['Alba Securities'].includes('NSE:KLBRENG_B') && !WLX.lists['Alba Securities'].some(x => /BSE:\d/.test(x)), 'symbol spellings: BSE alpha, underscores, confirmed names, never a raw BSE number');
    ok(st.lists.some(x => x.name === 'My Own List' && x.symbols.join() === 'NSE:AAA,NSE:BBB') && st.lists.some(x => x.type === 'colored' && x.symbols.join() === 'NSE:ZZZ'), "the person's other lists are untouched");
    ok(!st.lists.some(x => /\(syncing\)/.test(x.name || '')) && callsOf(st, 'mcp-watchlist-delete-watchlist').length === 0, 'no temporary list left and nothing deleted');
    const a = await readDb(page); ok(a.wlJob.status === 'done', 'lock released: ' + JSON.stringify(a.wlJob));
    eq(a.wlLog.length, 1, 'one log entry'); const lg = a.wlLog[0]; ok(lg.status === 'completed' && lg.qualifiedCount === WLX.strong + WLX.good && lg.strongBuyCount === WLX.strong && lg.moderateBuyCount === WLX.good && lg.added === total && lg.removed === 0 && lg.triggeredBy === 'manual', 'log entry: ' + JSON.stringify(lg).slice(0, 300));
    ok(a.meta.version === 5 && !(await page.evaluate(() => window.__sets.some(p => /^stockData\//.test(p)))), 'the stock data is not touched by a sync');
    ok(await page.evaluate(() => !document.getElementById('wl_fiResult').querySelector('button')), 'no "reload" button after a sync');
  });
  await runScenario('watchlist sync: a repeat sync with nothing new changes nothing', { cfg: { tvLists: WL.map((n, i) => tvList(10 + i, n, WLX.lists[n].slice().reverse())) } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'ok' && r.lines[0] === 'Sync complete.', r.text.slice(0, 160));
    ok(WL.every(n => r.lines.includes(`${n}: ${WLX.lists[n].length} symbols, unchanged`)) && r.text.includes('· 0 added · 0 removed in total.'), 'every list reported unchanged (order does not matter): ' + r.lines.join(' | ').slice(0, 300));
    const st = await tvState(page); ok(st.calls.every(c => c[0] === 'mcp-watchlist-list-watchlists') && st.lists.map(l => l.id).join() === '10,11,12,13', 'no write of any kind, same list ids');
    eq((await readDb(page)).wlLog[0].status, 'completed', 'logged as completed');
  });
  await runScenario('watchlist sync: changed lists are built beside the old one, then swapped', { cfg: { tvLists: own().concat([
      tvList(20, 'Alba Securities', WLX.lists['Alba Securities'].slice(0, 150).concat(['NSE:OLD1', 'NSE:OLD2', 'NSE:OLD3', 'NSE:OLD4', 'NSE:OLD5'])),
      tvList(21, 'Alba - Green', WLX.lists['Alba - Green']), tvList(22, 'Alba - Red', ['NSE:OLDRED'])]) } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'ok', 'finishes: ' + r.text.slice(0, 200));
    const sec = WLX.lists['Alba Securities'].length;
    ok(r.lines.includes(`Alba Securities: ${sec} symbols (+${sec - 150} / −5)`) && r.lines.includes(`Alba - Green: ${WLX.lists['Alba - Green'].length} symbols, unchanged`) && r.lines.includes(`Alba - Orange: ${WLX.lists['Alba - Orange'].length} symbols (+${WLX.lists['Alba - Orange'].length} / −0)`) && r.lines.includes(`Alba - Red: ${WLX.lists['Alba - Red'].length} symbols (+${WLX.lists['Alba - Red'].length} / −1)`), 'per-list lines: ' + r.lines.join(' | ').slice(0, 400));
    const st = await tvState(page);
    for(const n of WL){ const l = st.lists.filter(x => x.name === n); ok(l.length === 1 && JSON.stringify(setOf(l[0].symbols)) === JSON.stringify(setOf(WLX.lists[n])), n + ' is right'); }
    ok(st.lists.find(x => x.name === 'Alba - Green').id === '21', 'an unchanged list keeps its id'); ok(!st.lists.some(x => x.id === '20' || x.id === '22'), 'the old versions are gone');
    // order of events for "Alba Securities": the new list exists before the old one is deleted, and the rename comes last
    const seq = st.calls.map(c => c[0] + ':' + (c[1].name || c[1].watchlist_id || ''));
    const iCreate = seq.indexOf('mcp-watchlist-create-watchlist:Alba Securities (syncing)'), iDelete = seq.indexOf('mcp-watchlist-delete-watchlist:20'), iRename = seq.findIndex(x => /^mcp-watchlist-update-watchlist:Alba Securities$/.test(x));
    ok(iCreate >= 0 && iCreate < iDelete && iDelete < iRename, `create (${iCreate}) before delete (${iDelete}) before rename (${iRename})`);
    ok(callsOf(st, 'mcp-watchlist-delete-watchlist').length === 2, 'only the two replaced lists were deleted');
    ok(st.lists.some(x => x.name === 'My Own List') && st.lists.some(x => x.type === 'colored'), "the person's other lists are untouched");
  });
  await runScenario('watchlist sync: a few symbols TradingView will not take are reported, the rest goes ahead', { cfg: { tvRefuse: WLX.lists['Alba Securities'].slice(0, 3), tvLists: own() } }, async page => {
    const gone = WLX.lists['Alba Securities'].slice(0, 3);
    const r = await run(page, 'wl'); ok(r.cls === 'warn' && r.lines[0] === 'Sync finished with gaps.', 'finishes with gaps: ' + r.cls + ' ' + r.lines[0]);
    ok(new RegExp('TradingView could not resolve: ' + gone.map(g => g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(', ')).test(r.text) || gone.every(g => r.text.includes(g)), 'names the dropped symbols: ' + r.lines.slice(-2).join(' | '));
    const st = await tvState(page); const sec = st.lists.find(x => x.name === 'Alba Securities');
    ok(sec && JSON.stringify(setOf(sec.symbols)) === JSON.stringify(setOf(WLX.lists['Alba Securities'].filter(x => !gone.includes(x)))), 'the list holds everything except the dropped ones');
    eq((await readDb(page)).wlLog[0].status, 'partial', 'logged as partial');
  });
  await runScenario('watchlist sync: too many refused symbols leaves the existing list untouched', { cfg: { tvRefuse: WLX.lists['Alba Securities'].slice(0, 50), tvLists: own().concat([tvList(20, 'Alba Securities', ['NSE:KEEPME1', 'NSE:KEEPME2'])]) } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'err' && new RegExp('TradingView did not accept 50 of ' + WLX.lists['Alba Securities'].length + ' symbols, so the existing "Alba Securities" list was left untouched').test(r.text), 'message: ' + r.text.slice(0, 300));
    const st = await tvState(page); const old = st.lists.find(x => x.id === '20');
    ok(old && old.name === 'Alba Securities' && old.symbols.join() === 'NSE:KEEPME1,NSE:KEEPME2', 'the existing list is exactly as before');
    ok(callsOf(st, 'mcp-watchlist-delete-watchlist').length === 0, 'nothing was deleted'); ok(st.lists.some(x => x.name === 'Alba Securities (syncing)'), 'the new list is left for a person, under its temporary name');
    const a = await readDb(page); ok(a.wlLog[0].status === 'failed' && a.wlJob.status === 'failed', 'logged and the lock released as failed');
  });
  await runScenario('watchlist sync: stops at once if deleting a list also removes another', { cfg: { tvAlsoDelete: 'Alba - Green', tvLists: own().concat([tvList(20, 'Alba Securities', ['NSE:OLD1']), tvList(21, 'Alba - Green', ['NSE:OLDGREEN'])]) } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'err' && /Safety stop: after deleting "Alba Securities" these lists are also gone: Alba - Green\. Nothing more was touched\./.test(r.text), 'message: ' + r.text.slice(0, 300));
    const st = await tvState(page); eq(callsOf(st, 'mcp-watchlist-delete-watchlist').length, 1, 'exactly one delete was attempted');
    ok(st.lists.some(x => x.name === 'My Own List') && !st.lists.some(x => x.name === 'Alba - Orange' || x.name === 'Alba - Red'), 'no further lists were touched');
    ok((await readDb(page)).wlLog[0].status === 'failed', 'logged as failed');
  });
  await runScenario('watchlist sync: a temporary list left by an earlier failed run is cleaned up', { cfg: { tvLists: own().concat([tvList(30, 'Alba Securities (syncing)', ['NSE:JUNK'])]) } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'ok', 'finishes: ' + r.text.slice(0, 160));
    const st = await tvState(page); ok(!st.lists.some(x => x.id === '30' || /\(syncing\)/.test(x.name || '')), 'the leftover is gone'); ok(st.lists.filter(x => x.name === 'Alba Securities').length === 1, 'one proper list');
  });
  await runScenario('watchlist sync: without a TradingView connection nothing is attempted', { cfg: { noMcp: true } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'err' && /Sync stopped: The TradingView connector is not available in this view\./.test(r.text), 'message: ' + r.text.slice(0, 200));
    const a = await readDb(page); ok(a.wlLog[0].status === 'failed' && a.wlJob.status === 'failed', 'logged as failed');
  });
  await runScenario('watchlist sync: another sync is already running', { docs: { 'importJobs/watchlist': { status: 'running', startedAt: new Date().toISOString() } } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'err' && /another sync is already running \(started/.test(r.text), 'message: ' + r.text.slice(0, 200));
    const st = await tvState(page); eq(st.calls.length, 0, 'TradingView was not contacted'); ok((await readDb(page)).wlJob.status === 'running', "the other lock is left alone");
  });
  await runScenario('watchlist sync: a database with too few qualifying stocks is refused', { small: true }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'err' && /Sync stopped: only \d+ stocks qualify, which looks wrong, so nothing was changed in TradingView/.test(r.text), 'message: ' + r.text.slice(0, 220));
    eq((await tvState(page)).calls.length, 0, 'TradingView was not contacted');
  });
  await runScenario('watchlist sync: BSE-only stocks are looked up by exact company name and the symbol is saved', { docs: { 'stockMeta/bseAlpha': {} }, cfg: { tvSearch: {
      'Bse Only 0': [{ symbol: 'BSE:ALPHAONE', exchange: 'BSE', type: 'stock', description: 'Bse Only 0 Limited' }],
      'Bse Only 1': [{ symbol: 'BSE:ALPHAX', exchange: 'BSE', type: 'stock', description: 'Bse Only 1 Industries' }] } } }, async page => {
    const r = await run(page, 'wl'); ok(r.cls === 'warn' && r.lines[0] === 'Sync finished with gaps.' && /No TradingView symbol yet \(left out\): 512341 Bse Only 1/.test(r.text), 'result: ' + r.text.slice(0, 400));
    const a = await readDb(page); eq(a.all['stockMeta/bseAlpha'], { '512340': 'ALPHAONE' }, 'the exact match is saved, the near miss is not');
    const st = await tvState(page); const sec = st.lists.find(x => x.name === 'Alba Securities'); ok(sec.symbols.includes('BSE:ALPHAONE') && !sec.symbols.some(x => /ALPHAX|512341/.test(x)), 'the matched stock is on the list, the unmatched one left out');
    eq(a.wlLog[0].status, 'partial', 'logged as partial');
  });
}

// ---------------------------------------------------------------- 5. Refresh from TradingView (snapshot and history)
async function tvRefreshScenarios(){
  const first = symOf(DS.stocks.find(s => !/^\d/.test(symOf(s)))), today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const keep = { ticker: first, technical: { score: 7, asof: today, basis: { week: '2026-10-05', month: '2026-09-01' }, states: {}, raw: {}, reason: 'kept' } };
  await runScenario('refresh from TradingView: every stock gets a price and a snapshot score, a fresh completed-weeks score is kept', { docs: { ['stockUpdates/' + first]: keep }, cfg: { liveCollections: true } }, async page => {
    await page.click('#tvSnapshotBtn');
    await page.waitForSelector('#tv_fiResult.fi-result-ok, #tv_fiResult.fi-result-err', { timeout: 120000 });
    const r = await page.evaluate(() => ({ cls: /fi-result-(ok|err)/.exec(document.getElementById('tv_fiResult').className)[1], text: document.getElementById('tv_fiResult').textContent, calls: (window.__tvBatchCalls || []).map(c => c.symbols.length), btn: !!document.getElementById('tv_fiResult').querySelector('button') }));
    ok(r.cls === 'ok', 'finishes: ' + r.text.slice(0, 240));
    ok(r.calls.length >= 1 && r.calls.every(n => n <= 50), 'batches of at most 50: ' + r.calls.join(','));
    const asked = await page.evaluate(() => [].concat(...(window.__tvBatchCalls || []).map(c => c.symbols)));
    ok(asked.includes('NSE:J&KBANK') && !asked.includes('NSE:J_KBANK') && asked.includes('NSE:BAJAJ_AUTO'), 'a & in a ticker is kept, a hyphen becomes an underscore');
    await page.waitForFunction(() => { const row = [...document.querySelectorAll('#techFreshnessBars .refreshlog-freshness-row')].find(e => /Today/.test(e.textContent)); return row && parseInt(row.querySelector('.refreshlog-freshness-count').textContent, 10) > 100; }, null, { timeout: 15000 }).catch(() => {});
    const today0 = await page.evaluate(() => { const row = [...document.querySelectorAll('#techFreshnessBars .refreshlog-freshness-row')].find(e => /Today/.test(e.textContent)); return row ? parseInt(row.querySelector('.refreshlog-freshness-count').textContent, 10) : -1; });
    ok(today0 > 100, 'the technical data age bars show the refreshed stocks as Today without a reload: ' + today0);
    const a = await readDb(page), chunks = Object.entries(a.all).filter(([k]) => k.startsWith('liveSnapshot/')).sort(([x], [y]) => (x < y ? -1 : 1));
    const rows = [].concat(...chunks.map(([, v]) => v.rows));
    ok(chunks.length >= 1 && chunks.length === r.calls.length && chunks.every(([k, v], i) => k === 'liveSnapshot/c' + String(i + 1).padStart(3, '0') && v.v === 1 && v.asof === today && typeof v.at === 'string' && v.rows.length <= 50), 'one record per TradingView batch: ' + r.calls.length + ' calls, today ' + today + ', ' + chunks.slice(-2).map(([k, v]) => k + ':' + v.rows.length + ':' + v.asof + ':' + v.v + ':' + v.at).join(','));
    ok(rows.length > 100 && rows.every(x => x.c[0] === 111.1 && typeof x.k === 'string' && typeof x.y === 'string'), 'a price for every stock: ' + rows.length);
    ok(rows.filter(x => x.c[9] === 50000).length === rows.length, 'every row carries its average daily volume');
    ok(Object.keys(a.all).filter(k => k.startsWith('stockUpdates/')).length === 1, 'no per-stock record was written');
    // what the page shows after merging: snapshot scores for most stocks, the fresh completed-weeks score and note kept for the stock that had one
    const m = await page.evaluate(first => { const S = window.__alba.stocks; const one = S.filter(s => s.technical && s.technical.src === 'snapshot').length; const k = S.find(s => (window.__alba.sanitizeDocId ? window.__alba.sanitizeDocId(window.__alba.tickerSymbol(s)) : '') === first); return { snapCount: one, priced: S.filter(s => s.valuation && s.valuation.currentPrice === 111.1).length, kept: k && { px: k.valuation.currentPrice, score: k.technical.score, reason: k.technical.reason, snap: k.__snapAsof } }; }, first);
    ok(m.snapCount > 100 && m.priced > 100, 'merged into the stock list: ' + m.snapCount + ' snapshot scores, ' + m.priced + ' prices');
    ok(m.kept && m.kept.px === 111.1 && m.kept.reason === 'kept' && m.kept.score === 7, 'the fresh completed-weeks score is kept and only the price changes: ' + JSON.stringify(m.kept));
    ok(m.kept.snap === today, 'it still counts as confirmed today for the Technical data age: ' + JSON.stringify(m.kept));
    ok(r.btn && /skipped/.test(r.text), 'a skipped-stocks file is offered: ' + r.text.slice(0, 300));
    ok(await page.evaluate(() => !document.getElementById('tvStopBtn') || document.getElementById('tvStopBtn').hidden), 'the Stop button is hidden again');
  });
  // v1.190: a second run with the same figures does not rewrite what is already saved, and the result says how long the run took
  await runScenario('refresh from TradingView: a second run with the same figures rewrites nothing and reports its time', { cfg: { liveCollections: true } }, async page => {
    await page.click('#tvSnapshotBtn');
    await page.waitForSelector('#tv_fiResult.fi-result-ok, #tv_fiResult.fi-result-err', { timeout: 120000 });
    const first = await page.textContent('#tv_fiResult');
    ok(/Took \d+ (s|min)/.test(first) && !/already held exactly/.test(first), 'the first run reports its time and has nothing unchanged: ' + first.slice(0, 260));
    await page.waitForFunction(() => !document.getElementById('tvSnapshotBtn').disabled, null, { timeout: 30000 });
    const before = await readDb(page);
    await page.click('#tvSnapshotBtn');
    await page.waitForFunction(() => /already held exactly/.test((document.getElementById('tv_fiResult') || {}).textContent || ''), null, { timeout: 120000 });
    const second = await page.textContent('#tv_fiResult');
    ok(/(^|\s)0 stocks refreshed/.test(second) && /already held exactly these figures/.test(second), 'the second run saves nothing and says why: ' + second.slice(0, 300));
    ok(await page.evaluate(() => /fi-result-ok/.test(document.getElementById('tv_fiResult').className)), 'it still counts as a good run');
    const after = await readDb(page);
    const noLog = all => JSON.stringify(Object.keys(all).filter(k => !k.startsWith('refreshRunLog/')).sort().map(k => [k, all[k]]));
    ok(noLog(after.all) === noLog(before.all), 'the saved stock records are exactly as they were');
    // v1.196: each run leaves one record in the database with its timing and counts
    const runs = Object.entries(after.all).filter(([k]) => k.startsWith('refreshRunLog/')).map(([, v]) => v).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    ok(runs.length === 2 && runs.every(r => r.kind === 'snapshot' && r.v === 2 && typeof r.durationMs === 'number' && r.durationMs >= 0 && r.endedAt >= r.startedAt), 'each run saved one record with its start, end and duration: ' + JSON.stringify(runs.map(r => [r.kind, r.durationMs])));
    ok(runs[0].saved > 100 && runs[0].unchanged === 0 && runs[1].saved === 0 && runs[1].unchanged === runs[0].saved, 'the records say how many stocks each run saved and left alone: ' + JSON.stringify(runs.map(r => [r.saved, r.unchanged])));
    ok(runs.every(r => Array.isArray(r.batchSecs) && r.batchSecs.length === r.batches && r.batches > 0 && typeof r.tvWaitSecs === 'number' && typeof r.saveSecs === 'number' && typeof r.chunks === 'number' && r.error === null), 'the records hold the seconds each batch took and the time spent waiting on TradingView and saving');
    ok(runs[0].chunks === runs[0].batches && runs[1].chunks === 0, 'one save per batch, none the second time: ' + JSON.stringify(runs.map(r => [r.batches, r.chunks])));
    // v1.199: the Last 2 runs list under the option, and only the newest two records are kept
    const lastTxt = await page.evaluate(() => document.getElementById('lastRuns_snapshot').innerText);
    ok(/Last 2 runs/.test(lastTxt) && (lastTxt.match(/manual/g) || []).length === 2 && /2,?\d{3} saved/.test(lastTxt) && /unchanged/.test(lastTxt), 'the list shows both runs: ' + lastTxt.replace(/\s+/g, ' ').slice(0, 300));
    await page.waitForFunction(() => !document.getElementById('tvSnapshotBtn').disabled, null, { timeout: 30000 });
    await page.click('#tvSnapshotBtn');
    await page.waitForFunction(() => document.getElementById('tvSnapshotBtn').disabled === false && /Took/.test(document.getElementById('tv_fiResult').textContent), null, { timeout: 120000 });
    await page.waitForFunction(() => (document.getElementById('lastRuns_snapshot').innerText.match(/manual/g) || []).length === 2, null, { timeout: 15000 });
    const keptRuns = Object.keys((await readDb(page)).all).filter(k => k.startsWith('refreshRunLog/'));
    eq(keptRuns.length, 2, 'a third run leaves only the newest two records');
  });
  // v1.198: the snapshot is saved apart from the per-stock records, so a run never touches (or needs to read) research notes
  const research = { ticker: first, globalFactors: { scope: 'sector', asof: '2999-01-01', positive: ['kept note'], negative: [] }, technical: { score: 3, asof: '2020-01-01', states: {}, raw: {}, reason: 'old' } };
  await runScenario('refresh from TradingView: research notes in a stock record are never touched and still show next to the new price', { docs: { ['stockUpdates/' + first]: research }, cfg: { liveCollections: true } }, async page => {
    await page.click('#tvSnapshotBtn');
    await page.waitForSelector('#tv_fiResult.fi-result-ok, #tv_fiResult.fi-result-err', { timeout: 120000 });
    ok(await page.evaluate(() => /fi-result-ok/.test(document.getElementById('tv_fiResult').className)), 'it finishes: ' + (await page.textContent('#tv_fiResult')).slice(0, 200));
    const a = await readDb(page);
    eq(a.all['stockUpdates/' + first], research, 'the stock record is exactly as it was');
    const m = await page.evaluate(first => { const k = window.__alba.stocks.find(s => window.__alba.sanitizeDocId(window.__alba.tickerSymbol(s)) === first); return { px: k.valuation.currentPrice, note: k.globalFactors && k.globalFactors.positive[0], snap: k.technical && k.technical.src }; }, first);
    ok(m.px === 111.1 && m.note === 'kept note' && m.snap === 'snapshot', 'the page shows the new price, the note and the newer score: ' + JSON.stringify(m));
  });
  await runScenario('refresh from TradingView: a snapshot that cannot be read first still lets the run save everything', { cfg: { liveCollections: true, rules: [{ op: 'get', path: 'liveSnapshot', error: { message: 'network down' } }] } }, async page => {
    await page.click('#tvSnapshotBtn');
    await page.waitForSelector('#tv_fiResult.fi-result-ok, #tv_fiResult.fi-result-err', { timeout: 120000 });
    ok(await page.evaluate(() => /fi-result-ok/.test(document.getElementById('tv_fiResult').className)), 'it finishes: ' + (await page.textContent('#tv_fiResult')).slice(0, 200));
    ok(Object.keys((await readDb(page)).all).some(k => k.startsWith('liveSnapshot/')), 'the chunks were saved');
  });
  await runScenario('refresh from TradingView: a save that fails once is retried', { cfg: { liveCollections: true, rules: [{ op: 'set', path: 'liveSnapshot/c001', times: 1, error: { message: 'temporary network error' } }] } }, async page => {
    await page.click('#tvSnapshotBtn');
    await page.waitForSelector('#tv_fiResult.fi-result-ok, #tv_fiResult.fi-result-err', { timeout: 120000 });
    const text = await page.textContent('#tv_fiResult');
    ok(!/could not be saved/.test(text) && /fi-result-ok/.test(await page.evaluate(() => document.getElementById('tv_fiResult').className)), 'it finishes: ' + text.slice(0, 200));
    ok(Object.keys((await readDb(page)).all).includes('liveSnapshot/c001'), 'the first chunk was saved on the second try');
  });
  // v1.187: a quick double click on Refresh all stocks must not start two runs (the first run takes its place before it waits for TradingView)
  await runScenario('refresh from TradingView: a quick double click starts only one run', { cfg: { liveCollections: true } }, async page => {
    await page.evaluate(() => { const b = document.getElementById('tvSnapshotBtn'); b.click(); b.click(); });
    await page.waitForSelector('#tv_fiResult.fi-result-ok, #tv_fiResult.fi-result-err', { timeout: 120000 });
    const asked = await page.evaluate(() => [].concat(...(window.__tvBatchCalls || []).map(c => c.symbols)));
    ok(asked.length > 100 && new Set(asked).size === asked.length, 'each stock was asked for once: ' + asked.length + ' asked, ' + new Set(asked).size + ' different');
  });
  // v1.187: the summary counts a score only after it is saved, so refused saves never inflate it
  await runScenario('refresh from TradingView: stocks whose save fails are not counted as updated', { cfg: { liveCollections: true, rules: [{ op: 'set', prefix: 'liveSnapshot/', error: { message: 'write refused' } }] } }, async page => {
    await page.click('#tvSnapshotBtn');
    await page.waitForSelector('#tv_fiResult.fi-result-ok, #tv_fiResult.fi-result-err', { timeout: 120000 });
    const text = await page.textContent('#tv_fiResult');
    ok(/(^|\s)0 stocks refreshed.*\b0 technical scores updated/.test(text), 'nothing is counted as updated: ' + text.slice(0, 240));
  });
  // the real database hands out records that cannot be changed in place: the list of stocks that failed before must be copied first
  const old = {}; DS.stocks.filter((s, i) => i >= 6).forEach(s => { old[symOf(s).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_')] = '2020-01-01T00:00:00.000Z'; });
  await runScenario('fill missing history: a saved failure list that cannot be changed in place does not stop the run', { docs: { 'stockMeta/histFillTried': Object.assign({ uploadedAt: '2026-10-01' }, old) } }, async page => {
    await page.click('#tvHistoryBtn');
    await page.waitForSelector('#th_fiResult.fi-result-ok, #th_fiResult.fi-result-err', { timeout: 200000 });
    const text = await page.textContent('#th_fiResult');
    ok(!/Cannot|not extensible|Stopped/.test(text), 'the run finishes: ' + text.slice(0, 200));
  });
  await runScenario('refresh from TradingView: without a connection nothing is attempted', { cfg: { noMcp: true } }, async page => {
    await page.click('#tvSnapshotBtn');
    await page.waitForSelector('#tv_fiResult.fi-result-err', { timeout: 30000 });
    ok(/not available in this view/.test(await page.textContent('#tv_fiResult')), 'message shown');
  });
}
if(require.main === module) main().catch(e => { console.error('import tests crashed:', e); process.exit(1); });
