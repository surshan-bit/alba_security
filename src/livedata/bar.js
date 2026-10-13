// Live Data Refresh bar: buttons, progress and job state.
import { stocks } from '../core/stocks.js';
import { getShownIndex } from '../detail/render.js';
import { escapeHtml } from '../core/util.js';
import { fundamentalPendingItems, globalPendingInfo, priceHistoryStatus } from '../detail/pending.js';
import { pcTickerKey } from '../prices/store.js';
import { ldRunFundamental } from './fundamental.js';
import { ldErrText, ldIsClaudeError, setLdPhase } from './claude.js';
import { ldRunTechnical } from './technical.js';
import { getLdBatch, ldBatchPaint } from './batch.js';
import { activityEnd, activityNotify, activityRun } from '../ui/activity.js';
import { getRefreshKit } from '../refresh/hook.js';
import { registerBusy } from '../core/busy.js';

var ldJobs = new Map();    // "<ticker key>|fund" or "|tech" -> { pct, msg, state: 'idle'|'running'|'ok'|'error', at }
registerBusy(() => { for(const j of ldJobs.values()) if(j && j.state === 'running') return true; return false; });
const ldAbort = new Map();   // "<ticker key>|fund" -> AbortController
var ldOpen = false;   // the Live Data Refresh panel on the stock page starts collapsed and is opened when needed
const LD_LABEL = { fund: '↻ Refresh Fundamental Info', tech: '↻ Refresh Technical Info' };

function ldGet(key, kind){ return ldJobs.get(key + '|' + kind) || null; }
function ldRunning(key){
  const a = ldGet(key, 'fund'), b = ldGet(key, 'tech');
  return !!((a && a.state === 'running') || (b && b.state === 'running'));
}
function ldSet(key, kind, patch){
  const cur = ldJobs.get(key + '|' + kind) || { pct: 0, msg: '', state: 'idle' };
  ldJobs.set(key + '|' + kind, Object.assign({}, cur, patch, { at: Date.now() }));
  ldPaint(key);
  if(getLdBatch()) ldBatchPaint();
  ldReportOne(key, kind);
}

// One stock refreshed from its own page: while you are on another screen, the top strip follows it and tells you when it ends.
// (A run inside a batch is reported by the batch.) Nothing is shown while that stock's own panel is on screen.
const LD_KIND_NAME = { fund: 'Fundamental', tech: 'Technical' };
function ldPanelVisible(key){
  const root = document.getElementById('liveRefresh');
  return !!root && root.dataset.key === key && root.offsetParent !== null;
}
function ldInBatch(){ const b = getLdBatch(); return !!(b && b.running); }
function ldReportOne(key, kind){
  if(ldInBatch()) return;
  const id = 'one|' + key + '|' + kind, j = ldGet(key, kind), s = ldStockByKey(key);
  if(!j || !s || j.state !== 'running' || ldPanelVisible(key)){ activityEnd(id); return; }
  activityRun(id, {
    title: 'Refreshing ' + LD_KIND_NAME[kind] + ' Info · ' + s.name, text: j.msg + ' · You can move to other screens. If you close the dashboard it pauses and carries on when it is opened again.', pct: j.pct, section: '',
    onStop: kind === 'fund' ? () => { const c = ldAbort.get(key + '|fund'); if(c) c.abort(); } : null
  });
}
function ldRupees(n){ return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function ldMosText(v){ return v == null || !isFinite(v) ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function ldJson(v, max){
  let t; try { t = JSON.stringify(v); } catch(e){ t = String(v); }
  if(t === undefined) t = 'null';
  return t.length > max ? t.slice(0, max) + '…[truncated]' : t;
}
function ldStockByKey(key){ return stocks.find(x => pcTickerKey(x) === key) || null; }

function ldIdleNote(s, kind){
  if(kind === 'fund'){
    const p = fundamentalPendingItems(s);
    const miss = p.reduce((n, x) => n + x.missing.length, 0);
    const g = globalPendingInfo(s);
    const parts = [];
    if(s.__researchAsof) parts.push('Researched ' + s.__researchAsof); else parts.push('Not researched yet');
    if(miss) parts.push(miss + ' metric' + (miss === 1 ? '' : 's') + ' missing');
    if(g) parts.push('Global & Macro: ' + g);
    return parts.join(' · ') + '.';
  }
  const ps = priceHistoryStatus(s);
  const lp = s.__livePrice ? ('Price ' + ldRupees(s.valuation.currentPrice) + ' as of ' + s.__livePrice.asof + ' · ') : '';
  return lp + 'Price history: ' + ps.text + '.';
}

function renderLiveDataBar(s){
  if(getRefreshKit()) return '';
  const key = pcTickerKey(s);
  const row = (kind, title) => `
      <div class="live-refresh-item" data-kind="${kind}">
        <div class="live-refresh-actions">
          <button type="button" class="refresh-btn" id="ldBtn-${kind}" title="${escapeHtml(title)}">${LD_LABEL[kind]}</button>
          ${kind === 'fund' ? '<button type="button" class="live-stop" id="ldStop-fund" data-ld-stop="fund" hidden>Stop</button><button type="button" class="live-stop" id="ldPerm" title="Opens this page\'s permissions so you can allow Claude" hidden>Open permissions</button>' : ''}
        </div>
        <div class="live-progress" id="ldBar-${kind}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><div class="live-progress-fill" id="ldFill-${kind}"></div></div>
        <div class="live-status" id="ldStatus-${kind}">${escapeHtml(ldIdleNote(s, kind))}</div>
      </div>`;
  return `
    <div class="live-refresh" id="liveRefresh" data-key="${escapeHtml(key)}">
      <button type="button" class="live-refresh-head live-refresh-toggle" id="ldToggle" aria-expanded="${ldOpen}" aria-controls="ldGrid">
        <span class="live-refresh-caret" aria-hidden="true">${ldOpen ? '&#9662;' : '&#9656;'}</span>
        <span class="live-refresh-title">Live Data Refresh</span>
        <span class="live-refresh-chip" id="ldChip"></span>
      </button>
      <div class="live-refresh-grid" id="ldGrid"${ldOpen ? '' : ' hidden'}>
        ${row('fund', 'Fills missing metrics, re-scores Moat and Governance, and refreshes Global & Macro and recent news. Uses TradingView data plus your Claude usage; no web search.')}
        ${row('tech', 'Pulls the current price from TradingView, recomputes Margin of Safety, fetches new weekly and monthly bars, and recomputes MACD, RSI and the Technical Score.')}
      </div>
    </div>`;
}

function ldPaint(key){
  const root = document.getElementById('liveRefresh');
  if(!root || root.dataset.key !== key) return;
  const s = ldStockByKey(key);
  const busy = ldRunning(key);
  // While the panel is collapsed, a running or failed refresh still shows in its heading.
  const chip = document.getElementById('ldChip');
  if(chip){
    const jobs = ['fund', 'tech'].map(k => ldGet(key, k)).filter(Boolean);
    const run = jobs.find(j => j.state === 'running'), bad = jobs.find(j => j.state === 'error');
    chip.textContent = run ? 'Refreshing… ' + Math.round(run.pct) + '%' : bad ? 'Last refresh failed' : '';
    chip.classList.toggle('is-error', !run && !!bad);
  }
  ['fund', 'tech'].forEach(kind => {
    const j = ldGet(key, kind);
    const btn = document.getElementById('ldBtn-' + kind), bar = document.getElementById('ldBar-' + kind);
    const fill = document.getElementById('ldFill-' + kind), st = document.getElementById('ldStatus-' + kind);
    const stop = document.getElementById('ldStop-' + kind);
    const running = !!(j && j.state === 'running');
    if(btn){ btn.disabled = busy; btn.textContent = running ? 'Refreshing…' : LD_LABEL[kind]; }
    const pct = j ? Math.max(0, Math.min(100, Math.round(j.pct))) : 0;
    if(bar){ bar.hidden = !j || j.state === 'idle'; bar.setAttribute('aria-valuenow', String(pct)); }
    if(fill){
      fill.style.width = pct + '%';
      fill.classList.toggle('is-ok', !!(j && j.state === 'ok'));
      fill.classList.toggle('is-error', !!(j && j.state === 'error'));
    }
    if(stop) stop.hidden = !running;
    const permBtn = document.getElementById('ldPerm');
    if(permBtn && kind === 'fund') permBtn.hidden = !(j && j.state === 'error' && j.perm);
    if(st){
      if(j && j.state !== 'idle'){
        st.textContent = (j.state === 'error' ? 'Failed: ' : j.state === 'ok' ? 'Done: ' : pct + '% · ') + j.msg;
        st.classList.toggle('is-error', j.state === 'error');
      } else if(s){
        st.textContent = ldIdleNote(s, kind); st.classList.remove('is-error');
      }
    }
  });
}

function bindLiveDataBar(s){
  const key = pcTickerKey(s);
  const tg = document.getElementById('ldToggle');
  if(tg) tg.onclick = () => {
    ldOpen = !ldOpen;
    tg.setAttribute('aria-expanded', String(ldOpen));
    const grid = document.getElementById('ldGrid'), caret = tg.querySelector('.live-refresh-caret');
    if(grid) grid.hidden = !ldOpen;
    if(caret) caret.innerHTML = ldOpen ? '&#9662;' : '&#9656;';
  };
  const f = document.getElementById('ldBtn-fund'), t = document.getElementById('ldBtn-tech');
  const kit = getRefreshKit();
  if(f) f.onclick = () => (kit ? kit.enqueueOne(s, 'fund') : ldStart(s, 'fund'));
  if(t) t.onclick = () => (kit ? kit.enqueueOne(s, 'tech') : ldStart(s, 'tech'));
  document.querySelectorAll('[data-ld-stop]').forEach(b => {
    b.onclick = () => { const c = ldAbort.get(key + '|' + b.dataset.ldStop); if(c) c.abort(); };
  });
  const pb = document.getElementById('ldPerm');
  if(pb) pb.onclick = ldOpenPermissions;
  ldPaint(key);
}

// Opens the page's permissions panel so the viewer can allow Claude (shared by the stock page and the Analysis screen).
async function ldOpenPermissions(){
  try {
    const perms = await claude.use('permissions');
    if(perms && perms.manage) await perms.manage();
  } catch(e){ /* the panel did not open: the page's Permissions menu has the same switches */ }
}

async function ldStart(s, kind){
  const key = pcTickerKey(s);
  if(ldRunning(key)) return;
  ldSet(key, kind, { state: 'running', pct: 1, msg: 'Starting…', perm: false });
  setLdPhase('tv');
  try {
    const msg = kind === 'fund' ? await ldRunFundamental(s) : await ldRunTechnical(s);
    ldSet(key, kind, { state: 'ok', pct: 100, msg });
  } catch(e){
    const stopped = e && e.code === 'cancelled';
    if(!stopped) console.error('Live Data Refresh failed', kind, e);
    ldSet(key, kind, { state: 'error', pct: (ldGet(key, kind) || {}).pct || 0, perm: kind === 'fund' && ldIsClaudeError(e) && !stopped, msg: stopped ? 'Stopped. Anything already saved was kept.' : ldErrText(e) });
  }
  const sel = stocks[getShownIndex()];
  if(sel && pcTickerKey(sel) === key) ldPaint(key);
  const done = ldGet(key, kind);
  if(done && !ldInBatch() && !ldPanelVisible(key)){
    const stopped = done.state === 'error' && /^Stopped/.test(done.msg);
    activityNotify({ tone: done.state === 'ok' ? 'ok' : stopped ? 'warn' : 'error', title: LD_KIND_NAME[kind] + ' refresh ' + (done.state === 'ok' ? 'finished' : stopped ? 'stopped' : 'failed') + ' · ' + s.name, text: done.msg, section: '' });
  }
}

export { LD_LABEL, bindLiveDataBar, ldAbort, ldGet, ldJson, ldMosText, ldOpenPermissions, ldRunning, ldRupees, ldSet, ldStart, renderLiveDataBar };
