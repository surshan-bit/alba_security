// Per-user preferences. localStorage stays as a fast per-browser mirror (the page's head script reads the theme from it to
// avoid a flash); when someone is signed in the preferences are also saved to their own record, and that record wins when
// the page opens (see syncPrefs).
import { PREFS_LOCAL_AT_KEY, PREFS_OWNER_KEY, PREF_FIELDS, STRAT_AT_KEY, STRAT_KEY, UISTATE_KEY } from './keys.js';
import { getUid, userRef } from './session.js';

function prefsObject(){
  const o = { v: 1 };
  for(const k of Object.keys(PREF_FIELDS)){
    const [field, kind] = PREF_FIELDS[k];
    let raw = null;
    try { raw = localStorage.getItem(k); } catch(e){ /* storage unavailable: no saved value */ }
    if(raw == null) continue;
    try { o[field] = kind === 'json' ? JSON.parse(raw) : raw; } catch(e){ /* a saved value that does not parse is ignored */ }
  }
  return o;
}
let prefTimer = null, prefChain = Promise.resolve();
function prefWrite(){
  const ref = userRef('data/users/{uid}/prefs');
  if(!ref) return;
  const o = prefsObject(); o.updatedAt = new Date().toISOString();
  prefChain = prefChain.then(() => ref.set(o)).catch(e => console.error('Could not save preferences', e));
}
// Writes any pending change right away (called when the page is hidden, closed or refreshed).
function flushPrefs(){
  if(!prefTimer) return;
  clearTimeout(prefTimer); prefTimer = null;
  prefWrite();
}
// The one way the app saves a preference: always the browser mirror, and (when signed in) the user's own record.
function prefSet(key, value){
  try { localStorage.setItem(key, value); localStorage.setItem(PREFS_LOCAL_AT_KEY, new Date().toISOString()); } catch(e){ /* storage unavailable */ }
  if(!userRef('data/users/{uid}/prefs')) return;
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => { prefTimer = null; prefWrite(); }, 600);
}

// Screen state (last section, Analysis selection and panels).
// Saved through the same preference path as everything else, merged into one small record.
let uiTimer = null, uiPending = {};
function uiStateGet(){
  try { const r = localStorage.getItem(UISTATE_KEY); const o = r ? JSON.parse(r) : null; return (o && typeof o === 'object') ? o : {}; } catch(e){ return {}; }
}
function flushUiState(){
  if(!uiTimer) return;
  clearTimeout(uiTimer); uiTimer = null;
  const next = Object.assign(uiStateGet(), uiPending); uiPending = {};
  prefSet(UISTATE_KEY, JSON.stringify(next));
}
function uiStateSet(patch, delay){
  Object.assign(uiPending, patch);
  clearTimeout(uiTimer);
  uiTimer = setTimeout(flushUiState, delay == null ? 400 : delay);
}

// Runs once before the app starts: the saved preferences replace this browser's mirror, so the app's normal
// load-time reads pick them up. A first-time user with no saved record seeds it from this browser's settings.
async function syncPrefs(){
  const ref = userRef('data/users/{uid}/prefs');
  if(!ref) return;
  try {
    const prev = localStorage.getItem(PREFS_OWNER_KEY);
    if(prev && prev !== getUid()){ for(const k of Object.keys(PREF_FIELDS)) localStorage.removeItem(k); localStorage.removeItem(PREFS_LOCAL_AT_KEY); localStorage.removeItem(STRAT_KEY); localStorage.removeItem(STRAT_AT_KEY); }  // another person used this browser
    localStorage.setItem(PREFS_OWNER_KEY, getUid());
  } catch(e){ /* storage unavailable: nothing to compare with */ }
  try {
    const snap = await ref.get();
    const d = snap && snap.exists ? snap.data() : null;
    // If this browser holds a newer change than the saved record (the page was refreshed before the save finished),
    // keep the browser's copy and send it to the database instead of overwriting it with the older one.
    let localAt = 0; try { localAt = Date.parse(localStorage.getItem(PREFS_LOCAL_AT_KEY)) || 0; } catch(e){ /* storage unavailable: counts as never saved here */ }
    const dbAt = d ? (Date.parse(d.updatedAt) || 0) : 0;
    if(d && localAt > dbAt){
      const o = prefsObject(); o.updatedAt = new Date().toISOString();
      const t = o.theme; if(t === 'light' || t === 'indigo' || t === 'white' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
      await ref.set(o);
      return;
    }
    if(d){
      for(const k of Object.keys(PREF_FIELDS)){
        const [field, kind] = PREF_FIELDS[k];
        if(d[field] === undefined) continue;
        try { localStorage.setItem(k, kind === 'json' ? JSON.stringify(d[field]) : String(d[field])); } catch(e){ /* storage unavailable: the copy in the database still applies */ }
      }
      if(d.theme === 'light' || d.theme === 'indigo' || d.theme === 'white' || d.theme === 'dark') document.documentElement.setAttribute('data-theme', d.theme);
    } else {
      const o = prefsObject();
      if(Object.keys(o).length > 1){ o.updatedAt = new Date().toISOString(); await ref.set(o); }
    }
  } catch(e){ console.error('Could not load preferences', e); }
}

export { flushPrefs, flushUiState, prefSet, syncPrefs, uiStateGet, uiStateSet };
