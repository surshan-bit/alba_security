// Live database subscriptions (research, updates, triggers, pins, logs).
import { attachDb, attachTradeDb, dbCapabilityPromise, fundamentalCsvUploadLog, replacePinnedTickers, replaceTradeLog, watchlistSyncLog } from '../core/store.js';
import { refreshAnalysisSoon } from '../analysis/section.js';
import { setResearchTriggerKinds, setResearchTriggers } from '../research/status.js';
import { rerenderDetail } from '../detail/render.js';
import { applyResearchOverlay } from '../overlays/research.js';
import { applyRecentBarsOverlay, applySnapshotOverlay, applyTechBlocksOverlay, applyUpdatesOverlay } from '../overlays/updates.js';
import { applyTech2Overlay } from '../overlays/techscore2.js';
import { pinsRef, tradeCol } from '../identity/session.js';
import { pinWritesInFlight } from '../core/pins.js';
import { renderLoadedPart } from '../core/lazy.js';
import { setNewsChangeHook, startNewsSync } from '../news/store.js';

// A listener that fails is started again after a pause that grows with each try, up to this many times, so a slow start or a dropped connection does not
// leave a screen empty until the page is reloaded.
const WATCH_RETRIES = 5, WATCH_PAUSE_MS = 3000;
const TRADE_RETRIES = 4, TRADE_PAUSE_MS = 2000;
// The biggest record set (about 14 MB) is read after the first screen is up, so the launch is not spent downloading and processing it.
const BARS_DELAY_MS = 3000;

const sectionIsOpen = (id) => { const el = document.getElementById(id); return !!el && el.classList.contains('active'); };

// The saved news/events list marks stocks that have something coming up (grids, stock page), so it is read from the start, not only when News opens.
function watchNews(){
  setNewsChangeHook(() => {
    rerenderDetail();
    if(sectionIsOpen('section-analysis')) refreshAnalysisSoon();
    if(sectionIsOpen('section-strategies')) renderLoadedPart('strategies');
  });
  startNewsSync();
}

// ---- Pins. The saved list is read two ways so one failure cannot leave every star empty: the live listener (restarted after an
// error) and a one-time read at start-up that fills in if the listener has not delivered anything yet.
const pinSync = { heard: false };

function showPins(data){
  const arr = (data && Array.isArray(data.tickers)) ? data.tickers : [];
  // The write we just made via togglePin() already re-rendered optimistically; this snapshot fires
  // again once that write round-trips, with the same resulting set — replacePinnedTickers() reports
  // that as "no change", and the (expensive, full-list) re-render is skipped.
  if(!replacePinnedTickers(arr)) return;
  rerenderDetail();
  // Keep the Analysis section's pin highlighting/leaderboard order in sync too, if it's
  // the section currently open (e.g. a pin change arriving from another open tab/device).
  if(sectionIsOpen('section-analysis')) refreshAnalysisSoon();
}

function watchPins(db, attempt){
  const ref = pinsRef(db);
  if(!ref) return;   // not signed in: pins stay in this page only
  try {
    ref.onSnapshot(
      (snap) => {
        pinSync.heard = true;
        // While our own changes are still being saved, a snapshot may show an older list; the last one after they finish is right.
        if(pinWritesInFlight()) return;
        showPins(snap.data());
      },
      (err) => { console.error('Pin sync error', err); if(attempt < WATCH_RETRIES) setTimeout(() => watchPins(db, attempt + 1), WATCH_PAUSE_MS * (attempt + 1)); }
    );
  } catch(e){
    console.error('Pin persistence unavailable', e);
  }
}

function readPinsOnce(db){
  try {
    const ref = pinsRef(db);
    if(ref) ref.get().then((snap) => { if(!pinSync.heard && !pinWritesInFlight() && snap && snap.exists) showPins(snap.data()); }).catch((e) => console.error('Pins could not be read', e));
  } catch(e){ console.error('Pins could not be read', e); }
}

// ---- Collections. Each one is listened to and every snapshot is handed to `apply` as [{ id, data }]; `label` names it in the console.
function watchCollection(db, spec, attempt = 0){
  const { name, apply, label } = spec;
  try {
    db.collection(name).onSnapshot(
      (snap) => {
        const docs = [];
        snap.docs.forEach(d => { if(d.exists) docs.push({ id: d.id, data: d.data() }); });
        try { apply(docs); } catch(e){ console.error(label + ' could not be applied', e); }
      },
      (err) => { console.error(label + ' sync error', err); if(attempt < WATCH_RETRIES) setTimeout(() => watchCollection(db, spec, attempt + 1), WATCH_PAUSE_MS * (attempt + 1)); }
    );
  } catch(e){
    console.error(label + ' overlay unavailable', e);
  }
}

// Saved research, Global & Macro / technical / price updates, the live snapshot and completed-weeks technical blocks of Refresh all stocks (one record per
// batch of 50 stocks, laid under each stock's own saved update), the recent weekly and monthly bars (W % chg and M % chg are worked out from them), and
// Technical Score 2 (one record per 250 stocks).
const OVERLAYS = [
  { name: 'stockResearch', apply: applyResearchOverlay, label: 'Stock research' },
  { name: 'stockUpdates', apply: applyUpdatesOverlay, label: 'Stock updates' },
  { name: 'liveSnapshot', apply: applySnapshotOverlay, label: 'Live snapshot' },
  { name: 'techBlocks', apply: applyTechBlocksOverlay, label: 'Technical blocks' },
  { name: 'barsRecent', apply: applyRecentBarsOverlay, label: 'Recent bars', delayMs: BARS_DELAY_MS },
  { name: 'techScore2', apply: applyTech2Overlay, label: 'Technical Score 2' },
];

function watchOverlays(db){
  for(const spec of OVERLAYS){
    if(spec.delayMs) setTimeout(() => watchCollection(db, spec), spec.delayMs);
    else watchCollection(db, spec);
  }
}

// ---- Research triggers: which stocks have fresh research due, and why. The page is redrawn only when the set really changed.
let lastTriggerSignature = null;

function applyTriggers(snap){
  const next = new Map(), nextKinds = new Map();
  snap.docs.forEach(d => {
    if(!d.exists) return;
    const x = d.data();
    if(!(x && x.ticker && x.triggeredAt)) return;
    next.set(x.ticker, x.triggeredAt);
    if(x.kind) nextKinds.set(x.ticker, x.kind);
  });
  const signature = JSON.stringify([...next]) + JSON.stringify([...nextKinds]);
  if(signature === lastTriggerSignature) return;
  lastTriggerSignature = signature;
  setResearchTriggers(next);
  setResearchTriggerKinds(nextKinds);
  if(sectionIsOpen('section-analysis')) refreshAnalysisSoon();
}

function watchResearchTriggers(db){
  try {
    db.collection('researchTriggers').onSnapshot(applyTriggers, (err) => console.error('Research trigger sync error', err));
  } catch(e){
    console.error('Research trigger log unavailable', e);
  }
}

// The Data Refresh page's history lists: kept in the store, and the page redrawn if it is loaded.
function watchHistoryLogs(db){
  const logs = [{ name: 'watchlistSyncLog', log: watchlistSyncLog, label: 'Watchlist sync log' }, { name: 'fundamentalCsvUploadLog', log: fundamentalCsvUploadLog, label: 'Fundamental CSV upload log' }];
  for(const { name, log, label } of logs){
    watchCollection(db, { name, label, apply: (docs) => { docs.forEach(d => log.put(d.id, d.data)); renderLoadedPart('refreshlog'); } });
  }
}

// ---- The trade log: per signed-in user, so with no identity there is nothing to listen to.
function listenTradeLog(col, attempt){
  col.onSnapshot(
    (snap) => {
      const next = new Map();
      snap.docs.forEach(d => { if(d.exists) next.set(d.id, Object.assign({}, d.data(), { _id: d.id })); });
      replaceTradeLog(next);
      renderLoadedPart('trackrecord');
    },
    (err) => {
      console.error('Trade log sync error', err);
      if(attempt < TRADE_RETRIES) setTimeout(() => listenTradeLog(col, attempt + 1), TRADE_PAUSE_MS * (attempt + 1));
    }
  );
}

function watchTradeLog(db){
  try {
    const col = tradeCol(db);
    if(!col) throw new Error('no signed-in identity: the trade log is per user');
    attachTradeDb(db);
    listenTradeLog(col, 0);
  } catch(e){
    console.error('Trade log persistence unavailable', e);
  }
}

// Every subsystem needs the same `db` capability. It is awaited ONCE (dbCapabilityPromise, started in core/store.js) and the same `db` instance is handed to
// the store and to every subscription. Each subscription keeps its own try/catch (not one shared one around everything) so a failure in any single
// subsystem's listener registration can't prevent the others from setting up.
async function startSubscriptions(){
  const db = await dbCapabilityPromise;
  if(!db) return; // capability not granted/available in this view — everything below stays session-only
  attachDb(db);
  watchNews();
  watchPins(db, 0);
  readPinsOnce(db);
  watchOverlays(db);
  watchResearchTriggers(db);
  watchHistoryLogs(db);
  watchTradeLog(db);
}

function init_sync_subscriptions(){
  startSubscriptions();
}

export { init_sync_subscriptions };
