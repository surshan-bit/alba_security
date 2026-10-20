// Collects the latest news for a list of stocks on demand (Business page). Headlines come from the TradingView connector
// (one call per stock, newest 40) and are merged into each stock's saved events (stockResearch/<symbol>.events, the same record
// Refresh Fundamental Info keeps, so the price-chart tags and the news counts everywhere see them). New headlines that have no
// positive / negative label yet get one from Claude's cheapest tier. TradingView has no industry news feed, so an industry's
// news is the collected headlines of its stocks.
import { dbCapabilityPromise } from '../core/store.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { pcTickerKey } from '../prices/store.js';
import { tvCall, tvErrorText, tvMcp, tvResolveSymbol } from '../tv/connector.js';
import { ldAskJson, ldEnsureClaudeAccess } from '../livedata/claude.js';
import { claudeStepOn } from '../livedata/claudegate.js';
import { ldApplyLabels, ldBuildEvents, ldLabelPrompt, ldMergeEvents, ldUnlabeledNews } from '../livedata/events.js';

const NEWS_MAX = 30;        // stocks per press (each takes a few seconds); pressing again continues with the next ones
const PARALLEL = 2;
const collected = new Set();   // stocks done this session, so the next press moves on to the others
let run = null;                // { state, label, total, done, added, noFeed, failed: [], note, ctl }

const errText = (e) => (e && (e.message || e.code)) || String(e);
const getNewsRun = () => run;
const keyOf = (s) => pcTickerKey(s);
const evKey = (e) => e.k + '|' + e.d + '|' + e.t;

// Which of `list` the next press works on: ones not collected yet this session; once all are, start over from the top.
function planNews(list){
  const todo = list.filter(s => !collected.has(keyOf(s)));
  if(todo.length) return { stocks: todo.slice(0, NEWS_MAX), left: Math.max(0, todo.length - NEWS_MAX), again: false };
  return { stocks: list.slice(0, NEWS_MAX), left: Math.max(0, list.length - NEWS_MAX), again: true };
}

async function collectOne(s, db, sample, signal){
  const sym = await tvResolveSymbol(s);
  let payload;
  try { payload = await tvCall('mcp-tv-get-news', { symbol: sym, limit: 40 }); }
  catch(e){ if(/does not cover|no news feed/i.test(tvErrorText(e))) return { noFeed: true }; throw e; }
  if(payload && payload.success === false) return { noFeed: true };
  const data = payload && payload.data !== undefined ? payload.data : payload;
  const heads = data && Array.isArray(data.headlines) ? data.headlines : [];
  const fresh = ldBuildEvents(heads, null, null);
  const ref = db.doc('stockResearch/' + sanitizeDocId(tickerSymbol(s)));
  const cur = await ref.get();
  const stored = cur && cur.exists ? ((cur.data() || {}).events || []) : (s.__events || []);
  const seen = new Set((Array.isArray(stored) ? stored : []).map(evKey));
  const added = fresh.filter(e => !seen.has(evKey(e))).length;
  const merged = ldMergeEvents(stored, fresh);
  let labelled = 0;
  const todo = ldUnlabeledNews(merged);
  if(todo.length && sample && claudeStepOn('newsLabels')){
    try { labelled = ldApplyLabels(todo, await ldAskJson(sample, ldLabelPrompt(s.name, todo), { modelTier: 'quick', cache: false, signal })); }
    catch(e){ if(e && e.code === 'cancelled') throw e; /* the headlines are still saved, just without labels */ }
  }
  if(added || labelled){
    if(cur && cur.exists) await ref.update({ events: merged }); else await ref.set({ ticker: tickerSymbol(s), events: merged });
    s.__events = merged;
  }
  return { added };
}

// Runs the collection; onChange() is called on every step (progress) and once more at the end.
async function startNewsCollect(list, label, onChange){
  if(run && run.state === 'running') return;
  const plan = planNews(list);
  const ctl = new AbortController();
  run = { state: 'running', label, total: plan.stocks.length, done: 0, added: 0, noFeed: 0, failed: [], note: plan.left ? plan.left + ' more left: press again to continue.' : '', ctl };
  const r = run, tick = () => onChange(r);
  tick();
  try {
    if(!(await tvMcp())) throw new Error('The TradingView connector is not available in this view.');
    const db = await dbCapabilityPromise;
    if(!db) throw new Error('The database is not available in this view.');
    const sample = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('sample').catch(() => null) : null;
    if(sample && claudeStepOn('newsLabels')) await ldEnsureClaudeAccess();
    let next = 0;
    const worker = async () => {
      while(next < plan.stocks.length && !ctl.signal.aborted){
        const s = plan.stocks[next++];
        try {
          const res = await collectOne(s, db, sample, ctl.signal);
          if(res.noFeed) r.noFeed++; else r.added += res.added;
          collected.add(keyOf(s));
        } catch(e){ r.failed.push(s.name + ' (' + errText(e) + ')'); }
        r.done++; tick();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, plan.stocks.length) }, worker));
    r.state = ctl.signal.aborted ? 'stopped' : 'done';
  } catch(e){ r.state = 'failed'; r.failed.push(errText(e)); }
  tick();
}
function stopNewsCollect(){ if(run && run.state === 'running') run.ctl.abort(); }

export { getNewsRun, planNews, startNewsCollect, stopNewsCollect };
