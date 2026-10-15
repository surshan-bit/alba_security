// Shared browser-test environment: finds Playwright, serves the project over HTTP, and installs a stand-in for window.claude
// (database with live listeners, asset store, user, TradingView with a fake watchlist service) before the page runs.
// Everything the stand-in needs is passed in `cfg` (it must be plain data: the function below is serialised into the page).
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..', '..');

function findPlaywright(){
  for(const p of ['playwright', '/opt/npm-tools/node_modules/playwright', 'playwright-core', '/opt/npm-tools/node_modules/playwright-core']){
    try { return require(p).chromium; } catch(e){ /* try the next */ }
  }
  return null;
}

// ---- server: "/" is the inner document of index.html (the saved one has an outer skeleton) plus the skeleton's [hidden] rule.
// seeds: name -> JSON text served at /__seed/<name>.json; state.appBroken makes /app.js a 404.
function startServer(){
  const raw = fs.readFileSync(path.join(root, 'index.html'), 'utf8'), i0 = raw.indexOf('<!DOCTYPE html>');
  const indexHtml = (i0 >= 0 ? raw.slice(i0) : raw).replace('</head>', '<style>[hidden]:not([hidden=until-found i]){display:none!important}</style></head>');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const state = { appBroken: false, seeds: new Map(), base: '' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if(p === '/') p = '/index.html';
    if(p === '/index.html'){ res.writeHead(200, { 'content-type': 'text/html' }); res.end(indexHtml); return; }
    const sm = /^\/__seed\/(.+)\.json$/.exec(p);
    if(sm){ const t = state.seeds.get(sm[1]); if(t == null){ res.writeHead(404); res.end('nf'); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(t); } return; }
    const f = path.join(root, p);
    if(p === '/app.js' && state.appBroken){ res.writeHead(404); res.end('nf'); return; }
    if(!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(f));
  });
  state.listen = () => new Promise(r => server.listen(0, () => { state.base = 'http://localhost:' + server.address().port; r(state.base); }));
  state.close = () => server.close();
  return state;
}

// ---- the stand-in (runs inside the page) ----
//   cfg.chunks / cfg.seed / cfg.noMeta / cfg.missingChunk / cfg.failOnce   small stock list for the boot tests
//   cfg.seedUrl                         JSON { docs: { path: data } } loaded into the database before anything is read
//   cfg.assets / cfg.owner              asset store present; isOwner() answer (default true)
//   cfg.rules                           [{ op:'set'|'get'|'delete'|'update', path | prefix, nth, after, times, error:{code,message}, bumpMeta }]
//   cfg.tv, cfg.tvLists, cfg.tvRefuse, cfg.tvAlsoDelete, cfg.tvSearch        fake TradingView watchlist service
//   cfg.noClaude / cfg.theme
//   cfg.liveCollections                 collection listeners fire again whenever a document in the collection changes (documents always do)
//   cfg.noUser                          nobody is signed in: user.id() answers null
//   cfg.slowDbAfterApp                  ms: claude.use('db') answers this much later once the app has started (the start-up sequence is not slowed)
function installStub(cfg){
  const store = new Map(), listeners = new Map(), colListeners = new Map(), gets = [], sets = [], uploads = [];
  const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  const deepFreeze = o => { if(o && typeof o === 'object' && !Object.isFrozen(o)){ Object.freeze(o); for(const v of Object.values(o)) deepFreeze(v); } return o; };
  const snap = (id, d) => ({ id, exists: d !== undefined, data: () => d && d.uploadedAt ? deepFreeze(clone(d)) : clone(d) });   // the real runtime hands out records that cannot be changed in place (the upload logs rely on that being respected)
  const notify = p => {
    for(const cb of listeners.get(p) || []) cb(snap(p.split('/').pop(), store.get(p)));
    if(cfg.liveCollections){ const parent = p.slice(0, p.lastIndexOf('/')); for(const cb of colListeners.get(parent) || []) cb(colSnap(parent)); }
  };
  const failedOnce = new Set();
  const rules = (cfg.rules || []).map(r => Object.assign({ seen: 0, fired: 0 }, r));
  const seedP = cfg.seedUrl ? fetch(cfg.seedUrl).then(r => r.json()).then(d => { for(const [k, v] of Object.entries(d.docs)) store.set(k, v); }) : Promise.resolve();
  function rule(op, p){
    for(const r of rules){
      if(r.op !== op || !((r.path && r.path === p) || (r.prefix && p.startsWith(r.prefix)))) continue;
      r.seen++;
      if(r.nth && r.seen !== r.nth) continue;
      if(r.after && r.seen <= r.after) continue;
      if(r.times && r.fired >= r.times) continue;
      r.fired++;
      if(r.bumpMeta){ const m = store.get('stockMeta/main'); store.set('stockMeta/main', Object.assign({}, m, { version: (m.version || 0) + 100 })); }
      if(r.error){ const e = new Error(r.error.message || 'injected failure'); if(r.error.code) e.code = r.error.code; throw e; }
    }
  }
  function mkDoc(p){
    return { id: p.split('/').pop(), path: p,
      get: async () => {
        await seedP; gets.push(p); rule('get', p);
        if(cfg.failOnce && cfg.failOnce === p && !failedOnce.has(p)){ failedOnce.add(p); throw new Error('temporary network error'); }
        return snap(p.split('/').pop(), store.get(p));
      },
      set: async d => { await seedP; rule('set', p); store.set(p, clone(d)); sets.push(p); notify(p); },
      update: async d => { await seedP; rule('update', p); store.set(p, Object.assign({}, store.get(p) || {}, clone(d))); sets.push(p); notify(p); },
      delete: async () => { await seedP; rule('delete', p); store.delete(p); sets.push('-' + p); notify(p); },
      onSnapshot: cb => { if(!listeners.has(p)) listeners.set(p, new Set()); listeners.get(p).add(cb); seedP.then(() => cb(snap(p.split('/').pop(), store.get(p)))); return () => listeners.get(p).delete(cb); },
      collection: n => mkCol(p + '/' + n) };
  }
  function colSnap(p){ const docs = []; for(const [k, v] of store){ if(k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')) docs.push(snap(k.slice(p.length + 1), v)); } return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f), docChanges: () => [] }; }
  function mkCol(p){
    const c = { doc: id => mkDoc(p + '/' + id), get: async () => { await seedP; rule('get', p); return colSnap(p); },
      onSnapshot: cb => {
        if(cfg.liveCollections){ if(!colListeners.has(p)) colListeners.set(p, new Set()); colListeners.get(p).add(cb); }
        seedP.then(() => cb(colSnap(p)));
        return () => { if(colListeners.has(p)) colListeners.get(p).delete(cb); };
      },
      where: () => c, orderBy: () => c, limit: () => c };
    return c;
  }
  const db = { doc: p => mkDoc(p), collection: n => mkCol(n) };
  if(cfg.chunks){
    const seed = cfg.seed || {};
    if(!cfg.noMeta) store.set('stockMeta/main', { version: seed.version || 1, count: seed.count != null ? seed.count : cfg.chunks.reduce((a, c) => a + c.length, 0), chunks: cfg.chunks.map((_, i) => 'c00' + (i + 1)), index: {} });
    cfg.chunks.forEach((c, i) => { if(!(cfg.missingChunk === i)) store.set('stockData/c00' + (i + 1), { chunk: 'c00' + (i + 1), count: c.length, stocks: c }); });
  }
  store.set('data/users/u_SMOKE/prefs', { v: 1, theme: cfg.theme || 'dark', updatedAt: '2026-10-10T00:00:00.000Z', uiState: { section: cfg.section || 'analysis' } });
  const delay = ms => new Promise(r => setTimeout(r, ms));
  // ---- fake TradingView: a few watchlists that behave like the real connector (silent drops, ids as strings) ----
  const tv = window.__tv = { lists: clone(cfg.tvLists || []), calls: [], nextId: 100 };
  const refuse = new Set(cfg.tvRefuse || []);
  function tvCall(tool, input){
    tv.calls.push([tool, clone(input)]);
    const find = id => tv.lists.find(l => String(l.id) === String(id));
    switch(tool){
      case 'mcp-watchlist-list-watchlists': return { watchlists: clone(tv.lists) };
      case 'mcp-watchlist-create-watchlist': { const id = String(tv.nextId++); tv.lists.push({ id, name: input.name, type: 'custom', symbols: input.symbols.filter(s => !refuse.has(s)) }); return { id }; }
      case 'mcp-watchlist-add-to-watchlist': { const l = find(input.watchlist_id); if(!l) throw Object.assign(new Error('no such list'), { code: 'tool_error' }); for(const s of input.symbols) if(!refuse.has(s) && !l.symbols.includes(s)) l.symbols.push(s); return { ok: true }; }
      case 'mcp-watchlist-delete-watchlist': { const l = find(input.watchlist_id); tv.lists = tv.lists.filter(x => x !== l && !(cfg.tvAlsoDelete && x.name === cfg.tvAlsoDelete)); return { ok: true }; }
      case 'mcp-watchlist-update-watchlist': { const l = find(input.watchlist_id); if(l && input.name) l.name = input.name; return { ok: true }; }
      case 'mcp-tv-search-symbols': return { symbols: clone((cfg.tvSearch || {})[input.query] || []) };
    }
    return null;
  }
  const mcp = { callTool: async (server, tool, input) => { await delay(window.__tvDelay || 0);
    if(cfg.tv){ const r = tvCall(tool, input); if(r !== null) return { payload: r }; }
    if(tool === 'mcp-tv-search-symbols') return { payload: { data: { symbols: [{ symbol: 'NSE:' + String(input.query).replace(/\W/g, '').toUpperCase(), exchange: 'NSE', description: String(input.query) }] } } };
    if(tool === 'mcp-tv-get-symbol-data-batch'){ (window.__tvBatchCalls = window.__tvBatchCalls || []).push(clone(input)); const data = {}, missing = []; for(const sym of input.symbols){ if(/NOTV|ALPHATWO/.test(sym)) missing.push({ symbol: sym, reason: 'not found' }); else data[sym] = { close: 111.1, 'MACD.macd|1W': 2, 'MACD.signal|1W': 1, 'MACD.macd|1M': 3, 'MACD.signal|1M': 1, 'RSI|1W': 60, 'RSI|1M': 58, 'change|1W': 1.5, 'change|1M': 4, 'average_volume_30d_calc': 50000 }; } return { payload: { count: Object.keys(data).length, data, missing, missing_count: missing.length, success: true } }; }
    if(tool === 'mcp-tv-get-symbol-data'){ (window.__tvSymbolCalls = window.__tvSymbolCalls || []).push(clone(input)); return { payload: { data: window.__tvQuote ? clone(window.__tvQuote) : { close: 123.4 } } }; }   // a test can set window.__tvQuote to the whole answer
    if(tool === 'mcp-tv-get-ohlcv'){ if(window.__tvWeekClose != null && input.interval === '1W'){ (window.__tvWeekCalls = window.__tvWeekCalls || []).push(input.symbol); const e0 = Date.parse('2026-10-05T00:00:00Z') / 1000; return { payload: { bars: { t: [e0 - 7 * 86400, e0, e0 + 7 * 86400], o: [1, 1, 1], h: [1, 1, 1], l: [1, 1, 1], c: [50, window.__tvWeekClose, 999], v: [1, 1, 1] } } }; } if(window.__tvMonthClose != null && input.interval === '1mo'){ (window.__tvMonthCalls = window.__tvMonthCalls || []).push(input.symbol); const m = x => Date.UTC(2026, x, 1) / 1000; return { payload: { bars: { t: [m(7), m(8), m(9)], o: [1, 1, 1], h: [1, 1, 1], l: [1, 1, 1], c: [50, window.__tvMonthClose, 999], v: [1, 1, 1] } } }; } const step = input.interval === '1W' ? 7 * 86400 : 30 * 86400, n = Math.min(input.count || 100, 300), end = Date.parse('2026-10-05T00:00:00Z') / 1000; const b = { t: [], o: [], h: [], l: [], c: [], v: [] }; for(let i = 0; i < n; i++){ const px = 100 + i * 0.5 + (i % 5); b.t.push(end - (n - 1 - i) * step); b.o.push(px); b.c.push(px + 1); b.h.push(px + 2); b.l.push(px - 1); b.v.push(1000 + i); } return { payload: { bars: b } }; }
    return { payload: { data: { blob: 'y'.repeat(6000), tool } } }; } };
  const assets = cfg.assets ? {
    upload: async blob => { const text = await blob.text(); if(window.__uploadDelay) await new Promise(r => setTimeout(r, window.__uploadDelay)); const id = 'asset' + (uploads.length + 1); uploads.push(id); await window.__blobPut(id, text); return { id, url: '/_blob/' + id, sizeBytes: new Blob([text]).size, contentType: blob.type }; },
    delete: async id => { await window.__blobDel(id); window.__deletedAssets.push(id); }
  } : null;
  const user = { id: async () => cfg.noUser ? null : 'u_SMOKE', isOwner: () => cfg.owner !== false };
  const stubs = { mcp: cfg.noMcp ? null : mcp, sample: async () => ({ text: '{}' }), permissions: { state: async () => 'granted', request: async () => ({}), manage: async () => {} }, assets, user };
  window.__gets = gets; window.__sets = sets; window.__uploads = uploads; window.__deletedAssets = [];
  window.__setDoc = (p, d) => { store.set(p, clone(d)); notify(p); }; window.__store = store; window.__seedReady = seedP;
  if(!cfg.noClaude) window.claude = { use: async name => name === 'db' ? db : (name in stubs ? stubs[name] : null) };
  if(cfg.slowDbAfterApp && window.claude){
    // the db capability takes a while to arrive once the app has started, as it can in the real runtime.
    // The start-up sequence (src/boot) puts the stock list on window.__alba as its last step, right before it loads the app.
    const inner = window.claude.use;
    window.claude.use = async name => { if(name === 'db' && window.__alba && window.__alba.stocks) await delay(cfg.slowDbAfterApp); return inner(name); };
  }
}

// ---- opening a page: the stand-in, an in-memory asset store behind /_blob/<id>, and error collection ----
async function openPage(ctx, base, cfg, label, errsOut){
  const page = await ctx.newPage();
  const errs = errsOut || [];
  page.blobs = new Map();
  page.on('pageerror', e => errs.push(label + ' pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error') errs.push(label + ' console.error: ' + m.text().slice(0, 300)); });
  await page.exposeFunction('__blobPut', (id, text) => { page.blobs.set(id, text); });
  await page.exposeFunction('__blobDel', id => { page.blobs.delete(id); });
  await page.route('**/_blob/*', route => { const id = route.request().url().split('/_blob/')[1]; const t = page.blobs.get(id); if(t == null) route.fulfill({ status: 404, body: 'not found' }); else route.fulfill({ status: 200, contentType: 'text/plain', body: t }); });
  await page.addInitScript(installStub, cfg);
  await page.goto(base + '/index.html');
  return { page, errs };
}

module.exports = { findPlaywright, startServer, installStub, openPage, root };
