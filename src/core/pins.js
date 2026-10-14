// Pinned stocks: reading, toggling and saving the pin list.
import { stocks } from './stocks.js';
import { dbCapabilityPromise, getDb, isPinnedTicker, togglePinnedTicker } from './store.js';
import { getShownIndex, rerenderDetail } from '../detail/render.js';
import { pinsRef, userRef } from '../identity/session.js';

// Saves run one after another, so the last click is the last write.
let pinWriteChain = Promise.resolve();

function isPinned(s){
  return isPinnedTicker(s.ticker);
}

// Where a pin change came from: build, device and screen. Also kept as a short history (data/users/<uid>/pinAudit, last 40 changes).
function changeInfo(action, ticker, nBefore, nAfter, at){
  const sc = document.querySelector('script[data-entry]');
  const m = sc && /[?&]v=([0-9a-f]+)/.exec(sc.getAttribute('data-entry') || '');
  const sec = document.querySelector('.app-section.active');
  return { at, action, ticker, before: nBefore, after: nAfter, build: m ? m[1] : null, screen: sec ? sec.id.replace('section-', '') : null,
    visible: document.visibilityState, device: /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'phone' : 'desktop' };
}
async function appendAudit(entry){
  try {
    const ref = userRef('data/users/{uid}/pinAudit');
    if(!ref) return;
    const cur = await ref.get();
    const d = cur && cur.exists ? cur.data() : null;
    const log = (d && Array.isArray(d.log) ? d.log : []).concat([entry]).slice(-40);
    await ref.set({ log });
  } catch(e){ /* the history is optional */ }
}

let pinWritesPending = 0;
const pinWritesInFlight = () => pinWritesPending > 0;

// Saves ONE change (add or remove a ticker) against the list stored in the database, not this page's copy of the whole
// list. A page whose list had not loaded yet, or an older tab, can therefore never wipe the pins saved from elsewhere.
async function persistPin(ticker, add){
  // Wait for the db capability when it has not resolved yet, rather than give up: a pin clicked right after the
  // page loads must still be saved.
  const db = getDb() || await dbCapabilityPromise;
  if(!db) return; // capability genuinely unavailable/declined — pins stay session-only, as documented
  pinWritesPending++;
  pinWriteChain = pinWriteChain
    .then(async () => {
      const ref = pinsRef(db);   // per user; without a sign-in pins stay session-only
      if(!ref) return;
      const cur = await ref.get();
      const d = cur && cur.exists ? cur.data() : null;
      const before = d && Array.isArray(d.tickers) ? d.tickers : [];
      const set = new Set(before);
      if(add) set.add(ticker); else set.delete(ticker);
      const at = new Date().toISOString();
      const who = changeInfo(add ? 'pin' : 'unpin', ticker, before.length, set.size, at);
      // The date and origin of the latest change are stored with the list, so a later surprise can be traced to a build and a device.
      await ref.set({ tickers: Array.from(set), updatedAt: at, lastChange: who });
      await appendAudit(who);
    })
    .catch(err => console.error('Failed to save pinned stocks', err))
    .finally(() => { pinWritesPending--; });
}

function togglePin(ticker){
  const add = !isPinnedTicker(ticker);
  togglePinnedTicker(ticker);
  persistPin(ticker, add);
  const s = stocks[getShownIndex()];
  if(s && s.ticker === ticker) rerenderDetail();
}

export { isPinned, pinWritesInFlight, togglePin };
