// The website's front door: runs before the app. No signed-in Gmail account -> a sign-in screen; signed in -> the app starts
// with window.claude backed by Supabase (platform/shim.js), exactly the interface the app was written against.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, OWNER_EMAIL } from './config.js';
import { createSupabaseBackend } from './supabase-backend.js';
import { buildImportPage, buildSignInPage } from './gate.js';
import { installPlatform, supabaseUser, supabaseAssets, claudeSample } from './shim.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });

function showSignIn(message){
  const cover = document.getElementById('bootStatus'); if(cover) cover.hidden = true;
  const { page, button, message: msg } = buildSignInPage(document);
  document.body.appendChild(page);
  if(message) msg.textContent = message;
  button.addEventListener('click', async () => {
    msg.textContent = '';
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if(error) msg.textContent = 'Could not start sign-in: ' + error.message;
  });
}

// Owner-only: open  <site>/#import  to load a data file (made by the export tool) into the database. Uses the owner's own
// sign-in, so no secret key is involved; the database refuses everyone else (row-level security).
async function showImport(){
  const { page, file, button, log: logBox } = buildImportPage(document);
  document.body.appendChild(page);
  const log = (t) => { logBox.textContent = t; };
  const { data: prof } = await sb.from('profiles').select('role').maybeSingle();
  if(!prof || prof.role !== 'owner'){ log('This page is for the owner account only.'); button.disabled = true; return; }
  button.addEventListener('click', async () => {
    const f = file.files[0]; if(!f){ log('Choose the file first.'); return; }
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
  // Refreshes are for the owner only (the server functions check this again): everyone else gets none of that machinery.
  const { data: me } = await sb.from('profiles').select('role').maybeSingle();
  const owner = !!me && me.role === 'owner';
  installPlatform({ backend: createSupabaseBackend(sb), user: supabaseUser(sb, OWNER_EMAIL), assets: supabaseAssets(sb), sample: owner ? claudeSample(sb) : null });
  // app.js sits next to this file; the build id keeps a new release from being served out of an old cache
  const url = new URL('app.js?v=' + __ALBA_BUILD__, import.meta.url).href;
  await import(url);
})();
