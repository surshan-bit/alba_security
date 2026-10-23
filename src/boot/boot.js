// The start-up sequence: stock list and (who is viewing -> saved preferences) side by side -> the app (page text is fetched when its page is first opened).
// The app (src/main.js) is imported last because its modules read the stock list and the saved preferences when they load.
import { loadStocks as loadStocksFromDatabase } from './stockdata.js';
import { debugHandle, setBootStocks } from './handoff.js';
import { init_identity_flush } from '../identity/flush.js';
import { loadIdentity, touchUser } from '../identity/session.js';
import { syncPrefs } from '../identity/prefs.js';
import { syncStrategies } from '../identity/strategies.js';

// Waits for `work`, but no longer than `ms` (a slow preference sync must not hold the page back).
function atMost(ms, work){
  let timer;
  return Promise.race([work, new Promise(r => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}

// deps.loadStocks replaces the database loader (the jsdom regression harness hands in its own sample list).
async function boot(deps){
  const loadStocks = (deps && deps.loadStocks) || loadStocksFromDatabase;
  init_identity_flush();
  // The stock list and the viewer's identity and saved preferences do not depend on each other, so they load side by side.
  // Who is viewing, then their saved preferences (they replace this browser's mirror before the app reads it).
  const identity = loadIdentity().then(() => {
    touchUser();
    return atMost(4000, Promise.all([syncPrefs(), syncStrategies()]));
  });
  identity.catch(() => {});   // a failure here must not go unhandled while the stock list loads; the await below reports it
  const list = await loadStocks();
  setBootStocks(list);
  await identity;
  debugHandle().stocks = list;
  await import('../main.js');
}

export { boot };
