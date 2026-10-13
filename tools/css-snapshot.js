// Style snapshot and compare: proves a CSS change did not change what the page looks like.
//
//   node tools/css-snapshot.js snap <outdir> [--quick] [--states]
//       Opens the app (real Chromium, stand-in database, fixture stocks) in the Dark and Light themes at a set of screen widths, walks
//       through every screen and a number of open states (menus, forms, stock page...), and records for EVERY element (and its ::before,
//       ::after, ::placeholder, ::marker) the resolved style of every property plus its box. --quick uses three widths; the default adds
//       both sides of every @media breakpoint found in styles.css. --states also forces :hover, :focus, :active and :focus-visible on one
//       element of each kind and records the styles that result.
//       --only=dark-1280 limits the run to one theme and width.
//   node tools/css-snapshot.js compare <dirA> <dirB>
//       Lists every element whose resolved style or box differs between two snapshots (exit 1 if any), with the properties that changed.
//
// Typical use: take a snapshot, change styles/, `npm run build`, take a second snapshot, compare. No difference = no visible change.
// Needs Playwright (like the other browser tests). Not part of `npm run check` (it is slow); run it when styles/ changes.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const mode = process.argv[2];

// ---------------------------------------------------------------- compare
function loadDir(dir){
  const scen = new Map();
  for(const f of fs.readdirSync(dir)) if(f.endsWith('.json.gz')) scen.set(f.slice(0, -8), JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f)))));
  const dict = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'styles.dict.gz'))));
  return { scen, dict };
}
function compare(dirA, dirB){
  const A = loadDir(dirA), B = loadDir(dirB), report = [];
  let elements = 0, diffs = 0; const perScen = new Map();
  const names = new Set([...A.scen.keys(), ...B.scen.keys()]);
  for(const name of [...names].sort()){
    const a = A.scen.get(name), b = B.scen.get(name);
    if(!a || !b){ report.push(name + ': only in ' + (a ? 'A' : 'B')); diffs++; continue; }
    const mb = new Map(b.map(e => [e[0], e]));
    const ma = new Map(a.map(e => [e[0], e]));
    for(const e of a){
      elements++;
      const o = mb.get(e[0]);
      if(!o){ diffs++; report.push(name + ': ' + e[0] + ' (' + e[1] + ') missing in B'); continue; }
      if(e[2] !== o[2]){
        diffs++;
        const sa = (A.dict[e[2]] || '').split('\n'), sb = (B.dict[o[2]] || '').split('\n');
        const ch = [];
        for(const line of sa){ const i = line.indexOf(':'), k = line.slice(0, i), v = line.slice(i + 1); const w = sb.find(l => l.startsWith(k + ':')); if(w !== undefined && w.slice(k.length + 1) !== v) ch.push(k + ': ' + v + ' -> ' + w.slice(k.length + 1)); }
        report.push(name + ': ' + e[0] + ' (' + e[1] + ') style: ' + ch.slice(0, 6).join('; '));
      } else if(e[3] !== o[3] || e[4] !== o[4] || e[5] !== o[5] || e[6] !== o[6]){
        diffs++; report.push(name + ': ' + e[0] + ' (' + e[1] + ') box [' + e.slice(3).join(',') + '] -> [' + o.slice(3).join(',') + ']');
      }
    }
    for(const e of b) if(!ma.has(e[0])){ diffs++; report.push(name + ': ' + e[0] + ' (' + e[1] + ') missing in A'); }
    const n = report.filter(l => l.startsWith(name + ': ')).length; if(n) perScen.set(name, n);
  }
  console.log('compared ' + names.size + ' snapshots, ' + elements + ' elements: ' + diffs + ' difference(s)');
  if(perScen.size) console.log('snapshots that differ: ' + [...perScen].slice(0, 40).map(([k, v]) => k + ' (' + v + ')').join(', ') + (perScen.size > 40 ? ' ... ' + perScen.size + ' in all' : ''));
  report.slice(0, 60).forEach(l => console.log('  ' + l));
  if(report.length > 60) console.log('  ... and ' + (report.length - 60) + ' more');
  process.exit(diffs ? 1 : 0);
}
if(mode === 'compare'){ compare(process.argv[3], process.argv[4]); return; }
if(mode !== 'snap'){ console.error('usage: node tools/css-snapshot.js snap <outdir> [--quick] [--states]\n       node tools/css-snapshot.js compare <dirA> <dirB>'); process.exit(2); }

// ---------------------------------------------------------------- snap
const { findPlaywright, startServer, openPage, root } = require('../tests/lib/env.js');
const chromium = findPlaywright();
if(!chromium){ console.error('Playwright is not installed'); process.exit(2); }
const outDir = process.argv[3]; if(!outDir){ console.error('give an output folder'); process.exit(2); }
const QUICK = process.argv.includes('--quick'), STATES = process.argv.includes('--states');
fs.mkdirSync(outDir, { recursive: true });
for(const f of fs.readdirSync(outDir)) if(/\.json\.gz$|styles\.dict\.gz$/.test(f)) fs.unlinkSync(path.join(outDir, f));

const FIXTURE = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'stocks.json'), 'utf8')).stocks;
const CHUNKS = [FIXTURE.slice(0, Math.ceil(FIXTURE.length / 2)), FIXTURE.slice(Math.ceil(FIXTURE.length / 2))];
const UID = 'u_SMOKE', TRADES = 'data/users/' + UID + '/portfolio/trades';
const sid = x => String(x).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');
const symOf = s => s.ticker.split('·')[0].trim();
const snapshotOf = s => ({ score: s.score, verdict: s.verdict, currentPriceAtSnapshot: 100, intrinsicValue: 120, marginOfSafetyPct: 16.7, fundamentalFactorsComplete: 9, fundamentalFactorsTotal: 9, technicalComponentsComplete: 5, technicalComponentsTotal: 5 });
const [A, B, C] = FIXTURE;
const docs = {};
docs[TRADES + '/' + sid(symOf(A) + '-2026-10-01')] = { ticker: symOf(A), name: A.name, status: 'open', buy: { date: '2026-10-01', price: 100, quantity: 5, snapshot: snapshotOf(A) }, sell: null, loggedAt: '2026-10-01T10:00:00.000Z' };
docs[TRADES + '/' + sid(symOf(B) + '-2026-09-01')] = { ticker: symOf(B), name: B.name, status: 'closed', buy: { date: '2026-09-01', price: 80, quantity: 10, snapshot: snapshotOf(B) }, sell: { date: '2026-10-05', price: 95, quantity: 10, holdingDays: 34, realizedReturnPct: 18.75, snapshot: snapshotOf(B) }, loggedAt: '2026-09-01T10:00:00.000Z' };
docs[TRADES + '/' + sid(symOf(C) + '-2026-10-08')] = { ticker: symOf(C), name: C.name, status: 'open', buy: { date: '2026-10-08', price: 50, quantity: 20, snapshot: snapshotOf(C) }, sell: null, loggedAt: '2026-10-08T10:00:00.000Z' };

function widthsFromCss(){
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8'), set = new Set([1280, 390, 820]);
  if(QUICK) return [...set].sort((a, b) => b - a);
  for(const m of css.matchAll(/\((max|min)-width:(\d+)px\)/g)){ const b = +m[2]; if(m[1] === 'max'){ set.add(b); set.add(b + 1); } else { set.add(b - 1); set.add(b); } }
  return [...set].filter(w => w >= 320).sort((a, b) => b - a);
}

// runs inside the page
function installSnap(){
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE']);
  const LAYOUT = new Set(['width', 'height', 'block-size', 'inline-size', 'perspective-origin', 'transform-origin', 'top', 'right', 'bottom', 'left', 'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end']);
  const strings = new Map();
  let names = null;
  const h53 = (s) => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for(let i = 0; i < s.length; i++){ const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
  function styleHash(cs){
    if(!names){ names = []; for(let i = 0; i < cs.length; i++){ const n = cs[i]; if(n.charAt(0) !== '-' || n.charAt(1) !== '-') if(!LAYOUT.has(n)) names.push(n); } names.sort(); }
    const parts = new Array(names.length);
    for(let i = 0; i < names.length; i++) parts[i] = names[i] + ':' + cs.getPropertyValue(names[i]);
    const s = parts.join('\n'), h = h53(s);
    if(!strings.has(h)) strings.set(h, s);
    return h;
  }
  const r2 = v => Math.round(v * 100) / 100;
  function record(el, key, out, withPseudo){
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    out.push([key, (typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '')).split(/\s+/).slice(0, 3).join('.'), styleHash(cs), r2(r.x), r2(r.y), r2(r.width), r2(r.height)]);
    if(!withPseudo) return;
    const tag = el.tagName;
    const ps = ['::before', '::after'];
    if(tag === 'INPUT' || tag === 'TEXTAREA') ps.push('::placeholder');
    if(tag === 'SUMMARY' || tag === 'LI') ps.push('::marker');
    for(const p of ps){
      const pc = getComputedStyle(el, p), c = pc.content;
      if(p === '::before' || p === '::after'){ if(c === 'none' || c === 'normal') continue; }
      else if(p === '::placeholder'){ if(!el.getAttribute('placeholder')) continue; }
      out.push([key + p, '', styleHash(pc), 0, 0, 0, 0]);
    }
  }
  function walk(el, path, out){
    if(SKIP_TAGS.has(el.tagName)) return;
    if(el.classList && el.classList.contains('app-section') && !el.classList.contains('active')) return;
    record(el, path, out, true);
    let i = 0;
    for(let c = el.firstElementChild; c; c = c.nextElementSibling, i++) walk(c, path + '/' + c.tagName.toLowerCase() + i, out);
  }
  window.__snap = {
    dump(){ const out = []; record(document.documentElement, 'html', out, true); walk(document.body, 'body', out); return out; },
    text(hashes){ return hashes.map(h => strings.get(h)); },
    mark(){
      const seen = new Set(), reps = [];
      const sigOf = e => e ? e.tagName.toLowerCase() + '.' + Array.from(e.classList).sort().join('.') : '';
      for(const el of document.body.querySelectorAll('*')){
        if(el.closest('.app-section:not(.active)') || SKIP_TAGS.has(el.tagName)) continue;
        const r = el.getBoundingClientRect(); if(!r.width || !r.height) continue;
        const tag = el.tagName.toLowerCase(), cs = getComputedStyle(el);
        if(!(cs.cursor === 'pointer' || /^(a|button|input|select|textarea|summary|label|tr|th|td|li)$/.test(tag) || el.hasAttribute('tabindex'))) continue;
        const sig = sigOf(el) + (el.type ? '[' + el.type + ']' : '') + '<' + sigOf(el.parentElement) + '<' + (el.parentElement && el.parentElement.parentElement ? sigOf(el.parentElement.parentElement) : '');
        if(seen.has(sig)) continue; seen.add(sig);
        el.setAttribute('data-snapid', String(reps.length)); reps.push(sig);
      }
      return reps;
    },
    sub(id){
      const el = document.querySelector('[data-snapid="' + id + '"]'); if(!el) return [];
      const out = [], list = [el].concat(Array.from(el.querySelectorAll('*')).slice(0, 60));
      list.forEach((e, i) => record(e, i === 0 ? '.' : '.' + i + e.tagName.toLowerCase(), out, true));
      return out;
    },
    unmark(){ document.querySelectorAll('[data-snapid]').forEach(e => e.removeAttribute('data-snapid')); }
  };
}

(async () => {
  const srv = startServer();
  const base = await srv.listen();
  srv.seeds.set('snap', JSON.stringify({ docs }));
  const dict = new Map();
  const browser = await chromium.launch();
  const widths = widthsFromCss();
  let snaps = 0, elements = 0;
  const t0 = Date.now();
  const problems = [];

  async function runCombo(theme, width){
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await ctx.clock.setFixedTime(new Date('2026-10-12T05:30:00.000Z'));   // Date is frozen (the live price shows a clock time, whose width would differ run to run); timers still run
    const errs = [];
    const cfg = { chunks: CHUNKS, liveCollections: true, theme, section: 'analysis', seedUrl: base + '/__seed/snap.json' };
    const { page } = await openPage(ctx, base, cfg, 'snap', errs);
    await page.waitForFunction(() => window.__alba && window.__alba.stocks && document.querySelector('.app-section.active'), null, { timeout: 30000 });
    await page.waitForTimeout(700);
    await page.evaluate(installSnap);
    const tag = theme + '-' + width;
    const wait = ms => page.waitForTimeout(ms);
    const ev = (fn, arg) => page.evaluate(fn, arg).catch(e => { problems.push(tag + ': ' + String(e.message).split('\n')[0]); return null; });
    const click = sel => ev(s => { const e = document.querySelector(s); if(e) e.click(); return !!e; }, sel);
    const goto = k => ev(k => { const b = document.querySelector('.nav-item[data-section="' + k + '"]'); if(b) b.click(); }, k);
    const save = async (name, rows, forced) => {
      const hashes = new Set(rows.map(r => r[2])), need = [...hashes].filter(h => !dict.has(h));
      if(need.length){ const txt = await page.evaluate(h => window.__snap.text(h), need); need.forEach((h, i) => dict.set(h, txt[i])); }
      fs.writeFileSync(path.join(outDir, tag + '-' + name + '.json.gz'), zlib.gzipSync(JSON.stringify(rows)));
      snaps++; elements += rows.length;
    };
    const snap = async (name, keepScroll) => {
      await ev(keep => { document.getAnimations().forEach(a => a.cancel()); if(!keep) window.scrollTo(0, 0); }, !!keepScroll);
      await wait(60);
      const rows = await ev(() => window.__snap.dump());
      if(rows) await save(name, rows);
    };
    const forced = async (name) => {
      if(!STATES) return;
      const client = await ctx.newCDPSession(page);
      await client.send('DOM.enable'); await client.send('CSS.enable');
      const reps = await ev(() => window.__snap.mark()); if(!reps) return;
      const { root: doc } = await client.send('DOM.getDocument', { depth: 0 });
      const all = [];
      for(let id = 0; id < reps.length; id++){
        let nodeId; try { nodeId = (await client.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '[data-snapid="' + id + '"]' })).nodeId; } catch(e){ continue; }
        if(!nodeId) continue;
        for(const st of ['hover', 'focus', 'active', 'focus-visible', 'focus-within']){
          await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [st] });
          await ev(() => document.getAnimations().forEach(a => { try { a.finish(); } catch(e){} }));   // settle transitions so the read is not timing-dependent
          const rows = await ev(id => window.__snap.sub(id), id);
          await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
          if(rows) rows.forEach(r => all.push([st + '|' + reps[id] + '|' + r[0]].concat(r.slice(1))));
        }
      }
      await ev(() => window.__snap.unmark());
      await save(name + '.forced', all);
      await client.detach();
    };

    // 1. every screen, in the order the menu lists them
    const sections = ['analysis', 'business', 'strategies', 'trackrecord', 'refreshlog', 'help', 'knowledgebase', 'settings'];
    for(const k of sections){
      await goto(k); await wait(k === 'business' || k === 'strategies' ? 900 : 450);
      await snap('sec-' + k);
      if(['analysis', 'strategies', 'business', 'trackrecord', 'refreshlog', 'settings'].includes(k)) await forced('sec-' + k);
    }
    // 2. open states
    await goto('analysis'); await wait(400);
    await click('[data-rk-act="bar-menu"]'); await wait(250); await snap('analysis-refresh-menu');
    await page.keyboard.press('Escape'); await ev(() => document.body.click()); await wait(150);
    await click('#analysisFiltersToggle'); await wait(200); await snap('analysis-filters-toggled'); await click('#analysisFiltersToggle'); await wait(150);
    await click('#activityBell'); await wait(250); await snap('activity-open'); await click('#activityBell'); await wait(150);
    await click('#menuToggle'); await wait(300); await snap('menu-open'); await click('#sidebarOverlay'); await ev(() => document.body.click()); await wait(250);
    await page.fill('#globalSearch', FIXTURE[0].name.slice(0, 3)).catch(() => {}); await wait(350); await snap('search-suggest');
    await page.keyboard.press('ArrowDown').catch(() => {}); await page.keyboard.press('Enter').catch(() => {}); await wait(900);
    await page.waitForFunction(() => document.querySelector('#detail .live-px'), null, { timeout: 40000 }).catch(() => { problems.push(tag + ': live price chip never appeared (snapshot not comparable)'); }); await wait(400);   // the live price chip arrives after a variable delay: wait for it so every run sees the same page
    await snap('stock'); await forced('stock');
    await ev(() => window.scrollTo(0, 700)); await wait(500); await snap('stock-scrolled', true);
    await ev(() => window.scrollTo(0, 99999)); await wait(500); await snap('stock-bottom', true);
    await goto('trackrecord'); await wait(500);
    await click('#tradeAddBtn'); await wait(300); await snap('tl-add-form'); await click('#tlCancel'); await wait(150);
    await click('[data-tl-view="table"]'); await wait(300); await snap('tl-table');
    await click('[data-tl-sell]'); await wait(300); await snap('tl-sell-form'); await click('#tlCancel'); await wait(150);
    await click('[data-tl-view="cards"]'); await wait(200);
    await goto('business'); await wait(700); await click('.biz-row'); await wait(400); await snap('biz-expanded');
    await goto('strategies'); await wait(600);
    await ev(() => { document.querySelectorAll('details.strat-group').forEach(d => { d.open = true; }); }); await wait(250); await snap('strat-groups-open');
    const cardsN = (await ev(() => document.querySelectorAll('.strat-card').length)) || 0;
    for(let i = 0; i < Math.min(cardsN, 3); i++){ await ev(i => { const c = document.querySelectorAll('.strat-card')[i]; if(c) c.click(); }, i); await wait(500); await snap('strat-card-' + i); }
    await goto('settings'); await wait(300); await click('[data-theme-choice="' + (theme === 'dark' ? 'indigo' : 'dark') + '"]'); await wait(400); await snap('settings-other-theme');
    if(errs.length) problems.push(tag + ' console errors: ' + errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  try {
    const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);   // e.g. --only=dark-1280: one theme and width (fast check while editing)
    for(const theme of ['dark', 'indigo']) for(const w of widths){
      if(only && only !== theme + '-' + w) continue;
      const t = Date.now();
      await runCombo(theme, w);
      console.log(theme + ' ' + w + 'px done in ' + Math.round((Date.now() - t) / 1000) + 's (' + snaps + ' snapshots so far)');
    }
  } finally { await browser.close(); srv.close(); }
  fs.writeFileSync(path.join(outDir, 'styles.dict.gz'), zlib.gzipSync(JSON.stringify(Object.fromEntries(dict))));
  console.log('wrote ' + snaps + ' snapshots, ' + elements + ' element records, ' + dict.size + ' distinct styles in ' + Math.round((Date.now() - t0) / 1000) + 's');
  if(problems.length) console.log('notes:\n  ' + [...new Set(problems)].slice(0, 12).join('\n  '));
})().catch(e => { console.error('css-snapshot crashed:', e); process.exit(1); });
