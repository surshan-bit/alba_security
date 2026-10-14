// Pinned stocks: reading, toggling and saving the pin list.
import { stocks } from './stocks.js';
import { dbCapabilityPromise, getDb, isPinnedTicker, togglePinnedTicker } from './store.js';
import { getShownIndex, rerenderDetail } from '../detail/render.js';
import { pinsRef } from '../identity/session.js';

// Saves run one after another, so the last click is the last write.
let pinWriteChain = Promise.resolve();

function isPinned(s){
  return isPinnedTicker(s.ticker);
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
      const set = new Set(d && Array.isArray(d.tickers) ? d.tickers : []);
      if(add) set.add(ticker); else set.delete(ticker);
      await ref.set({ tickers: Array.from(set) });
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
