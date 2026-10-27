// Browser smoke test (real Chromium via Playwright): the parts the jsdom harness cannot see.
//  1. src/boot (start-up): loading the stock list from the (stand-in) database, the IndexedDB cache, version bumps, the "data updated"
//     banner, a chunk that fails once, and every failure message the user can see (no database, no index, missing chunk, wrong count, app.js missing).
//  2. Layout and CSS: every section at desktop, tablet and phone width has no sideways scrolling, nothing sticking out of the
//     screen, no errors in the console; the Live Data Refresh panels sit side by side on desktop and stacked on a phone; the three themes.
// It does NOT test the real claude.ai runtime, real TradingView or Claude. Playwright is a pinned devDependency (`npm ci` installs it,
// `npx playwright install chromium` fetches the browser). Without it the suite says "SKIPPED" (exit 0) on a developer machine, but fails in CI.
// Usage: node tests/browser.js   (also run by `npm run check` when Playwright is available)
const fs = require('fs'), path = require('path');
const { chromiumOrSkip, startServer, openPage: openPageEnv } = require('./lib/env.js');
const chromium = chromiumOrSkip('browser smoke test');
const srv = startServer();
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stocks.json'), 'utf8')).stocks;
const CHUNKS = [FIXTURE.slice(0, Math.ceil(FIXTURE.length / 2)), FIXTURE.slice(Math.ceil(FIXTURE.length / 2))];

const problems = []; let checks = 0;
const ok = (cond, msg) => { checks++; if(!cond) problems.push(msg); };
async function openPage(ctx, cfg, label){ return openPageEnv(ctx, base, Object.assign({ chunks: CHUNKS }, cfg), label); }
// ready = the stock list has arrived AND app.js has run (it opens the first page); the nav buttons exist in the static HTML so they prove nothing
const appReady = page => page.waitForFunction(() => window.__alba && window.__alba.stocks && document.querySelector('.app-section.active'), null, { timeout: 20000 });
const bootText = page => page.evaluate(() => { const b = document.getElementById('bootStatus'); return { hidden: b.hidden, msg: b.querySelector('.boot-msg').textContent, retry: !b.querySelector('.boot-retry').hidden }; });
let base;

// ---------------------------------------------------------------- 1. database loading
async function bootTests(browser){
  // fresh browser profile: list comes from the database, in chunks, and is cached
  let ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let { page, errs } = await openPage(ctx, {}, 'fresh');
  await appReady(page); await page.waitForTimeout(300);
  let info = await page.evaluate(() => window.__alba.loadInfo);
  ok(info && info.source === 'database' && info.cache === false && info.count === FIXTURE.length && info.version === 1, 'fresh load: load info is ' + JSON.stringify(info));
  ok((await bootText(page)).hidden, 'fresh load: the loading message is hidden once the app has started');
  const gets = await page.evaluate(() => window.__gets.filter(p => p.startsWith('stockData/')).sort());
  ok(JSON.stringify(gets) === '["stockData/c001","stockData/c002"]', 'fresh load: both chunks fetched once, got ' + JSON.stringify(gets));
  ok(await page.evaluate(() => Array.isArray(window.__alba.stocks) && window.__alba.stocks.length), 'fresh load: stock list is on the page');
  const diag = await page.evaluate(() => window.__store.get('diagnostics/stockLoad'));
  ok(diag && diag.source === 'database' && diag.count === FIXTURE.length && diag.cache === false, 'fresh load: diagnostics record written: ' + JSON.stringify(diag));
  ok(errs.length === 0, 'fresh load: console errors: ' + errs.slice(0, 3).join(' | '));
  { // a stock code left in the address must open the stock once; a refresh then returns to the page, not the stock
    const code = FIXTURE[3].ticker.split('·')[0].trim();
    await page.evaluate(c => { location.hash = c; }, code); await page.waitForTimeout(500);
    const open = () => page.evaluate(() => { const d = document.getElementById('detail'); return !!d.querySelector('.detail-name') && d.parentNode.id !== 'detailHome'; });
    ok(await open(), 'address code: the stock opens');
    await page.reload(); await appReady(page); await page.waitForTimeout(600);
    ok(!(await open()), 'address code: after a refresh the page you were on is shown, not the stock');
  }
  await page.close();

  // second visit, same browser profile: served from the IndexedDB cache, chunks not fetched again
  ({ page, errs } = await openPage(ctx, {}, 'cached'));
  await appReady(page);
  info = await page.evaluate(() => window.__alba.loadInfo);
  ok(info.cache === true && info.count === FIXTURE.length, 'second visit: should use the cache, got ' + JSON.stringify(info));
  ok((await page.evaluate(() => window.__gets.filter(p => p.startsWith('stockData/')).length)) === 0, 'second visit: no chunk should be fetched when the cache is current');
  ok(errs.length === 0, 'second visit: console errors: ' + errs.slice(0, 3).join(' | '));
  await page.close();

  // the database now has a newer version: the cache is ignored and every chunk is fetched again
  ({ page, errs } = await openPage(ctx, { seed: { version: 2 } }, 'bumped'));
  await appReady(page);
  info = await page.evaluate(() => window.__alba.loadInfo);
  ok(info.cache === false && info.version === 2, 'new version: cache must be ignored, got ' + JSON.stringify(info));
  ok((await page.evaluate(() => window.__gets.filter(p => p.startsWith('stockData/')).length)) === 2, 'new version: both chunks fetched again');
  // while the page is open somebody bumps the version: the "data updated" banner appears once, with a Reload button
  ok(!(await page.locator('#dataUpdateBanner').count()), 'banner must not show before the data changes');
  await page.evaluate(() => { const m = window.__store.get('stockMeta/main'); window.__setDoc('stockMeta/main', Object.assign({}, m, { version: 3 })); });
  await page.waitForSelector('#dataUpdateBanner', { timeout: 3000 });
  await page.evaluate(() => { const m = window.__store.get('stockMeta/main'); window.__setDoc('stockMeta/main', Object.assign({}, m, { version: 4 })); });
  ok((await page.locator('#dataUpdateBanner').count()) === 1, 'the update banner should be shown once, not stacked');
  ok((await page.locator('#dataUpdateBanner button').innerText()) === 'Reload', 'the update banner has a Reload button');
  ok(errs.length === 0, 'new version: console errors: ' + errs.slice(0, 3).join(' | '));
  await page.close(); await ctx.close();

  // a chunk fails once: the loader retries and succeeds
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ({ page, errs } = await openPage(ctx, { failOnce: 'stockData/c002' }, 'retry'));
  await appReady(page);
  ok((await page.evaluate(() => window.__gets.filter(p => p === 'stockData/c002').length)) === 2, 'a chunk that fails once is fetched a second time');
  ok((await page.evaluate(() => window.__alba.loadInfo.count)) === FIXTURE.length, 'after the retry the whole list is loaded');
  await page.close(); await ctx.close();

  // the messages people see when it cannot load
  const failCases = [
    ['no database in this view', { noClaude: true }, /the database is not available in this view/],
    ['no stock index', { noMeta: true }, /stock index not found in the database/],
    ['a chunk is missing', { missingChunk: 1 }, /chunk c002 is missing/],
    ['count does not match', { seed: { count: FIXTURE.length + 5 } }, new RegExp('expected ' + (FIXTURE.length + 5) + ' stocks but received ' + FIXTURE.length)],
  ];
  for(const [name, cfg, re] of failCases){
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    ({ page } = await openPage(ctx, cfg, name));
    const shown = await page.waitForFunction(() => { const b = document.getElementById('bootStatus'); return b && !b.hidden && /Could not/.test(b.textContent); }, null, { timeout: 15000 }).then(() => true, () => false);
    ok(shown, name + ': an error message should be shown, but the page started');
    if(!shown){ await page.close(); await ctx.close(); continue; }
    const t = await bootText(page);
    ok(re.test(t.msg) && /^Could not load the stock data:/.test(t.msg), name + ': message is "' + t.msg + '"');
    ok(t.retry, name + ': a Retry button is offered');
    ok(await page.evaluate(() => getComputedStyle(document.getElementById('bootStatus')).position === 'fixed' && document.getElementById('bootStatus').getBoundingClientRect().height >= innerHeight - 1), name + ': the message covers the page');
    await page.close(); await ctx.close();
  }
  // app.js cannot be fetched
  srv.appBroken = true; ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ({ page } = await openPage(ctx, {}, 'app.js missing'));
  await page.waitForFunction(() => /Could not start the dashboard/.test(document.getElementById('bootStatus').textContent), null, { timeout: 15000 });
  const t = await bootText(page); ok(!t.hidden && /could not load app\.js/.test(t.msg), 'app.js missing: message is "' + t.msg + '"');
  await page.close(); await ctx.close(); srv.appBroken = false;
}

// ---------------------------------------------------------------- 2. layout
const SECTIONS = ['analysis', 'business', 'strategies', 'trackrecord', 'refreshlog', 'help', 'knowledgebase', 'settings'];
const goto = (page, k) => page.evaluate(k => document.querySelector('.nav-item[data-section="' + k + '"]').click(), k);
// elements whose right edge is past the screen, ignoring ones that scroll inside their own box or are hidden
const sticksOut = page => page.evaluate(() => {
  const W = document.documentElement.clientWidth, out = [];
  const clipped = el => { for(let p = el.parentElement; p && p !== document.body; p = p.parentElement){ const o = getComputedStyle(p); if(/(auto|scroll|hidden|clip)/.test(o.overflowX) && p.getBoundingClientRect().width <= W + 1) return true; } return false; };
  for(const el of document.querySelectorAll('.app-section.active *')){
    const r = el.getBoundingClientRect(); if(!r.width || !r.height) continue;
    if(r.right > W + 1 && getComputedStyle(el).position !== 'fixed' && !clipped(el)) out.push((el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0] + ' ' + el.tagName.toLowerCase() + ' right=' + Math.round(r.right));
    if(out.length >= 5) break;
  }
  return { scrolls: document.documentElement.scrollWidth > W, scrollWidth: document.documentElement.scrollWidth, W, out };
});
// ---------------------------------------------------------------- 1b. markup in a stock name
// A stock name from the CSV is data, not HTML: on the stock page it shows as text and never runs.
async function markupNameTests(browser){
  const evil = '<img src=x onerror="window.__xss=1">Evil & Co';
  const stocks = FIXTURE.map((s, i) => i === 3 ? Object.assign({}, s, { name: evil }) : s);
  const half = Math.ceil(stocks.length / 2);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const { page } = await openPage(ctx, { chunks: [stocks.slice(0, half), stocks.slice(half)] }, 'markup name');
  await appReady(page);
  await page.evaluate(c => { location.hash = c; }, FIXTURE[3].ticker.split('·')[0].trim()); await page.waitForTimeout(500);
  ok((await page.locator('#detail .detail-name').innerText()) === evil, 'markup in a stock name: shown as plain text on the stock page');
  ok(!(await page.evaluate(() => window.__xss)), 'markup in a stock name: the script in it did not run');
  await ctx.close();
}

// ---------------------------------------------------------------- 3. Business page
async function businessTests(browser){
  const ctx = await browser.newContext({ viewport: process.env.SHOT ? { width: 400, height: 800 } : { width: 1280, height: 900 } });
  const { page, errs } = await openPage(ctx, {}, 'business'); await appReady(page); await page.waitForTimeout(400);
  await goto(page, 'business'); await page.waitForSelector('#businessBody .biz-row', { timeout: 5000 });
  const rows = await page.locator('.biz-row').count();
  ok(rows > 3, 'business: industries are listed (' + rows + ')');
  const means = await page.$$eval('.biz-row', trs => trs.map(tr => tr.children[2].textContent.trim()));
  const nums = means.map(t => parseFloat(t)).filter(n => !isNaN(n));
  ok(nums.every((n, i) => i === 0 || n <= nums[i - 1] + 1e-9), 'business: ranked by average change, highest first');
  // heat map: tiles are sized by % change by default; the toggle switches to number of stocks and the choice is saved
  await page.locator('[data-biz-view="heat"]').click(); await page.waitForSelector('.hm-tile', { timeout: 5000 });
  ok((await page.locator('[data-biz-size].active').getAttribute('data-biz-size')) === 'chg', 'heat map: sized by % change by default');
  const tilesChg = await page.$$eval('.hm-tile', t => t.slice(0, 5).map(x => x.title).join('|'));
  const signs = await page.$$eval('.hm-tile', t => t.map(x => (/: \+?(-?[0-9.]+)% average/.exec(x.title) || [0, '0'])[1]).map(v => parseFloat(v) > 0 ? 1 : 0));
  ok(signs.includes(1) && signs.includes(0) && signs.indexOf(0) > signs.lastIndexOf(1), 'heat map: sized by % change, the risers come first and then the fallers');
  await page.locator('[data-biz-size="count"]').click(); await page.waitForTimeout(200);
  const tilesCount = await page.$$eval('.hm-tile', t => t.slice(0, 5).map(x => x.title).join('|'));
  ok((await page.locator('[data-biz-size].active').getAttribute('data-biz-size')) === 'count' && tilesChg !== tilesCount, 'heat map: the toggle re-sizes the tiles by number of stocks');
  ok(/"heatSize":"count"/.test(await page.evaluate(() => localStorage.getItem('albaDashboard.business.v1') || '')), 'heat map: the size choice is remembered in the browser');
  await page.locator('[data-biz-size="chg"]').click(); await page.locator('[data-biz-view="table"]').click(); await page.waitForSelector('.biz-row', { timeout: 5000 });
  await page.locator('.biz-row').first().click();
  if(process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  ok((await page.locator('.biz-detail').count()) === 1 && (await page.locator('.biz-detail .strat-row').count()) >= 1, 'business: clicking an industry opens its stocks and news');
  // (the grids of opened industries are skipped by the browser until the next frame, see styles/business.css, so their text reads empty for an instant after the click: wait for it)
  await page.waitForFunction(() => /M RSI/i.test((document.querySelector('.biz-detail .strat-table thead') || {}).innerText || ''), null, { timeout: 5000 });
  ok(/M RSI/i.test(await page.locator('.biz-detail .strat-table thead').innerText()) && /M Tech Rating/i.test(await page.locator('.biz-detail .strat-table thead').innerText()), 'business: the stocks use the same grid columns as Analysis and Strategies');
  await page.locator('.biz-detail .strat-row').first().click(); await page.waitForTimeout(300);
  ok(await page.evaluate(() => { const b = document.getElementById('section-business'); return b.classList.contains('active') && b.contains(document.getElementById('detail')) && !!document.querySelector('#detail .detail-name'); }) && /Back to Explorer/.test(await page.locator('#detailBackBtn').innerText()), 'business: clicking a stock opens its detail right there with a way back');
  { // the stock page: its links keep their styling, and the Back button stays in view under the top bar while scrolling
    const linkColour = await page.evaluate(() => getComputedStyle(document.querySelector('#detail .detail-meta-links a')).color);
    ok(linkColour !== 'rgb(0, 0, 238)' && !/^rgb\(85, 26, 139\)/.test(linkColour), 'stock page: the links under the name are styled (' + linkColour + ')');
    await page.evaluate(() => window.scrollTo(0, 700)); await page.waitForTimeout(400);
    const bb = await page.evaluate(() => { const r = document.getElementById('detailBackBtn').getBoundingClientRect(), t = document.querySelector('.topbar').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), bar: Math.round(t.bottom), h: window.innerHeight }; });
    ok(bb.top >= bb.bar - 1 && bb.bottom < bb.h && bb.top < bb.bar + 20, 'stock page: the Back button stays under the top bar when scrolled ' + JSON.stringify(bb));
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
  }
  await page.locator('#detailBackBtn').click(); await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.getElementById('section-business').classList.contains('active') && !document.getElementById('section-business').contains(document.getElementById('detail'))) && (await page.locator('.biz-detail').count()) === 1, 'business: Back returns to the page with the industry still open');
  await page.locator('.biz-row').first().click();
  ok((await page.locator('.biz-detail').count()) === 0, 'business: clicking again closes it');
  { // the industry page: factors, global & macro, charts, news timeline and stocks, with a way back
    const name = await page.locator('.biz-row .biz-name').first().evaluate(td => td.firstChild.textContent.trim());
    await page.locator('.biz-open').first().click(); await page.waitForTimeout(300);
    const got = await page.evaluate(() => ['jump-ind-factors', 'jump-ind-global', 'jump-ind-charts', 'jump-ind-news', 'jump-ind-stocks'].map(id => !!document.querySelector('#detail #' + id)));
    ok(got.every(Boolean) && (await page.locator('#detail .detail-name').innerText()) === name && (await page.locator('#detail .biz-row, .biz-detail').count()) === 0, 'industry page: opens with factors, global & macro, charts, news and stocks (' + name + ')');
    ok((await page.locator('#detail #jump-ind-stocks .strat-row').count()) >= 1 && /Back to Explorer/.test(await page.locator('#detailBackBtn').innerText()), 'industry page: lists its stocks and has a way back');
    await page.locator('#jump-ind-stocks .strat-row').first().click(); await page.waitForTimeout(300);
    ok((await page.locator('#detail .detail-jump-ticker').count()) >= 1, 'industry page: clicking a stock opens its page');
    await page.locator('#detailBackBtn').click(); await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById('section-business').classList.contains('active') && !document.getElementById('section-business').contains(document.getElementById('detail'))), 'industry page: Back returns to the Explorer');
  }
  { // Strategy: none by default; choosing one counts its stocks per industry, highlights them and lists them first when open, nothing removed
    ok(!/Matching/i.test(await page.locator('.biz-table > thead').innerText()) && !/Matched \d+ of/.test(await page.locator('#businessBody').innerText()), 'business: no strategy chosen, so no matching columns');
    const before = await page.locator('.biz-row').count();
    const opts = await page.$$eval('[data-biz-strat]', bs => bs.map(b => b.dataset.bizStrat).filter(Boolean));
    ok(opts.length >= 2, 'business: the saved strategies can be chosen (' + opts.length + ')');
    let withMatch = [];
    for(const id of opts){
      await page.locator('[data-biz-strat="' + id + '"]').click();
      withMatch = await page.$$eval('.biz-row', trs => trs.map((tr, i) => ({ i, m: parseInt(tr.children[6].textContent, 10) })).filter(x => x.m > 0));
      if(withMatch.length) break;
    }
    const hdr = await page.locator('.biz-table > thead').innerText();
    ok(/Matching/i.test(hdr) && /vs industry/i.test(hdr) && /Matched \d+ of \d+ stocks/.test(await page.locator('#businessBody').innerText()) && (await page.locator('.biz-row').count()) === before, 'business: a strategy adds Matching and vs industry columns and the Matched line without removing industries');
    if(withMatch.length){
      await page.locator('.biz-row').nth(withMatch[0].i).click();
      const rows = await page.$$eval('.biz-detail .strat-row', trs => trs.map(t => t.classList.contains('biz-match')));
      const k = rows.filter(Boolean).length;
      if(!(await page.locator('.biz-detail [data-biz-newstoggle][aria-expanded="true"]').count())) await page.locator('.biz-detail [data-biz-newstoggle]').first().click();
      await page.locator('.biz-detail .biz-newsbtn').first().evaluate(b => b.click()); await page.waitForSelector('.rk-menu [data-rk-act="choice-run"]', { timeout: 5000 }).catch(() => {});
      const nb = await page.locator('.rk-menu [data-rk-act="choice-run"]').count();
      await page.keyboard.press('Escape'); await page.evaluate(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))); await page.waitForTimeout(150);
      ok(nb === (k < rows.length ? 2 : 1), 'business: an opened industry offers news for all its stocks' + (k < rows.length ? ' and for just the matching ones' : '') + ' (' + nb + ' choices)');
      ok(k === withMatch[0].m && rows.slice(0, k).every(Boolean) && rows.slice(k).every(x => !x), 'business: matching stocks are highlighted and listed first (' + k + ' of ' + rows.length + ')');
      await page.locator('.biz-row').nth(withMatch[0].i).click();
    } else ok(true, 'business: (no industry has a stock matching these strategies in this data)');
  }
  await page.locator('[data-biz-all]').click();
  const nRows = await page.locator('.biz-row').count();
  ok((await page.locator('.biz-detail').count()) === nRows && /Collapse all/.test(await page.locator('[data-biz-all]').innerText()), 'business: Expand all opens every industry (' + nRows + ') and the button becomes Collapse all');
  await page.locator('[data-biz-all]').click();
  ok((await page.locator('.biz-detail').count()) === 0 && /Expand all/.test(await page.locator('[data-biz-all]').innerText()), 'business: Collapse all closes them again');
  { const m = await page.evaluate(() => { const r = document.querySelector('.biz-row'); return { caret: !!document.querySelector('.biz-caret'), wrap: Math.round(r.children[0].getBoundingClientRect().height) <= 45 }; });
    ok(!m.caret && m.wrap, 'business: no arrow before the industry names, names stay on one line ' + JSON.stringify(m)); }
  { // columns fit their content, and opening an industry does not change their widths
    const widths = () => page.$$eval('.biz-table > thead th', ths => ths.map(t => Math.round(t.getBoundingClientRect().width)));
    const closed = await widths(), tw = await page.$eval('.biz-table', t => t.getBoundingClientRect().width), sw = await page.$eval('.biz-scroll', t => t.getBoundingClientRect().width);
    await page.locator('.biz-row').first().click();
    const opened = await widths();
    ok(JSON.stringify(closed) === JSON.stringify(opened), 'business: columns keep their widths when an opened industry does not change them ' + JSON.stringify(closed) + ' vs ' + JSON.stringify(opened));
    await page.locator('.biz-row').first().click();
  }
  { // collecting news on demand: runs, reports, and never breaks the page (the stand-in feed has no headlines)
    ok((await page.locator('.biz-newsbtn').count()) === 0, 'business: no news button at the top of the page, only inside an opened industry');
    await page.locator('.biz-row').first().click();
    if(!(await page.locator('.biz-detail [data-biz-newstoggle][aria-expanded="true"]').count())) await page.locator('.biz-detail [data-biz-newstoggle]').first().click();
    await page.locator('.biz-newsbtn').first().click();
    await page.waitForSelector('.rk-menu [data-rk-act="choice-run"]:not([disabled])', { timeout: 5000 });
    await page.locator('.rk-menu [data-rk-act="choice-run"]:not([disabled])').first().click();
    await page.waitForFunction(() => /^Done|Could not/.test((document.getElementById('bizNewsStatus') || { textContent: '' }).textContent), null, { timeout: 60000 });
    const st = await page.locator('#bizNewsStatus').innerText();
    ok(/^Done\. Looked at \d+ of \d+ stocks/.test(st) && /Refresh/.test(await page.locator('.biz-newsbtn').first().innerText()), 'business: Collect latest news runs and reports: ' + st.slice(0, 90));
  }
  await page.locator('[data-biz-period="1W"]').click();
  ok(/Average 1W/i.test(await page.locator('.biz-table th').nth(2).innerText()), 'business: the period buttons change the figures');
  await page.locator('[data-biz-period="3M"]').click(); await page.waitForTimeout(500);
  ok(/Average 3M/i.test(await page.locator('.biz-table th').nth(2).innerText()), 'business: a longer period reads weekly prices');
  { const t = await page.locator('#businessBody').innerText(); ok(!/Macro view|1 week change is|3 months change is|Nothing is hidden/.test(t) && /Matched \d+ of \d+ stocks/.test(t) && !/^\s*Industries\s*$/m.test(t), 'business: only the "Matched N of M stocks" line is shown above the grid'); }
  await page.locator('[data-biz-by="group"]').click();
  ok(/Industry group/i.test(await page.locator('.biz-table th').first().innerText()), 'business: the grouping button switches to industry groups');
  await page.reload(); await appReady(page); await page.waitForTimeout(300); await goto(page, 'business'); await page.waitForSelector('.biz-row', { timeout: 5000 });
  ok(/Industry group/i.test(await page.locator('.biz-table th').first().innerText()) && (await page.locator('[data-biz-period].active').innerText()) === '3M', 'business: the chosen period and grouping are remembered');
  ok(errs.length === 0, 'business: console errors: ' + errs.slice(0, 3).join(' | '));
  await ctx.close();
}

async function layoutTests(browser){
  for(const [w, h] of [[1280, 900], [820, 1000], [390, 800]]){
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const { page, errs } = await openPage(ctx, {}, 'layout ' + w); await appReady(page); await page.waitForTimeout(600);
    for(const k of SECTIONS){
      await goto(page, k); await page.waitForTimeout(350);
      const vis = await page.evaluate(k => { const s = document.getElementById('section-' + k); const r = s.getBoundingClientRect(); return { active: s.classList.contains('active'), h: Math.round(r.height), text: s.innerText.trim().length }; }, k);
      ok(vis.active && vis.h > 50 && vis.text > 20, `${w}px ${k}: section shows content (${JSON.stringify(vis)})`);
      const o = await sticksOut(page);
      ok(!o.scrolls && o.out.length === 0, `${w}px ${k}: sideways overflow (page ${o.scrollWidth} > ${o.W}) ${o.out.join('; ')}`);
    }
    // Refresh menus: Analysis and Strategies each have one "Refresh" button in the header that opens a menu with Fundamental and Technical
    for(const sec of ['analysis', 'strategies']){
      await goto(page, sec); await page.waitForTimeout(400);
      const bar = page.locator('#section-' + sec + ' [data-rk-act="bar-menu"]').first();
      ok((await bar.count()) === 1, `${w}px ${sec}: the header has one Refresh button`);
      if(await bar.count()){
        await bar.evaluate(b => b.click()); await page.waitForTimeout(250);
        const m = await page.evaluate(() => { const e = document.querySelector('.rk-menu'); if(!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), W: window.innerWidth, text: e.innerText }; });
        ok(!!m && /Fundamental/.test(m.text) && /Technical/.test(m.text), `${w}px ${sec}: the Refresh menu offers Fundamental and Technical`);
        ok(!!m && m.l >= -1 && m.r <= m.W + 1, `${w}px ${sec}: the Refresh menu fits the screen ${JSON.stringify(m && { l: m.l, r: m.r, W: m.W })}`);
        await page.keyboard.press('Escape'); await page.evaluate(() => document.body.click()); await page.waitForTimeout(150);
      }
      const o = await sticksOut(page); ok(!o.scrolls && o.out.length === 0, `${w}px ${sec}: overflow ${o.out.join('; ')}`);
    }
    // Analysis grouped by industry: the group lines fit the screen and nothing sticks out
    await goto(page, 'analysis'); await page.waitForTimeout(300);
    const setGroup = v => page.evaluate(v => { const g = document.getElementById('analysisGroupSelect'); g.value = v; g.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    await setGroup('industry'); await page.waitForTimeout(400);
    ok((await page.evaluate(() => document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-group').length)) > 0, `${w}px analysis grouped: group lines are drawn`);
    { const og = await sticksOut(page); ok(!og.scrolls && og.out.length === 0, `${w}px analysis grouped: overflow ${og.out.join('; ')}`); }
    await setGroup('none'); await page.waitForTimeout(300);
    // a stock's page
    await goto(page, 'analysis'); await page.waitForTimeout(400);
    await page.fill('#globalSearch', FIXTURE[0].name); await page.waitForTimeout(250); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
    const o = await sticksOut(page); ok(!o.scrolls && o.out.length === 0, `${w}px stock page: overflow ${o.out.join('; ')}`);
    if(w >= 1000){
      // the short name line shows only after the big header has scrolled away
      const who = () => page.evaluate(() => getComputedStyle(document.querySelector('#detail .detail-jump-who')).display !== 'none');
      ok(!(await who()), 'sticky name line is hidden at the top of the page');
      await page.evaluate(() => window.scrollTo(0, 700)); await page.waitForTimeout(500);
      ok(await who(), 'sticky name line shows after scrolling down');
      await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(500);
      ok(!(await who()), 'sticky name line hides again at the top');
    }
    if(w <= 450){
      // phones: no Jump-to row on a stock's page
      ok(await page.evaluate(() => ['.detail-jump'].every(s => { const e = document.querySelector('#detail ' + s); return !!e && e.getBoundingClientRect().width === 0; })), 'phone: the Jump-to row and the Full screen button are hidden');
      ok(await page.evaluate(() => ['.detail', '.val-panel', '.fund-cell'].every(s => { const e = document.querySelector('#detail' + (s === '.detail' ? '' : ' ' + s)) || document.querySelector(s); return !e || (parseFloat(getComputedStyle(e).borderLeftWidth) === 0 && parseFloat(getComputedStyle(e).borderRightWidth) === 0); })), 'phone: the stock page is flat (no boxes around the page, panels or factor cards)');
      // phones: Analysis's filters start folded into one "Filters" line and open when it is tapped
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      await goto(page, 'analysis'); await page.waitForTimeout(400);
      const fgVisible = () => page.evaluate(() => document.getElementById('analysisFilterGroups').getBoundingClientRect().height > 0);
      ok(!(await fgVisible()), 'phone: the filters start collapsed');
      await page.evaluate(() => document.getElementById('analysisFiltersToggle').click()); await page.waitForTimeout(150);
      ok(await fgVisible(), 'phone: tapping Filters opens the filter buttons');
      await page.evaluate(() => document.getElementById('analysisFiltersToggle').click()); await page.waitForTimeout(150);
      ok(!(await fgVisible()), 'phone: tapping Filters again folds them');
    } else {
      ok(await page.evaluate(() => document.querySelector('#detail .detail-jump').getBoundingClientRect().width > 0), `${w}px: the Jump-to row is shown`);
    }
    ok(errs.length === 0, `${w}px layout run: console errors: ${errs.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }
  // the three themes: nothing sticks out and text is readable (text colour differs from its background)
  for(const theme of ['dark', 'light', 'indigo', 'white']){
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const { page, errs } = await openPage(ctx, { theme }, 'theme ' + theme); await appReady(page); await page.waitForTimeout(500);
    ok((await page.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark')) === theme, `theme ${theme}: applied`);
    for(const k of ['analysis', 'strategies']){ await goto(page, k); await page.waitForTimeout(300); const o = await sticksOut(page); ok(!o.scrolls && o.out.length === 0, `theme ${theme} ${k}: overflow ${o.out.join('; ')}`); }
    const colours = await page.evaluate(() => { const b = getComputedStyle(document.body); return [b.color, b.backgroundColor]; });
    ok(colours[0] !== colours[1], `theme ${theme}: text and background colours differ (${colours.join(' on ')})`);
    ok(errs.length === 0, `theme ${theme}: console errors ${errs.slice(0, 2).join(' | ')}`);
    await ctx.close();
  }
}

// ---------------------------------------------------------------- 4. long grids: Analysis and Strategies draw 300 rows, then 300 more on request
async function rowCapTests(browser){
  const many = [];   // the sample list repeated under new names until the default Analysis range alone holds more than 300
  for(let i = 0; many.length < 1400; i++){ const s = JSON.parse(JSON.stringify(FIXTURE[i % FIXTURE.length])); s.ticker = (i + 1) + ' \u00b7 ' + (i % 3 === 0 ? 'Big Test Industry' : s.ticker.split('\u00b7')[1].trim()); s.name = s.name + ' ' + i; s.isin = 'INE' + String(100000 + i).padStart(6, '0') + '01'; many.push(s); }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const { page, errs } = await openPage(ctx, { chunks: [many.slice(0, 700), many.slice(700)] }, 'rowcap');
  await appReady(page); await page.waitForTimeout(600);
  const rows = sel => page.evaluate(sel => document.querySelectorAll(sel).length, sel);
  const total = await page.evaluate(() => (document.getElementById('analysisLeaderboardCount').textContent.match(/Showing (\d+)/) || [])[1]);
  ok(Number(total) > 300, 'row cap: the test list should put more than 300 stocks in the Analysis range, got ' + total);
  ok(await rows('#analysisLeaderboardBody tr') === 300, 'row cap: Analysis draws 300 rows first');
  { // grouped by industry: the cap counts stocks, not group lines; folding every group leaves only the lines; then back to a flat list
    const grouped = v => page.evaluate(v => { const g = document.getElementById('analysisGroupSelect'); g.value = v; g.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    await grouped('industry'); await page.waitForTimeout(600);
    ok(await rows('#analysisLeaderboardBody .analysis-lb-row') === 300 && await rows('#analysisLeaderboardBody .analysis-lb-group') > 1, 'row cap: grouped, Analysis still draws 300 stocks first (group lines are not counted)');
    ok(await rows('[data-lb-more]') === 1, 'row cap: grouped, Show more is offered');
    await page.evaluate(() => document.getElementById('analysisGroupAllBtn').click()); await page.waitForTimeout(300);
    ok(await rows('#analysisLeaderboardBody .analysis-lb-row') === 0 && await rows('#analysisLeaderboardBody .analysis-lb-group') > 1 && (await page.locator('#analysisGroupAllBtn').innerText()) === 'Expand all', 'row cap: Collapse all leaves only the group lines');
    await page.evaluate(() => document.getElementById('analysisGroupAllBtn').click()); await page.waitForTimeout(300);
    ok(await rows('#analysisLeaderboardBody .analysis-lb-row') === 300, 'row cap: Expand all brings the rows back');
    await grouped('none'); await page.waitForTimeout(600);
    ok(await rows('#analysisLeaderboardBody tr') === 300 && await rows('#analysisLeaderboardBody .analysis-lb-group') === 0, 'row cap: Group by None returns to the flat list');
  }
  await page.locator('[data-lb-more]').click(); await page.waitForTimeout(300);
  ok(await rows('#analysisLeaderboardBody tr') === Math.min(600, Number(total)), 'row cap: Show more adds 300 Analysis rows');
  await goto(page, 'strategies'); await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('stratNew').click()); await page.waitForTimeout(400);   // a new strategy has no rules: every stock qualifies
  ok(await rows('#stratResults .strat-row') === 300, 'row cap: Strategies draws 300 rows first');
  await page.locator('[data-strat-more]').click(); await page.waitForTimeout(300);
  ok(await rows('#stratResults .strat-row') === 600, 'row cap: Show more adds 300 Strategies rows');
  // Explorer: opening and closing an industry changes only that row (the rest of the table is not redrawn)
  await goto(page, 'business'); await page.waitForSelector('.biz-row', { timeout: 5000 });
  const tog = await page.evaluate(async () => {
    const r = Array.from(document.querySelectorAll('.biz-row')), keep = r[r.length - 1]; keep.dataset.keep = '1';
    r[0].click(); await new Promise(x => setTimeout(x, 50));
    const opened = !!(r[0].nextElementSibling && r[0].nextElementSibling.classList.contains('biz-detail')) && r[0].classList.contains('open') && r[0].getAttribute('aria-expanded') === 'true';
    const survived = document.querySelector('.biz-row[data-keep="1"]') === keep;   // the same element: the table was not rebuilt
    const label = document.querySelector('[data-biz-all]').textContent;
    r[0].click(); await new Promise(x => setTimeout(x, 50));
    const closed = !(r[0].nextElementSibling && r[0].nextElementSibling.classList.contains('biz-detail')) && !r[0].classList.contains('open') && r[0].getAttribute('aria-expanded') === 'false';
    return { opened, survived, closed, label };
  });
  ok(tog.opened && tog.closed, 'explorer toggle: a row opens its detail and closes it again, ' + JSON.stringify(tog));
  ok(tog.survived, 'explorer toggle: opening a row does not redraw the other rows');
  ok(tog.label === 'Expand all' || tog.label === 'Collapse all', 'explorer toggle: the Expand all button keeps a label');
  // an industry page with more than 300 stocks: 300 rows first, 300 more on request, and a row still opens its stock
  await goto(page, 'business'); await page.waitForSelector('.biz-row', { timeout: 5000 });
  const big = await page.evaluate(() => { const n = {}; window.__alba.stocks.forEach(s => { const k = (s.ticker.split('\u00b7')[1] || '').trim(); n[k] = (n[k] || 0) + 1; }); const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0]; return { name: top[0], count: top[1] }; });
  ok(big.count > 300, 'row cap: the test list should have an industry with more than 300 stocks, got ' + big.count);
  await page.evaluate(name => { Array.from(document.querySelectorAll('.biz-open')).find(b => b.dataset.bizOpen === name).click(); }, big.name); await page.waitForSelector('#jump-ind-stocks tbody tr', { timeout: 5000 });
  ok(await rows('#jump-ind-stocks tbody tr') === 300, 'row cap: an industry page draws 300 stocks first');
  await page.locator('[data-ind-more]').click(); await page.waitForTimeout(300);
  ok(await rows('#jump-ind-stocks tbody tr') === Math.min(600, big.count), 'row cap: Show more adds 300 stocks to an industry page');
  await page.locator('#jump-ind-stocks tbody tr').nth(400).evaluate(tr => tr.click()); await page.waitForTimeout(400);
  ok(await page.evaluate(() => !!document.querySelector('#detail .detail-name') && !document.getElementById('jump-ind-stocks')), 'row cap: a row added by Show more opens its stock');
  ok(errs.length === 0, 'row cap: console errors: ' + errs.slice(0, 3).join(' | '));
  await page.close(); await ctx.close();
}

// ---------------------------------------------------------------- 5. text saved with a stock is never drawn as markup
async function escapeTests(browser){
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const { page, errs } = await openPage(ctx, {}, 'escape');
  await appReady(page); await page.waitForTimeout(500);
  const code = FIXTURE[3].ticker.split('\u00b7')[0].trim();
  await page.evaluate(c => {   // what Claude (or another tool) could have saved with the stock: text with markup in it
    const bad = '<img src=x data-evil=1 onerror="window.__evil=1">';
    const s = window.__alba.stocks.find(x => x.ticker.split('\u00b7')[0].trim() === c);
    s.__fundSummary = { strengths: [{ text: bad + ' steady & strong', tone: 'strong' }], watchouts: [{ text: '<script>window.__evil=2</script>', tone: 'concern' }] };
    s.globalFactors = { positive: [{ text: bad + ' tailwind', source: 'Src' }], negative: [{ text: 'risk' }], events: [{ impact: 'negative', headline: bad, why: bad, source: 'Src' }] };
    location.hash = c;
  }, code);
  await page.waitForSelector('#detail .detail-name', { timeout: 5000 });
  const r = await page.evaluate(() => ({ imgs: document.querySelectorAll('#detail [data-evil]').length, scripts: document.querySelectorAll('#detail script').length, evil: window.__evil || 0, summary: (document.querySelector('#detail .fund-overall-summary') || {}).textContent || '', global: (document.querySelector('#jump-global') || {}).textContent || '' }));
  ok(r.imgs === 0 && r.scripts === 0 && !r.evil, 'escaping: saved text drew markup on the stock page: ' + JSON.stringify({ imgs: r.imgs, scripts: r.scripts, evil: r.evil }));
  ok(r.summary.includes('<img src=x') && r.summary.includes('steady & strong'), 'escaping: Strengths / Watch-outs show the text as written, got: ' + r.summary.slice(0, 120));
  ok(r.global.includes('tailwind') && r.global.includes('<img src=x'), 'escaping: Global & Macro shows the text as written');
  ok(errs.length === 0, 'escaping: console errors: ' + errs.slice(0, 3).join(' | '));
  await page.close(); await ctx.close();
}

// ---------------------------------------------------------------- 6. errors on the page are recorded
async function errorLogTests(browser){
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const { page } = await openPage(ctx, {}, 'errorlog');   // (the two errors below are on purpose, so the console is not checked here)
  await appReady(page); await page.waitForTimeout(500);
  await page.evaluate(() => {
    const boom = () => { throw new Error('boom one'); };
    setTimeout(boom, 0);
    Promise.reject(new Error('boom two'));
    setTimeout(boom, 20);   // the same error from the same place again: recorded once
    setTimeout(() => { throw new Error('ResizeObserver loop completed with undelivered notifications.'); }, 40);   // browser noise: ignored
  });
  await page.waitForTimeout(3800);
  const rec = await page.evaluate(() => window.__store.get('data/users/u_SMOKE/clientErrors'));
  const msgs = rec && rec.errors ? rec.errors.map(e => e.msg) : [];
  ok(msgs.length === 2 && msgs.some(m => /boom one/.test(m)) && msgs.some(m => /boom two/.test(m)), 'error log: expected the two different errors once each, got ' + JSON.stringify(msgs));
  ok(rec && rec.errors[0].page && rec.errors[0].version && rec.errors[0].when, 'error log: each entry says when, on which page and in which version');
  await page.click('#activityBell'); await page.waitForTimeout(200);
  ok(/Something went wrong on this page/.test(await page.locator('#activityPanel').innerText()), 'error log: the bell shows a notice');
  await page.close(); await ctx.close();
}

(async () => {
  base = await srv.listen();
  const browser = await chromium.launch();
  try { await bootTests(browser); await markupNameTests(browser); await businessTests(browser); await layoutTests(browser); await rowCapTests(browser); await escapeTests(browser); await errorLogTests(browser); }
  finally { await browser.close(); srv.close(); }
  if(problems.length){ console.error('browser smoke test FAILED (' + problems.length + ' of ' + checks + ' checks):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('browser smoke test: ' + checks + ' checks passed');
})().catch(e => { console.error('browser smoke test crashed:', e); process.exit(1); });
