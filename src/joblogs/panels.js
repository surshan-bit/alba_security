// Job and sync log panels on the Data Refresh page.
import { getDb, watchlistSyncLog } from '../core/store.js';
import { escapeHtml, formatDeepRefreshTimestamp } from '../core/util.js';

// ---- Shared machinery for the "recent runs" panels on the Data Refresh page (today: the TradingView
// watchlist sync). A panel shows a history read from a shared-database subscription and differs from
// the others only in which fields it reads and how a run's stats line is worded.

// Statuses whose label/badge-color are common to every job panel. A job whose status
// isn't listed here (or in that job's own `statusOverrides`) falls back to `{label: status ||
// 'Unknown', cls: 'muted'}` — matching every panel's original behavior for an unrecognized status.
const BASE_JOB_STATUS = {
  completed: {label:'Completed', cls:'buy'},
  running: {label:'In progress', cls:'hold'},
  requested: {label:'Requested (manual)', cls:'hold'}
};
function jobStatusInfo(status, overrides){
  if(overrides && overrides[status]) return overrides[status];
  if(BASE_JOB_STATUS[status]) return BASE_JOB_STATUS[status];
  return {label: status || 'Unknown', cls:'muted'};
}

// Renders one job's "next run" countdown + "recent runs" history. `cfg`:
//   runsElId                - element id of the runs container
//   dbFlagGetter()          - returns the truthy/falsy "is the db reachable in this view" flag
//   logGetter()             - returns the log (see core/store.js) holding the run records
//   notAvailableText        - shown when dbFlagGetter() is falsy
//   noRunsPrefix            - shown when the log is empty
//   statusOverrides         - {status: {label, cls}} entries specific to this job (e.g. its own
//                             wording for "partial", or statuses only this job ever sets)
//   tickersOf(r)            - returns this job's array of chip tickers for a run record
//   renderStats(r)          - returns the inner HTML of the run's stats line
//   renderExtra(r)          - optional extra HTML block(s) below the stats line (e.g. an error or
//                             dropped-tickers callout); omit for jobs that don't need one
// How many past runs/uploads to keep visible (and, going forward, stored) per Data Refresh job —
// keeps every history list on the Data Refresh Schedule page short and scannable rather than
// growing without bound. Used by renderJobLogPanel below.
const HISTORY_LIMIT = 3;

// After writing a new record into one of the three Data Refresh history collections
// (technicalCsvUploadLog, fundamentalCsvUploadLog, watchlistSyncLog), trims that
// collection back down to HISTORY_LIMIT documents (most recent first, by sortField) so it never
// grows without bound — a client-side backstop alongside the on-screen cap in
// renderJobLogPanel above and the "keep it trimmed" instruction given to
// Claude in the manual-trigger/import prompts (which write most run records from a separate
// conversation, not from this browser code).
async function pruneLogCollection(dbRef, collectionName, log, sortField){
  if(!dbRef) return;
  const ids = log.entries()
    .sort((a, b) => ((b[1][sortField] || '')).localeCompare(a[1][sortField] || ''))
    .map(([id]) => id);
  const toDelete = ids.slice(HISTORY_LIMIT);
  for(const id of toDelete){
    log.remove(id);
    try { await dbRef.collection(collectionName).doc(id).delete(); } catch(e){ console.error('Failed to prune', collectionName, id, e); }
  }
}

function renderJobLogPanel(cfg){
  const el = document.getElementById(cfg.runsElId);
  if(!el) return;
  if(!cfg.dbFlagGetter()){
    el.innerHTML = `<p class="upload-hint">${cfg.notAvailableText}</p>`;
    return;
  }
  const allRuns = cfg.logGetter().values();
  if(allRuns.length === 0){
    el.innerHTML = `<p class="upload-hint">${cfg.noRunsPrefix}</p>`;
    return;
  }
  const runs = allRuns
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, HISTORY_LIMIT); // keep only the most recent runs on screen — older ones don't add much once things are steady-state
  el.innerHTML = runs.map(r => {
    const {label: statusLabel, cls: statusClass} = jobStatusInfo(r.status, cfg.statusOverrides);
    const tickers = Array.isArray(cfg.tickersOf(r)) ? cfg.tickersOf(r) : [];
    const shown = tickers.slice(0, 14);
    const extra = tickers.length - shown.length;
    return `
      <div class="refreshlog-run">
        <div class="refreshlog-run-head">
          <span class="refreshlog-run-time">${escapeHtml(formatDeepRefreshTimestamp(r.startedAt))}</span>
          <span class="refreshlog-run-status refreshlog-run-status-${statusClass}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="refreshlog-run-stats">${cfg.renderStats(r)}</div>
        ${cfg.renderExtra ? cfg.renderExtra(r) : ''}
        ${shown.length ? `<div class="refreshlog-run-tickers">${shown.map(t => `<span class="refreshlog-ticker-chip">${escapeHtml(t)}</span>`).join('')}${extra > 0 ? `<span class="refreshlog-ticker-chip refreshlog-ticker-more">+${extra} more</span>` : ''}</div>` : ''}
      </div>
    `;
  }).join('');
}


// Renders the "TradingView Watchlist Sync" panel: recent-runs history only (populated from the
// watchlistSyncLog subscription, if the database is reachable in this view) — no next-run countdown, since this
// sync is manual-only (started by the "Sync now" button on this page).
function renderWatchlistSyncLogPanel(){
  renderJobLogPanel({
    runsElId: 'watchlistSyncLogRuns',
    dbFlagGetter: () => getDb(),
    logGetter: () => watchlistSyncLog,
    notAvailableText: "Sync history isn't available in this view (the shared database isn't reachable here).",
    noRunsPrefix: 'No sync runs recorded yet.',
    statusOverrides: {
      partial: {label:'Partial', cls:'tech-sell'},
      failed: {label:'Failed', cls:'avoid'}
    },
    tickersOf: r => r.tickers,
    renderStats: r => `
      ${r.qualifiedCount != null ? `<span>${r.qualifiedCount} qualified</span>` : ''}
      ${r.strongBuyCount != null ? `<span>${r.strongBuyCount} Strong</span>` : ''}
      ${r.moderateBuyCount != null ? `<span>${r.moderateBuyCount} Good</span>` : ''}
      ${r.added != null ? `<span>${r.added} added</span>` : ''}
      ${r.removed != null ? `<span>${r.removed} removed</span>` : ''}
      ${r.finishedAt ? `<span>finished ${escapeHtml(formatDeepRefreshTimestamp(r.finishedAt))}</span>` : ''}
    `,
    renderExtra: r => `
      ${r.note ? `<div class="refreshlog-run-stats" style="color:var(--muted);">${escapeHtml(r.note)}</div>` : ''}
      ${r.error ? `<div class="refreshlog-run-stats" style="color:var(--avoid);">${escapeHtml(r.error)}</div>` : ''}
      ${Array.isArray(r.droppedTickers) && r.droppedTickers.length ? `<div class="refreshlog-run-stats" style="color:var(--avoid);">Dropped by TradingView, couldn't be resolved: ${r.droppedTickers.map(escapeHtml).join(', ')}</div>` : ''}
    `
  });
}


export { pruneLogCollection, renderWatchlistSyncLogPanel };
