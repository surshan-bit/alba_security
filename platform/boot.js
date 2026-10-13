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

(async () => {
  const { data, error } = await sb.auth.getSession();
  if(location.search.includes('code=') || location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
  if(error || !data.session){ showSignIn(error ? error.message : ''); return; }
  window.albaSignOut = async () => { await sb.auth.signOut(); location.reload(); };
  installPlatform({ backend: createSupabaseBackend(sb), user: supabaseUser(sb, OWNER_EMAIL), assets: supabaseAssets(sb) });
  // app.js sits next to this file; the build id keeps a new release from being served out of an old cache
  const url = new URL('app.js?v=' + __ALBA_BUILD__, import.meta.url).href;
  await import(url);
})();
