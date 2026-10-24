// Regression harness: node tests/run.js <projectDir> <outDir>
// Loads the dashboard (index.html + partials + the start-up sequence and app built from src/) in jsdom with an anonymised sample of the
// stock list and an in-memory stand-in for the artifact database, drives common actions (filters, sort, search, selection,
// Analysis, theme, Trade Log, the top-bar stock search, lazy price history, the Live Data Refresh with a stubbed Claude and TradingView),
// and writes DOM snapshots + console output. tests/check.js compares their hashes with tests/golden.json.
process.env.TZ = 'UTC';   // the snapshots hold dates ("Today", "3 days ago"): fix the time zone so every machine and GitHub produce the same text
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const src = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const rd = f => fs.readFileSync(path.join(src, f), 'utf8');
const FIXTURE = path.join(__dirname, 'fixtures', 'stocks.json');

// the saved index.html is wrapped in an outer skeleton; use the inner document
let raw = rd('index.html');
const i0 = raw.indexOf('<!DOCTYPE html>');
let html = i0 >= 0 ? raw.slice(i0) : raw;
html = html.replace(/<script src="[^"]*"[^>]*><\/script>/g, '').replace(/<link rel="(stylesheet|modulepreload)"[^>]*>/g, '');

const logs = [];
const vc = new VirtualConsole();
for(const k of ['log','info','warn','error','debug']) vc.on(k, (...a) => logs.push(k + ': ' + a.map(x => (x && x.stack) ? x.stack.split('\n')[0] : String(x)).join(' ').slice(0, 300)));
vc.on('jsdomError', e => logs.push('jsdomError: ' + String(e.message || e).slice(0, 300)));

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://claude.ai/artifact/test', virtualConsole: vc });
const win = dom.window, ctx = dom.getInternalVMContext();
const run = (code, name) => new vm.Script(code, { filename: name }).runInContext(ctx);

// ---- environment stand-ins ----
win.eval(`
  (function(){
    const RealDate = Date, FIXED = RealDate.parse('2026-10-10T00:00:00Z');
    class FDate extends RealDate { constructor(...a){ if(a.length === 0) super(FIXED); else super(...a); } static now(){ return FIXED; } }
    window.Date = FDate;
    Element.prototype.scrollIntoView = function(){};
    window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }));
    window.scrollTo = function(){};
    Math.random = (function(){ let s = 12345; return function(){ s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; })();
  })();
`);
const store = new Map();
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
function mkSnap(id, d){ return { id, exists: d !== undefined, data: () => clone(d) }; }
function mkDoc(p){
  const doc = {
    id: p.split('/').pop(), path: p,
    get: async () => mkSnap(p.split('/').pop(), store.get(p)),
    set: async d => { store.set(p, clone(d)); },
    update: async d => { store.set(p, Object.assign({}, store.get(p) || {}, clone(d))); },
    delete: async () => { store.delete(p); },
    onSnapshot: (cb) => { Promise.resolve().then(() => cb(mkSnap(p.split('/').pop(), store.get(p)))); return () => {}; },
    collection: n => mkCol(p + '/' + n)
  };
  return doc;
}
function colSnap(p){
  const docs = [];
  for(const [k, v] of store){ if(k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) docs.push(mkSnap(k.slice(p.length + 1), v)); }
  docs.sort((a, b) => a.id < b.id ? -1 : 1);
  return { docs, size: docs.length, empty: docs.length === 0, forEach: f => docs.forEach(f), docChanges: () => [] };
}
globalThis.__reads = [];
function mkCol(p, flt){
  const sub = () => { const s = colSnap(p); if(!flt) return s; const docs = s.docs.filter(d => d.data()[flt[0]] === flt[2]); return Object.assign({}, s, { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) }); };
  const col = {
    doc: id => mkDoc(p + '/' + id),
    get: async () => { __reads.push(p + (flt ? '?' + flt[2] : ' ALL')); return sub(); },
    onSnapshot: (cb) => { __reads.push(p + ' SNAP'); Promise.resolve().then(() => cb(sub())); return () => {}; },
    where(f, o, v){ return mkCol(p, [f, o, v]); }, orderBy(){ return col; }, limit(){ return col; }
  };
  return col;
}
const db = { doc: p => mkDoc(p), collection: n => mkCol(n) };
win.ResizeObserver = class { observe(){} disconnect(){} unobserve(){} };
globalThis.__prompts = [];
const e2eStubs = {
  mcp: { callTool: async (server, tool, input) => {
    if(globalThis.__tvDelay) await new Promise(r => setTimeout(r, globalThis.__tvDelay));   // set only by checks that need a refresh to stay "running" for a while
    const d = {};
    const symOfStock = s => 'NSE:' + String(s.ticker).split('·')[0].trim().replace(/-/g, '_');
    if(tool === 'mcp-tv-search-symbols' && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(input.query)){ const s = stocks.find(x => x.isin === input.query); return { payload: { data: { symbols: s ? [{ symbol: symOfStock(s), exchange: 'NSE', type: 'stock', description: s.name }] : [] } } }; }
    if(tool === 'mcp-tv-get-symbol-data' && input.columns && input.columns.length === 1 && input.columns[0] === 'isin'){ const s = stocks.find(x => symOfStock(x) === input.symbol); return { payload: { data: { isin: s ? s.isin : null } } }; }
    if(tool === 'mcp-tv-search-symbols') return { payload: { data: { symbols: [{ symbol: 'NSE:' + String(input.query).replace(/\W/g, '').toUpperCase(), exchange: 'NSE', description: String(input.query) }] } } };
    if(tool === 'mcp-tv-get-symbol-data') return { payload: { data: { close: 123.4 } } };
    if(tool === 'mcp-tv-get-news') return { payload: { data: { headlines: [{ id: 'n1', title: 'News ' + 'x'.repeat(60), provider: { name: 'P' }, published: Date.now() / 1000 - 86400, link: 'https://e.com/1', paywall: false }] } } };
    if(tool === 'mcp-tv-get-ohlcv'){   // consistent, ascending bars ending at 2026-10-05
      const step = input.interval === '1W' ? 7 * 86400 : 30 * 86400, n = Math.min(input.count || 100, 300), end = Date.parse('2026-10-05T00:00:00Z') / 1000;
      const b = { t: [], o: [], h: [], l: [], c: [], v: [] };
      for(let i = 0; i < n; i++){ const px = 100 + i * 0.5 + (i % 5); b.t.push(end - (n - 1 - i) * step); b.o.push(px); b.c.push(px + 1); b.h.push(px + 2); b.l.push(px - 1); b.v.push(1000 + i); }
      return { payload: { bars: b } };
    }
    return { payload: { data: { blob: 'y'.repeat(6000), tool } } };
  } },
  sample: Object.assign(async (prompt, o) => { __prompts.push({ len: String(prompt).length, tier: o && o.modelTier, head: String(prompt).split('TASK:')[1] ? String(prompt).split('TASK:')[1].slice(0, 50) : String(prompt).slice(0, 40) }); if(String(prompt).includes('NEWS HEADLINES TO LABEL')){ const labels = {}; for(let i = 0; i < 60; i++) labels[i] = ['positive', 'negative', 'neutral'][i % 3]; return { text: JSON.stringify({ labels }) }; } return { text: '{}' }; }, {}),
  permissions: { state: async () => 'granted', request: async () => ({}) }
};
win.claude = { use: async name => e2eStubs[name] ? e2eStubs[name] : name === 'db' ? db : name === 'user' ? { id: async () => 'u_TEST' } : null };

// ---- seed: saved preferences of a returning member ----
store.set('data/users/u_TEST/prefs', { v: 1, theme: 'dark', tradeView: 'cards', updatedAt: '2026-10-09T21:02:07.036Z',
  analysis: { colorBy: 'week', columnOrder: null, monthMax: 97, monthMin: 0, mosHi: null, mosLo: null, mosRatings: ['green'], sortBy: 'monthRsi_desc', techM: [], techW: ['bull_above', 'bull_below'], verdicts: ['buy', 'mbuy'], weekMax: 100, weekMin: 45, xAxis: 'week', yAxis: 'month' },
  uiState: { section: 'analysis', search: 'a', scroll: 0, aSelMode: true, aColsOpen: true } });
store.set('data/users/u_TEST/pins', { tickers: [] });

// ---- stock data ----
const stocks = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).stocks;
// research for ONE stock was saved "today" (used by the up-to-date check of the Fundamental refresh below)
const FRESH = stocks.find((s, i) => i > 8 && s.fundamentals && s.fundamentals.factors.every(f => !(f.metrics || []).some(m => Array.isArray(m) && m[1] === 'n/a'))), freshSym = FRESH.ticker.split('·')[0].trim(), todayIso = '2026-10-10';
{ const f = FRESH.fundamentals.factors[0];
  store.set('stockResearch/' + freshSym.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_'), { ticker: freshSym, asof: todayIso, factors: { [f.key]: { research: { asof: todayIso, headline: 'seed', points: [], positives: [], negatives: [], sources: [] } } } }); }
// dated events for the price-chart tags of stocks[7] (the stock used by the lazy price-history check below)
{ const tk7 = String(stocks[7].ticker).split(' · ')[0].trim();
  store.set('stockResearch/' + tk7.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_'), { ticker: tk7, events: [
    { k: 'news', d: '2024-01-24', t: 'Plant expansion announced', src: 'Wire', url: 'https://e.com/a', s: 'pos' },
    { k: 'news', d: '2024-01-25', t: 'Order win', src: 'Wire', url: '', s: 'neg' },
    { k: 'news', d: '2024-03-04', t: 'Probe launched', src: 'Wire', url: '', s: 'neg' },
    { k: 'earn', d: '2024-02-10', t: 'Results · Q3 23/24', src: 'Quartr', url: '' },
    { k: 'corp', d: '2024-05-20', t: 'Investor Day', src: 'Quartr', url: '' },
    { k: 'news', d: '2023-01-01', t: 'Before the first bar', src: '', url: '' } ] }); }
// Analysis "Research done" column: research was triggered 3 days ago for TKR05 (and saved today since, e.g. by Live Data Refresh)
// and for TKR01 (research saved 9 days ago, nothing since)
for(const [sym, asof] of [['TKR05', todayIso], ['TKR01', '2026-10-01']]){
  store.set('researchTriggers/' + sym, { ticker: sym, triggeredAt: '2026-10-07', kind: 'full' });
  store.set('stockResearch/' + sym, { ticker: sym, asof, factors: { fin: { research: { asof, headline: 'seed', points: [], positives: [], negatives: [], sources: [] } } } });
}
// recent news for the Strategies news rules: TKR05 positive + negative, TKR06 positive only (dates relative to the fixed 2026-10-10)
store.set('stockResearch/TKR05', Object.assign({}, store.get('stockResearch/TKR05'), { events: [
  { k: 'news', d: '2026-10-08', t: 'Order win', src: 'Wire', url: '', s: 'pos' }, { k: 'news', d: '2026-10-05', t: 'Plant fire', src: 'Wire', url: '', s: 'neg' },
  { k: 'news', d: '2026-08-01', t: 'Old item', src: 'Wire', url: '', s: 'pos' }, { k: 'earn', d: '2026-08-05', t: 'Results · Q1', src: 'Quartr', url: '' } ] }));
store.set('stockResearch/TKR06', { ticker: 'TKR06', events: [ { k: 'news', d: '2026-10-09', t: 'Upgrade', src: 'Wire', url: '', s: 'pos' }, { k: 'news', d: '2026-10-02', t: 'Capacity added', src: 'Wire', url: '', s: 'pos' }, { k: 'corp', d: '2026-09-20', t: 'Investor day', src: 'Quartr', url: '' } ] });
// TKR05 has no monthly RSI reading yet (listed in Analysis only while the Monthly RSI range is left at 0-100)
stocks.find(x => x.ticker.startsWith('TKR05 ')).technical.raw.monthRsi = null;
win.__harnessStocks = JSON.parse(JSON.stringify(stocks));   // what the start-up sequence loads instead of reading the database
if(process.env.HARNESS_DEBUG) console.log('sample stocks:', stocks.length);

// ---- page structure: fill in the partials (the start-up sequence leaves a section that already has its text alone) ----

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const snaps = {};
function snap(step, entries){
  for(const [k, v] of Object.entries(entries)) snaps[step + '__' + k] = String(v);
}
const $ = s => win.document.querySelector(s);
const html$ = s => { const e = $(s); return e ? e.innerHTML : '<missing ' + s + '>'; };
const click = el => el && el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const typeInto = (el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };

(async () => {
  // the real partial loader (src/boot/partials.js) fills each section, reading the files from disk instead of over the network
  const { ensurePartial } = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'src', 'boot', 'partials.js')).href);
  const realFetch = globalThis.fetch; globalThis.fetch = async f => ({ ok: true, status: 200, text: async () => rd(f) });
  for(const el of Array.from(win.document.querySelectorAll('section[data-partial]'))) await ensurePartial(el);
  globalThis.fetch = realFetch;
  // The real start-up sequence (src/boot: identity, saved preferences, then the app) as one script. jsdom cannot load ES modules,
  // so this bundle is a single file; a lazily loaded part becomes an import() that resolves from inside the same file.
  const bundle = require('esbuild').buildSync({ stdin: { contents: "import { boot } from './src/boot/boot.js'; window.__bootDone = boot({ loadStocks: async () => window.__harnessStocks });", resolveDir: src, sourcefile: 'harness-entry.js' },
    bundle: true, format: 'iife', target: 'es2022', write: false, logLevel: 'warning' }).outputFiles[0].text;
  run(bundle, 'alba-app.js');
  await win.__bootDone;
  await sleep(400);

  const sections = ['help', 'refreshlog', 'analysis', 'business', 'trackrecord', 'knowledgebase', 'settings'];
  const dump = step => { const o = {}; for(const s of sections) o[s] = html$('#section-' + s); o.theme = win.document.documentElement.getAttribute('data-theme') || ''; o.active = (win.document.querySelector('.app-section.active') || {}).id || ''; o.nav = (win.document.querySelector('.nav-item.active') || {}).textContent || ''; snap(step, o); };

  dump('s0_boot');
  const nav = k => click($('.nav-item[data-section="' + k + '"]'));

  // a stock opened from the top-bar search shows its detail inside the page you are on; its star pins it
  nav('analysis'); await sleep(100);
  typeInto($('#globalSearch'), 'ind'); await sleep(200);
  snap('s4_search', { sugg: html$('#globalSuggest') });
  $('#globalSearch').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); $('#globalSearch').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(250);
  snap('s5_select', { detail: html$('#detail'), parent: $('#detail').parentNode.className });
  click($('#detailPinBtn')); await sleep(100);
  snap('s5b_pin', { star: $('#detailPinBtn').className });

  nav('analysis'); await sleep(200);
  // the last research stays on screen when the live read comes back with no documents at all
  { const alba = win.__alba, n = () => alba.stocks.filter(s => s.__researchAsof).length, before = n(); alba.applyResearchOverlay([]); snap('s5c_research_kept', { before, after: n(), some: before > 0 }); }
  snap('s6_analysis', { body: html$('#analysisPanelBody'), filt: html$('#analysisGlobalFilters') });
  snap('s6_triggered', { cells: Array.from(win.document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-researched')).map(td => td.outerHTML).join('\n') });
  click($('#xAxisMonthBtn')); await sleep(150);
  snap('s6b_axis', { body: html$('#analysisPanelBody') });
  click($('#colorByMonthBtn')); await sleep(100);
  snap('s6c_color', { body: html$('#analysisPanelBody') });
  click($('#analysisSelectBtn')); await sleep(150);
  snap('s6d_select', { body: html$('#analysisPanelBody') });
  const cbs = win.document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-row'); if(cbs[0]) click(cbs[0]); if(cbs[1]) click(cbs[1]); await sleep(100);
  snap('s6e_ticked', { body: html$('#analysisPanelBody'), bar: html$('#analysisSelNote') });
  click($('#analysisColumnsBtn')); await sleep(150);
  snap('s6f_columns', { body: html$('#analysisPanelBody') });
  // more Analysis paths: filter buttons, sliders, MoS range, sort, column move/reset, Y axis, tooltip, dot click, pin
  click($('#analysisVerdictFilters [data-averdict="hold"]')); await sleep(150);
  snap('s6g_verdictfilter', { body: html$('#analysisPanelBody'), filt: html$('#analysisGlobalFilters') });
  click($('#analysisTechMFilters [data-atechm="bull_above"]')); await sleep(150);
  snap('s6h_techmfilter', { body: html$('#analysisPanelBody'), filt: html$('#analysisGlobalFilters') });
  click($('#analysisMosFilters [data-amos="all"]')); await sleep(150);
  snap('s6i_mosfilter', { body: html$('#analysisPanelBody'), filt: html$('#analysisGlobalFilters') });
  click($('#analysisVerdictFilters [data-averdict="all"]')); await sleep(150);
  click($('#analysisTechMFilters [data-atechm="all"]')); await sleep(150);
  click($('#analysisTechWFilters [data-atechw="all"]')); await sleep(150);
  snap('s6j_allfilters', { body: html$('#analysisPanelBody'), filt: html$('#analysisGlobalFilters') });
  snap('s6j2_narrow', { rows: Array.from(win.document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-ticker')).map(e => e.textContent).join(',') });
  typeInto($('#monthRsiMaxInput'), '100'); typeInto($('#weekRsiMinInput'), '0'); await sleep(700);
  snap('s6j3_fullrange', { rows: Array.from(win.document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-ticker')).map(e => e.textContent).join(','), body: html$('#analysisPanelBody') });
  // v1.185: with nothing filtered, "All" and the list cover every stock, including those with no Intrinsic Value (their MoS and Price cells are blank)
  for(const id of ['weekRsiMinInput', 'monthRsiMaxInput']) $('#' + id).dispatchEvent(new win.Event('change', { bubbles: true }));   // a slider's release redraws the filter counts
  await sleep(300);
  { const rows = Array.from(win.document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-row'));
    const blankMos = rows.filter(r => /mos-none/.test(r.innerHTML)).length;
    snap('s6j3b_every_stock', { all: $('#analysisStrategyFilter [data-astrat="all"] .filter-n').textContent, fund: $('#analysisVerdictFilters [data-averdict="all"] .filter-n').textContent, mosAll: $('#analysisMosFilters [data-amos="all"] .filter-n').textContent, count: $('#analysisLeaderboardCount').textContent, note: String(!!$('#analysisHiddenNote')), blankMosRows: String(blankMos) }); }
  for(const dir of ['mos_desc', 'mos_asc']){ const sel = $('#analysisSortSelect'); sel.value = dir; sel.dispatchEvent(new win.Event('change', { bubbles: true })); await sleep(100);
    const rows = Array.from(win.document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-row:not(.pinned)')); const flags = rows.map(r => /mos-none/.test(r.innerHTML) ? 1 : 0).join('');   // pinned stocks always come first
    snap('s6j3c_blank_mos_last_' + dir, { lastBlankRun: String(/^0*1*$/.test(flags)), flags }); }
  { const sel = $('#analysisSortSelect'); sel.value = 'monthRsi_asc'; sel.dispatchEvent(new win.Event('change', { bubbles: true })); await sleep(100); }
  snap('s6j4_blank_sorted_last', { rows: Array.from(win.document.querySelectorAll('#analysisLeaderboardBody .analysis-lb-ticker')).map(e => e.textContent).join(',') });
  typeInto($('#weekRsiMinInput'), '55'); await sleep(700);
  typeInto($('#monthRsiMaxInput'), '90'); await sleep(100);
  snap('s6k_sliders', { body: html$('#analysisPanelBody') });
  { const mi = $('#mosMinInput'); typeInto(mi, String(Math.round((Number(mi.min) + Number(mi.max)) / 2))); await sleep(100); }
  snap('s6l_mos', { body: html$('#analysisPanelBody') });
  { const sel = $('#analysisSortSelect'); sel.value = 'mos_desc'; sel.dispatchEvent(new win.Event('change', { bubbles: true })); await sleep(100); }
  snap('s6m_sort', { body: html$('#analysisPanelBody') });
  click($('.analysis-col-move[data-dir="down"]')); await sleep(150);
  snap('s6n_colmove', { body: html$('#analysisPanelBody') });
  click($('#analysisColumnsResetBtn')); await sleep(150);
  snap('s6o_colreset', { body: html$('#analysisPanelBody') });
  click($('#yAxisWeekBtn')); await sleep(150);
  snap('s6p_yaxis', { body: html$('#analysisPanelBody') });
  { const d = $('#analysisDots .analysis-dot'); if(d){ d.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, clientX: 100, clientY: 100 })); } await sleep(50);
    snap('s6q_tooltip', { tip: html$('#analysisTooltip'), shown: String($('#analysisTooltip').classList.contains('show')) });
    if(d) d.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true })); await sleep(50);
    snap('s6r_tooltip_hidden', { shown: String($('#analysisTooltip').classList.contains('show')) }); }
  { const pb = $('#analysisLeaderboardBody .pin-btn'); click(pb); await sleep(150); }
  snap('s6s_pin', { body: html$('#analysisPanelBody') });
  { const pb = $('#analysisLeaderboardBody .pin-btn'); click(pb); await sleep(150); }
  click($('#analysisSelClear')); click($('#analysisSelAllShown')); await sleep(100);
  snap('s6t_selall', { bar: html$('#analysisSelNote'), body: html$('#analysisPanelBody') });
  click($('#analysisSelectBtn')); await sleep(150);
  click($('#analysisColumnsBtn')); await sleep(150);
  snap('s6u_closed', { body: html$('#analysisPanelBody') });
  { const d = $('#analysisDots .analysis-dot'); if(d) click(d); await sleep(200); snap('s6v_dotclick', { opened: String(!!$('#detailBackBtn')), parent: $('#detail').parentNode.className }); }
  const chg = (el, v) => { if(v !== undefined) el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); };
  nav('analysis'); await sleep(200);
  { const before = $('#analysisLeaderboardCount').textContent;
    const btn = $('#analysisStrategyFilter .filter-btn[data-astrat="starter-deep-value"]');
    if(btn){ click(btn); await sleep(200); }
    snap('s6w_analysis_strategy', { before, after: $('#analysisLeaderboardCount').textContent, hint: html$('#analysisStrategyFilter'), saved: String(win.localStorage.getItem('albaDashboard.analysisFilters.v1')).includes('starter-deep-value') ? 'saved' : 'not saved' });
    click($('#analysisStrategyFilter .filter-btn[data-astrat="all"]')); await sleep(200);
    snap('s6x_analysis_strategy_off', { count: $('#analysisLeaderboardCount').textContent }); }

  for(const k of ['refreshlog', 'business', 'trackrecord', 'help', 'knowledgebase', 'settings']){ nav(k); await sleep(150); snap('s7_' + k, { sec: html$('#section-' + k) }); }
  // ---- Strategies ----
  win.confirm = () => true;
  // Price history for every sample stock (a mean-reverting random walk ending at the stock's current price), used by
  // "Suggest rules from past prices" and the tracked-list judging. Removed again after this block.
  const readsBefore = globalThis.__reads.length, seededKeys = [];
  {
    let sd = 4242; const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
    const end = Date.parse('2026-10-05T00:00:00Z') / 1000;
    const mk = (n, step, lastPx) => {
      const rel = [1]; for(let i = 1; i < n; i++){ const prev = rel[i - 1], ma = rel.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, rel.length); rel.push(prev * (1 + (ma - prev) / ma * 0.35 + (rnd() - 0.5) * 0.08)); }
      const k = lastPx / rel[n - 1], bars = [];
      for(let i = 0; i < n; i++){ const c = rel[i] * k, o = i ? rel[i - 1] * k : c, h = Math.max(o, c) * (1 + rnd() * 0.02), l = Math.min(o, c) * (1 - rnd() * 0.02); bars.push([end - (n - 1 - i) * step, +o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +c.toFixed(2), 1000]); }
      return bars;
    };
    stocks.forEach(s => {
      const sym = s.ticker.split('·')[0].trim(), px = (s.valuation && s.valuation.currentPrice) || 100;
      for(const [iv, n, step] of [['1W', 170, 7 * 86400], ['1M', 48, 30 * 86400]]){
        const key = 'priceHistory/NSE_' + sym + '_' + iv;
        if(store.has(key)) continue;
        store.set(key, { ticker: sym, symbol: 'NSE:' + sym, interval: iv, bars: mk(n, step, px), fetchedAt: '2026-10-09T00:00:00Z' }); seededKeys.push(key);
      }
    });
    // an older tracked list (saved 2026-08-25, 30 days) for the second starter strategy, so hits / misses / open can be judged
    const pickOf = (s) => { const sym = s.ticker.split('·')[0].trim(), w = store.get('priceHistory/NSE_' + sym + '_1W').bars; const b = w.filter(x => x[0] * 1000 <= Date.parse('2026-08-25T00:00:00Z')).pop(); return { sym, name: s.name, entry: b[4], peak: b[4], peakAt: '2026-08-25' }; };
    store.set('data/users/u_TEST/strategyTracking/runs/rOLD', { v: 1, id: 'rOLD', strategyId: 'starter-turning-up', strategyName: 'Turning up early', startedAt: '2026-08-25', target: 5, days: 30, rules: [], picks: stocks.slice(0, 8).map(pickOf) });
    store.set('data/users/u_TEST/strategyTracking/runs/rOTHER', { v: 1, id: 'rOTHER', strategyId: 'someone-else', strategyName: 'Other', startedAt: '2026-09-01', target: 5, days: 30, rules: [], picks: [] });
  }
  nav('strategies'); await sleep(150);
  snap('s7b_strategies_open', { list: html$('#stratList'), main: html$('#stratMain') });
  click($('#stratList .strat-card:nth-child(6)')); await sleep(100);
  snap('s7c_strategies_second', { main: html$('#stratMain'), rows: Array.from(win.document.querySelectorAll('#stratResults .strat-row')).map(e => e.dataset.idx).join(',') });
  { // "Sort by" above the qualifying stocks (same choices as the Analysis leaderboard)
    const order = () => Array.from(win.document.querySelectorAll('#stratResults .strat-row')).map(e => e.dataset.idx);
    const base = order(), opts = Array.from(win.document.querySelectorAll('#stratSort option')).map(o => o.value);
    chg($('#stratSort'), 'name_asc'); await sleep(50); const byName = order();
    chg($('#stratSort'), 'monthRsi_desc'); await sleep(50); const byRsi = order();
    chg($('#stratSort'), 'score_desc'); await sleep(50); const back = order();
    snap('s7b2_strategies_sort', { opts: opts.join(','), same: String(base.slice().sort().join() === byName.slice().sort().join() && base.length === byRsi.length), reordered: String(byName.join() !== base.join() || base.length < 2), restored: String(back.join() === base.join()), saved: String(win.localStorage.getItem('albaDashboard.strategySort.v1')) }); }
  click($('#stratNew')); await sleep(100);
  chg($('#stratName'), 'My test strategy');
  chg($('.sr-add'), 'score'); await sleep(50);
  chg($('.sr-row .sr-v1'), '5'); await sleep(50);
  chg($('.sr-add'), 'weekRsi'); await sleep(50);
  chg($('.sr-row:nth-child(2) .sr-op'), 'between'); await sleep(50);
  chg($('.sr-row:nth-child(2) .sr-v1'), '30'); chg($('.sr-row:nth-child(2) .sr-v2'), '70'); await sleep(50);
  chg($('.sr-add'), 'verdict'); await sleep(50);
  click($('.sr-row:nth-child(3) .sr-opt[data-v="buy"]')); click($('.sr-row:nth-child(3) .sr-opt[data-v="mbuy"]')); await sleep(50);
  chg($('.sr-add'), 'industry'); await sleep(50);
  snap('s7d_strategies_edit', { list: html$('#stratList'), main: html$('#stratMain'), saved: String(win.localStorage.getItem('albaDashboard.strategies.v1')).length > 100 ? 'saved' : 'not saved' });
  { // Tech Rating M can be set to "None (no rating)" so that stocks without a rating qualify
    const count = () => (win.document.querySelector('#stratResults') ? win.document.querySelectorAll('#stratResults .strat-row').length : -1);
    chg($('.sr-add'), 'monthMacd'); await sleep(50);
    const row = () => win.document.querySelector('.sr-row:last-child');
    const pick = v => click(row().querySelector('.sr-opt[data-v="' + v + '"]'));
    const hasNone = !!row().querySelector('.sr-opt[data-v="none"]');
    pick('bull_above'); await sleep(80); const withRating = count();
    pick('none'); await sleep(80); const withNone = count();
    pick('bull_above'); await sleep(80); const onlyNone = count();
    snap('s7d1_strategies_tech_none', { buttons: html$('.sr-row:last-child .sr-opts'), withRating: String(withRating), withNone: String(withNone), onlyNone: String(onlyNone), ok: hasNone && onlyNone > 0 && withNone === onlyNone + withRating ? 'yes' : 'NO' });
    click(row().querySelector('.sr-del')); await sleep(50); }
  await sleep(500);   // the account copy is written a third of a second after the last change
  { const doc = store.get('data/users/u_TEST/strategies'); const back = doc && JSON.parse(doc.json);
    snap('s7d2_strategies_account_copy', { has: doc ? 'yes' : 'no', n: back ? String(back.length) : '0', rules: back ? String(back.find(x => x.id === 'starter-quality-momentum').rules.length) : '0', note: html$('#stratSaveNote') }); }
  { const who = $('#stratResults .strat-row .analysis-lb-ticker'); chg($('#stratWhy'), who ? who.textContent : 'zzz'); await sleep(50);
    snap('s7e_strategies_why_in', { out: html$('#stratWhyOut') });
    chg($('#stratWhy'), 'TKR10'); await sleep(50);
    snap('s7f_strategies_why_other', { out: html$('#stratWhyOut') });
    chg($('#stratWhy'), 'nosuchstock'); await sleep(50);
    snap('s7g_strategies_why_none', { out: html$('#stratWhyOut') }); }
  click($('.sr-row:nth-child(2) .sr-del')); await sleep(50);
  { const r = $('#stratResults .strat-row'); if(r){ click(r); await sleep(200); snap('s7h_strategies_open_stock', { back: ($('#detailBackBtn') || { textContent: 'none' }).textContent }); click($('#detailBackBtn')); await sleep(150); snap('s7i_strategies_back', { active: String($('#section-strategies').classList.contains('active')) }); } }
  click($('#stratDup')); await sleep(50);
  click($('#stratDel')); await sleep(50); click($('#albaConfirmOk')); await sleep(50);
  click($('#stratRestore')); await sleep(50);
  snap('s7j_strategies_end', { list: html$('#stratList') });
  // goal, learned rules, tracking
  click($('#stratList .strat-card:nth-child(3)')); await sleep(200);   // Turning up early (has the older tracked list)
  click($('#stratTrack .trk-toggle, #stratTrackBody .trk-toggle')); await sleep(100);
  snap('s7k_strategies_tracked_old', { body: html$('#stratTrackBody') });
  chg($('#goalTarget'), '4'); chg($('#goalDays'), '21'); await sleep(100);
  snap('s7l_strategies_goal', { goal: html$('.strat-goal'), learn: html$('#stratLearnOut') });
  click($('#stratLearn')); await sleep(800);
  snap('s7m_strategies_learned', { out: html$('#stratLearnOut') });
  { const ap = $('.learn-apply'); if(ap){ click(ap); await sleep(150); } }
  snap('s7n_strategies_applied', { learned: (($('.strat-learned') || {}).textContent || 'none'), rules: html$('#stratRules'), count: $('#stratCount').textContent });
  while($('.sr-del')){ click($('.sr-del')); await sleep(30); }
  click($('#stratTrackBtn')); await sleep(100); click($('#albaConfirmOk')); await sleep(300);
  snap('s7o_strategies_tracked_new', { body: html$('#stratTrackBody') });
  snap('s7p_strategies_saved_run', { runs: JSON.stringify([...store.keys()].filter(k => k.includes('strategyTracking/runs/')).sort()) });
  click($('#stratTrackBody .trk-run .trk-del')); await sleep(100); click($('#albaConfirmOk')); await sleep(150);
  snap('s7q_strategies_run_deleted', { n: String(win.document.querySelectorAll('#stratTrackBody .trk-run').length) });
  // news and event rules
  click($('#stratNew')); await sleep(100);
  chg($('.sr-add'), 'newsPos'); await sleep(50); chg($('.sr-row .sr-v1'), '1'); await sleep(50);
  chg($('.sr-add'), 'newsNeg'); await sleep(50); chg($('.sr-row:nth-child(2) .sr-op'), '<='); chg($('.sr-row:nth-child(2) .sr-v1'), '0'); await sleep(50);
  snap('s7r_strategies_news_rules', { rules: html$('#stratRules'), results: html$('#stratResults') });
  chg($('#stratWhy'), 'TKR05'); await sleep(50);
  snap('s7s_strategies_news_why', { out: html$('#stratWhyOut') });
  chg($('.sr-add'), 'resultsAge'); await sleep(50); chg($('.sr-row:nth-child(3) .sr-op'), '<='); chg($('.sr-row:nth-child(3) .sr-v1'), '90'); await sleep(50);
  snap('s7t_strategies_results_age', { count: $('#stratCount').textContent });
  click($('#stratLearn')); await sleep(800);
  snap('s7u_strategies_news_effect', { out: html$('#stratLearnOut') });
  seededKeys.forEach(k => store.delete(k)); globalThis.__reads.length = readsBefore;

  click($('.theme-toggle-btn[data-theme-choice="indigo"]')); await sleep(100);
  snap('s8_theme', { theme: win.document.documentElement.getAttribute('data-theme') });
  click($('.tl-view-btn[data-tl-view="table"]')); await sleep(100);
  snap('s8b_tradeview', { body: html$('#tradeLogPanelBody') });

  nav('analysis'); await sleep(100);
  typeInto($('#globalSearch'), stocks[5].name); await sleep(150);
  snap('s9_explore_suggest', { sugg: html$('#globalSuggest') });
  $('#globalSearch').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(250);
  snap('s9b_explore_open', { detail: html$('#detail'), parent: $('#detail').parentNode.className });


  // ---- lazy price history check ----
  {
    const tk = String(stocks[7].ticker).split(' · ')[0].trim();
    const bars = n => Array.from({ length: n }, (_, i) => [1700000000 + i * 604800, 100 + i, 110 + i, 95 + i, 105 + i, 1000 + i]);
    store.set('priceHistory/NSE_T7_1W', { ticker: tk, symbol: 'NSE:T7', interval: '1W', bars: bars(80), fetchedAt: '2026-10-01T00:00:00Z' });
    store.set('priceHistory/NSE_T7_1M', { ticker: tk, symbol: 'NSE:T7', interval: '1M', bars: bars(40), fetchedAt: '2026-10-01T00:00:00Z' });
    store.set('priceHistory/NSE_OTHER_1W', { ticker: 'ZZZ', symbol: 'NSE:ZZZ', interval: '1W', bars: bars(5), fetchedAt: '2026-10-01T00:00:00Z' });
    nav('analysis'); await sleep(100);
    typeInto($('#globalSearch'), stocks[7].name); await sleep(150);
    $('#globalSearch').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(600);
    snap('s9c_lazy', { chart: !!win.document.querySelector('#priceChartBlock'), panels: win.document.querySelectorAll('#priceChartBlock .pc-panels > *').length, reads: JSON.stringify(__reads.filter(r => r.startsWith('priceHistory'))), tk });
    { const blk = win.document.querySelector('#priceChartBlock'); const q = sel => blk ? blk.querySelectorAll(sel).length : -1;
      snap('s9d_events', { stats: blk ? (blk.querySelector('.pc-evstats') || { innerHTML: 'none' }).innerHTML : 'no chart', legend: blk ? (blk.querySelector('.pc-evlegend') || { outerHTML: 'none' }).outerHTML : 'no chart', tags: q('.pc-ev'), news: q('.pc-evk-news.pc-ev'), svg: html$('#priceChartBlock .pc-panel svg') });
      const tg = blk && blk.querySelector('.pc-evtoggle[data-g="news"]'); if(tg){ click(tg); await sleep(50); }
      snap('s9e_events_hidden', { tags: q('.pc-ev'), pressed: tg ? tg.getAttribute('aria-pressed') : 'none' }); }
    // v1.259: a MACD band under the volume of each chart. 80 weekly and 40 monthly bars, drawn from the 34th bar on (the warm-up is left out): 47 and 7 histogram bars.
    { const dCount = (p, sel) => { const e = p.querySelector(sel); return e ? (e.getAttribute('d') || '').split('M').length - 1 : 0; };
      snap('s9f_macd', { panels: JSON.stringify([...win.document.querySelectorAll('#priceChartBlock .pc-panel')].map(p => ({
        title: (p.querySelector('.pc-ptitle') || { textContent: '' }).textContent, label: (p.querySelector('tspan.pc-mtitle') || { textContent: 'none' }).textContent,
        lines: p.querySelectorAll('.pc-mline, .pc-msig').length, zero: p.querySelectorAll('.pc-mzero').length, bars: dCount(p, '.pc-mhu') + dCount(p, '.pc-mhd') }))),
        legend: ((win.document.querySelector('#priceChartBlock .pc-legend') || { textContent: '' }).textContent).replace(/\s+/g, ' ').trim() }); }
  }

  // ---- Live Data Refresh (Fundamental) with a stubbed Claude and TradingView ----
  {
    const status = () => (($('#ldStatus-fund') || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const openFresh = async () => { nav('analysis'); await sleep(100); typeInto($('#globalSearch'), FRESH.name); await sleep(150);
      $('#globalSearch').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(500); };
    await openFresh();
    __prompts.length = 0;
    click($('#ldBtn-fund')); await sleep(2500);
    const first = { calls: __prompts.length, status: status() };
    click($('#ldBtn-fund')); await sleep(2500);
    const second = { calls: __prompts.length, tiers: __prompts.map(p => p.tier + ':' + p.head.slice(1, 22).trim() + ':' + p.len), status: status().slice(0, 100) };
    snap('s10_livedata', { firstClick: JSON.stringify(first), secondClick: JSON.stringify(second) });
    // ---- Live Data Refresh (Technical): price, MoS, bars from the stubbed TradingView, technical score ----
    click($('#ldBtn-tech')); await sleep(2500);
    snap('s11_tech', { status: (($('#ldStatus-tech') || {}).textContent || '').replace(/\s+/g, ' ').trim(), saved: JSON.stringify([...store.keys()].filter(k => /^(priceHistory|stockUpdates)\//.test(k) && k.includes(freshSym.replace(/[^A-Za-z0-9]/g, '_').slice(0, 6))).sort()) });
  }
  await sleep(1800);   // let debounced saves go out
  const lsd = {}; for(let i = 0; i < win.localStorage.length; i++){ const k = win.localStorage.key(i); if(k.startsWith('albaDashboard')) lsd[k] = win.localStorage.getItem(k); }
  delete lsd['albaDashboard.prefsLocalAt.v1'];
  // (the old Live Data Refresh cards on Analysis and Strategies were replaced by the header Refresh menus: see tests/refresh.js)
  { // Business: collect the latest news for one industry, on demand
    const waitFor = async (fn, ms) => { for(let t = 0; t < ms; t += 100){ if(fn()) return true; await sleep(100); } return false; };
    nav('business'); await sleep(150);
    const rows = [...win.document.querySelectorAll('.biz-row')], target = rows.find(r => parseInt(r.children[1].textContent, 10) >= 2) || rows[0];
    const name = target.dataset.bizName; click(target); await sleep(80);
    const btn = () => win.document.querySelector('.biz-detail .biz-newsbtn');
    if(!btn()){ click(win.document.querySelector('.biz-detail [data-biz-newstoggle]')); await sleep(80); }   // the News block starts closed
    click(btn()); await sleep(60);   // opens the choice menu
    const choice = win.document.querySelector('.rk-menu [data-rk-act="choice-run"]');
    const label = choice.textContent.replace(/\s+/g, ' ').trim(), evBefore = [...store.keys()].filter(k => /^stockResearch\//.test(k) && (store.get(k).events || []).length).length;
    click(choice);
    await waitFor(() => /^Done/.test((win.document.getElementById('bizNewsStatus') || { textContent: '' }).textContent), 30000); await sleep(100);
    const status = win.document.getElementById('bizNewsStatus').textContent.replace(/\s+/g, ' ');
    const evAfter = [...store.keys()].filter(k => /^stockResearch\//.test(k) && (store.get(k).events || []).length).length;
    const labelled = [...store.entries()].filter(([k]) => /^stockResearch\//.test(k)).some(([, v]) => (v.events || []).some(e => e.k === 'news' && e.s));
    snap('s7j_business_news', { name, label, status, savedMore: String(evAfter > evBefore), labelled: String(labelled), listed: String(!!win.document.querySelector('.biz-detail .biz-news li')), again: ((btn() || { textContent: '' }).textContent) });
    click(target); await sleep(50); nav('analysis'); await sleep(50);
  }
  { // Explorer: the All / Matched toggle (Matched needs a strategy; it keeps only the industries and stocks that match)
    const D = win.document, $$ = (q) => [...D.querySelectorAll(q)];
    nav('business'); await sleep(150);
    const showBtn = (v) => D.querySelector('[data-biz-show="' + v + '"]');
    const noStrategy = { matchedDisabled: String(showBtn('matched').disabled), activeNoStrategy: D.querySelector('[data-biz-show].active').dataset.bizShow };
    const stratBtns = $$('[data-biz-strat]').filter(b => b.dataset.bizStrat && parseInt((b.querySelector('.filter-n') || { textContent: '0' }).textContent, 10) > 0);
    const out = { noStrategy: JSON.stringify(noStrategy), strategiesWithMatches: String(stratBtns.length > 0) };
    if(stratBtns.length){
      click(stratBtns[0]); await sleep(120);
      const allRows = $$('.biz-row').length;
      click(showBtn('matched')); await sleep(120);
      const matchedRows = $$('.biz-row'), counts = matchedRows.map(r => r.children[6] ? r.children[6].textContent : '');
      out.counts = JSON.stringify({ fewerRows: String(matchedRows.length > 0 && matchedRows.length <= allRows), everyRowHasMatches: String(counts.every(c => /\d+ of \d+/.test(c))), activeMatched: D.querySelector('[data-biz-show].active').dataset.bizShow });
      click(matchedRows[0]); await sleep(80);
      out.detailOnlyMatched = String($$('.biz-detail .strat-row').length === $$('.biz-detail .strat-row.biz-match').length && $$('.biz-detail .strat-row').length > 0);
      click(D.querySelector('.biz-row.open')); await sleep(50);
      click(showBtn('all')); await sleep(120);
      out.backToAll = String($$('.biz-row').length === allRows);
      click(D.querySelector('[data-biz-strat=""]')); await sleep(80);
    }
    snap('s7k_business_matched_toggle', out);
    nav('analysis'); await sleep(600);   // the saved screen choice is written after a short delay; wait so the final snapshot is steady
  }
  snap('z_final', { localStorage: JSON.stringify(lsd, Object.keys(lsd).sort(), 1), db: JSON.stringify([...store.entries()].filter(([k]) => !k.startsWith('stock')).map(([k, v]) => [k, v]).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => { const c = clone(v); if(c && c.updatedAt) delete c.updatedAt; if(c && c.lastSeenAt) delete c.lastSeenAt; if(c && c.firstSeenAt) delete c.firstSeenAt; return [k, c]; }), null, 1) });

  snap('z_console', { logs: logs.join('\n') });

  const index = {};
  for(const [k, v] of Object.entries(snaps)){ fs.writeFileSync(path.join(out, k + '.txt'), v); index[k] = v.length + ':' + sha(v); }
  fs.writeFileSync(path.join(out, '_index.json'), JSON.stringify(index, null, 1));
  console.log('snapshots:', Object.keys(snaps).length, ' console lines:', logs.length);
  process.exit(0);
})().catch(e => { console.error('HARNESS FAILURE', e); try { fs.writeFileSync(path.join(out, '_fail.txt'), String(e && e.stack || e) + '\n' + logs.join('\n')); } catch(_) {} process.exit(2); });
