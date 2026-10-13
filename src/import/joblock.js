// The job lock (importJobs/*) shared by the Fundamental import, Technical import, restore and watchlist sync.
// A running job refreshes `heartbeatAt` every few seconds. A job counts as interrupted when
//   - it was started by this same browser tab (the tab id survives a reload) and this page is not running it: the page was reloaded; or
//   - nothing was heard from it for a few minutes (another tab or device that was closed).
import { formatUploadTimestamp } from '../core/util.js';

const STALE_MS = 3 * 60 * 1000, BEAT_MS = 20 * 1000;
// (not Math.random: the tests replace it with a fixed sequence, and a job id must not shift what other code draws from it)
const rnd = () => { try { return Array.from(window.crypto.getRandomValues(new Uint8Array(6)), x => x.toString(36)).join(''); } catch(e){ return Date.now().toString(36); } };
const tabId = (() => {
  try { let t = window.sessionStorage.getItem('albaJobTab'); if(!t){ t = rnd(); window.sessionStorage.setItem('albaJobTab', t); } return t; }
  catch(e){ return 'tab-' + rnd(); }
})();

const quietMs = ld => Date.now() - (Date.parse(ld.heartbeatAt || ld.startedAt) || 0);
// Is the job this record describes really running, somewhere other than this page? (Callers have already checked that this page is not running one.)
const lockBusy = ld => !!ld && ld.status === 'running' && ld.owner !== tabId && quietMs(ld) < STALE_MS;
const lockText = ld => 'started ' + formatUploadTimestamp(ld.startedAt) + (ld.heartbeatAt ? ', last active ' + formatUploadTimestamp(ld.heartbeatAt) : '');
function startBeat(job){
  const t = setInterval(() => { try { job.update({ heartbeatAt: new Date().toISOString() }).catch(() => {}); } catch(e){ /* the next beat tries again */ } }, BEAT_MS);
  return () => clearInterval(t);
}

export { lockBusy, lockText, startBeat, tabId };
