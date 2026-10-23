// Saves each uploaded CSV file and its upload record.
import { fundamentalCsvUploadLog, getDb, technicalCsvUploadLog } from '../core/store.js';
import { sanitizeDocId } from '../core/util.js';
import { pruneLogCollection } from '../joblogs/panels.js';

// A file is saved in the background after its preview shows. The Import buttons wait for these saves, so pressing Import right
// after choosing a file imports THAT file and never an older one that is still waiting.
const saving = new Set();
function track(promise){ saving.add(promise); const done = () => saving.delete(promise); promise.then(done, done); return promise; }
async function uploadsSettled(){ while(saving.size) await Promise.allSettled(Array.from(saving)); }

// Saves the raw uploaded file to the artifact's own asset store (the `assets` capability — a
// separate, larger file-storage area alongside the shared `db`) and writes a metadata record to
// the `technicalCsvUploadLog` collection, so a future Claude
// conversation can always tell which file was used last without the file needing to be
// re-attached to the chat. Best-effort and silent-ish on failure: this runs after the on-page
// preview has already rendered successfully, so a storage hiccup here shouldn't look like the
// upload itself failed — it just means this particular upload won't be
// fetchable by Claude later.
function recordTechnicalCsvUpload(file, text, stats){ return track(saveCsvUpload(TECHNICAL, file, text, stats)); }

// Same as recordTechnicalCsvUpload, but for the Fundamental Score / screener.in upload flow and
// its own `fundamentalCsvUploadLog` collection.
function recordFundamentalCsvUpload(file, text, stats){ return track(saveCsvUpload(FUNDAMENTAL, file, text, stats)); }

// What differs between the two uploads: the log (and its collection) and the label in the error message.
const TECHNICAL = { collection: 'technicalCsvUploadLog', log: technicalCsvUploadLog, label: 'Technical' };
const FUNDAMENTAL = { collection: 'fundamentalCsvUploadLog', log: fundamentalCsvUploadLog, label: 'Fundamental' };

async function saveCsvUpload(kind, file, text, stats){
  if(!stats) return; // preview itself failed — nothing meaningful to log
  try {
    if(!(typeof claude !== 'undefined' && claude && typeof claude.use === 'function')){
      return; // not running in a context that grants capabilities (e.g. a plain browser preview)
    }
    const assets = await claude.use('assets');
    if(!assets){
      return;
    }
    const blob = new Blob([text], { type: 'text/csv' });
    const uploaded = await assets.upload(blob); // {id, url, sizeBytes, contentType}
    const uploadedAt = new Date().toISOString();
    const record = {
      assetId: uploaded.id,
      url: uploaded.url,
      filename: file.name,
      sizeBytes: uploaded.sizeBytes != null ? uploaded.sizeBytes : file.size,
      uploadedAt,
      rowCount: stats.rowCount,
      newCount: stats.newCount,
      droppedCount: stats.droppedCount,
      status: 'uploaded' // Claude sets this to 'processed' via ArtifactData once it has used this file
    };
    // Update in-memory immediately, even before the shared onSnapshot round-trip lands.
    const docId = sanitizeDocId(uploadedAt);
    kind.log.put(docId, record);
    const logDb = getDb();
    if(logDb){
      await logDb.collection(kind.collection).doc(docId).set(record);
      await pruneLogCollection(logDb, kind.collection, kind.log, 'uploadedAt');
    }
  } catch(e){
    console.error('Failed to save ' + kind.label + ' CSV upload record', e);
  }
}

export { recordFundamentalCsvUpload, recordTechnicalCsvUpload, uploadsSettled };
