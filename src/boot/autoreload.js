// Reloads this page by itself when a newer version of the dashboard has been published.
// The release record appMeta/release ({ build, version }) is written to the database after each publish; this page compares its own
// build id (the ?v= on its script) with it. The reload waits until nothing is running (imports, refreshes) and no text is being typed,
// so nothing in progress is interrupted. Never more than one automatic reload per build: if the new files do not arrive, a banner with a
// Reload button is shown instead.
import { dbCapabilityPromise } from '../core/store.js';
import { anyBusy } from '../core/busy.js';

const RELOAD_DELAY_MS = 1200;   // the notice of a new version is shown this long before the page reloads
const CHECK_INTERVAL_MS = 5000;   // how often the page asks whether a new version was published

const KEY = 'albaAutoReload';
const myBuild = () => {
  const s = document.querySelector('script[data-entry]');
  const m = s && /[?&]v=([0-9a-f]+)/.exec(s.getAttribute('data-entry') || '');
  return m ? m[1] : null;
};
const tried = () => { try { return window.sessionStorage.getItem(KEY); } catch(e){ return null; } };
const markTried = (b) => { try { window.sessionStorage.setItem(KEY, b); } catch(e){ /* the banner is the fallback */ } };
const typing = () => {
  const a = /** @type {HTMLInputElement | null} */ (document.activeElement);
  return !!(a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox' && a.type !== 'radio' && a.type !== 'button')) && a.value && a.id !== 'globalSearch');
};

function notice(text, withButton){
  let b = document.getElementById('appUpdateBanner');
  if(!b){
    b = document.createElement('div');
    b.id = 'appUpdateBanner';
    b.className = 'toast-banner';
    document.body.appendChild(b);
  }
  b.textContent = text + ' ';
  if(withButton){
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Reload now';
    btn.className = 'toast-banner__btn';
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
    setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
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
    timer = setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => { if(!document.hidden) check(); });
  })();
  void timer;
}

export { init_boot_autoreload };
