// Live database subscriptions (research, updates, triggers, pins, logs).
import { attachDb, attachTradeDb, dbCapabilityPromise, fundamentalCsvUploadLog, replacePinnedTickers, replaceRefreshRequests, replaceTradeLog, technicalCsvUploadLog, watchlistSyncLog } from '../core/store.js';
import { refreshAnalysisSoon } from '../analysis/section.js';
import { setResearchTriggerKinds, setResearchTriggers } from '../research/status.js';
import { rerenderDetail } from '../detail/render.js';
import { applyResearchOverlay } from '../overlays/research.js';
import { applyUpdatesOverlay } from '../overlays/updates.js';
import { pinsRef, tradeCol } from '../identity/session.js';
import { pinWritesInFlight } from '../core/pins.js';
import { renderLoadedPart } from '../core/lazy.js';

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

  try {
    db.collection('stockResearch').onSnapshot(
      (snap) => {
        const docs = [];
        snap.docs.forEach(d => { if(d.exists) docs.push({ id: d.id, data: d.data() }); });
        applyResearchOverlay(docs);
      },
      (err) => console.error('Stock research sync error', err)
    );
  } catch(e){
    console.error('Stock research overlay unavailable', e);
  }

  // Saved Global & Macro, technical and price updates. If the listener fails it is started again after a pause, so the
  // overlay does not silently disappear until the page is reloaded.
  const watchUpdates = (attempt) => {
    try {
      db.collection('stockUpdates').onSnapshot(
        (snap) => {
          const docs = [];
          snap.docs.forEach(d => { if(d.exists) docs.push({ id: d.id, data: d.data() }); });
          try { applyUpdatesOverlay(docs); } catch(e){ console.error('Stock updates could not be applied', e); }
        },
        (err) => { console.error('Stock updates sync error', err); if(attempt < 5) setTimeout(() => watchUpdates(attempt + 1), 3000 * (attempt + 1)); }
      );
    } catch(e){
      console.error('Stock updates overlay unavailable', e);
    }
  };
  watchUpdates(0);

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

  try {
    db.collection('refreshRequests').onSnapshot(
      (snap) => {
        const next = new Map();
        snap.docs.forEach(d => { if(d.exists) next.set(d.id, d.data()); });
        const _rsig = JSON.stringify([...next]);
        if(_rsig === window.__rrSig) return;
        window.__rrSig = _rsig;
        replaceRefreshRequests(next);
        rerenderDetail();
      },
      (err) => console.error('Refresh queue sync error', err)
    );
  } catch(e){
    console.error('Refresh queue unavailable', e);
  }

  try {
    db.collection('watchlistSyncLog').onSnapshot(
      (snap) => {
        snap.docs.forEach(d => {
          if(d.exists) watchlistSyncLog.put(d.id, d.data());
        });
        renderLoadedPart('refreshlog');
      },
      (err) => console.error('Watchlist sync log sync error', err)
    );
  } catch(e){
    console.error('Watchlist sync log persistence unavailable', e);
  }

  try {
    db.collection('fundamentalCsvUploadLog').onSnapshot(
      (snap) => {
        snap.docs.forEach(d => {
          if(d.exists) fundamentalCsvUploadLog.put(d.id, d.data());
        });
        renderLoadedPart('refreshlog');
      },
      (err) => console.error('Fundamental CSV upload log sync error', err)
    );
  } catch(e){
    console.error('Fundamental CSV upload log persistence unavailable', e);
  }

  try {
    db.collection('technicalCsvUploadLog').onSnapshot(
      (snap) => {
        snap.docs.forEach(d => {
          if(d.exists) technicalCsvUploadLog.put(d.id, d.data());
        });
        renderLoadedPart('refreshlog');
      },
      (err) => console.error('Technical CSV upload log sync error', err)
    );
  } catch(e){
    console.error('Technical CSV upload log persistence unavailable', e);
  }

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
