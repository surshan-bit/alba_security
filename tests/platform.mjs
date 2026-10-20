// Contract tests for the platform layer: the document store must behave like the db the app was written against.
// Run: node tests/platform.js
import { createDocStore, createMemoryBackend } from '../platform/docstore.js';
import { installPlatform } from '../platform/shim.js';
import { corsHeaders } from '../supabase/functions/_shared/cors.ts';
let fails = 0;
const eq = (name, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if(!ok){ fails++; console.log('FAIL', name, JSON.stringify(a), '!=', JSON.stringify(b)); } };
const tick = () => new Promise(r => setTimeout(r, 5));

const be = createMemoryBackend({ 'stockMeta/main': { version: 1 }, 'priceHistory/a1': { ticker: 'AAA', n: 2 }, 'priceHistory/a2': { ticker: 'BBB', n: 1 }, 'priceHistory/a3': { ticker: 'AAA', n: 3 } });
const db = createDocStore(be);

// doc get / set / update / delete
let s = await db.doc('x/y').get(); eq('missing doc', [s.exists, s.data(), s.id], [false, undefined, 'y']);
await db.doc('x/y').set({ a: 1, b: { c: 2 } }); s = await db.doc('x/y').get(); eq('set', [s.exists, s.data()], [true, { a: 1, b: { c: 2 } }]);
await db.doc('x/y').update({ a: 5 }); eq('update merges', (await db.doc('x/y').get()).data(), { a: 5, b: { c: 2 } });
await db.doc('x/new').update({ k: 1 }); eq('update creates', (await db.doc('x/new').get()).data(), { k: 1 });
const d = (await db.doc('x/y').get()).data(); d.a = 99; eq('data() is a copy', (await db.doc('x/y').get()).data().a, 5);
await db.doc('x/y').delete(); eq('delete', (await db.doc('x/y').get()).exists, false);

// nested collections
await db.doc('data/users/u1/prefs').set({ theme: 'dark' }); await db.doc('data/users/u1').collection('portfolio').doc('t1').set({ q: 1 });
eq('nested path', (await db.doc('data/users/u1').collection('portfolio').doc('t1').get()).data(), { q: 1 });
eq('collection lists only its children', (await db.collection('data/users/u1/portfolio').get()).size, 1);

// collection get + where
const all = await db.collection('priceHistory').get(); eq('col size', [all.size, all.empty], [3, false]);
const q = await db.collection('priceHistory').where('ticker', '==', 'AAA').get(); eq('where ==', q.docs.map(x => x.id).sort(), ['a1', 'a3']);
const ids = []; q.forEach(x => ids.push(x.id)); eq('forEach', ids.sort(), ['a1', 'a3']);
eq('orderBy+limit', (await db.collection('priceHistory').orderBy('n', 'desc').limit(2).get()).docs.map(x => x.id), ['a3', 'a1']);
eq('empty result', (await db.collection('priceHistory').where('ticker', '==', 'ZZZ').get()).empty, true);

// listeners: first call with current state, again on change, silent after unsubscribe
const seen = []; const off = db.doc('live/doc').onSnapshot(sn => seen.push(sn.exists ? sn.data().v : null));
await tick(); await db.doc('live/doc').set({ v: 1 }); await tick(); await db.doc('live/doc').update({ v: 2 }); await tick(); off(); await db.doc('live/doc').set({ v: 3 }); await tick();
eq('doc listener', seen, [null, 1, 2]);
const csz = []; const off2 = db.collection('lc').onSnapshot(sn => csz.push(sn.size));
await tick(); await db.doc('lc/a').set({}); await tick(); await db.doc('lc/b').set({}); await tick(); await db.doc('other/z').set({}); await tick(); off2();
eq('collection listener', csz, [0, 1, 2]);

// listeners under load (v1.185): a burst of saves must not cause a full re-read each, and the screen must end on the newest data
{
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const seed = {}; for(let i = 0; i < 500; i++) seed['big/S' + i] = { ticker: 'S' + i, v: 0 };
  const b = createMemoryBackend(seed); let lists = 0; const realList = b.list;
  b.list = async (p) => { lists++; const out = await realList(p); await sleep(15); return out; };   // a read takes a little while, like a real database
  const d2 = createDocStore(b); const got = [];
  const stop = d2.collection('big').onSnapshot(sn => got.push(sn.docs.find(x => x.id === 'S0').data().v));
  await sleep(40); const before = lists;
  for(let i = 1; i <= 100; i++){ await d2.doc('big/S0').update({ v: i }); }   // 100 quick saves, one after the other
  await sleep(700);
  eq('burst: far fewer full reads than saves', (lists - before) < 25, true);
  eq('burst: the last thing shown is the newest', got[got.length - 1], 100);
  eq('burst: nothing is shown out of order', got.every((v, i) => i === 0 || v >= got[i - 1]), true);
  stop(); const n = got.length; await d2.doc('big/S0').update({ v: 101 }); await sleep(100); eq('burst: silent after unsubscribe', got.length, n);
}
{
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const b = createMemoryBackend({ 'c/a': { v: 1 } }); let n = 0; const realList = b.list;
  b.list = async (p) => { const mine = ++n; const rows = await realList(p); await sleep(mine === 1 ? 80 : 5); return rows; };   // the first read is slow
  const d2 = createDocStore(b); const seen = [];
  d2.collection('c').onSnapshot(sn => seen.push(sn.docs[0].data().v));
  await sleep(1); await d2.doc('c/a').set({ v: 2 }); await sleep(500);
  eq('slow older read cannot leave the screen on old data', seen[seen.length - 1], 2);
  eq('slow older read: never goes back to an older value', seen.every((v, i) => i === 0 || v >= seen[i - 1]), true);
}
{
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const b = createMemoryBackend({ 'k/one': { v: 1 } }); const d2 = createDocStore(b); const got = [];
  d2.doc('k/one').onSnapshot(sn => got.push(sn.data().v));
  await sleep(10); for(let i = 2; i <= 6; i++) await d2.doc('k/one').set({ v: i }); await sleep(50);
  eq('single document: ends on the newest value', got[got.length - 1], 6);
}

// the shim: claude.use never answers synchronously; unknown names answer null; db is present
const host = {}; installPlatform({ backend: be, user: { id: async () => 'u', isOwner: () => false } }, host);
const p = host.claude.use('db'); eq('use returns a promise', typeof p.then, 'function');
eq('db present', !!(await p).doc, true); eq('unknown capability', await host.claude.use('nothing'), null);
eq('user', await (await host.claude.use('user')).id(), 'u'); eq('mcp absent', await host.claude.use('mcp'), null);
eq('permissions default', await (await host.claude.use('permissions')).state(), 'granted');

// Claude calls: both call styles reach the server function; its error codes come through; progress text is passed on
import { claudeSample } from '../platform/shim.js';
const calls = []; const sbOk = { functions: { invoke: async (n, o) => { calls.push([n, o.body]); return { data: { text: '{"a":1}' }, error: null }; } } };
const ask = claudeSample(sbOk); const prog = [];
eq('sample string style', (await ask('hello', { modelTier: 'quick', onText: t => prog.push(t) })).text, '{"a":1}');
eq('sample object style', (await ask({ prompt: 'hi', modelTier: 'default' })).text, '{"a":1}');
eq('sample body', calls, [['sample', { prompt: 'hello', modelTier: 'quick' }], ['sample', { prompt: 'hi', modelTier: 'default' }]]); eq('sample progress', prog, ['{"a":1}']);
const sbBad = { functions: { invoke: async () => ({ data: null, error: { message: 'x', context: { json: async () => ({ code: 'rate_limited', message: 'slow down' }) } } }) } };
let caught = null; try { await claudeSample(sbBad)('p'); } catch(e){ caught = e; }
eq('sample error code', [caught && caught.code, caught && caught.message], ['rate_limited', 'slow down']);

// file storage is private: no public link, files come back through read() with the person's own access
import { supabaseAssets } from '../platform/shim.js';
import { readFileSync } from 'node:fs';
{
  const log = [];
  const sb = { auth: { getSession: async () => ({ data: { session: { user: { id: 'U1' } } } }) },
    storage: { from: (bucket) => ({
      upload: async (path, blob, o) => { log.push(['upload', bucket, path.startsWith('U1/'), o.contentType]); return { error: null }; },
      getPublicUrl: () => { log.push(['PUBLIC LINK ASKED FOR']); return { data: { publicUrl: 'https://x/public' } }; },
      download: async (path) => path === 'U1/ok' ? { data: new Blob(['a,b\n1,2']), error: null } : { data: null, error: { message: 'Object not found' } },
      remove: async (ids) => { log.push(['remove', ids]); return { error: null }; } }) } };
  const a = supabaseAssets(sb);
  const up = await a.upload(new Blob(['hello'], { type: 'text/csv' }));
  eq('upload: stored in the signed-in person\'s folder, no public link', [log[0], up.url, up.id.startsWith('U1/'), up.sizeBytes], [['upload', 'assets', true, 'text/csv'], null, true, 5]);
  eq('upload: a public link is never requested', log.some(x => x[0] === 'PUBLIC LINK ASKED FOR'), false);
  const r = await a.read('U1/ok'); eq('read: a fetch-style answer', [r.ok, r.status, await r.text()], [true, 200, 'a,b\n1,2']);
  const miss = await a.read('U1/gone'); eq('read: a missing file answers 404 like /_blob/', [miss.ok, miss.status], [false, 404]);
  await a.delete('U1/ok'); eq('delete', log[log.length - 1], ['remove', ['U1/ok']]);
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  eq('schema: the file bucket is created private', /values \('assets', 'assets', false\)/.test(schema) && /set public = false/.test(schema) && !/'assets', 'assets', true/.test(schema), true);
  eq('migration for existing projects makes it private', /update storage\.buckets set public = false where id = 'assets'/.test(readFileSync(new URL('../supabase/003_private_assets.sql', import.meta.url), 'utf8')), true);
}

// CORS for the private functions: only the listed pages are answered, never a wildcard
{
  const site = 'https://alba-test.surshan.workers.dev', other = 'https://evil.example';
  eq('cors: the test site is allowed by default', corsHeaders(site)['Access-Control-Allow-Origin'], site);
  eq('cors: another page gets no allow-origin header', corsHeaders(other)['Access-Control-Allow-Origin'], undefined);
  eq('cors: no Origin header (not a browser) gets none', corsHeaders(null)['Access-Control-Allow-Origin'], undefined);
  eq('cors: never a wildcard', corsHeaders(other, '*')['Access-Control-Allow-Origin'], undefined);
  eq('cors: a listed origin is echoed back', corsHeaders('https://b.example', ' https://a.example , https://b.example ')['Access-Control-Allow-Origin'], 'https://b.example');
  eq('cors: the answer varies by Origin', corsHeaders(site).Vary, 'Origin');
}

// Security headers: the Cloudflare site must ship the file that sets them
{
  const { readFileSync } = await import('node:fs');
  const h = readFileSync(new URL('../platform/_headers', import.meta.url), 'utf8');
  for(const line of ['X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: strict-origin-when-cross-origin']) eq('headers: ' + line, h.includes(line), true);
}

console.log(fails ? fails + ' FAILED' : 'OK: platform contract tests pass');
process.exit(fails ? 1 : 0);
