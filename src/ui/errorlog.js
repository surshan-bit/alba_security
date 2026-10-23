// Records errors that happen on the page, so a crash in the real runtime (which the tests cannot reproduce) is not invisible.
// Each new error (once per page, capped) is kept in the viewer's own private record data/users/<uid>/clientErrors (the last 20, across
// visits) and the first one of a visit puts a notice in the bell. Saving is best effort and never throws, and this module's own
// failures are swallowed so it can never cause the loop it is there to report.
import { userRef } from '../identity/session.js';
import { activityNotify } from './activity.js';

const KEEP = 20, MAX_PER_PAGE = 30, SAVE_AFTER_MS = 3000;
const IGNORED = /ResizeObserver loop|^Script error\.?$/;   // browser noise that says nothing about the dashboard
const seen = new Set();   // message + place, so the same error is recorded once per page
let pending = [], timer = null, noticed = false, count = 0;

function record(msg, place){
  try {
    msg = String(msg || '').slice(0, 300);
    if(!msg || IGNORED.test(msg)) return;
    const key = msg + '|' + place;
    if(seen.has(key) || count >= MAX_PER_PAGE) return;
    seen.add(key); count++;
    const active = document.querySelector('.app-section.active'), badge = document.querySelector('.brand-version');
    pending.push({ when: new Date().toISOString(), msg, where: place || '', page: active ? active.id.replace(/^section-/, '') : '', version: badge ? badge.textContent : '' });
    if(!timer) timer = setTimeout(save, SAVE_AFTER_MS);
    if(!noticed){
      noticed = true;
      activityNotify({ tone: 'warn', title: 'Something went wrong on this page', text: msg.slice(0, 140) + ' It was recorded. If a page looks wrong, reload it and tell Claude.' });
    }
  } catch(e){ /* the error log must never raise an error of its own */ }
}

async function save(){
  timer = null;
  const batch = pending; pending = [];
  try {
    const ref = userRef('data/users/{uid}/clientErrors');
    if(!ref || !batch.length) return;
    const snap = await ref.get();
    const before = snap && snap.exists && Array.isArray((snap.data() || {}).errors) ? snap.data().errors : [];
    await ref.set({ v: 1, updatedAt: new Date().toISOString(), errors: before.concat(batch).slice(-KEEP) });
  } catch(e){ /* best effort: the notice in the bell has already been shown */ }
}

function init_ui_errorlog(){
  window.addEventListener('error', (e) => record(e.message || (e.error && e.error.message), (e.filename ? e.filename.split('/').pop() : '') + ':' + (e.lineno || 0)));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; record('Unhandled rejection: ' + ((r && r.message) || r), ''); });
}

export { init_ui_errorlog };
