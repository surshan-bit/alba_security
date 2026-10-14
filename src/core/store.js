// State backed by the shared database: the db handle, pins, the refresh queue, the upload and sync logs, the Trade Log.
//
// Everything mutable lives in the private `state` object (and the private records of each log) in this file,
// so no other module can reassign it. Other modules READ through the accessors and CHANGE it through the
// named actions exported below. There are no exported variables and no set_<name> setters.
// The one exported value that is not state is dbCapabilityPromise, a constant.

// `claude.use('db')` never resolves synchronously (see artifact-capabilities: "never within your script's first
// run"), so right after page load there is a short window in which no db handle exists yet. Started here, once,
// so that every module that needs the database awaits the SAME promise instead of asking again.
// Code that saves something (for example a pin clicked straight after the page loads) must wait for this promise
// rather than give up when getDb() is still null; otherwise the change looks saved on screen but is never written.
const dbCapabilityPromise = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function')
  ? claude.use('db').catch(() => null)
  : Promise.resolve(null);

const state = {
  db: null,                        // the shared database handle; null until the capability resolves, or when this view has none
  tradeDb: null,                   // the same handle, set only for a signed-in viewer (the Trade Log is per user)
  pinned: new Set(),               // tickers pinned to the top of the list (saved per user)
  refreshRequests: new Map(),      // sanitized ticker id -> {ticker, name, requestedAt}: stocks queued for a refresh
  tradeLog: new Map()              // doc id (`<TICKER>-<buy date ISO>`) -> trade record, with `_id` added
};

// ---- Database handles ----
// Every subsystem uses the same `db`; they are set together, when the capability resolves, by sync/subscriptions.js.
function getDb(){ return state.db; }
function attachDb(db){ state.db = db; }
function getTradeDb(){ return state.tradeDb; }
function attachTradeDb(db){ state.tradeDb = db; }

// ---- Pinned stocks ----
// Pins bubble a stock to the top of the list, independent of the filter and sort in use. They are saved per user
// through the db handle (see core/pins.js); without a db, or without a sign-in, they last for the current page load.
function isPinnedTicker(ticker){ return state.pinned.has(ticker); }
function togglePinnedTicker(ticker){
  if(state.pinned.has(ticker)) state.pinned.delete(ticker);
  else state.pinned.add(ticker);
}
// Replaces the pin list with the one just received from the database. Returns false, changing nothing, when it is
// the same list: the write made by togglePin() comes back as a snapshot with the same result, and that does not
// need the (full-list) re-render again.
function replacePinnedTickers(tickers){
  const next = new Set(tickers);
  if(next.size === state.pinned.size && [...next].every(t => state.pinned.has(t))) return false;
  state.pinned = next;
  return true;
}

// ---- Refresh requests ----
function getRefreshRequest(id){ return state.refreshRequests.get(id); }
function replaceRefreshRequests(next){ state.refreshRequests = next; }

// ---- Trade Log ----
// One document per real position taken from this dashboard's verdicts, in the signed-in user's own collection
// (tradeCol). Written by the "Add trade" form on the Trade Log page (tradelog/form.js) and by Claude when a
// trade is logged in a conversation. It exists to check "Strong" and "Good" verdicts against what a position
// bought at that verdict actually did, over time.
function getTrade(id){ return state.tradeLog.get(id); }
function allTrades(){ return Array.from(state.tradeLog.values()); }
function replaceTradeLog(next){ state.tradeLog = next; }

// ---- Upload and sync logs (Data Refresh page) ----
// A log keeps its records private and is changed only through put / remove:
//   fundamentalCsvUploadLog: one record per uploaded screener.in export, for the Fundamental Score import
//   technicalCsvUploadLog:   one record per uploaded TradingView Growth List, for the Technical Score import
//   watchlistSyncLog:        one record per TradingView watchlist sync run
// Each import reads the newest record whose status is 'uploaded' and marks it 'processed' when it finishes.
function createLog(){
  const records = new Map(); // doc id -> record
  return {
    put(id, record){ records.set(id, record); },
    remove(id){ records.delete(id); },
    entries(){ return Array.from(records.entries()); },
    values(){ return Array.from(records.values()); }
  };
}
const fundamentalCsvUploadLog = createLog();
const technicalCsvUploadLog = createLog();
const watchlistSyncLog = createLog();

export { allTrades, attachDb, attachTradeDb, dbCapabilityPromise, fundamentalCsvUploadLog, getDb, getRefreshRequest, getTrade, getTradeDb, isPinnedTicker, replacePinnedTickers, replaceRefreshRequests, replaceTradeLog, technicalCsvUploadLog, togglePinnedTicker, watchlistSyncLog };
