// Live ticker test (real Chromium): while the market is open the rows on screen get a fresh price from TradingView every 20 seconds,
// and the Price, MoS, W% CHG and M% CHG cells change in place without saving anything.
//  - the clock is fixed to a Monday at 10:30 India time so the market counts as open (Date only; timers stay real);
//  - the stand-in TradingView answers with a price, and with last week's and last month's closing prices from the weekly / monthly bars, set from the test;
//  - checks: the call asks for all three columns; W% CHG and M% CHG show the week-to-date and month-to-date moves and so do the stocks themselves
//    (sorting and filters read the same numbers); nothing is saved.
// It does not test the real claude.ai runtime or real TradingView. Playwright is optional (SKIPPED if missing).
// Usage: node tests/ticker.js   or   npm run ticker
const fs = require('fs'), path = require('path');
const { findPlaywright, startServer, openPage } = require('./lib/env.js');
const chromium = findPlaywright();
if(!chromium){ console.log('ticker test: SKIPPED (Playwright not installed)'); process.exit(0); }
const srv = startServer();
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stocks.json'), 'utf8')).stocks;
const CHUNKS = [FIXTURE.slice(0, Math.ceil(FIXTURE.length / 2)), FIXTURE.slice(Math.ceil(FIXTURE.length / 2))];

const problems = []; let checks = 0;
const ok = (cond, msg) => { checks++; if(!cond) problems.push(msg); return !!cond; };

// Every watched row: its stock index, the four live cells' text, and what the stock itself now holds.
const rowsNow = page => page.evaluate(() => {
  const txt = (tr, k) => { const c = tr.querySelector('[data-live="' + k + '"]'); return c ? c.textContent.trim() : null; };
  return Array.from(document.querySelectorAll('.app-section.active tr[data-idx]')).filter(tr => tr.offsetParent !== null).slice(0, 50).map(tr => {   // the ticker watches the first 50 shown rows
    const idx = Number(tr.dataset.idx), s = window.__alba.stocks[idx], raw = s.technical && s.technical.raw;
    return { idx, price: txt(tr, 'price'), week: txt(tr, 'weekChg'), month: txt(tr, 'monthChg'), hasRaw: !!raw, rawWeek: raw ? raw.weekPctChange : null, rawMonth: raw ? raw.monthPctChange : null, held: s.valuation ? s.valuation.currentPrice : null };
  });
});

(async () => {
  const base = await srv.listen();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  try {
    await ctx.clock.setFixedTime(new Date('2026-10-12T05:00:00Z'));   // Monday 10:30 IST: the NSE session is open
    const { page } = await openPage(ctx, base, { chunks: CHUNKS, liveCollections: true, section: 'analysis' }, 'ticker', errs);
    await page.waitForFunction(() => window.__alba && window.__alba.stocks && document.querySelector('.app-section.active tr[data-idx]'), null, { timeout: 20000 });
    await page.evaluate(() => { window.__tvWeekClose = 100; window.__tvMonthClose = 80; window.__tvQuote = { close: 123.4 }; });

    // 1. the first look (about 4 seconds after start-up) fills every live cell
    let good = true;
    try { await page.waitForFunction(() => { const c = Array.from(document.querySelectorAll('.app-section.active tr[data-idx]')).filter(tr => tr.offsetParent !== null).slice(0, 50).map(tr => tr.querySelector('[data-live="price"]')); return c.length > 0 && c.every(x => x && x.textContent.trim() === '₹123.4'); }, null, { timeout: 30000 }); } catch(e){ good = false; }
    ok(good, 'the live price reaches the Price cells of every row on screen');
    let rows = await rowsNow(page);
    const withRaw = rows.filter(r => r.hasRaw);
    ok(withRaw.length > 0, 'the test needs rows whose stocks have technical readings, found ' + withRaw.length + ' of ' + rows.length);
    withRaw.forEach(r => {
      ok(r.week === '+23.40%', 'W% CHG of row ' + r.idx + ' shows this week\'s move against last week\'s close, got ' + JSON.stringify(r.week));
      ok(r.month === '+54.25%', 'M% CHG of row ' + r.idx + ' shows this month\'s move against last month\'s close, got ' + JSON.stringify(r.month));
      ok(r.rawWeek === 23.4 && r.rawMonth === 54.25, 'the stock of row ' + r.idx + ' holds the same weekly and monthly figures (sorting and filters read them), got ' + r.rawWeek + ' / ' + r.rawMonth);
      ok(r.price === '₹123.4' && r.held === 123.4, 'Price of row ' + r.idx + ' is the live price, got ' + JSON.stringify(r.price) + ' / ' + r.held);
    });
    const asked = await page.evaluate(() => (window.__tvSymbolCalls || []).map(c => (c.columns || []).join(',')));
    ok(asked.length > 0 && asked.every(c => c === 'close'), 'every price look asks for the price only, got ' + JSON.stringify(Array.from(new Set(asked))));

    // 2. a later look: both figures follow the new price against the same week-start and month-start closes, which are read once per stock
    await page.evaluate(() => { window.__tvQuote = { close: 200 }; document.body.click(); });   // a click brings a look forward (about 1.5 s)
    good = true;
    try { await page.waitForFunction(() => { const c = Array.from(document.querySelectorAll('.app-section.active tr[data-idx]')).filter(tr => tr.offsetParent !== null).slice(0, 50).map(tr => tr.querySelector('[data-live="price"]')); return c.length > 0 && c.every(x => x && x.textContent.trim() === '₹200'); }, null, { timeout: 30000 }); } catch(e){ good = false; }
    ok(good, 'the next live price reaches the Price cells of every row on screen');
    rows = await rowsNow(page);
    rows.filter(r => r.hasRaw).forEach(r => {
      ok(r.week === '+100.00%' && r.month === '+150.00%', 'row ' + r.idx + ': W% CHG follows the price (+100% on last week\'s close of 100) and so does M% CHG (+150% on last month\'s close of 80), got ' + r.week + ' / ' + r.month);
      ok(r.rawWeek === 100 && r.rawMonth === 150, 'row ' + r.idx + ': the stock holds the new weekly and monthly figures, got ' + r.rawWeek + ' / ' + r.rawMonth);
    });

    const weekCalls = await page.evaluate(() => window.__tvWeekCalls || []);
    const monthCalls = await page.evaluate(() => window.__tvMonthCalls || []);
    ok(weekCalls.length > 0 && weekCalls.length === new Set(weekCalls).size && monthCalls.length === new Set(monthCalls).size && monthCalls.length === weekCalls.length, 'last week\'s and last month\'s close are read once per stock, got ' + weekCalls.length + ' / ' + monthCalls.length + ' reads for ' + new Set(weekCalls).size + ' stocks');

    // 2b. the Trade Log: an open position is watched too, so its price, return and live tag follow the live price
    {
      const s0 = FIXTURE[0], sym0 = s0.ticker.split('·')[0].trim();
      const id0 = sym0.replace(/[^A-Za-z0-9_-]/g, '_') + '-2026-10-01';
      const snap = { score: s0.score, verdict: s0.verdict, currentPriceAtSnapshot: 100, intrinsicValue: null, marginOfSafetyPct: null, fundamentalFactorsComplete: 9, fundamentalFactorsTotal: 9, technicalComponentsComplete: 5, technicalComponentsTotal: 5 };
      await page.evaluate(([id, rec]) => { window.__setDoc('data/users/u_SMOKE/portfolio/trades/' + id, rec); }, [id0, { ticker: sym0, name: s0.name, status: 'open', buy: { date: '2026-10-01', price: 100, quantity: 5, snapshot: snap }, sell: null, loggedAt: '2026-10-01T10:00:00.000Z' }]);
      await page.evaluate(() => { window.__tvQuote = { close: 150 }; document.querySelector('.nav-item[data-section="trackrecord"]').click(); });
      let g2 = true;
      try { await page.waitForFunction(() => { const c = document.querySelector('#tradeLogPanelBody .tl-card'); return !!c && /150/.test(c.textContent) && !!c.querySelector('.tl-live'); }, null, { timeout: 30000 }); } catch(e){ g2 = false; }
      ok(g2, 'an open trade on the Trade Log shows the live price (150) with the live tag');
      const txt = await page.evaluate(() => (document.querySelector('#tradeLogPanelBody .tl-card') || {}).textContent || '');
      ok(/\+50\.00%/.test(txt), 'its unrealized return follows the live price (+50% on a buy at 100), got ' + JSON.stringify(txt.slice(0, 160)));
    }

    // 3. nothing is saved by the ticker
    const saved = await page.evaluate(() => (window.__sets || []).filter(p => /^stockUpdates\//.test(p) || /^stockData\//.test(p) || /^priceHistory\//.test(p)));
    ok(saved.length === 0, 'the live ticker saves nothing, but wrote ' + JSON.stringify(saved.slice(0, 3)));
    ok(errs.length === 0, 'errors in the page: ' + errs.slice(0, 3).join(' | '));
  } catch(e){ problems.push('ticker test crashed: ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); checks++; }
  await ctx.close().catch(() => {}); await browser.close().catch(() => {}); srv.close();
  if(problems.length){ console.error('ticker test FAILED (' + problems.length + ' of ' + checks + ' checks):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('ticker test: ' + checks + ' checks passed');
  process.exit(0);
})();
