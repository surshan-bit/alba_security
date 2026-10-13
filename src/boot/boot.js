// The start-up sequence: stock list -> who is viewing -> saved preferences -> page text -> the app.
// The app (src/main.js) is imported last because its modules read the stock list and the saved preferences when they load.
import { loadStocks as loadStocksFromDatabase } from './stockdata.js';
import { debugHandle, setBootStocks } from './handoff.js';
import { ensurePartial } from './partials.js';
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
  const list = await loadStocks();
  setBootStocks(list);
  // Who is viewing, then their saved preferences (they replace this browser's mirror before the app reads it).
  await loadIdentity();
  touchUser();
  await atMost(4000, Promise.all([syncPrefs(), syncStrategies()]));
  // Static page text is filled into the empty <section data-partial="..."> elements before the app code runs.
  await Promise.all(Array.from(document.querySelectorAll('section[data-partial]')).map(ensurePartial));
  debugHandle().stocks = list;
  await import('../main.js');
}

export { boot };
