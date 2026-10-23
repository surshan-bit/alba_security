// "Last file loaded" card of the Fundamental section on the Data Refresh page: which file was uploaded last,
// when, and what became of it (waiting to be imported, imported, or the last attempt failed / was cancelled).
import { getDb, fundamentalCsvUploadLog } from '../core/store.js';
import { escapeHtml, formatUploadTimestamp } from '../core/util.js';
import { lockBusy } from './joblock.js';
import { pruneLogCollection } from '../joblogs/panels.js';

// The job record (importJobs/fundamental) as last read: tells whether an import is running or was interrupted.
let jobState = null;

const KINDS = {
  fund: { log: fundamentalCsvUploadLog, collection: 'fundamentalCsvUploadLog', el: 'fundamentalLastFile', stamps: 'Fundamental refresh date' }
};

function newest(log){
  let best = null;
  for(const r of log.values()) if(!best || String(r.uploadedAt) > String(best.uploadedAt)) best = r;
  return best;
}
function dayOf(iso){ try { return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }); } catch(e){ return ''; } }

/** What the card says about a record: [css class, headline, extra lines]
 * @returns {[string, string, string[]]} */
function describe(r, k){
  if(r.status === 'processed'){
    /** @type {string[]} */ const lines = [];
    if(r.processedAt) lines.push('Imported ' + formatUploadTimestamp(r.processedAt) + '. ' + k.stamps + ' set to ' + dayOf(r.uploadedAt) + ' for every stock in the file.');
    if(r.processedNote) lines.push(r.processedNote);
    return ['ok', 'Imported', lines];
  }
  const a = r.lastAttempt;
  if(a && a.at && String(a.at) >= String(r.uploadedAt)){
    const when = formatUploadTimestamp(a.at);
    return a.outcome === 'cancelled'
      ? ['warn', 'Not imported (cancelled)', ['Cancelled ' + when + '. Nothing was written. Press "Import data" to try again.']]
      : ['err', 'Not imported (the last attempt failed)', ['Failed ' + when + ': ' + (a.message || 'unknown error') + ' Press "Import data" to try again.']];
  }
  return ['warn', 'Uploaded, not imported yet', ['Press "Import data" to score this file and update the stock data. Stock dates and the data-age bars change only after that.']];
}

// A job that is marked running: either it is, or the page that ran it was closed or reloaded before it finished.
function jobBanner(){
  const j = jobState;
  if(!j || j.status !== 'running') return '';
  const when = formatUploadTimestamp(j.startedAt);
  return lockBusy(j)
    ? '<div class="lf-status lf-warn">An import is running (started ' + escapeHtml(when) + ').</div><div class="upload-hint lf-line">If it was started from another tab or device that has since been closed, it counts as interrupted after 3 minutes without activity.</div>'
    : '<div class="lf-status lf-err">An earlier import was interrupted (started ' + escapeHtml(when) + ').</div><div class="upload-hint lf-line">The page was reloaded or closed before it finished. Press "Import data" to run the file again; the stock data is checked again before anything is written.</div>';
}

function renderLastFile(kind){
  const k = KINDS[kind], host = document.getElementById(k.el);
  if(!host) return;
  const r = newest(k.log);
  const banner = jobBanner();
  if(!r){ host.innerHTML = '<div class="upload-title">Last file loaded</div><div class="upload-hint">No file has been uploaded yet.</div>' + banner; return; }
  const [cls, head, lines] = describe(r, k);
  host.innerHTML = '<div class="upload-title">Last file loaded</div>' + banner +
    '<div class="lf-file">' + escapeHtml(r.filename || 'file') + '</div>' +
    '<div class="upload-hint">Uploaded ' + escapeHtml(formatUploadTimestamp(r.uploadedAt)) + (r.rowCount != null ? ' \u00b7 ' + Number(r.rowCount).toLocaleString('en-IN') + ' rows' : '') + '</div>' +
    '<div class="lf-status lf-' + cls + '">' + escapeHtml(head) + '</div>' +
    lines.map(t => '<div class="upload-hint lf-line">' + escapeHtml(t) + '</div>').join('');
}
function renderAllLastFiles(){ renderLastFile('fund'); }
// Reads the job record first, so the cards can say that an import is running or was interrupted.
async function refreshLastFiles(){
  try { const db = getDb(); if(db){ const d = await db.doc('importJobs/fundamental').get(); jobState = d && d.exists ? d.data() : null; } }
  catch(e){ /* the cards just leave the job line out */ }
  renderAllLastFiles();
}

// Writes a whole upload record back (the same way it was created, which is known to work) and redraws the card.
// Returns null, or the reason it could not be saved.
async function saveRecord(kind, recId, record, db){
  const k = KINDS[kind];
  k.log.put(recId, record);
  jobState = null;   // the job that produced this outcome has ended
  renderLastFile(kind);
  try {
    await db.collection(k.collection).doc(recId).set(record);
    await pruneLogCollection(db, k.collection, k.log, 'uploadedAt');
    return null;
  } catch(e){
    console.error('Could not save the upload record', e);
    return String((e && (e.message || e.code)) || e);
  }
}

// Records the outcome of a failed or cancelled import attempt on the file's upload record (it stays 'uploaded', so it can be tried again).
async function recordAttempt(kind, rec, recId, e, db){
  if(!rec || !recId || !db) return;
  const lastAttempt = { at: new Date().toISOString(), outcome: e && e.cancelled ? 'cancelled' : 'failed', message: String((e && e.message) || e || '').slice(0, 300) };
  await saveRecord(kind, recId, Object.assign({}, rec, { lastAttempt }), db);
}

export { recordAttempt, refreshLastFiles, renderAllLastFiles, saveRecord };
