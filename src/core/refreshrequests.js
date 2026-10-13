// Queued "request refresh" documents for a stock.
import { getDb } from './store.js';
import { sanitizeDocId, tickerSymbol } from './util.js';

async function requestRefresh(s){
  const db = getDb();
  if(!db) return;
  const sym = tickerSymbol(s);
  const id = sanitizeDocId(sym);
  try {
    await db.collection('refreshRequests').doc(id).set({
      ticker: sym,
      name: s.name,
      requestedAt: new Date().toISOString()
    });
  } catch(e){
    console.error('Failed to queue refresh request', e);
  }
}

async function cancelRefreshRequest(id){
  const db = getDb();
  if(!db) return;
  try {
    await db.collection('refreshRequests').doc(id).delete();
  } catch(e){
    console.error('Failed to cancel refresh request', e);
  }
}

export { cancelRefreshRequest, requestRefresh };
