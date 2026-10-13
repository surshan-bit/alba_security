// The "Track record" panel: the runs saved for the selected strategy, each judged against the goal, plus the overall
// success rate of the runs whose time is up.
import { escapeHtml, tickerSymbol } from '../core/util.js';
import { stockByTickerSymbol, stocks } from '../core/stocks.js';
import { deleteRun, evaluateRun, loadRuns, makeRun, saveRun, savesToAccount } from './tracking.js';
import { loadPriceSet } from './pricedata.js';
import { qualifyingStocks } from './rules.js';
import { askConfirm } from '../ui/confirm.js';

const open = new Set();      // run ids whose pick list is expanded
let renderToken = 0;
const pct = (v, dp = 1) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + v.toFixed(dp) + '%');
const dateText = (ms) => new Date(ms).toISOString().slice(0, 10);
const goalSentence = (g) => `gain at least ${g.target}% within ${g.days} days of the day the list was saved`;
const STATUS = { hit: 'Hit', open: 'Open', miss: 'Missed' };

function pickRows(ev, target){
  const order = { hit: 0, open: 1, miss: 2 };
  return ev.items.slice().sort((a, b) => order[a.ev.status] - order[b.ev.status] || b.ev.retBest - a.ev.retBest).map(({ pick, ev: e }) => `<tr>
      <td><span class="analysis-lb-name">${escapeHtml(pick.name)}</span><span class="analysis-lb-ticker">${escapeHtml(pick.sym)}</span></td>
      <td class="num">${pick.entry.toFixed(2)}</td>
      <td class="num">${(pick.entry * (1 + target / 100)).toFixed(2)}</td>
      <td class="num">${e.now ? e.now.toFixed(2) : '—'}</td>
      <td class="num ${e.retNow > 0 ? 'chg-up' : e.retNow < 0 ? 'chg-down' : ''}">${pct(e.retNow)}</td>
      <td class="num">${pct(e.retBest)}</td>
      <td><span class="trk-status trk-${e.status}">${STATUS[e.status]}</span>${e.status === 'hit' ? ` <span class="learn-sub">${dateText(e.hitMs)}</span>` : ''}</td>
    </tr>`).join('');
}
function runHtml(ev){
  const r = ev.run, n = ev.items.length, c = ev.counts;
  const state = ev.finished ? `Finished &middot; hit rate <b>${(ev.rate * 100).toFixed(0)}%</b>` : `Running until ${dateText(ev.endMs)}`;
  const med = ev.medianDays !== null ? ` &middot; median ${ev.medianDays} day${ev.medianDays === 1 ? '' : 's'} to hit` : '';
  const isOpen = open.has(r.id);
  return `<div class="trk-run" data-run="${escapeHtml(r.id)}">
      <div class="trk-run-head">
        <button type="button" class="trk-toggle" aria-expanded="${isOpen}">${isOpen ? '&#9662;' : '&#9656;'} ${escapeHtml(r.startedAt)}</button>
        <span class="trk-goal"><b>Goal:</b> ${escapeHtml(goalSentence({ target: r.target, days: r.days }))}</span>
        <span class="trk-chips"><span class="trk-status trk-hit">${c.hit} hit</span><span class="trk-status trk-open">${c.open} open</span><span class="trk-status trk-miss">${c.miss} missed</span><span class="learn-sub">of ${n}</span></span>
        <span class="trk-state">${state}${med}</span>
        <button type="button" class="trk-del" aria-label="Delete this tracked list" title="Delete this tracked list">&times;</button>
      </div>
      ${isOpen ? `<div class="trk-legend"><b>Success</b> = the price reaches the <b>Target</b> (entry price +${r.target}%) on any day up to ${dateText(ev.endMs)}. <b>Hit</b>: reached it. <b>Open</b>: not yet, still inside the ${r.days} days. <b>Missed</b>: the ${r.days} days ended without reaching it. <b>Best</b> is the highest gain seen so far.</div><div class="strat-table-wrap"><table class="strat-table"><thead><tr><th>Stock</th><th class="num">Entry</th><th class="num" title="The price that counts as success: the entry price plus the goal's gain">Target</th><th class="num">Now</th><th class="num">Change</th><th class="num">Best</th><th>Result</th></tr></thead><tbody>${pickRows(ev, r.target)}</tbody></table></div>` : ''}
    </div>`;
}

// The goal a new list would be judged by, stated above the lists.
function goalLineHtml(st){
  return `<div class="trk-goalline"><b>Goal for this strategy:</b> ${escapeHtml(goalSentence(st.goal))}.</div>`;
}
function summaryHtml(evals){
  const done = evals.filter(e => e.finished && e.items.length);
  if(!done.length) return '';
  const picks = done.reduce((a, e) => a + e.items.length, 0), hits = done.reduce((a, e) => a + e.counts.hit, 0);
  // the same picks split by the news they had when saved
  const grp = { pos: { n: 0, h: 0 }, neg: { n: 0, h: 0 }, none: { n: 0, h: 0 } };
  done.forEach(e => e.items.forEach(({ pick, ev }) => {
    if(pick.np === undefined) return;
    const k = pick.nn > 0 ? 'neg' : pick.np > 0 ? 'pos' : 'none';
    grp[k].n++; if(ev.status === 'hit') grp[k].h++;
  }));
  const part = (label, x) => x.n ? `<span>${label}: <b>${(100 * x.h / x.n).toFixed(0)}%</b> <span class="learn-sub">(${x.n})</span></span>` : '';
  const split = grp.pos.n + grp.neg.n + grp.none.n ? `<div class="trk-split">By news when saved (last 14 days): ${part('negative news', grp.neg)}${part('positive news only', grp.pos)}${part('no news', grp.none)}</div>` : '';
  return `<div class="trk-summary">Finished lists: <b>${(100 * hits / picks).toFixed(0)}%</b> of ${picks} picks reached the goal (${done.length} list${done.length === 1 ? '' : 's'}).${split}</div>`;
}

// A read that never answers must not leave the panel on "Loading…": give up after a while.
const within = (promise, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timed out')), ms);
  promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
});
const LOAD_MS = 25000;

// Fill the panel body for the selected strategy. Stale results (a newer call started meanwhile) are dropped. The panel is looked up
// again when the answer is ready, because the page may have been redrawn meanwhile. If the saved lists cannot be read the panel says
// so with a "Try again" button; if only the stored price history cannot be read, the lists are still judged, from current prices.
async function renderTrackPanel(st){
  if(!st || !document.getElementById('stratTrackBody')) return;
  const token = ++renderToken;
  const show = (html) => { const b = document.getElementById('stratTrackBody'); if(b && token === renderToken) b.innerHTML = html; };
  let stage = 'reading your saved lists';
  try {
    const all = await within(loadRuns(), LOAD_MS);
    const runs = all.filter(r => r.strategyId === st.id);
    if(!runs.length){ show(`<div class="strat-empty">Nothing tracked yet. Press "Track these picks" above to save today's list, then come back to see how many picks ${escapeHtml(goalSentence(st.goal))}.</div>`); return; }
    stage = 'reading the stored price history';
    let priceSet = new Map(), note = '';
    try { priceSet = await within(loadPriceSet(), LOAD_MS); }
    catch(e){ console.error('Could not load the price history for the track record', e); note = '<div class="learn-hint">The stored weekly price history could not be read, so these results use current prices only. A pick that reached its target earlier in the week may still show as Open.</div>'; }
    if(token !== renderToken) return;
    stage = 'judging the picks';
    const now = Date.now();
    const evals = runs.map(r => evaluateRun(r, priceSet, stockByTickerSymbol, now));
    evals.forEach(ev => { if(ev.changed) saveRun(ev.run); });   // highest price seen so far is kept with the run
    stage = 'drawing the lists';
    show(goalLineHtml(st) + note + summaryHtml(evals) + evals.map(runHtml).join(''));
  } catch(e){
    console.error('Could not show the track record (while ' + stage + ')', e);
    const why = String((e && e.message) || e).slice(0, 160);
    show('<div class="strat-empty">The track record could not be loaded (while ' + stage + ': ' + escapeHtml(why) + '). <button type="button" class="strat-btn" id="stratTrackRetry">Try again</button></div>');
  }
}

function trackPanelHtml(){
  return `<div class="analysis-panel strat-panel">
      <div class="analysis-panel-title">Track record</div>
      ${savesToAccount() ? '' : '<div class="learn-hint">You are not signed in, so tracked lists are kept in this browser only.</div>'}
      <div id="stratTrackBody"><div class="strat-empty">Loading&hellip;</div></div>
    </div>`;
}

// `getTicked()` is the set of symbols ticked in the qualifying table; when it is not empty only those are tracked.
function wireTrackPanel(root, getStrategy, getTicked){
  root.addEventListener('click', async (e) => {
    const st = getStrategy(); if(!st) return;
    if(e.target.closest('#stratTrackRetry')){ renderTrackPanel(st); return; }
    if(e.target.closest('#stratTrackBtn')){
      const ticked = getTicked();
      const all = qualifyingStocks(stocks, st.rules);
      const matches = ticked.size ? all.filter(s => ticked.has(tickerSymbol(s))) : all;
      const run = makeRun(st, matches);
      if(!run.picks.length) return;
      const skipped = matches.length - run.picks.length;
      if(!await askConfirm(`Save ${ticked.size ? 'the ' + run.picks.length + ' ticked' : "today's " + run.picks.length} picks at their current prices and follow them for ${st.goal.days} days?${skipped ? ` (${skipped} without a price cannot be tracked and are left out.)` : ''}`, 'Track these picks')) return;
      await saveRun(run);
      open.add(run.id);
      renderTrackPanel(st);
      return;
    }
    const row = e.target.closest('.trk-run');
    if(!row) return;
    const runs = await loadRuns();
    const run = runs.find(r => r.id === row.dataset.run);
    if(!run) return;
    if(e.target.closest('.trk-del')){
      if(await askConfirm('Delete this tracked list?', 'Delete')){ await deleteRun(run); open.delete(run.id); renderTrackPanel(st); }
    } else if(e.target.closest('.trk-toggle')){
      if(open.has(run.id)) open.delete(run.id); else open.add(run.id);
      renderTrackPanel(st);
    }
  });
}

export { renderTrackPanel, trackPanelHtml, wireTrackPanel };
