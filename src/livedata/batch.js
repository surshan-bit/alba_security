// Live Data Refresh for several stocks at once (started from the Analysis, Strategies or Explorer screen).
import { sleep, tickerSymbol } from '../core/util.js';
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

var ldBatch = null;   // { kind, source, total, done, active: Map(key -> ticker), workers (allowed now), maxWorkers, running, stop, failed[], skipped, note, perm }
// The last finished run of each kind on each screen: { state, pct, text, perm }. Kept so a card still shows its result
// after the screen redraws and after the other kind has been run.
var ldBatchLast = { analysis: { fund: null, tech: null }, strat: { fund: null, tech: null } };   // more screens (the Explorer's industries, 'biz-N') are added as they start a run
const LD_PARALLEL = { fund: 5, tech: 3 };   // stocks refreshed at the same time by a batch (Fundamental waits mostly on Claude; Technical calls only TradingView)
const LD_RECOVER_AFTER = 3;   // stocks finished cleanly in a row before one worker that stood down after a failure is let back in
const LD_IDLE_MS = 500;   // how often a worker that stood down looks again
// A failure that would repeat for every stock: the whole batch stops (Claude's usage limit or permission, or TradingView refusing calls for its quota or a suspension).
const LD_HALT_RE = /usage limit|not allowed|not available for this account|sign in again|quota|exhausted|suspended/i;
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
// How many stocks run at once now, e.g. " (5 at a time)", and why it is fewer after a failure.
const atATime = () => ldBatch.maxWorkers > 1 ? ' (' + ldBatch.workers + ' at a time' + (ldBatch.workers < ldBatch.maxWorkers ? ', slowed after a failure' : '') + ')' : '';
const KIND_NAME = { fund: 'Fundamental', tech: 'Technical' };
const STAY_OPEN_NOTE = 'You can move to other screens. If you close the dashboard it pauses and carries on when it is opened again.';
// The screen that started a run, for the "View" button on the top strip.
function batchStoppingText(){
  return 'Stopping: finishing ' + activeNames() + ' (a bar download already under way cannot be cut short), then the remaining stock(s) will not run.';
}

// Draws one screen's Live Data Refresh panel (P = 'analysis' or 'strat'): the same buttons, bars and result lines
// as the stock page shows for one stock.
function paintLivePanel(P){
  const running = !!(ldBatch && ldBatch.running);
  const mine = running && ldBatch.source === P;
  const state = {};
  for(const kind of ['fund', 'tech']){
    if(mine && ldBatch.kind === kind){
      const first = ldBatch.active.size ? ldBatch.active.keys().next().value : '', j = first ? ldGet(first, kind) : null;
      const pct = batchPct();
      state[kind] = { state: 'running', pct, text: ldBatch.stop ? batchStoppingText() : pct + '% · ' + ldBatch.done + ' of ' + ldBatch.total + ' done · ' + activeNames() + (j ? ' · ' + j.msg : '') + atATime() + '' };
    } else state[kind] = running && !mine ? null : (ldBatchLast[P] || {})[kind] || null;
  }
  // While the panel is closed, a running or failed refresh still shows at the end of its heading.
  const chip = document.getElementById(P + 'LdChip');
  if(chip){
    const all = [state.fund, state.tech];
    const run = all.find(x => x && x.state === 'running'), bad = all.find(x => x && x.state === 'error');
    chip.textContent = run ? 'Refreshing… ' + run.pct + '%' : bad ? 'Last refresh failed' : '';
    chip.classList.toggle('is-error', !run && !!bad);
  }
  for(const kind of ['fund', 'tech']){
    const x = state[kind], card = document.getElementById(P + 'Card-' + kind);
    if(!card) continue;
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
  const perm = document.getElementById(P + 'Perm');
  if(perm) perm.hidden = !(state.fund && state.fund.state === 'error' && state.fund.perm);
}
// The strip at the top of every screen follows the run, so progress stays visible after you leave the screen that started it.
function syncActivity(){
  if(!(ldBatch && ldBatch.running)){ activityEnd('batch'); return; }
  const info = {
    title: 'Refreshing ' + KIND_NAME[ldBatch.kind] + ' Info · ' + ldBatch.done + ' of ' + ldBatch.total + ' done',
    text: ldBatch.stop ? batchStoppingText() : (activeNames() ? activeNames() + atATime() + ' · ' : '') + STAY_OPEN_NOTE,
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
// `stocksToRun`: the stocks to refresh. `source`: the panel that started it.
async function ldBatchStart(kind, list, source = 'strat'){
  if(ldBatch && ldBatch.running) return;
  if(!list.length || list.length > LD_BATCH_MAX[kind]) return;
  // Several stocks at a time: both refreshes mostly wait on TradingView (and Claude), so the waits overlap.
  const maxWorkers = Math.min(LD_PARALLEL[kind], list.length);
  ldBatch = { kind, source, total: list.length, done: 0, active: new Map(), workers: maxWorkers, maxWorkers, running: true, stop: false, failed: [], skipped: 0, note: '', perm: false };
  ldBatchPaint();
  if(kind === 'fund' && claudeAnyOn()) await ldEnsureClaudeAccess();   // one permission dialog up front, not one per stock
  let next = 0, halted = false, clean = 0;
  // A failure takes one worker out for a while; a few clean stocks in a row bring it back.
  const outcome = ok => {
    if(!ok){ ldBatch.workers = Math.max(1, ldBatch.workers - 1); clean = 0; return; }
    if(++clean >= LD_RECOVER_AFTER && ldBatch.workers < ldBatch.maxWorkers){ ldBatch.workers++; clean = 0; }
  };
  const worker = async (w) => {
    while(!ldBatch.stop && !halted && next < list.length){
      if(w >= ldBatch.workers){ await sleep(LD_IDLE_MS); continue; }   // stood down after a failure: look again shortly
      const i = next++, s = list[i], key = pcTickerKey(s), sym = tickerSymbol(s);
      if(ldRunning(key)){ ldBatch.failed.push(sym + ' (already refreshing)'); ldBatch.done++; continue; }
      ldBatch.active.set(key, sym);
      await ldStart(s, kind);
      ldBatch.active.delete(key);
      const j = ldGet(key, kind);
      if(j && j.state === 'error'){
        if(ldBatch.stop && /Stopped/.test(j.msg)){ ldBatch.done++; continue; }
        ldBatch.failed.push(sym + ' (' + String(j.msg).slice(0, 90) + ')');
        outcome(false);
        if(j.perm || LD_HALT_RE.test(j.msg)){
          halted = true; ldBatch.note = 'Stopped early: ' + String(j.msg).slice(0, 100) + '.'; ldBatch.perm = !!j.perm;
        }
      } else outcome(true);
      ldBatch.done++;
      if(source !== 'strat') setTimeout(batchStockSaved, 1200);   // the saved numbers reach the stock list a moment after the save
      ldBatchPaint();
    }
  };
  await Promise.all(Array.from({ length: maxWorkers }, (_, w) => worker(w)));
  ldBatch.skipped = list.length - ldBatch.done;
  if(ldBatch.stop && !ldBatch.note) ldBatch.note = 'Stopped.';
  ldBatch.running = false; ldBatch.active.clear();
  if(!ldBatch.note) ldBatch.note = 'Finished.';
  {
    // Keep the result in that screen's card for this kind, so later redraws and a run of the other kind do not wipe it.
    const failed = ldBatch.failed.length > 0;
    (ldBatchLast[ldBatch.source] = ldBatchLast[ldBatch.source] || { fund: null, tech: null })[kind] = { state: failed ? 'error' : 'ok', pct: batchPct(), text: !failed && ldBatch.note === 'Finished.' ? 'Done: ' + batchTail() : ldBatch.note + ' ' + batchTail(), perm: ldBatch.perm };
    // Tell the viewer on whatever screen they are on; the notice stays until they close it.
    const refreshed = ldBatch.total - ldBatch.failed.length - ldBatch.skipped, clean = ldBatch.note === 'Finished.';
    activityEnd('batch');
    const kit = getRefreshKit();
    if(!(kit && kit.batchNotice())) activityNotify({
      tone: failed ? (refreshed > 0 ? 'warn' : 'error') : clean ? 'ok' : 'warn',
      title: KIND_NAME[kind] + ' refresh ' + (ldBatch.stop ? 'stopped' : clean ? 'finished' : 'ended early'),
      text: (clean ? '' : ldBatch.note + ' ') + batchTail(), section: sectionOf(ldBatch.source)
    });
  }
  try { refreshAnalysisSoon(); } catch(e){ /* the leaderboard repaints on its next render */ }
  // the refreshed numbers reach the stock list through the live subscription, a moment after the last save, so redraw twice
  const redraw = () => { try { const sec = document.getElementById('section-strategies'); if(sec && sec.classList.contains('active') && !(ldBatch && ldBatch.running)) redrawWhenIdle('strategies', () => renderLoadedPart('strategies')); } catch(e){ /* repaints when opened again */ } };
  if(source === 'strat'){ redraw(); setTimeout(redraw, 1500); }
  else { batchStockSaved(); setTimeout(batchStockSaved, 1500); }
  ldBatchPaint();
}

function getLdBatch(){ return ldBatch; }

export { LD_BATCH_MAX, getLdBatch, ldBatchPaint, ldBatchStart, ldBatchStop };
