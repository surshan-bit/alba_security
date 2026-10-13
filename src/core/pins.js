// Pinned stocks: reading, toggling and saving the pin list.
import { stocks } from './stocks.js';
import { dbCapabilityPromise, getDb, isPinnedTicker, pinnedTickerList, togglePinnedTicker } from './store.js';
import { getShownIndex, rerenderDetail } from '../detail/render.js';
import { pinsRef } from '../identity/session.js';

// Saves run one after another, so the last click is the last write.
let pinWriteChain = Promise.resolve();

function isPinned(s){
  return isPinnedTicker(s.ticker);
}

async function persistPins(){
  // Wait for the db capability when it has not resolved yet, rather than give up: a pin clicked right after the
  // page loads must still be saved.
  const db = getDb() || await dbCapabilityPromise;
  if(!db) return; // capability genuinely unavailable/declined — pins stay session-only, as documented
  const arr = pinnedTickerList();
  pinWriteChain = pinWriteChain
    .then(() => { const ref = pinsRef(db); return ref ? ref.set({ tickers: arr }) : null; })  // per user; without a sign-in pins stay session-only
    .catch(err => console.error('Failed to save pinned stocks', err));
}

function togglePin(ticker){
  togglePinnedTicker(ticker);
  persistPins();
  const s = stocks[getShownIndex()];
  if(s && s.ticker === ticker) rerenderDetail();
}

export { isPinned, togglePin };
