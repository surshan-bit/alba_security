// Share links and opening a stock from the page address.
import { stocks } from '../core/stocks.js';
import { tickerSymbol } from '../core/util.js';
import { appSections, showSection } from './navigation.js';
import { openStockInline } from './inlinedetail.js';
import { closestEl } from '../core/evt.js';

// ---- Deep link to a stock (added 2026-10-06) ----
// A link such as <artifact URL>#OCCLLTD (or ?stock=OCCLLTD) opens that stock's detail view.
// The code is the stock's ticker symbol; a stock's exact name (e.g. "OCCL") also works. The page
// looks in its own address, and in the address of the page that embeds it when the browser allows.
const ARTIFACT_BASE_URL = 'https://claude.ai/artifact/VbEn1ocnjxCGFL9Bz9S5Wh';
function stockCodeFromHash(){
  const read = (loc) => {
    try{
      const h = String(loc.hash || '').replace(/^#\/?/, '');
      if(h) return decodeURIComponent(h.replace(/^stock=/i, ''));
      const q = new URLSearchParams(loc.search || '');
      return q.get('stock') || q.get('s') || '';
    }catch(e){ return ''; }
  };
  let code = read(window.location);
  if(!code){ try{ if(window.top && window.top !== window) code = read(window.top.location); }catch(e){ /* a parent page on another site cannot be read */ } }
  return String(code || '').trim();
}
// The page address does not always reach the page (it runs inside the artifact frame), so a link opened in a new tab also
// leaves a short-lived note in this site's storage, which the new tab reads once at start-up.
const HANDOFF_KEY = 'alba.openStock', HANDOFF_TTL_MS = 30000, bootId = Math.random().toString(36).slice(2);
function leaveHandoff(code){ try{ localStorage.setItem(HANDOFF_KEY, JSON.stringify({ code, from: bootId, at: Date.now() })); }catch(e){ /* storage unavailable: no hand-off */ } }
let launchHandoff;
function takeHandoff(){
  if(launchHandoff !== undefined) return launchHandoff;
  launchHandoff = '';
  try{
    const n = JSON.parse(localStorage.getItem(HANDOFF_KEY) || 'null');
    if(n && n.from !== bootId && Date.now() - n.at < HANDOFF_TTL_MS){ launchHandoff = String(n.code || ''); localStorage.removeItem(HANDOFF_KEY); }
  }catch(e){ /* an unreadable hand-off is ignored */ }
  return launchHandoff;
}
// A link's code stays in the address (of this page or of the page around it) after the stock is closed, so a refresh would
// reopen it. Each code is therefore acted on once per browser tab: once used (opened from a link, or shown by the app itself),
// a refresh ignores it and returns to the page you were last on.
const USED_KEY = 'alba.usedStockCode';
function codeUsed(code){ try{ return window.sessionStorage.getItem(USED_KEY) === code; }catch(e){ return false; } }
function markCodeUsed(code){ try{ window.sessionStorage.setItem(USED_KEY, code); }catch(e){ /* storage unavailable: the code may be used again */ } }
let launchCode;
function stockCodeFromAddress(){
  if(launchCode !== undefined) return launchCode;
  const h = stockCodeFromHash();
  launchCode = (h && !codeUsed(h)) ? h : takeHandoff();
  if(launchCode) markCodeUsed(launchCode);
  return launchCode;
}
function findStockByCode(code){
  const c = String(code || '').trim().toUpperCase().replace(/[_\s]+/g, '');
  if(!c) return -1;
  let idx = stocks.findIndex(s => tickerSymbol(s).toUpperCase().replace(/[_\s]+/g, '') === c);
  if(idx < 0) idx = stocks.findIndex(s => String(s.name).toUpperCase().replace(/[_\s]+/g, '') === c);
  return idx;
}
function openStockByCode(code){
  const idx = findStockByCode(code);
  if(idx < 0) return false;
  showSection('business');
  openStockInline(appSections.business, '', idx);
  return true;
}
function stockShareLink(s){ return ARTIFACT_BASE_URL + '#' + encodeURIComponent(tickerSymbol(s)); }
// Puts the open stock's code in the address bar; with no stock, clears it.
function syncStockHash(s){
  if(s) markCodeUsed(tickerSymbol(s));
  try{ if(window.history && history.replaceState) history.replaceState(history.state, '', s ? '#' + encodeURIComponent(tickerSymbol(s)) : location.pathname + location.search); }catch(e){ /* the address bar cannot be changed here */ }
}
function copyText(text){
  try{ if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text); }catch(e){ /* no clipboard access: falls back below */ }
  return new Promise((resolve, reject) => {
    try{
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); document.body.removeChild(ta);
      ok ? resolve(undefined) : reject(new Error('copy failed'));
    }catch(e){ reject(e); }
  });
}

function init_ui_deeplink(){
// The browser's Back / Forward between the app's own history entries also changes the address; those are handled by historyrestore.js.
window.addEventListener('hashchange', () => { if(history.state && history.state.alba) return; const c = stockCodeFromHash(); if(c) openStockByCode(c); });
// Stock names are real links, so right-click offers "Open link in new tab" (also Ctrl/Cmd/middle click). A plain click keeps opening the detail view in place.
const noteLink = e => { const a = e.target.closest && e.target.closest('a.stock-link'); if(a) leaveHandoff(decodeURIComponent(a.hash.replace(/^#/, ''))); };
document.addEventListener('contextmenu', noteLink, true);
document.addEventListener('auxclick', noteLink, true);
document.addEventListener('click', e => { if(e.ctrlKey || e.metaKey || e.shiftKey) noteLink(e); });
document.addEventListener('click', e => { const a = /** @type {Element} */ (e.target).closest && closestEl(e, 'a.stock-link'); if(a && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) e.preventDefault(); }, true);
(() => { const c = stockCodeFromAddress(); if(c) openStockByCode(c); })();

}

export { copyText, init_ui_deeplink, stockCodeFromAddress, stockShareLink, syncStockHash };
