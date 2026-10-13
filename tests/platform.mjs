// Contract tests for the platform layer: the document store must behave like the db the app was written against.
// Run: node tests/platform.js
import { createDocStore, createMemoryBackend } from '../platform/docstore.js';
import { installPlatform } from '../platform/shim.js';
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

console.log(fails ? fails + ' FAILED' : 'OK: platform contract tests pass');
process.exit(fails ? 1 : 0);
