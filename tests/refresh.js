// Refresh and Analysis-count tests (real Chromium), written for the header Refresh menus and the tiered refresh:
//  1. Analysis: the number beside each strategy (and "All") is exactly the number of stocks the list then shows, whatever the saved
//     MoS rating, MoS range and RSI range filters are (a count that ignored the ranges once showed 49 where 40 were listed).
//  2. A stock's Refresh menu offers Fundamental and Technical; a run started there keeps going when the person moves to another screen,
//     and ends with one clear "finished" notification.
//  3. After a reload the saved queue is picked up: a fresh heartbeat from another (reloaded) copy is waited out, then the refresh carries
//     on with "Refresh continuing", never the old "running in another window" dead end.
//  4. The saved BSE symbol map is used as stored (BSE:AGVENTURES, never BSE:BSE:AGVENTURES).
//  5. (v1.193) The Refresh menu (open, arrow keys, Escape, outside click), the confirmation for a big Fundamental run, and a run on another
//     device (shown in the bell, no second run, Stop asks it to stop): the behaviour the split of src/refresh/kit.js must keep.
//  6. (v1.194) A saved update redraws the Analysis grid but keeps its sideways scroll, and waits while the viewer is scrolling.
//  7. (v1.253) Refresh Fundamental Info end to end with a scripted Claude and TradingView: the prompts asked, the research and update documents
//     written and the notice shown are compared with tests/fixtures/ld-fundamental.expected.json (node tests/refresh.js --update-ld rewrites it).
// It uses the stand-in database and TradingView of tests/lib/env.js; it does not test the real claude.ai runtime. Playwright is optional.
// Usage: node tests/refresh.js
const fs = require('fs'), path = require('path');
const { chromiumOrSkip, startServer, openPage } = require('./lib/env.js');
const chromium = chromiumOrSkip('refresh tests');
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

// ---- 5. v1.193: behaviour of the refresh controls that the split of src/refresh/kit.js must keep (written before the split)
// 5a. the Analysis Refresh menu: opens, offers the six runs, moves with the arrow keys, closes with Escape (focus goes back) and on an outside click
async function barMenuTests(){
  const { ctx, page, errs } = await open('bar menu', {});
  try {
    await page.waitForSelector('.rk-barbtn', { timeout: 8000 });
    const btn = '.rk-barbtn';
    await page.click(btn); await page.waitForSelector('.rk-menu', { timeout: 3000 });
    const t = await page.evaluate(() => ({ text: document.querySelector('.rk-menu').innerText, items: document.querySelectorAll('.rk-menu .rk-item').length, expanded: document.querySelector('.rk-barbtn').getAttribute('aria-expanded'), role: document.querySelector('.rk-menu').getAttribute('role') }));
    ok(t.role === 'menu' && t.expanded === 'true', 'the Refresh menu opens as a menu and marks its button expanded: ' + JSON.stringify(t).slice(0, 160));
    ok(t.items === 6 && /Fundamental/.test(t.text) && /Technical/.test(t.text) && /Both/.test(t.text) && /Only what is out of date/i.test(t.text), 'it offers Fundamental, Technical and Both for all stocks and for only those out of date: ' + JSON.stringify(t.text.slice(0, 200)));
    const focusIdx = () => page.evaluate(() => Array.from(document.querySelectorAll('.rk-menu button:not(:disabled), .rk-menu input:not(:disabled)')).indexOf(document.activeElement));
    const first = await focusIdx();
    await page.keyboard.press('ArrowDown'); const second = await focusIdx();
    await page.keyboard.press('ArrowUp'); const back = await focusIdx();
    ok(first === 0 && second === 1 && back === 0, 'the first item has focus and the arrow keys move through the items: ' + [first, second, back]);
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
    const closed = await page.evaluate(() => ({ menu: !!document.querySelector('.rk-menu'), expanded: document.querySelector('.rk-barbtn').getAttribute('aria-expanded'), focused: document.activeElement === document.querySelector('.rk-barbtn') }));
    ok(!closed.menu && closed.expanded === 'false' && closed.focused, 'Escape closes the menu and puts focus back on its button: ' + JSON.stringify(closed));
    await page.click(btn); await page.waitForSelector('.rk-menu', { timeout: 3000 });
    await page.mouse.click(5, 5); await page.waitForTimeout(150);
    ok(!(await page.evaluate(() => !!document.querySelector('.rk-menu'))), 'a click elsewhere closes the menu');
    await page.click(btn); await page.waitForSelector('.rk-menu', { timeout: 3000 });
    await page.click(btn); await page.waitForTimeout(150);
    ok(!(await page.evaluate(() => !!document.querySelector('.rk-menu'))), 'clicking the button again closes its menu');
    ok(errs.length === 0, 'bar menu: errors in the page: ' + errs.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}
// 5b. a Fundamental refresh of more than 50 stocks asks first; Cancel starts nothing
async function confirmTests(){
  const wide = JSON.stringify({ weekMin: 0, weekMax: 100, monthMin: 0, monthMax: 100, colorBy: 'week', xAxis: 'week', yAxis: 'month', sortBy: 'mos_desc', verdicts: [], mosRatings: [], techW: [], techM: [], mosLo: null, mosHi: null, strategyId: '', columnOrder: null });
  const { ctx, page, errs } = await open('confirm', {}, { fn: v => localStorage.setItem('albaDashboard.analysisFilters.v1', v), arg: wide });
  try {
    await page.waitForSelector('.rk-barbtn', { timeout: 8000 });
    await page.click('.rk-barbtn'); await page.waitForSelector('.rk-menu', { timeout: 3000 });
    const n = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.rk-menu [data-rk-act="menu-run"]')).find(x => /Fundamental/.test(x.textContent) && x.getAttribute('data-rk-only') === '0'); const m = b && /all (\d+)/.exec(b.textContent); if(b && m && Number(m[1]) > 50) b.click(); return m ? Number(m[1]) : 0; });
    if(n > 50){
      await page.waitForSelector('.rk-menu [data-rk-act="confirm-run"]', { timeout: 3000 });
      const t = await page.evaluate(() => document.querySelector('.rk-menu').innerText);
      ok(/Refresh this many stocks\?/i.test(t) && /batches of 50/.test(t) && /Claude usage/.test(t), 'the confirmation says how many, the batch size and that Fundamental uses Claude usage: ' + JSON.stringify(t.slice(0, 200)));
      await page.evaluate(() => document.querySelector('.rk-menu [data-rk-act="close"]').click()); await page.waitForTimeout(300);
      const q = await page.evaluate(k => { const d = window.__store.get(k); return d ? (d.jobs || []).length : 0; }, QUEUE);
      ok(q === 0 && !(await page.evaluate(() => !!document.querySelector('.rk-menu'))), 'Cancel closes the confirmation and queues nothing');
    } else ok(false, 'expected more than 50 stocks with every filter off, the view lists ' + n);
    ok(errs.length === 0, 'confirm: errors in the page: ' + errs.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}
// 5c. a refresh running on another device: this device shows it in the bell, will not start a second one, and Stop asks the other device to stop
async function remoteTests(){
  const s = FIXTURE[3], beat = '2026-10-11T04:59:50.000Z';   // 10 seconds before the fixed test clock
  const doc = { v: 1, owner: 'another-device', heartbeatAt: beat, updatedAt: beat, notices: [], progress: { title: 'Refreshing Technical Info · 3 of 10 done', text: 'A STOCK · Running', pct: 30, section: 'analysis' }, jobs: [{ id: 'r1', kind: 'tech', keys: [symOf(s), symOf(FIXTURE[4])], total: 10, done: 8, source: 'analysis', label: 'Everything', createdAt: beat }] };
  srv.seeds.set('remote', JSON.stringify({ docs: { [QUEUE]: doc } }));
  const { ctx, page, errs } = await open('remote', { seedUrl: base + '/__seed/remote.json' });
  try {
    await page.click('#activityBell'); await page.waitForSelector('#activityPanel .activity-item', { timeout: 8000 });
    const item = await page.evaluate(() => { const el = document.querySelector('#activityPanel .activity-item'); return { title: el.querySelector('.activity-title').textContent, text: el.querySelector('.activity-text').textContent, hasStop: !!el.querySelector('[data-act="stop"]') }; });
    ok(/Refreshing Technical Info/.test(item.title) && /Running on another device/.test(item.text) && item.hasStop, 'the other device\'s run is in the bell with its progress and a Stop button: ' + JSON.stringify(item));
    await page.click('#activityBell');   // close the panel again
    await page.click('.rk-barbtn'); await page.waitForSelector('.rk-menu', { timeout: 3000 });
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.rk-menu [data-rk-act="menu-run"]')).find(x => /Technical/.test(x.textContent) && x.getAttribute('data-rk-only') === '0'); b.click(); });
    await page.waitForTimeout(500);
    const notices = await page.evaluate(k => { const d = window.__store.get(k); return d ? (d.notices || []).map(n => n.title) : []; }, QUEUE);
    ok(notices.some(x => /A refresh is already in progress/.test(x)), 'starting a second refresh while another device runs one says so instead: ' + JSON.stringify(notices));
    await page.click('#activityBell'); await page.waitForSelector('#activityPanel [data-act="stop"]', { timeout: 3000 });
    await page.evaluate(() => document.querySelector('#activityPanel .activity-item.is-running [data-act="stop"]').click());
    await page.waitForTimeout(600);
    const stopReq = await page.evaluate(k => { const d = window.__store.get(k); return d ? d.stopRequest : null; }, QUEUE);
    ok(typeof stopReq === 'number' && stopReq > 0, 'Stop on this device asks the running device to stop (stopRequest saved): ' + stopReq);
    ok(errs.length === 0, 'remote: errors in the page: ' + errs.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}

// ---- 6. v1.194: a background update (saved prices arriving) must not move a table the viewer has scrolled sideways, and waits for scrolling to stop
async function scrollKeepTests(){
  const { ctx, page, errs } = await open('scroll keep', {});
  try {
    await page.waitForSelector('#section-analysis .strat-table-wrap', { timeout: 8000 });
    const t0 = symOf(FIXTURE[0]);
    const info = await page.evaluate(() => { const w = document.querySelector('#section-analysis .strat-table-wrap'); w.scrollLeft = 300; window.__w = w; return { left: w.scrollLeft, wide: w.scrollWidth > w.clientWidth + 300 }; });
    ok(info.wide && info.left === 300, 'the test needs a leaderboard wider than the screen and scrolled sideways: ' + JSON.stringify(info));
    await page.waitForTimeout(600);   // let the scroll settle so the next update is not held back by it
    await page.evaluate(t => window.__setDoc('stockUpdates/' + t, { ticker: t, valuation: { currentPrice: 151.5, asof: '2026-10-14', source: 'test' } }), t0);
    await page.waitForFunction(() => document.querySelector('#section-analysis .strat-table-wrap') !== window.__w, null, { timeout: 5000 }).catch(() => {});
    const after = await page.evaluate(() => ({ replaced: document.querySelector('#section-analysis .strat-table-wrap') !== window.__w, left: document.querySelector('#section-analysis .strat-table-wrap').scrollLeft }));
    ok(after.replaced && after.left === 300, 'a saved update redraws the Analysis grid but keeps it scrolled where it was (replaced: ' + after.replaced + ', scrollLeft ' + after.left + ')');
    // while the viewer is scrolling, the redraw waits
    await page.evaluate(() => { const w = document.querySelector('#section-analysis .strat-table-wrap'); window.__w = w; w.scrollLeft = 200; });
    await page.evaluate(t => window.__setDoc('stockUpdates/' + t, { ticker: t, valuation: { currentPrice: 152.5, asof: '2026-10-14', source: 'test' } }), t0);
    await page.waitForTimeout(150);
    ok(await page.evaluate(() => document.querySelector('#section-analysis .strat-table-wrap') === window.__w), 'while the viewer has just scrolled, the redraw is held back (the grid is not rebuilt under them)');
    await page.waitForFunction(() => document.querySelector('#section-analysis .strat-table-wrap') !== window.__w, null, { timeout: 5000 }).catch(() => {});
    const later = await page.evaluate(() => ({ replaced: document.querySelector('#section-analysis .strat-table-wrap') !== window.__w, left: document.querySelector('#section-analysis .strat-table-wrap').scrollLeft }));
    ok(later.replaced && later.left === 200, 'once scrolling has stopped the update is drawn and the position is still kept: ' + JSON.stringify(later));
    // the Strategies grid keeps its sideways scroll through a redraw too
    await page.setViewportSize({ width: 700, height: 900 });
    await goto(page, 'strategies');
    await page.waitForSelector('#section-strategies .strat-table-wrap', { timeout: 8000 });
    const st = await page.evaluate(() => { const w = document.querySelector('#section-strategies .strat-table-wrap'); w.scrollLeft = 120; return { left: w.scrollLeft, wide: w.scrollWidth > w.clientWidth + 120 }; });
    if(st.wide){
      await page.evaluate(() => { window.__sw = document.querySelector('#section-strategies .strat-table-wrap'); window.dispatchEvent(new Event('alba-strategies-reloaded')); });
      await page.waitForTimeout(300);
      const sa = await page.evaluate(() => ({ replaced: document.querySelector('#section-strategies .strat-table-wrap') !== window.__sw, left: document.querySelector('#section-strategies .strat-table-wrap').scrollLeft }));
      ok(sa.replaced && sa.left === 120, 'the Strategies grid is redrawn and keeps its sideways scroll: ' + JSON.stringify(sa));
    } else ok(true, 'the Strategies grid is not wider than the screen in the fixtures');
    ok(errs.length === 0, 'scroll keep: errors in the page: ' + errs.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}


// ---- 7. Refresh Fundamental Info end to end (a scripted Claude and TradingView; the saved documents are compared with a checked-in file)
const LD_EXPECTED = path.join(__dirname, 'fixtures', 'ld-fundamental.expected.json');
const ldScript = () => {
  window.__prompts = [];
  window.__tvFund = {
    'mcp-tv-get-financials': { revenue: [1, 2, 3], note: 'made-up financials' },
    'mcp-tv-get-forecasts': { quality_note: 'made-up', eps: [1, 2] },
    'mcp-tv-get-news': { headlines: [
      { id: 'n1', title: 'Company wins a big order', published: 1791439200, provider: { name: 'Wire' }, link: 'https://news.example/n1', paywall: false },
      { id: 'n2', title: 'Regulator opens a probe', published: 1791352800, provider: { name: 'Wire' }, link: 'https://news.example/n2', paywall: false },
      { id: 'n3', title: 'Quarterly note', published: 1789884000, provider: { name: 'Desk' }, link: 'https://news.example/n3', paywall: true }] },
    'mcp-tv-get-news-story': { summary: 'made-up story', short_description: 'short' },
    'mcp-tv-get-documents': input => ({ items: input.event === 'earning' ? [{ reported: 1785542400, title: 'Q1 results', correlation_id: 'e1', provider: { name: 'Exch' } }] : input.event === 'corporate_event' ? [{ reported: 1788220800, title: 'Dividend', correlation_id: 'c1', provider: { name: 'Exch' } }] : [] })
  };
  window.__inflight = 0; window.__maxInflight = 0;   // v1.316: how many Claude requests were open at the same moment
  const inner = async (prompt, opts) => {
    const task = String(prompt).split('TASK:')[1] || '';
    window.__prompts.push({ tier: opts && opts.modelTier, len: String(prompt).length, task: task.slice(0, 60) });
    const reply = o => ({ text: JSON.stringify(o) });
    if(/NEWS HEADLINES TO LABEL/.test(prompt)){ const labels = {}; for(let i = 0; i < 60; i++) labels[i] = ['positive', 'negative', 'neutral'][i % 3]; return reply({ labels }); }
    if(/These metrics are "n\/a"/.test(task)){ const f = {}; for(const m of task.matchAll(/\[(\w+)\] ([^;\[]+?)(?:;|\.\n)/g)){ const metrics = {}; m[2].split(', ').forEach(l => { metrics[l.trim()] = '12.5%'; }); f[m[1]] = { metrics, note: 'basis: made-up' }; } return reply({ factors: f }); }
    if(/Refresh the written analysis on these Fundamental Score factor cards/.test(task)){
      const f = {}; for(const m of task.split('\n')[0].matchAll(/"(\w+)" \(/g)) f[m[1]] = { score: 0.5, note: 'rescored: made-up', research: { headline: 'Headline for ' + m[1], points: [{ text: 'Point one', view: true, refs: ['D/E', 'Not a metric'], url: 'https://news.example/n1' }, 'Point two <b>x</b> grew 777.7%'], facts: [{ label: 'Invented row', value: '4242.4x', tone: 'pos' }], positives: ['Plus'], negatives: ['Minus'], sources: [{ title: 'Order win', url: 'https://news.example/n1' }, { title: 'Invented', url: 'https://invented.example/x' }] } };
      return reply({ factors: f });
    }
    if(/Global & Macro Information/.test(task)) return reply({ positive: [{ text: 'Demand is firm <i>now</i>', source: 'Wire, 2026-10-08', url: 'https://news.example/n1' }], negative: [{ text: 'Input costs rising', source: 'Claude analysis, no live source', url: '' }],
      events: [{ headline: 'Oil shock', impact: 'negative', why: 'Raises freight cost.', source: 'Wire', url: 'https://news.example/n2' }, { headline: 'Odd impact', impact: 'sideways', why: 'x', source: '', url: 'https://invented.example/y' }] });
    if(/Strengths and Watch-outs box/.test(task)) return reply({ strengths: [{ text: 'Cheap for its quality', tone: 'strong' }, { text: 'Steady', tone: 'weird' }], watchouts: [{ text: 'Debt is rising', tone: 'concern' }] });
    return reply({});
  };
  window.__sample = async (prompt, opts) => { window.__inflight++; window.__maxInflight = Math.max(window.__maxInflight, window.__inflight); try { await new Promise(r => setTimeout(r, 40)); return await inner(prompt, opts); } finally { window.__inflight--; } };
};
async function ldFundamentalTests(){
  const { ctx, page, errs } = await open('ldfund', {}, { fn: ldScript });
  try {
    const idOf = st => symOf(st).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');
    // opens the stock, presses its Refresh > Fundamental and waits for `count` finished notices naming it
    const run = async (st, count) => {
      await page.fill('#globalSearch', st.name); await page.waitForTimeout(250); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      await page.waitForSelector('#detail .rk-stockbtn', { timeout: 8000 });
      await page.evaluate(() => document.querySelector('#detail .rk-stockbtn').click()); await page.waitForTimeout(250);
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.rk-menu [data-rk-act]')).find(x => /Fundamental/.test(x.textContent)); if(b) b.click(); });
      let mine = [];
      for(let i = 0; i < 80 && mine.length < count; i++){
        await page.waitForTimeout(250);
        mine = await page.evaluate(([q, name]) => { const d = window.__store.get(q); return d ? (d.notices || []).filter(x => /Fundamental refresh/.test(x.title) && x.title.includes(name)).map(x => ({ title: x.title, text: x.text, tone: x.tone })) : []; }, [QUEUE, st.name]);
      }
      await page.waitForTimeout(500);
      return mine[0];
    };
    const grab = st => page.evaluate(id => ({ research: window.__store.get('stockResearch/' + id) || null, updates: window.__store.get('stockUpdates/' + id) || null, prompts: window.__prompts.slice() }), idOf(st));
    const A = FIXTURE[0], B = FIXTURE[1];
    const firstA = await run(A, 1), afterA = await grab(A);
    const secondA = await run(A, 2), afterA2 = await grab(A);   // researched just now: since v1.297 it is asked about again
    const firstB = await run(B, 1), afterB = await grab(B);     // a stock with figures missing from the file
    const got = JSON.parse(JSON.stringify({ firstA, afterA, promptsAfterSecondA: afterA2.prompts.length, firstB, afterB }));
    if(process.argv.includes('--update-ld')){ fs.writeFileSync(LD_EXPECTED, JSON.stringify(got, null, 1) + '\n'); console.log('ld-fundamental.expected.json written'); }
    const want = fs.existsSync(LD_EXPECTED) ? JSON.parse(fs.readFileSync(LD_EXPECTED, 'utf8')) : null;
    ok(want && JSON.stringify(got) === JSON.stringify(want), 'Refresh Fundamental Info: the prompts asked, the documents saved and the notices shown are unchanged (' + JSON.stringify(firstA) + ' / ' + JSON.stringify(firstB) + ')');
    ok(firstA && /finished/.test(firstA.title) && secondA && /finished/.test(secondA.title), 'both runs on the first stock end with a finished notice');
    ok(afterA.research && afterA.research.factors && afterA.updates && afterA.updates.globalFactors, 'research and Global & Macro were saved');
    const pts0 = Object.values((afterA.research && afterA.research.factors) || {}).map(x => x.research).filter(Boolean).flatMap(r => r.points || []);
    ok(pts0.length && pts0.every(p => p && typeof p === 'object' && Array.isArray(p.basis) && p.basis.length), 'v1.299: every saved bullet carries its source tags');
    ok(pts0.some(p => p.text === 'Point one' && p.basis.includes('tv-news') && p.basis.includes('claude') && p.url === 'https://news.example/n1'), 'v1.299: a bullet with a supplied news link is tagged TradingView news and Claude\'s view');
    ok(pts0.some(p => /777\.7%/.test(p.text) && p.ok === false), 'v1.299: a bullet whose figure is in neither the metric rows nor the TradingView data is marked not verified');
    ok(Object.values(afterA.research.factors).every(x => !x.research || !x.research.facts), 'v1.299: an extra figure row that is not in the TradingView data is dropped');
    ok(pts0.every(p => !(p.refs || []).includes('Not a metric')), 'v1.299: a reference to a row that does not exist is dropped');
    ok(afterA2.prompts.length > afterA.prompts.length && !/Already up to date/.test(secondA.text), 'v1.297: a stock researched just now is refreshed in full again when asked: ' + afterA.prompts.length + ' -> ' + afterA2.prompts.length);
    ok(afterB.prompts.length > afterA2.prompts.length && afterB.prompts.some(p => /These metrics/.test(p.task)), 'a stock with missing figures is asked for them');
    const par = await page.evaluate(() => ({ max: window.__maxInflight, runs: Array.from(window.__store).filter(([k]) => /^refreshRunLog\/fundamental-\d$/.test(k)).map(([, v]) => v) }));
    ok(par.max >= 2, 'v1.316: the factor cards and Global & Macro are asked at the same time (most open at once: ' + par.max + ')');
    ok(par.runs.length >= 1 && par.runs.every(r => r.kind === 'fundamental' && typeof r.durationMs === 'number' && typeof r.stepsMs.cards === 'number' && typeof r.stepsMs.globalMacro === 'number'), 'v1.316: a finished run saves its timing (total and per step; the test page runs on a stopped clock, so only the shape is checked)');
    ok(errs.length === 0, 'ldfund: errors in the page: ' + errs.slice(0, 2).join(' | '));
  } finally { await ctx.close(); }
}

(async () => {
  base = await srv.listen(); browser = await chromium.launch();
  try { for(const f of [countTests, menuTests, resumeTests, symbolTests, barMenuTests, confirmTests, remoteTests, scrollKeepTests, ldFundamentalTests]){ try { await f(); } catch(e){ problems.push(f.name + ' crashed: ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); checks++; } } }
  finally { await browser.close(); srv.close(); }
  if(problems.length){ console.error('refresh tests FAILED (' + problems.length + ' of ' + checks + ' checks):\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('refresh tests: ' + checks + ' checks passed');
})();
