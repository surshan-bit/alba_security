// Accessibility audit (CLAUDE.md section 4): opens every screen and a number of open states in real Chromium (White theme, three widths), runs axe-core on each,
// and lists what it finds, grouped by rule.
//   node tools/a11y.js               print the findings
//   node tools/a11y.js --json <file> also write them as JSON
//   node tools/a11y.js --ratchet     write tools/a11y-ratchet.json (the number of failing elements per rule); a plain run fails when any count goes up
// axe-core checks what a program can check (names, roles, contrast, labels, landmarks). Keyboard order and what a screen reader says still need a person.
const fs = require('fs'), path = require('path');
const { chromiumOrSkip, startServer, openPage, root } = require('../tests/lib/env.js');
const chromium = chromiumOrSkip('accessibility');   // no Playwright: skipped on a developer machine, a failure in CI
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const RATCHET = path.join(root, 'tools', 'a11y-ratchet.json');
const jsonAt = process.argv.indexOf('--json'), jsonOut = jsonAt >= 0 ? process.argv[jsonAt + 1] : '';
const WIDTHS = [1280, 820, 390];
const SECTIONS = ['analysis', 'business', 'strategies', 'trackrecord', 'refreshlog', 'help', 'knowledgebase', 'settings'];

const FIXTURE = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'stocks.json'), 'utf8')).stocks;
const CHUNKS = [FIXTURE.slice(0, Math.ceil(FIXTURE.length / 2)), FIXTURE.slice(Math.ceil(FIXTURE.length / 2))];
const UID = 'u_SMOKE', TRADES = 'data/users/' + UID + '/portfolio/trades';
const sid = x => String(x).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');
const symOf = s => s.ticker.split('·')[0].trim();
const snapshotOf = s => ({ score: s.score, verdict: s.verdict, currentPriceAtSnapshot: 100, intrinsicValue: 120, marginOfSafetyPct: 16.7, fundamentalFactorsComplete: 9, fundamentalFactorsTotal: 9, technicalComponentsComplete: 4, technicalComponentsTotal: 4 });
const docs = {};
FIXTURE.slice(0, 3).forEach((s, i) => { docs[TRADES + '/' + sid(symOf(s) + '-2026-10-0' + (i + 1))] = { ticker: symOf(s), name: s.name, status: i === 1 ? 'closed' : 'open', buy: { date: '2026-10-0' + (i + 1), price: 100, quantity: 5, snapshot: snapshotOf(s) }, sell: i === 1 ? { date: '2026-10-20', price: 110, quantity: 5, holdingDays: 19, realizedReturnPct: 10, snapshot: snapshotOf(s) } : null, loggedAt: '2026-10-0' + (i + 1) + 'T00:00:00Z' }; });


// Keyboard: Tab through a screen; every control that takes focus must look different when focused (an outline, a shadow, a border or a background change).
// Returns the controls that show nothing.
async function invisibleFocus(page, tabs){
  const found = [];
  await page.evaluate(() => { window.__focusLook = (el) => { const cs = getComputedStyle(el); return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderTopColor, cs.borderBottomColor, cs.backgroundColor, cs.color, cs.textDecorationLine].join('|'); }; });
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); });
  for(let i = 0; i < tabs; i++){
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if(!el || el === document.body) return null;
      const settle = () => document.getAnimations().forEach(a => { try { a.finish(); } catch(e){ /* a running animation that cannot finish is read as it is */ } });   // a colour transition would otherwise be read half way
      settle(); const on = window.__focusLook(el), beforeKey = el.tagName + '#' + el.id + '.' + String(el.className).slice(0, 40);
      const outlineShown = getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) > 0;
      el.blur(); settle(); const off = window.__focusLook(el); el.focus({ focusVisible: true });
      return { key: beforeKey, differs: on !== off, outlineShown, html: el.outerHTML.slice(0, 110), look: on };
    });
    if(r && !r.differs && !r.outlineShown) found.push(r);
  }
  return found;
}

(async () => {
  const srv = startServer(), base = await srv.listen();
  srv.seeds.set('a11y', JSON.stringify({ docs }));
  const browser = await chromium.launch();
  const found = new Map();   // rule -> { impact, help, url, nodes: Map(screen+selector -> detail) }
  const problems = [];
  async function scan(page, label){
    const res = await page.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, url: v.helpUrl, nodes: v.nodes.map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 140), summary: (n.failureSummary || '').split('\n').slice(1, 3).join(' ') })) })); });
    for(const v of res) for(const n of v.nodes) addFinding(v.id, v.impact, v.help, label + ' | ' + n.target, n.html, n.summary, v.url);
  }
  function addFinding(id, impact, help, where, html, summary, url){
    const e = found.get(id) || { impact, help, url: url || '', nodes: new Map() };
    e.nodes.set(where, { html, summary });
    found.set(id, e);
  }
  for(const width of WIDTHS){
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await ctx.clock.setFixedTime(new Date('2026-10-12T05:30:00.000Z'));
    const errs = [], cfg = { chunks: CHUNKS, liveCollections: true, theme: 'white', section: 'analysis', seedUrl: base + '/__seed/a11y.json' };
    const { page } = await openPage(ctx, base, cfg, 'a11y', errs);
    await page.waitForFunction(() => window.__alba && window.__alba.stocks && document.querySelector('.app-section.active'), null, { timeout: 30000 });
    await page.waitForTimeout(700);
    await page.evaluate(AXE);   // evaluated through the debugging channel: the page's CSP rightly refuses an inline script tag
    const tag = String(width), wait = ms => page.waitForTimeout(ms);
    const ev = (fn, arg) => page.evaluate(fn, arg).catch(e => { problems.push(tag + ': ' + String(e.message).split('\n')[0]); return null; });
    const click = sel => ev(s => { const e = document.querySelector(s); if(e) e.click(); return !!e; }, sel);
    const goto = k => ev(k => { const b = document.querySelector('.nav-item[data-section="' + k + '"]'); if(b) b.click(); }, k);
    for(const k of SECTIONS){
      await goto(k); await wait(k === 'business' || k === 'strategies' ? 900 : 450); await scan(page, tag + ' ' + k);
      if(width === 1280) for(const f of await invisibleFocus(page, 120)) addFinding('focus-visible', 'serious', 'A control that takes keyboard focus must look different when it has it', tag + ' ' + k + ' | ' + f.key, f.html, 'Focused and unfocused look the same: ' + f.look);
    }
    await goto('analysis'); await wait(400);
    await click('[data-rk-act="bar-menu"]'); await wait(250); await scan(page, tag + ' refresh-menu'); await page.keyboard.press('Escape'); await ev(() => document.body.click()); await wait(150);
    await click('#analysisFiltersToggle'); await wait(200); await scan(page, tag + ' filters'); await click('#analysisFiltersToggle'); await wait(150);
    await click('#activityBell'); await wait(250); await scan(page, tag + ' notifications'); await click('#activityBell'); await wait(150);
    await click('#menuToggle'); await wait(300); await scan(page, tag + ' menu'); await click('#sidebarOverlay'); await ev(() => document.body.click()); await wait(250);
    await page.fill('#globalSearch', FIXTURE[0].name.slice(0, 3)).catch(() => {}); await wait(350); await scan(page, tag + ' search');
    await page.keyboard.press('ArrowDown').catch(() => {}); await page.keyboard.press('Enter').catch(() => {}); await wait(1200);
    await scan(page, tag + ' stock'); await ev(() => window.scrollTo(0, 99999)); await wait(400); await scan(page, tag + ' stock-bottom');
    await goto('trackrecord'); await wait(500);
    await click('#tradeAddBtn'); await wait(300); await scan(page, tag + ' trade-add'); await click('#tlCancel'); await wait(150);
    await click('[data-tl-view="table"]'); await wait(300); await scan(page, tag + ' trade-table'); await click('[data-tl-view="cards"]'); await wait(200);
    await goto('business'); await wait(700); await click('.biz-row'); await wait(400); await scan(page, tag + ' explorer-open');
    await goto('strategies'); await wait(600);
    await ev(() => { document.querySelectorAll('details.strat-group').forEach(d => { d.open = true; }); }); await wait(250); await scan(page, tag + ' strategies-open');
    await ctx.close();
  }
  await browser.close(); srv.close();
  const counts = {}, report = [];
  for(const [id, e] of found){ counts[id] = e.nodes.size; report.push({ id, impact: e.impact, help: e.help, url: e.url, elements: e.nodes.size, samples: [...e.nodes.entries()].slice(0, 6).map(([k, n]) => ({ where: k, html: n.html, why: n.summary })), all: jsonOut ? [...e.nodes.entries()].map(([k, n]) => ({ where: k, html: n.html, why: n.summary })) : undefined }); }
  report.sort((a, b) => b.elements - a.elements);
  for(const r of report) console.log(String(r.elements).padStart(5) + '  ' + (r.impact || '').padEnd(9) + r.id + ' - ' + r.help);
  console.log('total: ' + report.reduce((a, r) => a + r.elements, 0) + ' failing elements in ' + report.length + ' rules' + (problems.length ? '\nnotes: ' + [...new Set(problems)].slice(0, 6).join('; ') : ''));
  if(jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
  if(process.argv.includes('--ratchet')){ fs.writeFileSync(RATCHET, JSON.stringify(counts, null, 2) + '\n'); console.log('a11y ratchet written'); return; }
  let saved = null; try { saved = JSON.parse(fs.readFileSync(RATCHET, 'utf8')); } catch(e){ /* none yet */ }
  if(saved){
    const up = Object.keys(counts).filter(id => counts[id] > (saved[id] || 0));
    if(up.length){ console.error('ERROR accessibility: more failing elements than the ratchet allows for: ' + up.map(id => id + ' (' + (saved[id] || 0) + ' -> ' + counts[id] + ')').join(', ')); process.exit(1); }
  }
})().catch(e => { console.error('a11y crashed:', e); process.exit(1); });
