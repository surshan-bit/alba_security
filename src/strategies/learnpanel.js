// "Suggest rules from past prices": reads every stored weekly/monthly bar, searches for technical rules that were
// followed by the strategy's goal more often than chance, and lets you apply one. Nothing is changed until you apply.
import { escapeHtml } from '../core/util.js';
import { stockByTickerSymbol, stocks } from '../core/stocks.js';
import { horizonWeeks, goalText } from './goal.js';
import { loadPriceSet } from './pricedata.js';
import { addStockSamples, finishSampleSet, newSampleSet } from './samples.js';
import { learnRules, newsEffect } from './learn.js';
import { newsTimeline } from './news.js';
import { FIELD_BY_ID } from './fields.js';
import { describeRule, qualifyingStocks } from './rules.js';
import { saveStrategies } from './state.js';
import { HORIZONS, applyPractice, hasPractice, practiceHtml, runPractice } from './practice.js';
import { closestEl } from '../core/evt.js';

const results = new Map();    // strategy id -> { key, ... } last result
const running = new Map();    // strategy id -> progress text
const pc = (x) => (100 * x).toFixed(0) + '%';
const goalKey = (st) => st.goal.target + '/' + st.goal.days;
const nextTick = () => new Promise(r => setTimeout(r, 0));

function forgetLearned(id){ results.delete(id); }

function suggestionHtml(sug, k, base, baseHold){
  const rules = sug.rules.map(r => `<li>${escapeHtml(describeRule(r))}</li>`).join('');
  return `<div class="learn-card ${sug.holds ? 'learn-ok' : 'learn-weak'}">
      <ul class="learn-rules">${rules}</ul>
      <div class="learn-stats">
        <span><b>${pc(sug.train.rate)}</b> hit rate in the older period <span class="learn-sub">(all stocks ${pc(base)}, ${sug.train.n.toLocaleString('en-IN')} cases in ${sug.train.stocks} stocks)</span></span>
        <span><b>${pc(sug.hold.rate)}</b> in the newest period <span class="learn-sub">(all stocks ${pc(baseHold)}, ${sug.hold.n.toLocaleString('en-IN')} cases)</span></span>
        <span class="learn-verdict">${sug.holds ? '&#10003; Held up on newer data' : '&#10007; Did not hold up on newer data'}</span>
        <span><b>${sug.nowCount}</b> stock${sug.nowCount === 1 ? '' : 's'} qualify today</span>
      </div>
      <button type="button" class="strat-btn learn-apply" data-k="${k}">Use these rules</button>
    </div>`;
}
function newsHtml(news){
  if(!news) return '';
  if(news.covered < 150) return `<div class="learn-meta"><b>News and events:</b> the saved news record is still short (${news.covered} stock-weeks across ${news.stocks} stock${news.stocks === 1 ? '' : 's'}), so its effect on this goal cannot be measured yet. It grows each time you run Refresh Fundamental Info. You can already use the news rules in a strategy and judge them with "Track these picks".</div>`;
  const g = news.groups;
  const part = (label, x) => x.n ? `<span>${label}: <b>${pc(x.hits / x.n)}</b> <span class="learn-sub">(${x.n.toLocaleString('en-IN')} weeks)</span></span>` : '';
  return `<div class="learn-meta"><b>News and events, so far:</b> share of cases that reached the goal after a week with
      <div class="learn-stats">${part('positive news only', g.pos)}${part('negative news only', g.neg)}${part('both', g.both)}${part('no news', g.none)}</div>
      Based on ${news.covered.toLocaleString('en-IN')} stock-weeks across ${news.stocks} stocks whose news is saved. Small groups are only a hint.</div>`;
}
function learnOutHtml(st){
  const busy = running.get(st.id);
  if(busy) return `<div class="learn-status">${escapeHtml(busy)}</div>`;
  const r = results.get(st.id);
  if(!r || r.key !== goalKey(st)) return '';
  if(r.error) return `<div class="learn-status">${escapeHtml(r.error)}</div>`;
  const cards = r.res.suggestions.map((s, k) => suggestionHtml(s, k, r.res.baseTrain.rate, r.res.baseHold.rate)).join('');
  const none = r.res.suggestions.length ? '' : `<div class="learn-status">No rule did clearly better than chance for this goal.</div>`;
  const anyHolds = r.res.suggestions.some(s => s.holds);
  const verdict = r.res.suggestions.length && !anyHolds ? `<div class="learn-status">None of the rules found held up on the newest data, so the past shows no reliable pattern for this goal. Treat them as ideas only.</div>` : '';
  return `<div class="learn-meta">${r.nStocks} stocks, ${r.res.samples.toLocaleString('en-IN')} past weeks. Goal reached in <b>${pc(r.res.baseTrain.rate)}</b> of cases overall (older period) and <b>${pc(r.res.baseHold.rate)}</b> (newest period).</div>
    ${verdict}${none}<div class="learn-cards">${cards}</div>
    ${newsHtml(r.news)}
    <div class="learn-note">A "hit" means the weekly high reached the target above the next week's opening price within ${horizonWeeks(st.goal)} week${horizonWeeks(st.goal) === 1 ? '' : 's'}. Rules were searched on the older ${pc(0.7)} of the timeline and checked on the rest. The suggested rules use prices only; news is measured separately above because only a short record is saved. Weekly prices are the finest detail used, and past results do not guarantee future ones. Use "Track these picks" to test a rule on real, new prices.</div>`;
}
let tab = 'short';    // which tab of the pop-up is showing: short | medium | long | past
const TABS = [['short', HORIZONS.short.label], ['medium', HORIZONS.medium.label], ['long', HORIZONS.long.label], ['past', 'From past prices']];
function modalBodyHtml(st){
  const tabs = TABS.map(([k, label]) => `<button type="button" class="lm-tab${k === tab ? ' on' : ''}" data-tab="${k}">${label}</button>`).join('');
  const body = tab === 'past'
    ? (results.has(st.id) || running.has(st.id) ? learnOutHtml(st) : '') + `<button type="button" class="strat-btn" id="stratLearnRun">Search past prices for ${escapeHtml(goalText(st.goal))}</button>`
    : practiceHtml(tab);
  return `<div class="lm-tabs">${tabs}</div><div class="lm-pane">${body}</div>`;
}
function renderLearnOut(st){
  const el = document.getElementById('stratLearnBody');
  if(el && st) el.innerHTML = modalBodyHtml(st);
}
// The suggestions open in a pop-up so the Goal section stays compact.
function closeLearnModal(){
  const m = document.getElementById('stratLearnModal');
  if(m) m.remove();
  document.removeEventListener('keydown', onLearnKey, true);
}
function onLearnKey(e){ if(e.key === 'Escape'){ e.stopPropagation(); closeLearnModal(); } }
function openLearnModal(st){
  closeLearnModal();
  const box = document.createElement('div');
  box.id = 'stratLearnModal';
  box.className = 'alba-confirm learn-modal';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.innerHTML = '<div class="alba-confirm-card learn-modal-card"><div class="learn-modal-head"><div class="analysis-panel-title">Suggested rules</div><button type="button" class="strat-btn" id="stratLearnClose">Close</button></div><div id="stratLearnBody" class="learn-modal-body"></div></div>';
  document.body.appendChild(box);
  document.addEventListener('keydown', onLearnKey, true);
  renderLearnOut(st);
}

async function runLearn(st, getStrategy){
  if(running.has(st.id)) return;
  const key = goalKey(st), H = horizonWeeks(st.goal), target = st.goal.target;
  const show = (text) => { running.set(st.id, text); const cur = getStrategy(); if(cur && cur.id === st.id) renderLearnOut(cur); };
  show('Reading stored price history…');
  try {
    const priceSet = await loadPriceSet();
    const entries = [...priceSet.entries()].filter(([, e]) => e.w && e.w.length);
    if(!entries.length){ results.set(st.id, { key, error: 'No weekly price history is stored yet. Refresh technical data for some stocks first.' }); return; }
    const set = newSampleSet();
    let i = 0;
    for(const [sym, e] of entries){
      const stock = stockByTickerSymbol.get(sym);
      addStockSamples(set, i++, e.w, e.m, H, target, stock ? newsTimeline(stock) : null);
      if(i % 40 === 0){ show(`Reading price history… ${i} of ${entries.length} stocks`); await nextTick(); }
    }
    show('Searching for rules…'); await nextTick();
    const data = finishSampleSet(set);
    const res = learnRules(data, H);
    if(!res){ results.set(st.id, { key, error: 'There is not enough price history yet to test rules for this goal.' }); return; }
    res.suggestions.forEach(s => { /** @type {any} */ (s).nowCount = qualifyingStocks(stocks, s.rules).length; });
    results.set(st.id, { key, res, nStocks: entries.length, news: newsEffect(data) });
  } catch(e){
    console.error('Learning rules failed', e);
    results.set(st.id, { key, error: 'Could not learn rules: ' + (e && e.message ? e.message : 'unknown error') });
  } finally {
    running.delete(st.id);
    const cur = getStrategy(); if(cur && cur.id === st.id) renderLearnOut(cur);
  }
}

// Replace the strategy's price-based rules with the suggestion; rules about fundamentals are kept.
function applySuggestion(st, k){
  const r = results.get(st.id);
  if(!r || !r.res || !r.res.suggestions[k]) return false;
  const sug = r.res.suggestions[k];
  const keep = st.rules.filter(x => !(FIELD_BY_ID.get(x.field) || {}).priceBased);
  st.rules = [...keep, ...JSON.parse(JSON.stringify(sug.rules))];
  st.learned = `Learned for ${goalText(st.goal)}: ${pc(sug.train.rate)} hit rate in the older period vs ${pc(r.res.baseTrain.rate)} for all stocks; ${pc(sug.hold.rate)} vs ${pc(r.res.baseHold.rate)} in the newest period${sug.holds ? '' : ' (did not hold up)'}.`;
  saveStrategies();
  return true;
}

function wireLearnPanel(root, getStrategy, rerender){
  const redraw = () => renderLearnOut(getStrategy());
  const ask = (key, refresh) => runPractice(key, redraw, refresh);
  root.addEventListener('click', (e) => {
    const st = getStrategy(); if(!st) return;
    if(e.target.closest('#stratLearn')){
      openLearnModal(st);
      if(tab !== 'past' && !hasPractice(tab)) ask(tab);
    }
  });
  document.addEventListener('click', (e) => {
    const m = document.getElementById('stratLearnModal');
    if(!m || !m.contains(/** @type {Node} */ (e.target)) && e.target !== m) return;
    const st = getStrategy();
    if(e.target === m || closestEl(e, '#stratLearnClose')){ closeLearnModal(); return; }
    if(!st) return;
    const t = closestEl(e, '.lm-tab');
    if(t){ tab = t.dataset.tab; redraw(); if(tab !== 'past' && !hasPractice(tab)) ask(tab); return; }
    const pa = closestEl(e, '.pr-ask');
    if(pa){ ask(pa.dataset.h, !!pa.dataset.refresh); return; }
    if(closestEl(e, '#stratLearnRun')){ runLearn(st, getStrategy); return; }
    const ap = closestEl(e, '.learn-apply');
    if(!ap) return;
    const ok = ap.dataset.pr ? applyPractice(st, ap.dataset.pr, Number(ap.dataset.k)) : applySuggestion(st, Number(ap.dataset.k));
    if(ok){ closeLearnModal(); rerender(); }
  });
}

export { forgetLearned, wireLearnPanel };
