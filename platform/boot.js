// The website's front door: runs before the app. No signed-in Gmail account -> a sign-in screen; signed in -> the app starts
// with window.claude backed by Supabase (platform/shim.js), exactly the interface the app was written against.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, OWNER_EMAIL } from './config.js';
import { createSupabaseBackend } from './supabase-backend.js';
import { installPlatform, supabaseUser, supabaseAssets } from './shim.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });

function showSignIn(message){
  const cover = document.getElementById('bootStatus'); if(cover) cover.hidden = true;
  const box = document.createElement('div');
  box.id = 'albaSignIn';
  box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#121210;color:#f2efe6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;z-index:99999;padding:16px';
  box.innerHTML = '<div style="max-width:360px;width:100%;text-align:center"><div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;opacity:.65">Alba Securities</div>'
    + '<h1 style="font-size:26px;margin:10px 0 8px;font-weight:600">Stock Analyzer</h1>'
    + '<p style="opacity:.75;margin:0 0 26px;line-height:1.5">Sign in with your Gmail account to open your dashboard.</p>'
    + '<button id="albaGoogle" type="button" style="width:100%;padding:13px 16px;border-radius:10px;border:0;background:#3fa56b;color:#fff;font-size:16px;font-weight:600;cursor:pointer">Continue with Google</button>'
    + '<p id="albaSignInMsg" style="color:#e8a0a0;min-height:20px;margin:16px 0 0;font-size:14px"></p></div>';
  document.body.appendChild(box);
  const msg = box.querySelector('#albaSignInMsg'); if(message) msg.textContent = message;
  box.querySelector('#albaGoogle').addEventListener('click', async () => {
    msg.textContent = '';
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if(error) msg.textContent = 'Could not start sign-in: ' + error.message;
  });
}

// Owner-only: open  <site>/#import  to load a data file (made by the export tool) into the database. Uses the owner's own
// sign-in, so no secret key is involved; the database refuses everyone else (row-level security).
async function showImport(){
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#121210;color:#f2efe6;font-family:system-ui,sans-serif;z-index:99999;padding:24px';
  box.innerHTML = '<div style="max-width:560px;margin:40px auto"><h1 style="font-size:22px">Import stock data (owner only)</h1>'
    + '<p style="opacity:.75;line-height:1.5">Choose the data file (<b>alba-data.json.gz</b>) and press Import. Existing documents with the same name are replaced.</p>'
    + '<input id="impFile" type="file" accept=".gz,.json" style="margin:14px 0;display:block">'
    + '<button id="impGo" type="button" style="padding:11px 18px;border-radius:9px;border:0;background:#3fa56b;color:#fff;font-size:15px;font-weight:600;cursor:pointer">Import</button>'
    + '<pre id="impLog" style="white-space:pre-wrap;margin-top:18px;font-size:13px;line-height:1.5"></pre></div>';
  document.body.appendChild(box);
  const log = (t) => { box.querySelector('#impLog').textContent = t; };
  const { data: prof } = await sb.from('profiles').select('role').maybeSingle();
  if(!prof || prof.role !== 'owner'){ log('This page is for the owner account only.'); box.querySelector('#impGo').disabled = true; return; }
  box.querySelector('#impGo').addEventListener('click', async () => {
    const f = box.querySelector('#impFile').files[0]; if(!f){ log('Choose the file first.'); return; }
    try {
      log('Reading the file...');
      const text = f.name.endsWith('.gz') ? await new Response(f.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await f.text();
      const parsed = JSON.parse(text);
      if(parsed.format !== 'alba-docs-v1') throw new Error('This is not an Alba data file.');
      // a settings file names the person as "me": it lands under the signed-in account
      const { data: ses } = await sb.auth.getSession(), uid = ses.session.user.id;
      const entries = Object.entries(parsed.docs).map(([p, d]) => [p.startsWith('data/users/me/') ? 'data/users/' + uid + p.slice('data/users/me'.length) : p, d]);
      let done = 0, batch = [], size = 0;
      const flush = async () => {
        if(!batch.length) return;
        const { error } = await sb.from('docs').upsert(batch);
        if(error) throw new Error(error.message);
        done += batch.length; batch = []; size = 0; log('Imported ' + done + ' of ' + entries.length + ' documents...');
      };
      for(const [path, data] of entries){
        const n = JSON.stringify(data).length;
        if(size + n > 1500000 && batch.length) await flush();
        batch.push({ path, data }); size += n;
      }
      await flush();
      log('Done: ' + done + ' documents imported. Open the site (without #import) to see your dashboard.');
    } catch(e){ log('Stopped: ' + (e && e.message || e)); }
  });
}

(async () => {
  const { data, error } = await sb.auth.getSession();
  if(location.search.includes('code=') || location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
  if(error || !data.session){ showSignIn(error ? error.message : ''); return; }
  if(location.hash === '#import'){ showImport(); return; }
  window.albaSignOut = async () => { await sb.auth.signOut(); location.reload(); };
  installPlatform({ backend: createSupabaseBackend(sb), user: supabaseUser(sb, OWNER_EMAIL), assets: supabaseAssets(sb) });
  // app.js sits next to this file; the build id keeps a new release from being served out of an old cache
  const url = new URL('app.js?v=' + __ALBA_BUILD__, import.meta.url).href;
  await import(url);
})();
