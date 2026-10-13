// State tests (real Chromium): the shared-database state kept by src/core/store.js, seen through the page.
// Each scenario checks what the person sees AND what ended up in the (stand-in) database.
//  - Pins: shown from the database, saved per user, replaced when another device changes them, still saved when clicked before the
//    database capability has arrived, and kept for the page load only when nobody is signed in.
//  - Trade Log: shown from the live collection; add (with the duplicate guard), sell and remove; the saved Cards / Table choice;
//    the signed-out view.
// The stand-in database is the one in tests/lib/env.js (collections made live with cfg.liveCollections). It does not test the real
// claude.ai runtime. Playwright is optional (SKIPPED if missing). Usage: node tests/state.js   or   npm run state
const fs = require('fs'), path = require('path');
const { findPlaywright, startServer, openPage } = require('./lib/env.js');
const chromium = findPlaywright();
if(!chromium){ console.log('state tests: SKIPPED (Playwright not installed)'); process.exit(0); }
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

async function main(){
  base = await srv.listen(); browser = await chromium.launch();
  try { await pinScenarios(); await tradeScenarios(); } finally { await browser.close(); srv.close(); }
  if(problems.length){ console.error('state tests FAILED (' + problems.length + ' problems, ' + checks + ' checks):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('state tests: ' + checks + ' checks passed');
}
main().catch(e => { console.error(e); process.exit(1); });
