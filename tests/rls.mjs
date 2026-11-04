// Database tests: the real supabase/schema.sql and the numbered migrations run on a throw-away PostgreSQL server, and each case acts as one
// kind of user (owner, free, pro, trial, expired trial, a second free user, anyone not signed in). Supabase's own pieces (auth, storage)
// are small stand-ins in tests/rls/standins.sql, so this proves the rules written in our SQL, not Supabase's services.
// Run: npm run rls.   No PostgreSQL on the machine: skipped, unless RLS_REQUIRED=1 (CI sets it), then it fails.
// RLS_SUPABASE_DIR=<folder> runs the same cases against a changed copy of supabase/ (used to check that these tests catch a weakened rule).
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startPostgres } from './lib/pgtemp.mjs';

const SUPABASE = process.env.RLS_SUPABASE_DIR || fileURLToPath(new URL('../supabase/', import.meta.url));
const STANDINS = fileURLToPath(new URL('./rls/standins.sql', import.meta.url));
const DOC_LIMIT_BYTES = 1048576;   // public.doc_size_ok
const DOC_ROW_LIMIT = 10000;   // public.doc_row_limit: most documents one user may keep
const JSON_FRAME = '{"a": ""}'.length;   // what jsonb adds around one string value when it is written out as text
const U = {   // one id per kind of user
  owner: '00000000-0000-0000-0000-0000000000a1', free: '00000000-0000-0000-0000-0000000000b2', pro: '00000000-0000-0000-0000-0000000000c3',
  trial: '00000000-0000-0000-0000-0000000000d4', expired: '00000000-0000-0000-0000-0000000000e5', other: '00000000-0000-0000-0000-0000000000f6'
};
let checks = 0;
const failures = [];
const eq = (name, actual, expected) => { checks++; if(JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(name + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); };

const pg = startPostgres();
if(!pg){
  if(process.env.RLS_REQUIRED === '1'){ console.error('rls tests FAILED: PostgreSQL is required here (RLS_REQUIRED=1) but was not found'); process.exit(1); }
  console.log('rls tests skipped: no PostgreSQL programs found (set PG_BIN, or install postgresql)');
  process.exit(0);
}

// ---- running SQL as a user
const sqlAs = (db, who, sql) => {
  const role = who === 'anon' ? 'anon' : 'authenticated';
  return pg.run(db, `set role ${role}; select set_config('request.uid', '${who === 'anon' ? '' : U[who]}', false); ${sql}`);
};
const value = (db, who, sql) => { const r = sqlAs(db, who, sql); return r.ok ? r.out.split('\n').pop() : ''; };   // a refused statement has no value
const allowed = (db, who, sql) => sqlAs(db, who, sql).ok;
const count = (db, who, sql) => Number(value(db, who, `with r as (${sql} returning 1) select count(*) from r`));   // rows an insert / update / delete really touched
const visible = (db, who) => value(db, who, `select coalesce(string_agg(path, ',' order by path collate "C"), '-') from public.docs`);
const asServer = (db, sql) => { const r = pg.run(db, sql); if(!r.ok) throw new Error(r.err); return r.out; };
const bigDoc = (extra = 0) => `jsonb_build_object('a', repeat('x', ${DOC_LIMIT_BYTES - JSON_FRAME + extra}))`;

// ---- building the database
function build(db, withMigrations){
  pg.createDb(db);
  for(const file of [STANDINS, join(SUPABASE, 'schema.sql'), join(SUPABASE, 'schema.sql')]){ const r = pg.runFile(db, file); eq(db + ': ' + file.split('/').pop() + ' runs without errors', r.ok ? '' : r.err, ''); }
  if(withMigrations){
    const files = readdirSync(SUPABASE).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
    eq(db + ': the numbered migrations are found', files.length >= 7, true);
    for(const f of [...files, ...files]){ const r = pg.runFile(db, join(SUPABASE, f)); eq(db + ': ' + f + ' can run again', r.ok ? '' : r.err, ''); }
  }
  seed(db);
}

function seed(db){
  const users = Object.entries(U).map(([name, id]) => `('${id}', '${name}@example.test')`).join(', ');
  asServer(db, `insert into auth.users values ${users};
    update public.profiles set role = 'owner' where uid = '${U.owner}';
    update public.profiles set plan = 'free' where uid in ('${U.free}', '${U.other}');
    update public.profiles set plan = 'pro', pro_until = now() + interval '30 days' where uid = '${U.pro}';
    update public.profiles set trial_end = now() - interval '1 day' where uid = '${U.expired}';
    insert into public.docs (path, data) values ('stockMeta/main', '{}'), ('stockUpdates/u1', '{}'), ('stockData/a', '{}'), ('stockResearch/r', '{}'), ('priceHistory/p', '{}'), ('priceHistory1D/p', '{}'),
      ('data/users/${U.free}/prefs', '{}'), ('data/users/${U.other}/prefs', '{}'), ('users/${U.free}', '{}'), ('users/${U.other}', '{}')`);
}

// ---- the cases
const FREE_SHARED = ['stockMeta/main', 'stockUpdates/u1'];
const PRO_SHARED = ['priceHistory/p', 'priceHistory1D/p', 'stockData/a', 'stockResearch/r'];
const list = paths => paths.slice().sort().join(',');

function readCases(db){
  const own = (who) => [`data/users/${U[who]}/prefs`, `users/${U[who]}`];
  eq(db + ': free user reads the free stock data and their own documents only', visible(db, 'free'), list([...FREE_SHARED, ...own('free')]));
  eq(db + ': a second free user sees their own, not the first one\'s', visible(db, 'other'), list([...FREE_SHARED, ...own('other')]));
  eq(db + ': a trial user also reads the Pro stock data', visible(db, 'trial'), list([...FREE_SHARED, ...PRO_SHARED]));
  eq(db + ': a pro user also reads the Pro stock data', visible(db, 'pro'), list([...FREE_SHARED, ...PRO_SHARED]));
  eq(db + ': an expired trial is back to the free stock data', visible(db, 'expired'), list(FREE_SHARED));
  eq(db + ': the owner reads all stock data and every user record, but nobody\'s private documents', visible(db, 'owner'), list([...FREE_SHARED, ...PRO_SHARED, `users/${U.free}`, `users/${U.other}`]));
  eq(db + ': someone not signed in reads nothing', allowed(db, 'anon', 'select count(*) from public.docs'), false);
}

function writeCases(db){
  const shared = "update public.docs set data = '{\"x\": 1}' where path = 'stockMeta/main'";
  eq(db + ': a free user cannot change shared stock data', count(db, 'free', shared), 0);
  eq(db + ': a free user cannot delete shared stock data', count(db, 'free', "delete from public.docs where path = 'stockMeta/main'"), 0);
  eq(db + ': a free user cannot add shared stock data', allowed(db, 'free', "insert into public.docs (path, data) values ('stockMeta/new', '{}')"), false);
  eq(db + ': a pro user cannot change shared stock data either', count(db, 'pro', "update public.docs set data = '{}' where path = 'stockData/a'"), 0);
  eq(db + ': the owner can change and add shared stock data', [count(db, 'owner', "update public.docs set data = '{}' where path = 'stockData/a'"), allowed(db, 'owner', "insert into public.docs (path, data) values ('stockData/b', '{}')")], [1, true]);
  const mine = `data/users/${U.free}`, theirs = `data/users/${U.other}`;
  eq(db + ': a user writes and removes their own documents', [allowed(db, 'free', `insert into public.docs (path, data) values ('${mine}/pins', '{}')`), count(db, 'free', `delete from public.docs where path = '${mine}/pins'`)], [true, 1]);
  eq(db + ': a user cannot write under another user\'s path', allowed(db, 'free', `insert into public.docs (path, data) values ('${theirs}/x', '{}')`), false);
  eq(db + ': a user cannot change or delete another user\'s documents', [count(db, 'free', `update public.docs set data = '{"x": 1}' where path = '${theirs}/prefs'`), count(db, 'free', `delete from public.docs where path = '${theirs}/prefs'`)], [0, 0]);
  eq(db + ': the owner cannot write into users\' private documents', allowed(db, 'owner', `insert into public.docs (path, data) values ('${theirs}/x', '{}')`), false);
  eq(db + ': a user changes their own record but not another\'s', [count(db, 'free', `update public.docs set data = '{"v": 1}' where path = 'users/${U.free}'`), count(db, 'free', `update public.docs set data = '{"v": 1}' where path = 'users/${U.other}'`)], [1, 0]);
  eq(db + ': a user cannot create a record for someone else', allowed(db, 'free', "insert into public.docs (path, data) values ('users/00000000-0000-0000-0000-000000000099', '{}')"), false);
}

function mergeCases(db){
  eq(db + ': merging into your own document works and keeps the other fields', [allowed(db, 'free', `select public.docs_merge('data/users/${U.free}/prefs', '{"y": 2}')`), value(db, 'free', `select data::text from public.docs where path = 'data/users/${U.free}/prefs'`)], [true, '{"y": 2}']);
  eq(db + ': merging into shared stock data is refused for a free user', allowed(db, 'free', `select public.docs_merge('stockMeta/main', '{"hack": 1}')`), false);
  eq(db + ': and left the document as it was', asServer(db, "select data::text from public.docs where path = 'stockMeta/main'"), '{}');
}

function profileCases(db){
  eq(db + ': signing up gives a profile: user, on a 15-day trial', asServer(db, `select plan || role || (trial_end > now() + interval '14 days' and trial_end < now() + interval '16 days')::text from public.profiles where uid = '${U.trial}'`), 'trialusertrue');
  eq(db + ': a user sees only their own profile', value(db, 'free', 'select count(*) from public.profiles'), '1');
  for(const who of ['free', 'owner']){
    eq(db + ': ' + who + ' cannot promote themselves', allowed(db, who, `update public.profiles set role = 'owner', plan = 'pro' where uid = '${U[who]}'`), false);
    eq(db + ': ' + who + ' cannot add or remove profiles', [allowed(db, who, `insert into public.profiles (uid, email) values ('${U.other}', 'x')`), allowed(db, who, `delete from public.profiles where uid = '${U[who]}'`)], [false, false]);
  }
  eq(db + ': who is owner and who has Pro', ['owner', 'free', 'pro', 'trial', 'expired'].map(w => value(db, w, 'select public.is_owner()::text || public.has_pro()::text')), ['truetrue', 'falsefalse', 'falsetrue', 'falsetrue', 'falsefalse']);
}

function sizeCases(db){
  const mine = `data/users/${U.free}`, insertBig = (path, extra) => `insert into public.docs (path, data) values ('${path}', ${bigDoc(extra)})`;
  eq(db + ': a document exactly at the size limit is stored, one byte more is not', [allowed(db, 'free', insertBig(mine + '/big', 0)), allowed(db, 'free', insertBig(mine + '/big2', 1))], [true, false]);
  eq(db + ': growing a document past the limit is refused, by update and by merge', [count(db, 'free', `update public.docs set data = ${bigDoc(1)} where path = '${mine}/big'`), allowed(db, 'free', `select public.docs_merge('${mine}/big', '{"b": "y"}')`)], [0, false]);
  const record = size => count(db, 'other', `update public.docs set data = ${bigDoc(size)} where path = 'users/${U.other}'`);
  eq(db + ': the user record has the same limit', [record(1), record(0)], [0, 1]);
  eq(db + ': the owner\'s shared stock data has no size limit', allowed(db, 'owner', "insert into public.docs (path, data) values ('priceHistory/big', jsonb_build_object('a', repeat('x', 3000000)))"), true);
}

function quotaCases(db){
  eq(db + ': the owner may call Claude twice in the limit, the third is refused', [1, 2, 3].map(() => value(db, 'owner', "select public.take_sample_slot(2, interval '1 hour')::text")), ['true', 'true', 'false']);
  eq(db + ': someone who is not the owner gets no slot', value(db, 'free', "select public.take_sample_slot(2, interval '1 hour')::text"), 'false');
  eq(db + ': the usage table is not readable by clients', ['anon', 'owner', 'free'].map(who => allowed(db, who, 'select * from public.sample_usage')), [false, false, false]);
  asServer(db, `update public.sample_usage set window_start = now() - interval '2 hours' where uid = '${U.owner}'`);
  eq(db + ': a new window starts when the old one has run out', value(db, 'owner', "select public.take_sample_slot(2, interval '1 hour')::text"), 'true');
}

function functionCases(db){
  const definers = asServer(db, "select string_agg(proname, ',' order by proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and prosecdef and coalesce(array_to_string(proconfig, ','), '') <> 'search_path=\"\"'");
  eq(db + ': every security-definer function has an empty search path', definers, '');
  for(const fn of ['public.is_owner()', 'public.has_pro()', 'public.on_new_user()', 'public.take_sample_slot(integer, interval)'])
    eq(db + ': anon cannot run ' + fn, asServer(db, `select has_function_privilege('anon', '${fn}', 'execute')::text`), 'false');
  eq(db + ': signed-in users can run the checks the row rules call', ['public.is_owner()', 'public.has_pro()'].map(fn => asServer(db, `select has_function_privilege('authenticated', '${fn}', 'execute')::text`)), ['true', 'true']);
}

function storageCases(db){
  eq(db + ': the file bucket is private, CSV only, 10 MiB', asServer(db, "select public::text || file_size_limit || allowed_mime_types::text from storage.buckets where id = 'assets'"), 'false10485760{text/csv}');
  const put = (who, bucket, name) => allowed(db, who, `insert into storage.objects (bucket_id, name) values ('${bucket}', '${name}')`);
  eq(db + ': a user stores a file in their own folder only', [put('free', 'assets', U.free + '/f.csv'), put('free', 'assets', U.other + '/f.csv'), put('free', 'public', U.free + '/f.csv')], [true, false, false]);
  eq(db + ': another user cannot see that file, its owner can', [value(db, 'other', 'select count(*) from storage.objects'), value(db, 'free', 'select count(*) from storage.objects')], ['0', '1']);
  eq(db + ': someone not signed in cannot touch files', allowed(db, 'anon', 'select count(*) from storage.objects'), false);
}

function realtimeCases(db){
  eq(db + ': Realtime publishes only docs, inserts and updates, never deletes', asServer(db, "select (select string_agg(schemaname || '.' || tablename, ',') from pg_publication_tables where pubname = 'supabase_realtime') || ' ' || pubinsert || pubupdate || pubdelete from pg_publication where pubname = 'supabase_realtime'"), 'public.docs truetruefalse');
}

function rowCapCases(db){
  const base = `data/users/${U.trial}`, stored = () => Number(asServer(db, `select coalesce((select n from public.doc_counts where uid = '${U.trial}'), 0)`));
  const put = (who, path) => allowed(db, who, `insert into public.docs (path, data) values ('${path}', '{}')`);
  asServer(db, `insert into public.docs (path, data) select '${base}/bulk/' || g, '{}' from generate_series(1, ${DOC_ROW_LIMIT}) g`);
  eq(db + ': a user can keep exactly the most documents, and they are counted', stored(), DOC_ROW_LIMIT);
  eq(db + ': one document more is refused', put('trial', base + '/extra'), false);
  eq(db + ': rewriting or merging into an existing document still works at the limit', [allowed(db, 'trial', `insert into public.docs (path, data) values ('${base}/bulk/1', '{"v": 1}') on conflict (path) do update set data = excluded.data`), allowed(db, 'trial', `select public.docs_merge('${base}/bulk/2', '{"v": 2}')`), stored()], [true, true, DOC_ROW_LIMIT]);
  eq(db + ': deleting a document frees a place', [count(db, 'trial', `delete from public.docs where path = '${base}/bulk/3'`), stored(), put('trial', base + '/extra'), stored()], [1, DOC_ROW_LIMIT - 1, true, DOC_ROW_LIMIT]);
  eq(db + ': nobody but the triggers can read or change the counters', ['anon', 'trial', 'owner'].map(who => allowed(db, who, 'select count(*) from public.doc_counts')), [false, false, false]);
  eq(db + ': the user record, other users and the owner\'s shared data are not held back', [put('trial', 'users/' + U.trial), put('pro', `data/users/${U.pro}/x`), put('owner', 'stockData/c'), stored()], [true, true, true, DOC_ROW_LIMIT]);
}

// The counters are kept by triggers, so after everything above they must still equal the real number of documents of each user.
function counterCases(db){
  eq(db + ': every user\'s counter equals their real number of documents', asServer(db, `select count(*) from (select public.doc_owner(path) as uid, count(*) as c from public.docs where public.doc_owner(path) is not null group by 1) a
    full join public.doc_counts d on d.uid = a.uid where coalesce(a.c, 0) <> coalesce(d.n, 0)`), '0');
}

function runCases(db){
  for(const group of [readCases, writeCases, mergeCases, profileCases, sizeCases, quotaCases, functionCases, storageCases, realtimeCases, rowCapCases, counterCases]) group(db);
}

try {
  build('fresh', false);
  runCases('fresh');
  build('migrated', true);
  runCases('migrated');
} catch(e){ failures.push('crashed: ' + (e && e.message || e)); }
finally { pg.stop(); }

if(failures.length){ console.error('rls tests FAILED (' + failures.length + ' of ' + checks + ' checks):\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('rls tests: ' + checks + ' checks passed');
