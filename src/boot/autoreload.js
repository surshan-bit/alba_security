// Reloads this page by itself when a newer version of the dashboard has been published.
// The release record appMeta/release ({ build, version }) is written to the database after each publish; this page compares its own
// build id (the ?v= on its script) with it. The reload waits until nothing is running (imports, refreshes) and no text is being typed,
// so nothing in progress is interrupted. Never more than one automatic reload per build: if the new files do not arrive, a banner with a
// Reload button is shown instead.
import { dbCapabilityPromise } from '../core/store.js';
import { anyBusy } from '../core/busy.js';

const KEY = 'albaAutoReload';
const myBuild = () => {
  const s = document.querySelector('script[data-entry]');
  const m = s && /[?&]v=([0-9a-f]+)/.exec(s.getAttribute('data-entry') || '');
  return m ? m[1] : null;
};
const tried = () => { try { return window.sessionStorage.getItem(KEY); } catch(e){ return null; } };
const markTried = (b) => { try { window.sessionStorage.setItem(KEY, b); } catch(e){ /* the banner is the fallback */ } };
const typing = () => {
  const a = document.activeElement;
  return !!(a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox' && a.type !== 'radio' && a.type !== 'button')) && a.value && a.id !== 'globalSearch');
};

function notice(text, withButton){
  let b = document.getElementById('appUpdateBanner');
  if(!b){
    b = document.createElement('div');
    b.id = 'appUpdateBanner';
    b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:90;background:var(--panel);color:var(--text);border:1px solid var(--accent);border-radius:10px;padding:10px 14px;display:flex;gap:12px;align-items:center;font:600 .85rem -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);';
    document.body.appendChild(b);
  }
  b.textContent = text + ' ';
  if(withButton){
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Reload now';
    btn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-weight:700;cursor:pointer;';
    btn.addEventListener('click', () => window.location.reload());
    b.appendChild(btn);
  }
}

function init_boot_autoreload(){
  const mine = myBuild();
  if(!mine) return;
  let latest = null, timer = null;
  const check = () => {
    if(!latest || latest === mine) return;
    if(tried() === latest){ notice('A new version is available.', true); return; }   // already reloaded once for it: do not loop
    if(anyBusy() || typing()){ notice('A new version is ready. It loads when the current work finishes.', false); return; }
    markTried(latest);
    notice('Updating to the new version…', false);
    setTimeout(() => window.location.reload(), 1200);
  };
  (async () => {
    let db = null;
    try { db = await dbCapabilityPromise; } catch(e){ db = null; }
    if(!db) return;
    try {
      db.doc('appMeta/release').onSnapshot((snap) => {
        const d = snap && snap.exists ? snap.data() : null;
        latest = d && typeof d.build === 'string' ? d.build : null;
        check();
      }, () => {});
    } catch(e){ return; }
    timer = setInterval(check, 5000);
    document.addEventListener('visibilitychange', () => { if(!document.hidden) check(); });
  })();
  void timer;
}

export { init_boot_autoreload };
