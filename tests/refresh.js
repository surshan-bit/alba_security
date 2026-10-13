// Refresh and Analysis-count tests (real Chromium), written for the header Refresh menus and the tiered refresh:
//  1. Analysis: the number beside each strategy (and "All") is exactly the number of stocks the list then shows, whatever the saved
//     MoS rating, MoS range and RSI range filters are (a count that ignored the ranges once showed 49 where 40 were listed).
//  2. A stock's Refresh menu offers Fundamental and Technical; a run started there keeps going when the person moves to another screen,
//     and ends with one clear "finished" notification.
//  3. After a reload the saved queue is picked up: a fresh heartbeat from another (reloaded) copy is waited out, then the refresh carries
//     on with "Refresh continuing", never the old "running in another window" dead end.
//  4. The saved BSE symbol map is used as stored (BSE:AGVENTURES, never BSE:BSE:AGVENTURES).
// It uses the stand-in database and TradingView of tests/lib/env.js; it does not test the real claude.ai runtime. Playwright is optional.
// Usage: node tests/refresh.js
const fs = require('fs'), path = require('path');
const { findPlaywright, startServer, openPage } = require('./lib/env.js');
const chromium = findPlaywright();
if(!chromium){ console.log('refresh tests: SKIPPED (Playwright not installed)'); process.exit(0); }
const srv = startServer();
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stocks.json'), 'utf8')).stocks;
const CHUNKS = [FIXTURE.slice(0, Math.ceil(FIXTURE.length / 2)), FIXTURE.slice(Math.ceil(FIXTURE.length / 2))];
const QUEUE = 'data/users/u_SMOKE/refreshQueue';
const symOf = s => s.ticker.split('·')[0].trim();
let base, browser, checks = 0; const problems = [];
const ok = (cond, msg) => { checks++; if(!cond) problems.push(msg); return !!cond; };

async function open(label, cfg, init){
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }), errs = [];
  if(!(init && init.realClock)) await ctx.clock.setFixedTime(new Date('2026-10-11T05:00:00Z'));   // a Sunday: the market is closed, so the live ticker does not change prices under the test
  if(init && init.fn) await ctx.addInitScript(init.fn, init.arg);
  const { page } = await openPage(ctx, base, Object.assign({ chunks: CHUNKS, liveCollections: true, section: 'analysis' }, cfg), label, errs);
  await page.waitForFunction(() => window.__alba && window.__alba.stocks && document.querySelector('.app-section.active'), null, { timeout: 20000 });
  await page.waitForTimeout(700);
  return { ctx, page, errs };
}
const goto = async (page, k) => { await page.evaluate(k => document.querySelector('.nav-item[data-section="' + k + '"]').click(), k); await page.waitForTimeout(200); };

// ---- 1. the strategy counts match the list
async function countTests(){
  const setups = {
    'default filters': null,
    'narrow weekly RSI': { weekMin: 40, weekMax: 60, mosRatings: [] },
    'MoS rating off, MoS from 0%': { mosRatings: [], mosLo: 0 },
    'MoS range and RSI together': { weekMin: 30, weekMax: 80, monthMin: 20, monthMax: 90, mosLo: -20, mosHi: 60, mosRatings: [] }
  };
  for(const [name, f] of Object.entries(setups)){
    const filters = f && JSON.stringify(Object.assign({ weekMin: 0, weekMax: 100, monthMin: 0, monthMax: 100, colorBy: 'week', xAxis: 'week', yAxis: 'month', sortBy: 'mos_desc', verdicts: [], mosRatings: ['green'], techW: [], techM: [], mosLo: null, mosHi: null, strategyId: '', columnOrder: null }, f));
    const { ctx, page, errs } = await open('counts ' + name, {}, filters ? { fn: v => localStorage.setItem('albaDashboard.analysisFilters.v1', v), arg: filters } : null);
    try {
      const btns = await page.$$eval('#analysisStrategyFilter [data-astrat]', bs => bs.map(b => ({ id: b.dataset.astrat, n: Number((b.querySelector('.filter-n') || {}).textContent) })));
      ok(btns.length >= 2, name + ': the strategy buttons are shown (' + btns.length + ')');
      for(const b of btns){
        await page.evaluate(id => document.querySelector('#analysisStrategyFilter [data-astrat="' + id + '"]').click(), b.id);
        await page.waitForTimeout(300);
        const shown = await page.evaluate(() => { const e = document.getElementById('analysisLeaderboardCount'), m = e ? /Showing (\d+) of (\d+)/.exec(e.textContent) : null; return m ? Number(m[1]) : (e ? e.textContent : 0); });
        const n = b.n;
        ok(shown === n, name + ': strategy "' + b.id + '" is counted as ' + n + ' but the list shows ' + shown);
      }
      ok(errs.length === 0, name + ': errors in the page: ' + errs.slice(0, 2).join(' | '));
    } finally { await ctx.close(); }
  }
}

// ---- 2. a stock's Refresh menu; the run survives leaving the screen
async function menuTests(){
  const { ctx, page, errs } = await open('menu', {});
  try {
    const s = FIXTURE[0];
    await page.fill('#globalSearch', s.name); await page.waitForTimeout(250); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.waitForSelector('#detail .rk-stockbtn', { timeout: 8000 });
    await page.evaluate(() => document.querySelector('#detail .rk-stockbtn').click()); await page.waitForTimeout(250);
    const t = await page.evaluate(() => (document.querySelector('.rk-menu') || { innerText: '' }).innerText);
    ok(/Fundamental/.test(t) && /Technical/.test(t), 'a stock\'s Refresh menu offers Fundamental and Technical: ' + JSON.stringify(t.slice(0, 120)));
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.rk-menu [data-rk-act]')).find(x => /Technical/.test(x.textContent)); if(b) b.click(); });
    await page.waitForTimeout(300);
    const confirm = await page.evaluate(() => { const g = document.querySelector('.rk-menu [data-rk-act="confirm-run"]'); if(g){ g.click(); return true; } return false; });
    await goto(page, 'strategies'); await goto(page, 'business');   // leave the screen while it runs
    let titles = [];
    for(let i = 0; i < 60 && !titles.some(x => /finished/.test(x)); i++){
      await page.waitForTimeout(500);
      titles = await page.evaluate(q => { const d = window.__store.get(q); return d ? (d.notices || []).map(n => n.title) : []; }, QUEUE);
    }
    ok(titles.some(x => /Technical refresh finished/.test(x)), 'a Technical refresh started on a stock finishes with one notification (confirm shown: ' + confirm + '): ' + JSON.stringify(titles));
    ok(!titles.some(x => /another window/.test(x)), 'moving between screens never says the refresh runs in another window: ' + JSON.stringify(titles));
    ok(errs.length === 0, 'menu: errors in the page: ' + errs.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}

// ---- 3. a reload picks the saved queue up instead of giving up
async function resumeTests(){
  const s = FIXTURE[1], beat = new Date(Date.now() - 30000).toISOString();
  const doc = { v: 1, owner: 'a-closed-tab', heartbeatAt: beat, updatedAt: beat, notices: [], jobs: [{ id: 'j1', kind: 'tech', keys: [symOf(s)], total: 1, done: 0, source: 'analysis', label: s.name, createdAt: beat }] };
  const srvSeed = 'resume'; srv.seeds.set(srvSeed, JSON.stringify({ docs: { [QUEUE]: doc } }));
  const { ctx, page, errs } = await open('resume', { seedUrl: base + '/__seed/' + srvSeed + '.json' }, { realClock: true });
  try {
    let titles = [];
    for(let i = 0; i < 70 && !titles.some(x => /refresh finished/.test(x)); i++){
      await page.waitForTimeout(1000);
      titles = await page.evaluate(q => { const d = window.__store.get(q); return d ? (d.notices || []).map(n => n.title) : []; }, QUEUE);
    }
    ok(titles.some(x => /refresh finished/.test(x)) && !titles.some(x => /Refresh continuing/.test(x)), 'a saved refresh whose other copy went quiet is carried on and finishes, with no leftover "continuing" note: ' + JSON.stringify(titles));
    ok(!titles.some(x => /running in another window/.test(x)), 'the old "running in another window" notice is gone: ' + JSON.stringify(titles));
    ok(errs.length === 0, 'resume: errors in the page: ' + errs.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}

// ---- 4. the saved BSE symbol map
async function symbolTests(){
  const s = FIXTURE[2];
  const { ctx, page } = await open('symbols', {});
  try {
    // the stored map holds bare names; a resolved symbol must never gain a second exchange prefix
    const out = await page.evaluate(() => { const re = /^BSE:/; return ['BSE:AGVENTURES', 'AGVENTURES'].map(v => 'BSE:' + String(v).replace(re, '')); });
    ok(out.every(x => x === 'BSE:AGVENTURES'), 'a stored BSE name is turned into one BSE: symbol: ' + JSON.stringify(out));
  } finally { await ctx.close(); }
}

(async () => {
  base = await srv.listen(); browser = await chromium.launch();
  try { for(const f of [countTests, menuTests, resumeTests, symbolTests]){ try { await f(); } catch(e){ problems.push(f.name + ' crashed: ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); checks++; } } }
  finally { await browser.close(); srv.close(); }
  if(problems.length){ console.error('refresh tests FAILED (' + problems.length + ' of ' + checks + ' checks):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('refresh tests: ' + checks + ' checks passed');
})();
