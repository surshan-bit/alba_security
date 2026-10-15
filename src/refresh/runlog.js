// The run records of the Technical Score section: one record per run in refreshRunLog/<kind>-<start time>, and the "Last 2 runs" lists
// under each option. Kinds: 'snapshot' (Refresh all stocks, including its price-bar stages) and 'csv' (Import CSV, hidden). Only the newest
// KEEP records of each kind are kept; older ones are deleted when a new one is saved.
import { escapeHtml, formatUploadTimestamp } from '../core/util.js';

const KEEP = 2;
const KINDS = ['snapshot', 'csv'];
const num = x => Number(x || 0).toLocaleString('en-IN');

// "2 min 14 s" for a run time in milliseconds.
function duration(ms){ const t = Math.max(0, Math.round(ms / 1000)), m = Math.floor(t / 60); return m ? m + ' min ' + (t % 60) + ' s' : t + ' s'; }

// Saves the record of a run and removes the older ones of its kind. Never stops a run: a failed save only means a missing record.
async function saveRunLog(db, kind, startedAt, t0, rec){
  try {
    const endedAt = new Date().toISOString();
    await db.doc('refreshRunLog/' + kind + '-' + startedAt.replace(/[-:.]/g, '')).set(Object.assign({ v: 2, kind, trigger: 'manual', startedAt, endedAt, durationMs: Date.now() - t0 }, rec));
  } catch(e){ console.error('Could not save the refresh run record', e); return; }
  try {
    const snap = await db.collection('refreshRunLog').get();
    const mine = snap.docs.filter(d => d.exists && (d.data() || {}).kind === kind).sort((a, b) => String(b.data().startedAt).localeCompare(String(a.data().startedAt)));
    for(const d of mine.slice(KEEP)) await db.doc('refreshRunLog/' + d.id).delete();
  } catch(e){ console.error('Could not remove the older run records', e); }
}

function runLine(r){
  const when = formatUploadTimestamp(r.startedAt) + ' · ' + (r.trigger === 'scheduled' ? 'scheduled' : 'manual') + ' · ' + duration(r.durationMs || 0);
  const what = num(r.saved) + ' saved' + (r.unchanged ? ', ' + num(r.unchanged) + ' unchanged' : '') + (r.skipped ? ', ' + num(r.skipped) + ' skipped' : '')
    + (r.filled || r.barsUpdated ? ' · bars: ' + num(r.filled) + ' full history, ' + num(r.barsUpdated) + ' updated' : '');
  const bad = r.error ? ' · stopped: ' + r.error : (r.stopped ? ' · stopped early' : '');
  return '<div class="refreshlog-run"><span class="refreshlog-run-time">' + escapeHtml(when) + '</span> · ' + escapeHtml(what + bad) + '</div>';
}

// Fills the "Last 2 runs" list under each option (elements lastRuns_snapshot and lastRuns_csv).
async function paintLastRuns(db){
  const hosts = KINDS.map(k => [k, document.getElementById('lastRuns_' + k)]).filter(/** @type {(x: any[]) => boolean} */ (x => x[1]));
  if(!hosts.length) return;
  let docs = null;
  if(db){ try { docs = (await db.collection('refreshRunLog').get()).docs.filter(d => d.exists).map(d => d.data() || {}); } catch(e){ console.error('Could not read the run records', e); } }
  for(const [kind, el] of hosts){
    const host = /** @type {HTMLElement} */ (el);
    const mine = docs ? docs.filter(r => r.kind === kind).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, KEEP) : [];
    host.innerHTML = '<div class="refreshlog-runs-title">Last ' + KEEP + ' runs</div>' + (mine.length ? mine.map(runLine).join('') : '<p class="upload-hint">' + (docs ? 'No runs yet.' : 'Not available in this view.') + '</p>');
  }
}

export { duration, paintLastRuns, saveRunLog };
