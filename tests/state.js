// State tests (real Chromium): the shared-database state kept by src/core/store.js, seen through the page.
// Each scenario checks what the person sees AND what ended up in the (stand-in) database.
//  - Pins: shown from the database, saved per user, replaced when another device changes them, still saved when clicked before the
//    database capability has arrived, and kept for the page load only when nobody is signed in.
//  - Trade Log: shown from the live collection; add (with the duplicate guard), sell and remove; the saved Cards / Table choice;
//    the signed-out view.
// The stand-in database is the one in tests/lib/env.js (collections made live with cfg.liveCollections). It does not test the real
// claude.ai runtime. Playwright is optional locally (SKIPPED if missing) but required in CI. Usage: node tests/state.js   or   npm run state
const fs = require('fs'), path = require('path');
const { chromiumOrSkip, startServer, openPage } = require('./lib/env.js');
const chromium = chromiumOrSkip('state tests');
const srv = startServer();
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stocks.json'), 'utf8')).stocks;
const CHUNKS = [FIXTURE.slice(0, Math.ceil(FIXTURE.length / 2)), FIXTURE.slice(Math.ceil(FIXTURE.length / 2))];
const UID = 'u_SMOKE', PINS = 'data/users/' + UID + '/pins', TRADES = 'data/users/' + UID + '/portfolio/trades', PREFS = 'data/users/' + UID + '/prefs';
const sid = x => String(x).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');
const symOf = s => s.ticker.split('·')[0].trim();
const [A, B, C] = FIXTURE;          // the three best-scored stocks, so they are the first stocks in the list

let base, browser, checks = 0; const problems = [];
const ok = (cond, msg) => { checks++; if(!cond) problems.push(msg); return !!cond; };
const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' — expected ' + JSON.stringify(b) + ' but got ' + JSON.stringify(a));

// ---------------------------------------------------------------- helpers
async function scenario(name, cfg, docs, fn, allowedError){
  let s;
  try {
    const o = Object.assign({ chunks: CHUNKS, liveCollections: true, section: 'analysis' }, cfg);
    if(docs){ srv.seeds.set(name, JSON.stringify({ docs })); o.seedUrl = base + '/__seed/' + encodeURIComponent(name) + '.json'; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }), errs = [];
    s = { ctx, errs };
    const { page } = await openPage(ctx, base, o, name, errs);
    await page.waitForFunction(() => window.__alba && window.__alba.stocks && document.querySelector('.app-section.active'), null, { timeout: 20000 });
    await fn(page);
    const bad = errs.filter(e => !(allowedError && allowedError.test(e)));
    ok(bad.length === 0, name + ': errors in the page: ' + bad.slice(0, 3).join(' | '));
  } catch(e){ problems.push(name + ': test crashed: ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); checks++; }
  finally { if(s) await s.ctx.close().catch(() => {}); }
}
async function until(page, fn, arg, msg){
  let good = true;
  try { await page.waitForFunction(fn, arg, { timeout: 8000 }); } catch(e){ good = false; }
  return ok(good, msg);
}
const goto = async (page, k) => { await page.evaluate(k => document.querySelector('.nav-item[data-section="' + k + '"]').click(), k); await page.waitForTimeout(150); };
const stored = (page, p) => page.evaluate(p => { const d = window.__store.get(p); return d === undefined ? undefined : JSON.parse(JSON.stringify(d)); }, p);
const storedIds = (page, prefix) => page.evaluate(prefix => Array.from(window.__store.keys()).filter(k => k.startsWith(prefix + '/')).map(k => k.slice(prefix.length + 1)).sort(), prefix);
// A stock is pinned from the star on its detail page (opened here from the top-bar search).
async function openStock(page, s){
  await goto(page, 'analysis');
  await page.fill('#globalSearch', s.name); await page.waitForTimeout(250);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.waitForFunction(n => { const e = document.querySelector('#detail .detail-name'); return !!e && e.textContent === n && !!document.getElementById('detailPinBtn'); }, s.name, { timeout: 8000 }).catch(() => {});
}
const starPinned = page => page.evaluate(() => { const b = document.getElementById('detailPinBtn'); return b ? b.getAttribute('aria-pressed') === 'true' : null; });
const clickStar = page => page.evaluate(() => { const b = document.getElementById('detailPinBtn'); if(b) b.click(); return !!b; });
const cards = page => page.evaluate(() => Array.from(document.querySelectorAll('#tradeLogPanelBody .tl-card .tl-card-tk')).map(e => e.textContent.trim()).sort());
const domClick = (page, sel) => page.evaluate(s => { const b = document.querySelector(s); if(b) b.click(); return !!b; }, sel);
const pinsWithOnly = (page, tickers) => until(page, ([p, want]) => { const d = window.__store.get(p); return !!d && JSON.stringify(d.tickers.slice().sort()) === JSON.stringify(want); }, [PINS, tickers.slice().sort()], 'the saved pins are ' + JSON.stringify(tickers));

// ---------------------------------------------------------------- pins
async function pinScenarios(){
  await scenario('pins: saved, restored and replaced from another device', {}, { [PINS]: { tickers: [C.ticker] } }, async page => {
    await openStock(page, C);
    await until(page, () => document.getElementById('detailPinBtn') && document.getElementById('detailPinBtn').getAttribute('aria-pressed') === 'true', null, 'the pin saved in the database is shown');

    await openStock(page, A);
    same(await starPinned(page), false, A.name + ' starts unpinned');
    ok(await clickStar(page), A.name + ' has a pin star');
    await pinsWithOnly(page, [A.ticker, C.ticker]);
    same(await starPinned(page), true, 'the star shows the pin after pinning');

    ok(await clickStar(page), A.name + ' star clicked again');
    await pinsWithOnly(page, [C.ticker]);
    same(await starPinned(page), false, 'unpinned again');

    // another device changes the list: this page follows it
    await openStock(page, B);
    await page.evaluate(([p, t]) => window.__setDoc(p, { tickers: [t] }), [PINS, B.ticker]);
    await until(page, () => document.getElementById('detailPinBtn') && document.getElementById('detailPinBtn').getAttribute('aria-pressed') === 'true', null, 'a pin list changed elsewhere is shown on the open stock');
    // the same list arriving again (what a save of our own looks like when it comes back) changes nothing
    await page.evaluate(([p, t]) => window.__setDoc(p, { tickers: [t] }), [PINS, B.ticker]);
    await page.waitForTimeout(150);
    same(await starPinned(page), true, 'the same list arriving again changes nothing');
    await page.evaluate(([p]) => window.__setDoc(p, { tickers: [] }), [PINS]);
    await until(page, () => document.getElementById('detailPinBtn') && document.getElementById('detailPinBtn').getAttribute('aria-pressed') === 'false', null, 'an emptied pin list is shown too');
  });

  // the database capability arrives late: a pin clicked in the meantime must not be lost
  await scenario('pins: a pin clicked before the database is ready is still saved', { slowDbAfterApp: 2500 }, null, async page => {
    await openStock(page, A);
    ok(await clickStar(page), A.name + ' has a pin star');
    await page.waitForTimeout(300);
    ok((await stored(page, PINS)) === undefined, 'nothing is saved while the database is still on its way (the test must click inside that window)');
    same(await starPinned(page), true, 'the pin shows at once');
    await pinsWithOnly(page, [A.ticker]);
  });

  // nobody signed in: pins work for this page load only
  await scenario('pins: signed out, they last for this page load only', { noUser: true }, null, async page => {
    await openStock(page, A);
    ok(await clickStar(page), A.name + ' has a pin star');
    same(await starPinned(page), true, 'the pin shows');
    await page.waitForTimeout(800);
    same(await storedIds(page, 'data/users/' + UID), ['prefs'], 'nothing but the seeded preferences exists: pins are not saved without a sign-in');
  }, /Trade log persistence unavailable/);
}

// ---------------------------------------------------------------- Trade Log
const snapshotOf = s => ({ score: s.score, verdict: s.verdict, currentPriceAtSnapshot: 100, intrinsicValue: null, marginOfSafetyPct: null, fundamentalFactorsComplete: 9, fundamentalFactorsTotal: 9, technicalComponentsComplete: 5, technicalComponentsTotal: 5 });
const openTrade = (s, date, price, qty) => ({ ticker: symOf(s), name: s.name, status: 'open', buy: { date, price, quantity: qty, snapshot: snapshotOf(s) }, sell: null, loggedAt: date + 'T10:00:00.000Z' });
async function fillAddForm(page, s, date, price, qty){
  await domClick(page, '#tradeAddBtn');
  await page.waitForSelector('#tlStock');
  await page.fill('#tlStock', symOf(s)); await page.fill('#tlDate', date); await page.fill('#tlPrice', String(price)); await page.fill('#tlQty', String(qty));
  await domClick(page, '#tlSave');
}

async function tradeScenarios(){
  const idA = sid(symOf(A) + '-2026-10-01'), idB = sid(symOf(B) + '-2026-10-08');
  await scenario('trade log: shown from the database; add, sell and remove', { section: 'trackrecord' }, { [TRADES + '/' + idA]: openTrade(A, '2026-10-01', 100, 5) }, async page => {
    await goto(page, 'trackrecord');
    await until(page, () => document.querySelectorAll('#tradeLogPanelBody .tl-card').length === 1, null, 'the saved trade is shown');
    same(await cards(page), [symOf(A)], 'the card shows the trade');

    // a second trade for the same stock and date is refused, nothing is written
    await fillAddForm(page, A, '2026-10-01', 100, 5);
    await until(page, () => /already exists/.test((document.getElementById('tlMsg') || {}).textContent || ''), null, 'a duplicate trade is refused with a message');
    same(await storedIds(page, TRADES), [idA], 'nothing was written for the duplicate');
    await domClick(page, '#tlCancel');

    // a new trade is saved with a snapshot of what the dashboard said, and appears in the list
    await fillAddForm(page, B, '2026-10-08', 250.5, 10);
    await until(page, id => { const d = window.__store.get('data/users/u_SMOKE/portfolio/trades/' + id); return !!d; }, idB, 'the new trade is saved');
    const b = await stored(page, TRADES + '/' + idB);
    ok(b && b.ticker === symOf(B) && b.status === 'open' && b.buy.price === 250.5 && b.buy.quantity === 10 && b.buy.date === '2026-10-08' && b.sell === null, 'new trade fields: ' + JSON.stringify(b).slice(0, 200));
    const liveB = await page.evaluate(n => { const s = window.__alba.stocks.find(x => x.name === n); return { verdict: s.verdict, score: s.score }; }, B.name);   // the score the page shows (it counts only reliable information), not the raw fixture value
    ok(b && b.buy.snapshot.verdict === liveB.verdict && b.buy.snapshot.score === liveB.score, 'the snapshot holds the verdict and score at that moment: ' + JSON.stringify(b && b.buy.snapshot).slice(0, 160));
    await until(page, () => document.querySelectorAll('#tradeLogPanelBody .tl-card').length === 2, null, 'the new trade appears in the list');
    ok((await page.evaluate(() => document.getElementById('tradeFormHost').innerHTML.trim())) === '', 'the form closes after saving');

    // sell it: the record is closed with the realised return
    ok(await domClick(page, '[data-tl-sell="' + idB + '"]'), 'the new trade has a Sell button');
    await page.waitForSelector('#tlSellPrice');
    await page.fill('#tlSellDate', '2026-10-09'); await page.fill('#tlSellPrice', '300');
    await domClick(page, '#tlSellSave');
    await until(page, id => { const d = window.__store.get('data/users/u_SMOKE/portfolio/trades/' + id); return !!d && d.status === 'closed'; }, idB, 'the sale is saved');
    const s = await stored(page, TRADES + '/' + idB);
    ok(s && s.sell && s.sell.price === 300 && s.sell.quantity === 10 && s.sell.date === '2026-10-09' && Math.abs(s.sell.realizedReturnPct - 19.7605) < 0.001 && s.sell.holdingDays === 1, 'closed trade fields: ' + JSON.stringify(s && s.sell).slice(0, 200));
    ok(s && s._id === undefined, 'the saved record does not carry the page-only _id');
    await until(page, id => !document.querySelector('[data-tl-sell="' + id + '"]') && /Realized return/.test(document.getElementById('tradeLogPanelBody').textContent), idB, 'the list shows the trade as closed');

    // remove the first trade (two clicks: arm, then confirm)
    await page.evaluate(id => { const b = document.querySelector('[data-tl-remove="' + id + '"]'); b.click(); b.click(); }, idA);
    await until(page, id => !window.__store.has('data/users/u_SMOKE/portfolio/trades/' + id), idA, 'the removed trade is deleted from the database');
    await until(page, () => document.querySelectorAll('#tradeLogPanelBody .tl-card').length === 1, null, 'the removed trade leaves the list');
    same(await cards(page), [symOf(B)], 'the remaining card');

    // Cards / Table
    await domClick(page, '.tl-view-btn[data-tl-view="table"]');
    await until(page, () => !!document.querySelector('#tradeLogPanelBody table') && !document.querySelector('#tradeLogPanelBody .tl-card'), null, 'the Table button shows the table');
    await domClick(page, '.tl-view-btn[data-tl-view="cards"]');
    await until(page, () => !document.querySelector('#tradeLogPanelBody table') && !!document.querySelector('#tradeLogPanelBody .tl-card'), null, 'the Cards button shows the cards again');
  });

  // Buy / Sell ideas: pick a strategy, the qualifying stocks are listed with a call, and a name opens the stock page
  await scenario('trade log: Buy / Sell ideas for a chosen strategy', { section: 'trackrecord' }, { [TRADES + '/' + idA]: openTrade(A, '2026-10-01', 100, 5) }, async page => {
    await goto(page, 'trackrecord');
    await until(page, () => !!document.querySelector('#tradeIdeasStrategy') && document.querySelectorAll('#tradeIdeasStrategy option').length > 1, null, 'the strategy picker lists the strategies');
    await until(page, () => /Choose a strategy/.test((document.getElementById('tradeIdeasBody') || {}).textContent || ''), null, 'it asks for a strategy first');
    ok(await page.evaluate(() => document.getElementById('tradeIdeasRun').disabled), 'Process waits for a strategy');
    await page.selectOption('#tradeIdeasStrategy', 'starter-deep-value');
    await until(page, () => !document.getElementById('tradeIdeasRun').disabled && /Press Process/.test((document.getElementById('tradeIdeasBody') || {}).textContent || ''), null, 'choosing a strategy enables Process and asks for it, without working anything out');
    ok(await page.evaluate(() => !(window.__filteredGets || []).some(x => /^priceHistory /.test(x)) && !document.querySelector('#tradeIdeasBody .tl-top5')), 'nothing is read or listed before Process is pressed');
    // v1.290: Process reads the weekly prices (the panel says it is working), then shows the results
    await page.evaluate(() => { window.__sawBar = null; new MutationObserver(() => { const b = document.querySelector('#tradeIdeasBody .fi-bar[role="progressbar"]'); if(b && !window.__sawBar) window.__sawBar = { steps: document.querySelectorAll('#tradeIdeasBody .fi-step').length, pct: document.querySelector('#tradeIdeasBody .fi-pct').textContent }; }).observe(document.getElementById('tradeIdeasBody'), { childList: true, subtree: true }); });
    await page.evaluate(() => document.getElementById('tradeIdeasRun').click());
    await until(page, () => /Processed on|No stock qualifies|no longer available/.test((document.getElementById('tradeIdeasBody') || {}).textContent || '') || /Processing/.test(document.getElementById('tradeIdeasRun').textContent), null, 'pressing Process shows that it is working, then the result');
    await until(page, () => /Processed on|No stock qualifies/.test((document.getElementById('tradeIdeasBody') || {}).textContent || ''), null, 'the results appear when processing is done');
    ok(await page.evaluate(() => document.getElementById('tradeIdeasBody').getAttribute('aria-busy') === 'false' && document.getElementById('tradeIdeasRun').textContent === 'Process again' && !document.getElementById('tradeIdeasRun').disabled), 'when done the button offers Process again');
    const saw = await page.evaluate(() => window.__sawBar);
    ok(saw && saw.steps === 3 && /^\d+%$/.test(saw.pct), 'while it runs a progress bar with three steps and a percentage is shown, got ' + JSON.stringify(saw));
    ok(await page.evaluate(() => !document.querySelector('#tradeIdeasBody table')), 'there is no table of every stock under the lists');
    const n = await page.evaluate(() => Number(((document.getElementById('tradeIdeasBody').textContent || '').match(/\. (\d+) stocks:/) || [0, 0])[1]));
    // v1.190: the timing check reads each listed stock's bars with its own filtered read, never the whole priceHistory collection
    ok(await page.evaluate(() => !(window.__colGets || []).includes('priceHistory')), 'the whole price-history collection is not read for the ideas');
    ok(await page.evaluate(n => (window.__filteredGets || []).filter(x => /^priceHistory /.test(x)).length >= Math.min(n, 1), n), 'each listed stock\'s bars are read with a filtered read');
    if(n > 0){
      // v1.290: two Top 5 lists (Upward, Downward); each holds at most five stocks
      const top = await page.evaluate(() => ({ blocks: document.querySelectorAll('#tradeIdeasBody .tl-top5').length, over: Array.from(document.querySelectorAll('#tradeIdeasBody .tl-top5')).some(b => b.querySelectorAll('li').length > 5), first: document.querySelector('#tradeIdeasBody .tl-top5 a[data-idea-open]') ? true : false }));
      ok(await page.evaluate(() => { const n = document.querySelectorAll('#tradeIdeasBody .tl-top5 > ol > li').length; return n === document.querySelectorAll('#tradeIdeasBody .tl-top5 .tl-news').length; }), 'v1.294: every listed stock shows its news line');
      ok(top.blocks === 2 && !top.over, 'the two Top 5 lists hold at most five stocks each, got ' + JSON.stringify(top));
      await page.selectOption('#tradeIdeasStrategy', '');
      await until(page, () => /Choose a strategy/.test((document.getElementById('tradeIdeasBody') || {}).textContent || '') && !document.querySelector('#tradeIdeasBody .tl-top5'), null, 'changing the strategy clears the lists until Process is pressed again');
      // v1.293: the result is kept with a date stamp, saved for the user, and comes back with the strategy
      await until(page, () => window.__store.has('data/users/u_SMOKE/ideasResults'), null, 'the result is written to the database');
      const kept = await page.evaluate(() => window.__store.get('data/users/u_SMOKE/ideasResults'));
      ok(kept && kept.v === 1 && /"starter-deep-value":\{"v":1,"at":"/.test(kept.json), 'the Process result is saved for the user, got ' + JSON.stringify(kept).slice(0, 120));
      await page.selectOption('#tradeIdeasStrategy', 'starter-deep-value');
      await until(page, () => /Processed on .*\(today\)/.test((document.getElementById('tradeIdeasBody') || {}).textContent || '') && document.querySelectorAll('#tradeIdeasBody .tl-top5').length === 2 && document.getElementById('tradeIdeasRun').textContent === 'Process again', null, 'choosing the strategy again shows the kept result with its date stamp and offers Process again, without processing');
    } else ok(true, 'no stock qualifies in the fixtures for this strategy');
  });

  // a failed delete tells the viewer, and the trade stays
  await scenario('trade log: a refused remove shows a notice and keeps the trade', { section: 'trackrecord', liveCollections: true, rules: [{ op: 'delete', prefix: TRADES, error: { message: 'refused' } }] }, { [TRADES + '/' + idA]: openTrade(A, '2026-10-01', 100, 5) }, async page => {
    await goto(page, 'trackrecord');
    await until(page, () => document.querySelectorAll('#tradeLogPanelBody .tl-card').length === 1, null, 'the trade is listed');
    await page.evaluate(id => { const b = document.querySelector('[data-tl-remove="' + id + '"]'); b.click(); b.click(); }, idA);
    await until(page, () => !!document.getElementById('albaConfirm') && /Could not remove the trade/.test(document.getElementById('albaConfirm').textContent), null, 'a notice says the trade could not be removed');
    ok(await page.evaluate(() => document.getElementById('albaConfirmNo').hidden), 'the notice has a single OK button');
    ok(await page.evaluate(id => window.__store.has('data/users/u_SMOKE/portfolio/trades/' + id), idA), 'the trade is still in the database');
    await domClick(page, '#albaConfirmOk');
    ok(!(await page.evaluate(() => !!document.getElementById('albaConfirm'))), 'the notice closes');
  }, /Failed to remove trade/);

  // v1.195: a redraw of the Trade Log (a live price, another device's save) keeps the table's sideways scroll
  await scenario('trade log: a redraw keeps the table scrolled sideways', { section: 'trackrecord', liveCollections: true }, { [PREFS]: { v: 1, theme: 'dark', tradeView: 'table', updatedAt: '2026-10-10T00:00:00.000Z', uiState: { section: 'trackrecord' } }, [TRADES + '/' + idA]: openTrade(A, '2026-10-01', 100, 5) }, async page => {
    await page.setViewportSize({ width: 600, height: 900 });
    await goto(page, 'trackrecord');
    await until(page, () => !!document.querySelector('#tradeLogPanelBody .help-table-wrap table'), null, 'the table is shown');
    const before = await page.evaluate(() => { const w = document.querySelector('#tradeLogPanelBody .help-table-wrap'); w.scrollLeft = 150; window.__tw = w; return { left: w.scrollLeft, wide: w.scrollWidth > w.clientWidth + 150 }; });
    if(before.wide){
      await page.evaluate(([p, d]) => window.__setDoc(p, d), [TRADES + '/' + idA, Object.assign(openTrade(A, '2026-10-01', 100, 5), { note: 'changed' })]);
      await until(page, () => document.querySelector('#tradeLogPanelBody .help-table-wrap') !== window.__tw, null, 'the Trade Log is redrawn after the save');
      ok(await page.evaluate(() => document.querySelector('#tradeLogPanelBody .help-table-wrap').scrollLeft) === 150, 'the redrawn table is still scrolled to where it was');
    } else ok(true, 'the Trade Log table is not wider than the screen in the fixtures');
  });

  // the saved choice of view is read when the page loads
  const prefsTable = { v: 1, theme: 'dark', tradeView: 'table', updatedAt: '2026-10-10T00:00:00.000Z', uiState: { section: 'trackrecord' } };
  await scenario('trade log: the saved Table view is used on load', { section: 'trackrecord' }, { [PREFS]: prefsTable, [TRADES + '/' + idA]: openTrade(A, '2026-10-01', 100, 5) }, async page => {
    await goto(page, 'trackrecord');
    await until(page, () => !!document.querySelector('#tradeLogPanelBody table'), null, 'the table is shown without clicking anything');
    ok(await page.evaluate(() => { const b = document.querySelector('.tl-view-btn.active'); return !!b && b.getAttribute('data-tl-view') === 'table'; }), 'the Table button is marked active');
  });

  // nobody signed in: no trade log
  await scenario('trade log: signed out', { noUser: true }, null, async page => {
    await goto(page, 'trackrecord');
    await until(page, () => /signed-in view/.test(document.getElementById('tradeLogPanelBody').textContent), null, 'the panel says a signed-in view is needed');
    await fillAddForm(page, A, '2026-10-09', 100, 1);
    await until(page, () => /not reachable/.test((document.getElementById('tlMsg') || {}).textContent || ''), null, 'saving says the trade log database is not reachable');
    same(await storedIds(page, 'data/users/' + UID), ['prefs'], 'nothing was written (only the seeded preferences exist)');
  }, /Trade log persistence unavailable/);
}

// v1.295: the Analysis "Buy / Sell ideas" filter shows only the stocks of the saved Upward / Downward trend list
async function ideasFilterScenarios(){
  const U = FIXTURE[4], Dn = FIXTURE[3];
  const snap = { v: 1, at: '2026-10-29T04:34:00.000Z', today: '2026-10-29', n: 2, up: 1, down: 1, mixed: 0, short: 0, lists: { up: [{ sym: symOf(U), name: U.name, cap: '', price: 100, reasons: ['x'] }], down: [{ sym: symOf(Dn), name: Dn.name, cap: '', price: 100, reasons: ['x'] }] } };
  const docs = { 'data/users/u_SMOKE/ideasResults': { v: 1, json: JSON.stringify({ 'starter-deep-value': snap }), updatedAt: '2026-10-29T04:34:00.000Z' } };
  const rows = page => page.evaluate(() => Array.from(document.querySelectorAll('#analysisLeaderboardBody tr.analysis-lb-row')).map(r => r.textContent));
  const pick = (page, sel) => page.evaluate(sel => { const b = document.querySelector(sel); if(b) b.click(); return !!b; }, sel);
  await scenario('analysis: Buy / Sell ideas filter', {}, docs, async page => {
    await goto(page, 'analysis');
    await until(page, () => !!document.querySelector('#analysisIdeasFilter'), null, 'the Buy / Sell ideas filter is drawn');
    ok(await page.evaluate(() => Array.from(document.querySelectorAll('#analysisIdeasFilter .filter-btn')).map(b => b.textContent.replace(/\d+$/, '').trim()).join('|') === 'All|Upward Trend|Downward Trend'), 'it offers All, Upward Trend and Downward Trend');
    // v1.306: the View button sits below the sticky top bar, so scrolling slides it under the bar with the rest of the toolbar
    ok(await page.evaluate(() => { const z = e => parseInt(getComputedStyle(e).zIndex, 10); return z(document.querySelector('.analysis-view-bar')) < z(document.querySelector('.topbar')); }), 'the View button is layered below the top bar');
    await pick(page, '#analysisMosFilters [data-amos="all"]');
    const all = (await rows(page)).length;
    ok(all > 2, 'with All, many stocks are listed, got ' + all);
    await pick(page, '#analysisIdeasFilter [data-aideas="up"]');
    await until(page, n => { const r = document.querySelectorAll('#analysisLeaderboardBody tr.analysis-lb-row'); return r.length === 1 && r[0].textContent.includes(n); }, U.name, 'Upward Trend shows only the stock of the saved Upward list');
    ok(await page.evaluate(() => /processed 29 Oct 2026/.test((document.getElementById('analysisIdeasNote') || {}).textContent || '')), 'the note says when the list was processed');
    // v1.306: both lists can be chosen together (the stocks of either), and each button toggles on its own
    await pick(page, '#analysisIdeasFilter [data-aideas="down"]');
    await until(page, ([a, b]) => { const r = Array.from(document.querySelectorAll('#analysisLeaderboardBody tr.analysis-lb-row')).map(x => x.textContent); return r.length === 2 && r.some(t => t.includes(a)) && r.some(t => t.includes(b)); }, [U.name, Dn.name], 'Upward and Downward Trend together show the stocks of both lists');
    ok(await page.evaluate(() => Array.from(document.querySelectorAll('#analysisIdeasFilter .filter-btn.active')).map(b => b.dataset.aideas).join() === 'up,down'), 'both buttons show as chosen');
    ok(await page.evaluate(() => document.getElementById('analysisLeaderboardCount').textContent.startsWith('Showing 2 of')), 'the count follows the shortlist');
    await pick(page, '#analysisIdeasFilter [data-aideas="up"]');
    await until(page, n => { const r = document.querySelectorAll('#analysisLeaderboardBody tr.analysis-lb-row'); return r.length === 1 && r[0].textContent.includes(n); }, Dn.name, 'switching Upward Trend off leaves only the stock of the Downward list');
    await pick(page, '#analysisIdeasFilter [data-aideas="all"]');
    await until(page, n => document.querySelectorAll('#analysisLeaderboardBody tr.analysis-lb-row').length === n, all, 'All brings every stock back');
  });
  await scenario('analysis: Buy / Sell ideas filter without a saved result', {}, null, async page => {
    await goto(page, 'analysis');
    await until(page, () => !!document.querySelector('#analysisIdeasFilter'), null, 'the filter is drawn');
    await pick(page, '#analysisIdeasFilter [data-aideas="up"]');
    await until(page, () => document.querySelectorAll('#analysisLeaderboardBody tr.analysis-lb-row').length === 0 && /No Buy \/ Sell result is saved yet/.test((document.getElementById('analysisIdeasNote') || {}).textContent || ''), null, 'with nothing saved it lists no stock and says to press Process in the Trade Log');
  });
}

// v1.296: a listed stock that is already a position carries an "In Trade Log" tag
async function heldTagScenario(){
  const U = FIXTURE[4];
  const item = (s, holding) => ({ sym: symOf(s), name: s.name, cap: '', price: 100, reasons: ['x'], holding });
  const snap = { v: 1, at: '2026-10-29T04:34:00.000Z', today: '2026-10-29', n: 2, up: 2, down: 0, mixed: 0, short: 0, lists: { up: [item(U, 'Hold'), item(FIXTURE[3], '')], down: [] } };
  const docs = { 'data/users/u_SMOKE/ideasResults': { v: 1, json: JSON.stringify({ 'starter-deep-value': snap }), updatedAt: '2026-10-29T04:34:00.000Z' } };
  await scenario('trade log: a listed stock already held is tagged', { section: 'trackrecord' }, docs, async page => {
    await goto(page, 'trackrecord');
    await until(page, () => document.querySelectorAll('#tradeIdeasStrategy option').length > 1, null, 'the strategy picker is filled');
    await page.selectOption('#tradeIdeasStrategy', 'starter-deep-value');
    await until(page, () => document.querySelectorAll('#tradeIdeasBody .tl-top5 li .tl-top5-head').length === 2, null, 'both stocks of the saved list are shown');
    ok(await page.evaluate(() => { const t = document.querySelectorAll('#tradeIdeasBody .tl-held-tag'); return t.length === 1 && /In Trade Log . Hold/.test(t[0].textContent); }), 'only the held stock carries the In Trade Log tag, with its call');
  });
}

// v1.299: a factor card shows each bullet's source tags, the numbers tying bullets to rows, the extra TradingView rows and the source tag on every row
async function sourceTagsScenario(){
  const T = FIXTURE[2], sym = symOf(T), fin = T.fundamentals.factors.find(f => f.key === 'fin'), m0 = fin.metrics[0][0], m1 = fin.metrics[1][0];
  const research = { ticker: sym, asof: '2026-10-29', changeNote: 'x', metricsFilled: 0, factors: { fin: { metricsTv: [m1], research: { asof: '2026-10-29', headline: 'Headline', sources: [{ title: 'Wire', url: 'https://news.example/n1' }, { title: 'Other source', url: 'https://news.example/n2' }],
    points: [{ text: 'Debt sentence', basis: ['csv', 'claude'], refs: [m0], ok: true }, { text: 'News sentence', basis: ['tv-news'], refs: [], ok: true, url: 'https://news.example/n1', src: 'Order win' }, { text: 'Odd figure 55.5%', basis: ['claude'], refs: [m0], ok: false }, 'Old plain sentence'],
    facts: [{ label: 'Price to book value (TradingView)', value: '13.9496814684338', basis: 'tv-financials', tone: 'pos', note: 'differs from the CSV' }], positives: ['Debt sentence', 'A separate strength worth noting'], negatives: [] } } } };
  await scenario('stock page: bullets carry source tags and numbered links', { section: 'analysis' }, { ['stockResearch/' + sid(sym)]: research }, async page => {
    await page.fill('#globalSearch', T.name); await page.waitForTimeout(300); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await until(page, () => document.querySelectorAll('#detail .fund-cell-research .fr-pt').length === 4, null, 'the four bullets are shown');
    const r = await page.evaluate(([a, b]) => {
      const pts = Array.from(document.querySelectorAll('#detail .fund-cell-research .fr-pt')), chips = Array.from(document.querySelectorAll('#detail .data-chip'));
      const chip = l => chips.find(c => c.querySelector('.chip-label') && c.querySelector('.chip-label').textContent.includes(l));
      return {
        tags: pts.map(p => Array.from(p.querySelectorAll('.srcico')).map(t => t.getAttribute('aria-label').replace(/^Not verified.*/, 'not verified'))),
        nums: pts.map(p => p.getAttribute('data-n')),
        link: pts[1].querySelector('a') && pts[1].querySelector('a').getAttribute('href'),
        factRow: (() => { const c = chips.find(x => x.classList.contains('chip-new')); return c && { text: c.textContent, tag: c.querySelector('.srcico').getAttribute('aria-label') }; })(),
        csvTags: chips.filter(c => !c.classList.contains('chip-new')).map(c => c.querySelector('.srcico') && c.querySelector('.srcico').getAttribute('aria-label')),
        filled: (chip('Interest coverage') || {}).querySelector && chip('Interest coverage').querySelector('.srcico').getAttribute('aria-label'),
        rowNum: chip('Debt-to-Equity') && chip('Debt-to-Equity').getAttribute('data-n'),
        pos: Array.from(document.querySelectorAll('#detail .fund-cell-research .fund-research-list.pos li')).map(e => e.textContent),
        badgeRight: (() => { const c = document.querySelector('#detail .fund-cell .data-chip[data-n]'); const n = c && c.querySelector('.chip-n'), v = c && c.querySelector('.chip-val'); return !!(n && v && n.getBoundingClientRect().left >= v.getBoundingClientRect().right - 1); })(),
        iconsRight: Array.from(document.querySelectorAll('#detail .fund-cell-research .fr-pt')).every(li => { const a = li.querySelector('.fr-src').getBoundingClientRect(), n = li.querySelector('.fr-numr').getBoundingClientRect(); return a.right <= n.left + 1; }),
        numRight: Array.from(document.querySelectorAll('#detail .fund-cell-research .fr-pt[data-n]')).every(li => { const n = li.querySelector('.fr-numr').getBoundingClientRect(), a = li.querySelector('.fr-src').getBoundingClientRect(), b = li.getBoundingClientRect(); return n.width > 0 && a.right <= n.left + 1 && b.right - n.right < 4; }),
        iconText: document.querySelectorAll('#detail .fund-cell .srctag').length,
        sources: Array.from(document.querySelectorAll('#detail .fund-research-sources')).map(e => e.textContent),
        align: Array.from(document.querySelectorAll('#detail .fund-cell .data-chip .chip-val')).every(e => getComputedStyle(e).textAlign === 'right'),
        gutters: Array.from(document.querySelectorAll('#detail .fund-cell-research .fr-pt .fr-body')).map(e => Math.round(e.getBoundingClientRect().left)).filter((v, i, a) => a.indexOf(v) === i).length
      };
    }, [m0, m1]);
    ok(JSON.stringify(r.tags[0]) === JSON.stringify(["Claude's view"]) && JSON.stringify(r.tags[1]) === JSON.stringify(['TradingView news']) && JSON.stringify(r.tags[2]) === JSON.stringify(["Claude's view", 'not verified']) && r.tags[3].length === 0, 'each bullet shows an icon for TradingView or Claude (never for the CSV), "not verified" when a figure was not found, and an old plain bullet shows none: ' + JSON.stringify(r.tags));
    ok(r.nums[0] === '1' && r.nums[1] === null && r.nums[2] === '2' && r.rowNum === '1 2', 'bullets that rely on rows are numbered and the row carries the same numbers: ' + JSON.stringify([r.nums, r.rowNum]));
    ok(r.link === 'https://news.example/n1', 'a news bullet links to its headline');
    ok(r.factRow && /Price to book value:/.test(r.factRow.text) && !/\(TradingView\)/.test(r.factRow.text) && /13\.95/.test(r.factRow.text) && !/13\.9496/.test(r.factRow.text) && r.factRow.tag === 'TradingView financials', 'an extra figure row from TradingView is added, tagged, without a repeated (TradingView) and with a long decimal rounded: ' + JSON.stringify(r.factRow));
    ok(r.sources.length === 1 && /Other source/.test(r.sources[0]) && !/Wire/.test(r.sources[0]), 'the Sources line lists only what no bullet already links to: ' + JSON.stringify(r.sources));
    ok(r.pos.length === 1 && /separate strength/.test(r.pos[0]), 'a Strengths line that repeats a numbered bullet is dropped: ' + JSON.stringify(r.pos));
    ok(r.badgeRight, 'the link numbers sit at the right end of the row, after the value');
    ok(r.iconsRight && r.iconText === 0, 'source marks are small icons just before the number slot at the right end of each bullet, with no long text tags');
    ok(r.numRight, 'the bullet numbers sit flush at the right end of the bullet, like the row numbers');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'white'));
    const w = await page.evaluate(() => {
      const c = document.querySelector('#detail .fund-cell .data-chip[data-n]'), q = e => c.querySelector(e);
      const cr = c.getBoundingClientRect(), pad = parseFloat(getComputedStyle(c).paddingRight) || 0;
      return { display: getComputedStyle(c).display, label: getComputedStyle(q('.chip-label')).textAlign, numRight: Math.round(cr.right - pad - q('.chip-n').getBoundingClientRect().right), valBeforeIcon: q('.chip-val').getBoundingClientRect().right <= q('.chip-src').getBoundingClientRect().left + 1, iconBeforeNum: q('.chip-src').getBoundingClientRect().right <= q('.chip-n').getBoundingClientRect().left + 1 };
    });
    ok(w.display === 'grid' && w.label === 'left' && Math.abs(w.numRight) <= 1 && w.valBeforeIcon && w.iconBeforeNum, 'White theme: metric rows are still a grid, label left, then value, icon, and the number flush right: ' + JSON.stringify(w));
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    // v1.305: the one-card Valuation subsection is as wide as a single column of Traditional Analysis, and reads top to bottom
    const lay = await page.evaluate(() => {
      const one = document.querySelector('#detail .fund-subsection .fund-grid > .fund-cell:only-child'), many = document.querySelectorAll('#detail .fund-subsection .fund-grid > .fund-cell:not(:only-child)')[1];
      if(!one || !many) return null;
      const cols = el => getComputedStyle(el).gridTemplateColumns.split(' ').length;
      return { oneW: Math.round(one.getBoundingClientRect().width), colW: Math.round(many.getBoundingClientRect().width), researchCols: cols(one.querySelector('.fund-cell-research') || one), chipCols: cols(one.querySelector('.data-chips')) };
    });
    // v1.308: a card with written points and a metric table puts them side by side on a wide page
    const two = await page.evaluate(() => {
      const c = document.querySelector('#detail .fund-subsection .fund-grid > .fund-cell:not(:only-child):has(.fund-cell-research):has(.data-chips)');
      if(!c) return null;
      const r = c.querySelector('.fund-cell-research').getBoundingClientRect(), m = c.querySelector('.data-chips').getBoundingClientRect();
      return { sideBySide: r.right <= m.left + 1 && Math.abs(r.top - m.top) < 40 };
    });
    ok(two && two.sideBySide, 'a factor with points and metrics shows them side by side on a wide page: ' + JSON.stringify(two));
    ok(lay && Math.abs(lay.oneW - lay.colW) <= 2 && lay.chipCols === 1, 'the Valuation card is as wide as one Traditional column and its rows stack top to bottom: ' + JSON.stringify(lay));
    if(process.env.SHOT_DETAIL){ await page.setViewportSize({ width: 1700, height: 1000 }); await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'white')); await page.waitForTimeout(300); await page.locator('#detail').screenshot({ path: process.env.SHOT_DETAIL }); await page.evaluate(() => document.documentElement.removeAttribute('data-theme')); }
    ok(r.align, 'every metric value is right-aligned');
    ok(r.gutters === 1, 'every bullet sentence starts at the same left edge (numbered or not)');
    ok(r.csvTags.every(t => t === null || t === 'TradingView') && r.filled === 'TradingView', 'a metric row has an icon only when TradingView supplied it (CSV rows have none): ' + JSON.stringify(r.csvTags));
  });
}

// v1.303: bullets show even when the research lists no sources, and a number on a row always has a bullet to match.
async function bulletsWithoutSourcesScenario(){
  const T = FIXTURE[2], sym = symOf(T), prof = T.fundamentals.factors.find(f => f.key === 'prof'), pm = prof.metrics[0][0];
  const research = { ticker: sym, asof: '2026-10-29', changeNote: 'x', metricsFilled: 0, factors: { prof: { research: { asof: '2026-10-29', sources: [], points: [{ text: 'Returns look healthy for a bank.', basis: ['csv'], refs: [pm], ok: true }] } } } };
  await scenario('stock page: bullets without a sources list are still shown', { section: 'analysis' }, { ['stockResearch/' + sid(sym)]: research }, async page => {
    await page.fill('#globalSearch', T.name); await page.waitForTimeout(300); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await until(page, () => document.querySelectorAll('#detail .fund-cell').length > 2, null, 'the factor cards are drawn');
    const np = await page.evaluate(() => { const c = Array.from(document.querySelectorAll('#detail .fund-cell')).find(x => /Profitab/i.test(x.textContent)); return c && { bullets: c.querySelectorAll('.fr-pt').length, rowNums: c.querySelectorAll('.data-chip[data-n]').length }; });
    ok(np && np.bullets === 1 && np.rowNums === 1, 'the bullet is shown and its one row number has a bullet to match: ' + JSON.stringify(np));
  });
}

// An inactive stock (not in the latest Fundamental CSV) is hidden from the lists and the search, but a position held in it stays on the Trade Log, tagged.
async function inactiveScenario(){
  const off = Object.assign({}, FIXTURE[5], { active: false }), chunks = CHUNKS.map(c => c.map(s => s === FIXTURE[5] ? off : s));
  const id = sid(symOf(off) + '-2026-10-01');
  await scenario('inactive stock: hidden everywhere except a held position on the Trade Log', { section: 'trackrecord', chunks }, { [TRADES + '/' + id]: openTrade(off, '2026-10-01', 100, 5) }, async page => {
    await goto(page, 'trackrecord');
    await until(page, () => document.querySelectorAll('#tradeLogPanelBody .tl-card').length === 1, null, 'the held position is shown');
    ok(await page.evaluate(() => /Inactive/.test(document.querySelector('#tradeLogPanelBody .tl-card-name').textContent) && !document.querySelector('#tradeLogPanelBody .tl-name-link')), 'the card is tagged Inactive and has no link to a stock page');
    ok(await page.evaluate(t => window.__alba.stocks.length === window.__alba.loadInfo.count - 1 && !window.__alba.stocks.some(s => s.ticker === t), off.ticker), 'the stock list the screens use leaves the inactive stock out');
    await goto(page, 'analysis');
    await page.fill('#globalSearch', off.name); await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.querySelectorAll('#globalSuggest .suggest-item, #globalSuggest [role="option"]').length === 0), 'search does not offer the inactive stock');
    await page.fill('#globalSearch', FIXTURE[4].name); await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.querySelectorAll('#globalSuggest .suggest-item, #globalSuggest [role="option"]').length > 0), 'search still offers an active stock (so the check above can fail)');
  });
}

async function main(){
  base = await srv.listen(); browser = await chromium.launch();
  try { await pinScenarios(); await tradeScenarios(); await inactiveScenario(); await ideasFilterScenarios(); await heldTagScenario(); await sourceTagsScenario(); await bulletsWithoutSourcesScenario(); } finally { await browser.close(); srv.close(); }
  if(problems.length){ console.error('state tests FAILED (' + problems.length + ' problems, ' + checks + ' checks):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('state tests: ' + checks + ' checks passed');
}
main().catch(e => { console.error(e); process.exit(1); });
