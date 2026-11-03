// Contract tests for the platform layer: the document store must behave like the db the app was written against.
// Run: node tests/platform.js
import { createDocStore, createMemoryBackend } from '../platform/docstore.js';
import { installPlatform } from '../platform/shim.js';
import { corsHeaders } from '../supabase/functions/_shared/cors.ts';
import { readPrompt, MAX_PROMPT_CHARS } from '../supabase/functions/_shared/prompt.ts';
import { allowedMethod, quotaConfig, quotaDecision, DEFAULT_MAX_CALLS, DEFAULT_WINDOW_MINUTES } from '../supabase/functions/_shared/guard.ts';
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
  eq('schema: the file bucket is created private', /values \('assets', 'assets', false,/.test(schema) && /set public = false/.test(schema) && !/'assets', 'assets', true/.test(schema), true);
  eq('migration for existing projects makes it private', /update storage\.buckets set public = false where id = 'assets'/.test(readFileSync(new URL('../supabase/003_private_assets.sql', import.meta.url), 'utf8')), true);
  // The bucket accepts only what the app uploads (CSV files, see src/import/upload-history.js) and caps their size (CLAUDE.md section 3, A04).
  const LIMIT_BYTES = 10485760, limits = readFileSync(new URL('../supabase/004_assets_limits.sql', import.meta.url), 'utf8');
  const uploader = readFileSync(new URL('../src/import/upload-history.js', import.meta.url), 'utf8');
  eq('schema: the bucket caps the size of a file', schema.includes("file_size_limit") && schema.includes(String(LIMIT_BYTES)), true);
  eq('schema: the bucket accepts only CSV files', /allowed_mime_types[^;]*array\['text\/csv'\]/.test(schema), true);
  eq('schema: a re-run keeps the limits in force', /on conflict \(id\) do update set public = false, file_size_limit = \d+, allowed_mime_types = array\['text\/csv'\]/.test(schema), true);
  eq('migration for existing projects sets the same limits', limits.includes('file_size_limit = ' + LIMIT_BYTES) && /allowed_mime_types = array\['text\/csv'\]/.test(limits) && /where id = 'assets'/.test(limits), true);
  eq('the app uploads CSV text, which the bucket accepts', /new Blob\(\[text\], \{ type: 'text\/csv' \}\)/.test(uploader), true);
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

// Reading the prompt of a request to the Claude function: any malformed body is a clean 400/413, never a crash
{
  const bad = body => { const r = readPrompt(body); return 'status' in r ? r.status : 0; };
  eq('prompt: a plain prompt is accepted', readPrompt({ prompt: 'hello' }), { prompt: 'hello' });
  for(const body of [null, undefined, 7, 'text', true, [], ['prompt'], {}, { prompt: '' }, { prompt: 5 }, { prompt: null }, { prompt: { a: 1 } }]) eq('prompt: ' + JSON.stringify(body) + ' is a 400', bad(body), 400);
  eq('prompt: the longest allowed prompt passes', bad({ prompt: 'a'.repeat(MAX_PROMPT_CHARS) }), 0);
  eq('prompt: one character too many is a 413', bad({ prompt: 'a'.repeat(MAX_PROMPT_CHARS + 1) }), 413);
  eq('prompt: the error carries a code and a user-safe message', readPrompt(null), { code: 'invalid_request', message: 'Bad request.', status: 400 });
}

// Guards in front of the Claude function: method, a per-owner call quota (counted in the database) and what a failed count means
{
  eq('guard: POST is allowed', allowedMethod('POST'), true);
  for(const m of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'post', '']) eq('guard: ' + (m || 'empty method') + ' is refused', allowedMethod(m), false);
  eq('quota: defaults when nothing is set', quotaConfig(undefined, undefined), { maxCalls: DEFAULT_MAX_CALLS, windowMinutes: DEFAULT_WINDOW_MINUTES });
  eq('quota: secrets are read as whole numbers', quotaConfig('50', '10'), { maxCalls: 50, windowMinutes: 10 });
  for(const bad of ['', 'abc', '0', '-5', '1.5', '1e3', 'NaN', '99999999']) eq('quota: "' + bad + '" falls back to the default', quotaConfig(bad, bad), { maxCalls: DEFAULT_MAX_CALLS, windowMinutes: DEFAULT_WINDOW_MINUTES });
  eq('quota: a counted call inside the limit is allowed', quotaDecision({ data: true, error: null }), 'allowed');
  eq('quota: a refused slot is limited', quotaDecision({ data: false, error: null }), 'limited');
  for(const r of [{ data: null, error: { message: 'x' } }, { data: true, error: { message: 'x' } }, { data: null, error: null }, { data: 'true', error: null }, { data: 1, error: null }]) eq('quota: ' + JSON.stringify(r) + ' fails closed', quotaDecision(r), 'unavailable');
}
{
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'), mig = readFileSync(new URL('../supabase/005_sample_quota.sql', import.meta.url), 'utf8');
  for(const [name, sql] of [['schema', schema], ['migration', mig]]){
    eq(name + ': the usage table has row level security and no policy', /alter table public\.sample_usage enable row level security/.test(sql) && !/on public\.sample_usage/.test(sql), true);
    eq(name + ': the slot function is owner-only, with an empty search path', /function public\.take_sample_slot\([^)]*\)[\s\S]*?security definer set search_path = ''[\s\S]*?is_owner\(\)/.test(sql), true);
    eq(name + ': only signed-in users may run it', /revoke all on function public\.take_sample_slot\(integer, interval\) from public, anon/.test(sql) && /grant execute on function public\.take_sample_slot\(integer, interval\) to authenticated/.test(sql), true);
    eq(name + ': the table is not readable by clients', !/grant [^;]*sample_usage/.test(sql), true);
  }
}

// The three security-definer functions run with an empty search path and are not callable by the public (CLAUDE.md section 3)
{
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'), mig = readFileSync(new URL('../supabase/006_definer_search_path.sql', import.meta.url), 'utf8');
  for(const [name, sql] of [['schema', schema], ['migration', mig]]){
    for(const fn of ['on_new_user', 'is_owner', 'has_pro']){
      eq(name + ': ' + fn + ' is security definer with an empty search path', new RegExp('function public\\.' + fn + '\\(\\)[^;]*?security definer set search_path = \'\' as').test(sql), true);
      eq(name + ': ' + fn + ' is not callable by the public or anon', new RegExp('revoke all on function public\\.' + fn + '\\(\\) from public, anon').test(sql), true);
    }
    for(const fn of ['is_owner', 'has_pro']) eq(name + ': ' + fn + ' stays callable by signed-in users (the row-level rules call it)', new RegExp('grant execute on function public\\.' + fn + '\\(\\) to authenticated').test(sql), true);
    eq(name + ': no definer function keeps search_path = public', !/security definer set search_path = public/.test(sql), true);
  }
}

// Every numbered migration can be run again: a policy is dropped before it is created, so a second run does not stop with "already exists"
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../supabase/', import.meta.url);
  const files = readdirSync(dir).filter(f => /^\d{3}_.*\.sql$/.test(f));
  eq('migrations: the numbered files are found', files.length >= 5, true);
  for(const f of files){
    const sql = readFileSync(new URL(f, dir), 'utf8');
    for(const m of sql.matchAll(/^create policy (\w+) on ([\w.]+)/gm)) eq(f + ': policy ' + m[1] + ' is dropped first', new RegExp('drop policy if exists ' + m[1] + ' on ' + m[2].replace('.', '\\.') + ';\\s*create policy ' + m[1] + ' on').test(sql), true);
  }
}

// Server functions import packages by exact version from the npm registry, never from a mutable URL (CLAUDE.md section 3, A06 and A08),
// and the version is the one package.json pins for the browser, so there is a single version to review
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../supabase/functions/', import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter(f => String(f).endsWith('.ts'));
  const pinned = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies['@supabase/supabase-js'];
  eq('functions: the server function files are found', files.length >= 5, true);
  for(const f of files){
    const src = readFileSync(new URL(f, root), 'utf8');
    eq(f + ': no import from a web address', /^\s*(import|export)[^\n]*from\s+['"]https?:/m.test(src), false);
    for(const m of src.matchAll(/from\s+'npm:(@?[^@']+(?:\/[^@']+)?)@([^'/]+)[^']*'/g)) eq(f + ': ' + m[1] + ' is pinned to an exact version', /^\d+\.\d+\.\d+$/.test(m[2]), true);
  }
  const owner = readFileSync(new URL('_shared/owner.ts', root), 'utf8');
  eq('functions: owner.ts imports supabase-js from npm at the version package.json pins', owner.includes("from 'npm:@supabase/supabase-js@" + pinned + "'"), true);
}

// A signed-in user cannot store a document bigger than 1 MiB under their own paths (CLAUDE.md section 3, A04); the one number lives in doc_size_ok
{
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'), mig = readFileSync(new URL('../supabase/007_doc_size_limit.sql', import.meta.url), 'utf8');
  for(const [name, sql] of [['schema', schema], ['migration', mig]]){
    eq(name + ': doc_size_ok caps a document at 1 MiB, with an empty search path', /function public\.doc_size_ok\(d jsonb\)[^;]*?immutable[^;]*?set search_path = ''[^;]*?octet_length\(d::text\) <= 1048576/.test(sql), true);
    for(const policy of ['own_docs_all', 'own_user_record']) eq(name + ': ' + policy + ' checks the size of what is written', new RegExp('create policy ' + policy + ' on public\\.docs[\\s\\S]*?with check \\([^;]*public\\.doc_size_ok\\(data\\)\\);').test(sql), true);
    eq(name + ': the owner\'s shared-data policy is not size-capped', !/create policy shared_write_owner[^;]*doc_size_ok/.test(sql), true);
  }
}

// Security headers: the Cloudflare site must ship the file that sets them
{
  const { readFileSync } = await import('node:fs');
  const h = readFileSync(new URL('../platform/_headers', import.meta.url), 'utf8');
  for(const line of ['Strict-Transport-Security: max-age=31536000', 'X-Frame-Options: DENY', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: strict-origin-when-cross-origin']) eq('headers: ' + line, h.includes(line), true);
}

console.log(fails ? fails + ' FAILED' : 'OK: platform contract tests pass');
process.exit(fails ? 1 : 0);
