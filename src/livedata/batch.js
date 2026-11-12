// Live Data Refresh for several stocks at once (started from the Analysis, Strategies or Explorer screen).
import { tickerSymbol } from '../core/util.js';
import { refreshAnalysisSoon } from '../analysis/section.js';
import { redrawWhenIdle } from '../ui/scrollkeep.js';
import { renderLoadedPart } from '../core/lazy.js';
import { pcTickerKey } from '../prices/store.js';
import { sectionOf } from '../refresh/kit-lookup.js';
import { LD_LABEL, ldAbort, ldGet, ldRunning, ldStart } from './bar.js';
import { ldEnsureClaudeAccess } from './claude.js';
import { claudeAnyOn } from './claudegate.js';
import { activityEnd, activityNotify, activityRun } from '../ui/activity.js';
import { getRefreshKit } from '../refresh/hook.js';

const SAVED_REACH_MS = 1200;   // the saved numbers reach the stock list a moment after the save
const SAVED_REDRAW_MS = 1500;   // the screen is drawn once more after this, to catch what arrived late

var ldBatch = null;   // { kind, source, total, done, active: Map(key -> ticker), workers, slow, running, stop, failed[], skipped, note, perm }
// The last finished run of each kind on each screen: { state, pct, text, perm }. Kept so a card still shows its result
// after the screen redraws and after the other kind has been run.
var ldBatchLast = { analysis: { fund: null, tech: null }, strat: { fund: null, tech: null } };   // more screens (the Explorer's industries, 'biz-N') are added as they start a run
const LD_PARALLEL = 3;   // stocks refreshed at the same time by a batch
const LD_BATCH_MAX = { fund: 50, tech: 50 };   // the Fundamental refresh uses the viewer's Claude usage (cheapest model tier), so it is capped
const otherScreen = (P) => P === 'analysis' ? 'the Strategies screen' : P === 'strat' ? 'the Analysis screen' : 'another screen';

// Overall progress of the current run, 0-100: finished stocks plus the share of the stock being refreshed now.
function batchPct(){
  let cur = 0;
  if(ldBatch.running) ldBatch.active.forEach((sym, key) => { const j = ldGet(key, ldBatch.kind); if(j) cur += Math.max(0, Math.min(100, j.pct)) / 100; });
  return Math.round(Math.min(1, (ldBatch.done + cur) / ldBatch.total) * 100);
}
function batchTail(){
  const ok = ldBatch.total - ldBatch.failed.length - ldBatch.skipped;
  return ok + ' of ' + ldBatch.total + ' refreshed.' + (ldBatch.skipped ? ' ' + ldBatch.skipped + ' not run.' : '') + (ldBatch.failed.length ? ' Failed: ' + ldBatch.failed.slice(0, 5).join('; ') : '');
}
const activeNames = () => Array.from(ldBatch.active.values()).join(', ');
const KIND_NAME = { fund: 'Fundamental', tech: 'Technical' };
const STAY_OPEN_NOTE = 'You can move to other screens. If you close the dashboard it pauses and carries on when it is opened again.';
// The screen that started a run, for the "View" button on the top strip.
function batchStoppingText(){
  return 'Stopping: finishing ' + activeNames() + ' (a bar download already under way cannot be cut short), then the remaining stock(s) will not run.';
}

// What a card shows for one kind on one screen: the running progress, the last result kept for that screen, or nothing.
function cardState(P, kind, running, mine){
  if(mine && ldBatch.kind === kind){
    const first = ldBatch.active.size ? ldBatch.active.keys().next().value : '', j = first ? ldGet(first, kind) : null;
    const pct = batchPct();
      return { state: 'running', pct, text: ldBatch.stop ? batchStoppingText() : pct + '% · ' + ldBatch.done + ' of ' + ldBatch.total + ' done · ' + activeNames() + (j ? ' · ' + j.msg : '') + (ldBatch.workers > 1 ? ' (' + ldBatch.workers + ' at a time)' : '') + '' };
  }
  return running && !mine ? null : (ldBatchLast[P] || {})[kind] || null;
}
// While the panel is closed, a running or failed refresh still shows at the end of its heading.
function paintChip(P, state){
  const chip = document.getElementById(P + 'LdChip');
  if(!chip) return;
  const all = [state.fund, state.tech];
  const run = all.find(x => x && x.state === 'running'), bad = all.find(x => x && x.state === 'error');
  chip.textContent = run ? 'Refreshing… ' + run.pct + '%' : bad ? 'Last refresh failed' : '';
  chip.classList.toggle('is-error', !run && !!bad);
}
// One kind's card: the button, the progress bar, the Stop button and the status line.
function paintCard(P, kind, x, flags){
  const { running, mine } = flags, card = document.getElementById(P + 'Card-' + kind);
  if(!card) return;
  const btn = /** @type {HTMLButtonElement} */ (card.querySelector('.refresh-btn'));
  const bar = document.getElementById(P + 'Bar-' + kind), fill = document.getElementById(P + 'Fill-' + kind);
  const st = document.getElementById(P + 'Status-' + kind), stop = document.getElementById(P + 'Stop-' + kind);
  if(btn){
    btn.disabled = running || card.dataset.off === '1';
    btn.title = card.dataset.title || '';
    btn.textContent = mine && ldBatch.kind === kind ? 'Refreshing…' : (card.dataset.label || LD_LABEL[kind]);
  }
  if(bar){ bar.hidden = !x; bar.setAttribute('aria-valuenow', String(x ? x.pct : 0)); }
  if(fill){
    fill.style.setProperty('--w', (x ? x.pct : 0) + '%');
    fill.classList.toggle('is-ok', !!x && x.state === 'ok');
    fill.classList.toggle('is-error', !!x && x.state === 'error');
  }
  if(stop){
    const r = !!x && x.state === 'running';
    stop.hidden = !r; /** @type {HTMLButtonElement} */ (stop).disabled = !!(r && ldBatch.stop); stop.textContent = r && ldBatch.stop ? 'Stopping…' : 'Stop';
  }
  if(st){
    st.textContent = x ? x.text : running && !mine ? 'A refresh started from ' + otherScreen(P) + ' is running.' : (card.dataset.idle || '');
    st.classList.toggle('is-error', !!x && x.state === 'error');
  }
}
// Draws one screen's Live Data Refresh panel (P = 'analysis' or 'strat'): the same buttons, bars and result lines
// as the stock page shows for one stock.
function paintLivePanel(P){
  const running = !!(ldBatch && ldBatch.running);
  const mine = running && ldBatch.source === P;
  const state = {};
  for(const kind of ['fund', 'tech']) state[kind] = cardState(P, kind, running, mine);
  paintChip(P, state);
  for(const kind of ['fund', 'tech']) paintCard(P, kind, state[kind], { running, mine });
  const perm = document.getElementById(P + 'Perm');
  if(perm) perm.hidden = !(state.fund && state.fund.state === 'error' && state.fund.perm);
}
// The strip at the top of every screen follows the run, so progress stays visible after you leave the screen that started it.
function syncActivity(){
  if(!(ldBatch && ldBatch.running)){ activityEnd('batch'); return; }
  const info = {
    title: 'Refreshing ' + KIND_NAME[ldBatch.kind] + ' Info · ' + ldBatch.done + ' of ' + ldBatch.total + ' done',
    text: ldBatch.stop ? batchStoppingText() : (activeNames() ? activeNames() + ' · ' : '') + STAY_OPEN_NOTE,
    pct: batchPct(), section: sectionOf(ldBatch.source), onStop: ldBatchStop, stopping: ldBatch.stop
  };
  const kit = getRefreshKit();
  if(kit) kit.activity(info); else activityRun('batch', info);
}
function ldBatchPaint(){
  syncActivity();
  const kit = getRefreshKit();
  if(kit) kit.repaint();
  paintLivePanel('analysis');
  paintLivePanel('strat');
  document.querySelectorAll('[data-live-panel]').forEach(el => paintLivePanel(/** @type {HTMLElement} */ (el).dataset.livePanel));
}
function ldBatchStop(){
  if(!ldBatch || !ldBatch.running) return;
  ldBatch.stop = true;
  ldBatchPaint();
  ldBatch.active.forEach((sym, key) => { const c = ldAbort.get(key + '|fund'); if(c) c.abort(); });
}
// Tells the screen that started a run (the Explorer's industries) that data was saved, so it can redraw, e.g. its "Research done" column.
function batchStockSaved(){ if(ldBatch) document.dispatchEvent(new window.CustomEvent('alba-batch-done', { detail: { source: ldBatch.source } })); }
// After a failure the extra workers stand down and the rest runs one at a time; a permission or usage error halts the whole run.
const HALTING_ERROR = /usage limit|not allowed|not available for this account|sign in again/i;
// One stock's result: a failure is listed, slows the run down, and may halt it.
function noteStockResult(sym, j, run){
  if(!(j && j.state === 'error')) return;
  ldBatch.failed.push(sym + ' (' + String(j.msg).slice(0, 90) + ')');
  ldBatch.slow = true;
  if(j.perm || HALTING_ERROR.test(j.msg)){
    run.halted = true; ldBatch.note = 'Stopped early: ' + String(j.msg).slice(0, 100) + '.'; ldBatch.perm = !!j.perm;
  }
}
// One worker: takes the next stock of the list until none is left, the run is stopped or it is halted. `run` = { list, kind, source, next, halted }.
async function batchWorker(w, run){
  const { list, kind, source } = run;
  while(!ldBatch.stop && !run.halted && run.next < list.length){
    if(w > 0 && ldBatch.slow) return;   // after a failure the extra workers stand down: the rest runs one at a time
    const i = run.next++, s = list[i], key = pcTickerKey(s), sym = tickerSymbol(s);
    if(ldRunning(key)){ ldBatch.failed.push(sym + ' (already refreshing)'); ldBatch.done++; continue; }
    ldBatch.active.set(key, sym);
    await ldStart(s, kind);
    ldBatch.active.delete(key);
    const j = ldGet(key, kind);
    if(j && j.state === 'error' && ldBatch.stop && /Stopped/.test(j.msg)){ ldBatch.done++; continue; }
    noteStockResult(sym, j, run);
    ldBatch.done++;
    if(source !== 'strat') setTimeout(batchStockSaved, SAVED_REACH_MS);   // the saved numbers reach the stock list a moment after the save
    ldBatchPaint();
  }
}
// Keeps the result in that screen's card for this kind, so later redraws and a run of the other kind do not wipe it, then tells the viewer on whatever screen they are on; the notice stays until they close it.
function recordFinished(kind){
  const failed = ldBatch.failed.length > 0;
  (ldBatchLast[ldBatch.source] = ldBatchLast[ldBatch.source] || { fund: null, tech: null })[kind] = { state: failed ? 'error' : 'ok', pct: batchPct(), text: !failed && ldBatch.note === 'Finished.' ? 'Done: ' + batchTail() : ldBatch.note + ' ' + batchTail(), perm: ldBatch.perm };
  const refreshed = ldBatch.total - ldBatch.failed.length - ldBatch.skipped, clean = ldBatch.note === 'Finished.';
  activityEnd('batch');
  const kit = getRefreshKit();
  if(!(kit && kit.batchNotice())) activityNotify({
    tone: failed ? (refreshed > 0 ? 'warn' : 'error') : clean ? 'ok' : 'warn',
    title: KIND_NAME[kind] + ' refresh ' + (ldBatch.stop ? 'stopped' : clean ? 'finished' : 'ended early'),
    text: (clean ? '' : ldBatch.note + ' ') + batchTail(), section: sectionOf(ldBatch.source)
  });
}
// `stocksToRun`: the stocks to refresh. `source`: the panel that started it.
async function ldBatchStart(kind, list, source = 'strat'){
  if(ldBatch && ldBatch.running) return;
  if(!list.length || list.length > LD_BATCH_MAX[kind]) return;
  // A few stocks at a time: both refreshes mostly wait on TradingView (and Claude), so the waits overlap.
  const workers = Math.min(LD_PARALLEL, list.length);
  ldBatch = { kind, source, total: list.length, done: 0, active: new Map(), workers, slow: false, running: true, stop: false, failed: [], skipped: 0, note: '', perm: false };
  ldBatchPaint();
  if(kind === 'fund' && claudeAnyOn()) await ldEnsureClaudeAccess();   // one permission dialog up front, not one per stock
  const run = { list, kind, source, next: 0, halted: false };
  await Promise.all(Array.from({ length: workers }, (_, w) => batchWorker(w, run)));
  ldBatch.skipped = list.length - ldBatch.done;
  if(ldBatch.stop && !ldBatch.note) ldBatch.note = 'Stopped.';
  ldBatch.running = false; ldBatch.active.clear();
  if(!ldBatch.note) ldBatch.note = 'Finished.';
  recordFinished(kind);
  try { refreshAnalysisSoon(); } catch(e){ /* the leaderboard repaints on its next render */ }
  // the refreshed numbers reach the stock list through the live subscription, a moment after the last save, so redraw twice
  const redraw = () => { try { const sec = document.getElementById('section-strategies'); if(sec && sec.classList.contains('active') && !(ldBatch && ldBatch.running)) redrawWhenIdle('strategies', () => renderLoadedPart('strategies')); } catch(e){ /* repaints when opened again */ } };
  if(source === 'strat'){ redraw(); setTimeout(redraw, SAVED_REDRAW_MS); }
  else { batchStockSaved(); setTimeout(batchStockSaved, SAVED_REDRAW_MS); }
  ldBatchPaint();
}

function getLdBatch(){ return ldBatch; }

export { LD_BATCH_MAX, getLdBatch, ldBatchPaint, ldBatchStart, ldBatchStop };
