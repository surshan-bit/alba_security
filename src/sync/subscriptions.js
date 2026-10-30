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

function init_sync_subscriptions(){
// ---- Shared database bootstrap ----
// Every subsystem needs the same `db` capability. It is awaited ONCE (dbCapabilityPromise, started in
// core/store.js) and the same `db` instance is handed to the store and to every subscription below. Each
// subscription keeps its own try/catch (not one shared one around everything) so a failure in any single
// subsystem's listener registration can't prevent the others from setting up.
(async () => {
  const db = await dbCapabilityPromise;
  if(!db) return; // capability not granted/available in this view — everything below stays session-only
  attachDb(db);

  // The saved news/events list marks stocks that have something coming up (grids, stock page), so it is read from the start, not only when News opens.
  setNewsChangeHook(() => {
    rerenderDetail();
    const a = document.getElementById('section-analysis');
    if(a && a.classList.contains('active')) refreshAnalysisSoon();
    const st = document.getElementById('section-strategies');
    if(st && st.classList.contains('active')) renderLoadedPart('strategies');
  });
  startNewsSync();

  // Pins. The saved list is read two ways so one failure cannot leave every star empty: the live listener (restarted after an
  // error) and a one-time read at start-up that fills in if the listener has not delivered anything yet.
  let pinsHeard = false;
  const showPins = (data) => {
    const arr = (data && Array.isArray(data.tickers)) ? data.tickers : [];
    // The write we just made via togglePin() already re-rendered optimistically; this snapshot fires
    // again once that write round-trips, with the same resulting set — replacePinnedTickers() reports
    // that as "no change", and the (expensive, full-list) re-render is skipped.
    if(!replacePinnedTickers(arr)) return;
    rerenderDetail();
    // Keep the Analysis section's pin highlighting/leaderboard order in sync too, if it's
    // the section currently open (e.g. a pin change arriving from another open tab/device).
    const analysisSectionEl = document.getElementById('section-analysis');
    if(analysisSectionEl && analysisSectionEl.classList.contains('active')) refreshAnalysisSoon();
  };
  const watchPins = (attempt) => {
    const ref = pinsRef(db);
    if(!ref) return;   // not signed in: pins stay in this page only
    try {
      ref.onSnapshot(
        (snap) => {
          pinsHeard = true;
          // While our own changes are still being saved, a snapshot may show an older list; the last one after they finish is right.
          if(pinWritesInFlight()) return;
          showPins(snap.data());
        },
        (err) => { console.error('Pin sync error', err); if(attempt < 5) setTimeout(() => watchPins(attempt + 1), 3000 * (attempt + 1)); }
      );
    } catch(e){
      console.error('Pin persistence unavailable', e);
    }
  };
  watchPins(0);
  try {
    const ref0 = pinsRef(db);
    if(ref0) ref0.get().then((snap) => { if(!pinsHeard && !pinWritesInFlight() && snap && snap.exists) showPins(snap.data()); }).catch((e) => console.error('Pins could not be read', e));
  } catch(e){ console.error('Pins could not be read', e); }

  // Listens to one collection and hands every snapshot to `apply` as [{ id, data }]. If the listener fails it is started again after a
  // pause (up to 5 times), so the overlay does not silently disappear until the page is reloaded. `label` names it in the console.
  const watchCollection = (name, apply, label, attempt = 0) => {
    try {
      db.collection(name).onSnapshot(
        (snap) => {
          const docs = [];
          snap.docs.forEach(d => { if(d.exists) docs.push({ id: d.id, data: d.data() }); });
          try { apply(docs); } catch(e){ console.error(label + ' could not be applied', e); }
        },
        (err) => { console.error(label + ' sync error', err); if(attempt < 5) setTimeout(() => watchCollection(name, apply, label, attempt + 1), 3000 * (attempt + 1)); }
      );
    } catch(e){
      console.error(label + ' overlay unavailable', e);
    }
  };
  watchCollection('stockResearch', applyResearchOverlay, 'Stock research');
  // Saved Global & Macro, technical and price updates.
  watchCollection('stockUpdates', applyUpdatesOverlay, 'Stock updates');
  // The live snapshot of Refresh all stocks: one record per batch of 50 stocks, laid under each stock's own saved update.
  watchCollection('liveSnapshot', applySnapshotOverlay, 'Live snapshot');
  // Completed-weeks technical blocks of Refresh all stocks: one record per 50 stocks, laid under each stock's own saved update.
  watchCollection('techBlocks', applyTechBlocksOverlay, 'Technical blocks');
  // The recent weekly and monthly bars of Refresh all stocks (the biggest record set, about 14 MB): W % chg and M % chg are worked out
  // from them. Read after the first screen is up, so the launch is not spent downloading and processing it.
  setTimeout(() => watchCollection('barsRecent', applyRecentBarsOverlay, 'Recent bars'), 3000);
  // Technical Score 2: one record per 250 stocks, saved by Refresh all stocks.
  watchCollection('techScore2', applyTech2Overlay, 'Technical Score 2');

  try {
    db.collection('researchTriggers').onSnapshot(
      (snap) => {
        const next = new Map();
        const nextKinds = new Map();
        snap.docs.forEach(d => { if(d.exists){ const x = d.data(); if(x && x.ticker && x.triggeredAt){ next.set(x.ticker, x.triggeredAt); if(x.kind) nextKinds.set(x.ticker, x.kind); } } });
        const sig = JSON.stringify([...next]) + JSON.stringify([...nextKinds]);
        if(sig === window.__rtSig) return;
        window.__rtSig = sig;
        setResearchTriggers(next);
        setResearchTriggerKinds(nextKinds);
        const el = document.getElementById('section-analysis');
        if(el && el.classList.contains('active')) refreshAnalysisSoon();
      },
      (err) => console.error('Research trigger sync error', err)
    );
  } catch(e){
    console.error('Research trigger log unavailable', e);
  }

  // The Data Refresh page's history lists: kept in the store, and the page redrawn if it is loaded.
  [{ name: 'watchlistSyncLog', log: watchlistSyncLog, label: 'Watchlist sync log' }, { name: 'fundamentalCsvUploadLog', log: fundamentalCsvUploadLog, label: 'Fundamental CSV upload log' }]
    .forEach(({ name, log, label }) => watchCollection(name, (docs) => { docs.forEach(d => log.put(d.id, d.data)); renderLoadedPart('refreshlog'); }, label));

  try {
    const _tradeCol = tradeCol(db);
    if(!_tradeCol) throw new Error('no signed-in identity: the trade log is per user');
    attachTradeDb(db);
    // A failed listener (a slow start, a dropped connection) is retried a few times, so the cards do not stay empty until a reload.
    const listen = (attempt) => {
      _tradeCol.onSnapshot(
        (snap) => {
          const next = new Map();
          snap.docs.forEach(d => {
            if(d.exists) next.set(d.id, Object.assign({}, d.data(), {_id: d.id}));
          });
          replaceTradeLog(next);
          renderLoadedPart('trackrecord');
        },
        (err) => {
          console.error('Trade log sync error', err);
          if(attempt < 4) setTimeout(() => listen(attempt + 1), 2000 * (attempt + 1));
        }
      );
    };
    listen(0);
  } catch(e){
    console.error('Trade log persistence unavailable', e);
  }

})();
}

export { init_sync_subscriptions };
