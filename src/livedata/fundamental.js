// Live Data Refresh: Fundamental Info (asks Claude, writes research).
import { dbCapabilityPromise } from '../core/store.js';
import { daysSinceDate, escapeHtml, sanitizeDocId, tickerIndustry, tickerSymbol } from '../core/util.js';
import { marginOfSafety } from '../core/mos.js';
import { fundamentalPendingItems, globalPendingInfo, technicalPendingItems } from '../detail/pending.js';
import { pcTickerKey } from '../prices/store.js';
import { tvCall, tvErrorText, tvIstDate, tvMcp } from '../tv/connector.js';
import { priceJobs, refreshOneNow } from '../prices/refresh.js';
import { ldAbort, ldGet, ldJson, ldSet } from './bar.js';
import { ldAskJson, ldEnsureClaudeAccess, ldErrText, setLdPhase } from './claude.js';
import { claudeAnyOn, claudeStepOn } from './claudegate.js';
import { ldVerifiedSymbol } from './symbols.js';
import { ldApplyLabels, ldBuildEvents, ldLabelPrompt, ldMergeEvents, ldUnlabeledNews } from './events.js';

// Two buttons in each stock's detail view, both run entirely in the page (no Claude conversation is opened):
//   Refresh Technical Info   - TradingView connector: current price, MoS vs the CSV intrinsic value, weekly and monthly bars
//                              (delta only when bars are already stored), MACD/RSI and the Technical Score.
//   Refresh Fundamental Info - TradingView connector data (financials, forecasts, news, filings) is handed to Claude through the
//                              page's `sample` capability, which fills missing metrics, re-scores Moat and Governance and
//                              refreshes Global & Macro. `sample` cannot browse the web: it only sees what the page gives it.
// Results are saved to the same overlay collections the old buttons used (stockResearch, stockUpdates, priceHistory), so every
// other screen keeps working unchanged.

// Writing rules that apply to EVERY piece of Fundamental Score research the page asks Claude to write (and are repeated in the
// "fundamental-research-style" skill). Keep the two in step: change both when the rules change.
var LD_FRESH_DAYS = 30;          // research newer than this (with no newer news and no missing metrics) is not re-run
var ldForce = new Set();         // tickers whose next Fundamental refresh skips the freshness check (set after an 'already up to date' answer)
var LD_STYLE = 'WRITING RULES (apply to every word you write):\n'
  + '1. Write for a business owner who has never studied finance. Use everyday words, no jargon and no abbreviations. Say "profit earned on the money invested in the business" instead of ROCE or ROE, "debt compared with the owners\' own money" instead of D/E, "profit margin" instead of OPM, "cash left after running costs and investments" instead of free cash flow, "price compared with yearly profit" instead of P/E, "price below estimated fair value" instead of margin of safety, "momentum" instead of MACD or RSI. When a figure helps, put it in brackets after the plain statement, for example "Cheaper than most peers (P/E 14.4)". If a technical term is truly unavoidable, explain it in a few words in brackets.\n'
  + '2. Use bullets, not paragraphs. One idea per bullet, under 20 words, starting with the point itself, not with background. Never write a block of prose longer than two short sentences.\n'
  + '3. Lead with what it means for the business or the investor. Say plainly when something could not be found or calculated, and never present a gap as a strength.\n'
  + '4. No hype, no filler, no stacked hedges. Do not repeat the same point in two places.\n\n';

// ------------------------------------------------------------------------------------------------------------------
// Refresh Fundamental Info
// ------------------------------------------------------------------------------------------------------------------

// The checks before anything is read: the database, Claude (when any step uses it) and the TradingView connector.
async function ldPrepare(c){
  const db = await dbCapabilityPromise;
  if(!db) throw new Error('The database is not available in this view.');
  const useClaude = claudeAnyOn();   // every Claude step switched off in Settings: still refresh from TradingView, never contact Claude
  const sample = useClaude && (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('sample').catch(() => null) : null;
  if(useClaude && !sample) throw new Error('Asking Claude from this page is not available in this view.');
  if(useClaude) await ldEnsureClaudeAccess();
  const skippedOff = [];   // steps skipped because Settings > Claude controls turned them off
  const offNote = (id, label) => { if(!claudeStepOn(id)) skippedOff.push(label); return !claudeStepOn(id); };
  if(!(await tvMcp())) throw Object.assign(new Error('The TradingView connector is not available in this view.'), { code: 'no_mcp' });
  Object.assign(c, { db, sample, useClaude, skippedOff, offNote });
}

// Reads what TradingView can tell us about the company: financials, forecasts, news, filings and the text of up to 3 free stories.
async function ldGather(c){
  const { s, set, halt } = c;
  // ---- Gather what TradingView can tell us about this company (the only outside data Claude will see) ----
  set(5, 'Finding the TradingView symbol…');
  const sym = (await ldVerifiedSymbol(s)).sym; halt();
  const grab = async (tool, input) => {
    try { const r = await tvCall(tool, input); return (r && r.data !== undefined) ? r.data : r; }
    catch(e){ return { unavailable: tvErrorText(e) }; }
  };
  set(9, 'Reading TradingView financials…');
  const [finTtm, finFy] = await Promise.all([grab('mcp-tv-get-financials', { symbol: sym, period: 'ttm' }), grab('mcp-tv-get-financials', { symbol: sym, period: 'fy' })]); halt();
  set(14, 'Reading analyst forecasts…');
  const fc = await grab('mcp-tv-get-forecasts', { symbol: sym }); halt();
  set(18, 'Reading recent news and filings…');
  // News is read 40 deep (and results / corporate-event dates alongside) so the price chart can tag past events; Claude still sees only the newest 15.
  const [newsRaw, docsRaw, earnRaw, corpRaw] = await Promise.all([grab('mcp-tv-get-news', { symbol: sym, limit: 40 }), grab('mcp-tv-get-documents', { symbol: sym, limit: 8 }), grab('mcp-tv-get-documents', { symbol: sym, event: 'earning', limit: 40 }), grab('mcp-tv-get-documents', { symbol: sym, event: 'corporate_event', limit: 20 })]); halt();
  const allHeads = (newsRaw && Array.isArray(newsRaw.headlines)) ? newsRaw.headlines : [];
  const heads = allHeads.slice(0, 15);
  const news = heads.map(h => ({
    id: h.id, title: h.title, source: h.provider && h.provider.name ? h.provider.name : '',
    date: h.published ? tvIstDate(h.published) : '', url: h.link || ''
  }));
  const allowedUrls = new Set(news.map(n => n.url).filter(u => /^https?:\/\//i.test(u)));
  const stories = [];
  for(const h of heads.filter(x => x && x.paywall === false).slice(0, 3)){
    halt();
    set(22 + stories.length * 2, 'Reading news story ' + (stories.length + 1) + '…');
    const st = await grab('mcp-tv-get-news-story', { id: h.id });
    const body = st && (st.summary || st.short_description) ? { summary: st.summary, short: st.short_description } : null;
    if(body) stories.push({ title: h.title, url: h.link, text: ldJson(body, 1500) });
  }
  const gotAnything = [finTtm, finFy, fc, newsRaw, docsRaw].some(x => x && !x.unavailable);
  if(!gotAnything) throw new Error('TradingView returned no data for ' + sym + '.');
  Object.assign(c, { sym, finTtm, finFy, fc, docsRaw, earnRaw, corpRaw, allHeads, news, allowedUrls, stories });
}

// Saves the dated events for the price chart and labels the headlines that have no label yet.
async function ldSaveEvents(c){
  const { s, sym0, docId, set, halt, signal, notes, failed, db, sample, offNote, earnRaw, corpRaw, allHeads, news } = c;
  // Save the dated events for the price chart (no Claude involved). A failure here never stops the refresh.
  try {
    const fresh = ldBuildEvents(allHeads, earnRaw, corpRaw);
    if(fresh.length){
      const eref = db.doc('stockResearch/' + docId);
      const ecur = await eref.get();
      const merged = ldMergeEvents(ecur && ecur.exists ? (ecur.data() || {}).events : [], fresh);
      // Label the headlines that have no positive / negative label yet (cheapest model tier, only the unlabelled ones).
      const todo = ldUnlabeledNews(merged);
      if(todo.length && !offNote('newsLabels', 'news labels')){
        try {
          halt();
          c.labelled = ldApplyLabels(todo, await ldAskJson(sample, ldLabelPrompt(s.name, todo), { modelTier: 'quick', cache: false, signal }));
          if(c.labelled) notes.push(c.labelled + ' headline' + (c.labelled === 1 ? '' : 's') + ' c.labelled positive, negative or neutral');
        } catch(e){ if(e && e.code === 'cancelled') throw e; failed.push('news labels (' + ldErrText(e) + ')'); }
      }
      if(ecur && ecur.exists) await eref.update({ events: merged }); else await eref.set({ ticker: sym0, events: merged });
      s.__events = merged;   // show the tags now; the saved document will replace this through the live overlay
      notes.push(fresh.length + ' dated event' + (fresh.length === 1 ? '' : 's') + ' tagged on the price chart');
    }
  } catch(e){ failed.push('chart event tags (' + ldErrText(e) + ')'); }
}

// The pieces every Claude call is built from: the TradingView sections, the factor list, the shared prompt head and `ask`.
function ldPromptKit(c){
  const { s, key, today, set, halt, signal, sample, sym, finTtm, finFy, fc, docsRaw, news, stories } = c;
  // Each Claude call below gets only the TradingView sections it needs (the caps are per section), not the whole bundle.
  const TV = {
    fin: () => 'FINANCIALS TTM: ' + ldJson(finTtm, 3500) + '\nFINANCIALS LAST FISCAL YEAR: ' + ldJson(finFy, 3500),
    finLite: () => 'FINANCIALS LAST FISCAL YEAR: ' + ldJson(finFy, 2000),
    fc: () => 'ANALYST FORECASTS (check quality_note; ignore price targets it flags): ' + ldJson(fc, 2500),
    fcLite: () => 'ANALYST FORECASTS (check quality_note; ignore price targets it flags): ' + ldJson(fc, 1500),
    news: () => 'RECENT NEWS HEADLINES (title, source, date, url): ' + ldJson(news, 5000),
    newsLite: () => 'RECENT NEWS HEADLINES (title, source, date, url): ' + ldJson(news.slice(0, 8), 2500),
    stories: () => 'NEWS STORY EXCERPTS: ' + ldJson(stories, 4500),
    docs: () => 'FILINGS AND TRANSCRIPTS LIST: ' + ldJson(docsRaw, 3000)
  };

  const factors = (s.fundamentals && Array.isArray(s.fundamentals.factors)) ? s.fundamentals.factors : [];
  const factorLine = f => '- key "' + f.key + '" | ' + String(f.name).replace(/&amp;/g, '&') + ' | weight ' + f.weight + ' | score ' + (typeof f.score === 'number' ? f.score.toFixed(2) : 'n/a') + ' | metrics ' + ldJson(f.metrics || [], 900);
  // headFor(factorKeys, tvSections): the shared prompt prefix, limited to the factors and TradingView sections one call needs.
  const headFor = (factorKeys, tvSections) => LD_STYLE + 'Company: ' + s.name + ' (' + sym + '), industry: ' + tickerIndustry(s) + '. Today: ' + today + '. Overall Fundamental Score: ' + (s.score != null ? Number(s.score).toFixed(2) : 'n/a') + '/10.\nYou cannot browse the web. Everything you know about this company\'s current situation must come from the TRADINGVIEW DATA below; use general background knowledge only for stable facts (business model, industry structure) and say so. Never invent figures, dates, URLs or sources.\n\n' +
    (factorKeys && factorKeys.length ? 'FUNDAMENTAL SCORE FACTORS:\n' + factors.filter(f => factorKeys.includes(f.key)).map(factorLine).join('\n') + '\n\n' : '') +
    (tvSections && tvSections.length ? 'TRADINGVIEW DATA:\n' + tvSections.map(k => TV[k]()).join('\n') + '\n\n' : '');
  // Streams nudge the bar between two values while Claude writes.
  const nudge = (from, to, expected) => ({ text }) => set(Math.min(to, from + (to - from) * Math.min(1, text.length / expected)), ldGet(key, 'fund').msg);
  const ask = (prompt, from, to, expected, tier) => {
    halt();
    return ldAskJson(sample, prompt, { modelTier: tier || 'quick', cache: false, signal, onText: nudge(from, to, expected) });
  };
  Object.assign(c, { factors, headFor, ask });
}

// Works out what is missing and whether the research is recent enough to leave alone. Returns the "Already up to date" answer, or null to go on.
function ldCheckFresh(c){
  const { s, key, failed, news } = c;
  // ---- 1. Missing metrics not available in the CSV ----
  setLdPhase('claude');
  const pend = fundamentalPendingItems(s);
  const withGaps = pend.filter(x => x.missing.length);
  // Skip the Claude calls when nothing would change: research is recent, no metric is missing and TradingView shows no news newer than it.
  const asofR = s.__researchAsof ? String(s.__researchAsof).slice(0, 10) : null;
  const newestNews = news.reduce((m, n) => (n.date && n.date > m ? n.date : m), '');
  const researchFresh = !!asofR && daysSinceDate(asofR) !== null && daysSinceDate(asofR) <= LD_FRESH_DAYS && !(newestNews && newestNews > asofR);
  const forced = ldForce.has(key);
  // Global & Macro with nothing in it counts as missing, so a stock whose earlier Global & Macro step failed is not skipped as 'up to date'.
  const gfMissing = globalPendingInfo(s) === 'not yet researched';
  if(researchFresh && !withGaps.length && !forced && !gfMissing){
    ldForce.add(key); setTimeout(() => ldForce.delete(key), 120000);
    return 'Already up to date: researched ' + asofR + ', no missing metrics and no newer news' + (newestNews ? ' (latest ' + newestNews + ')' : '') + '. ' + (c.labelled ? 'Claude only c.labelled ' + c.labelled + ' news headline' + (c.labelled === 1 ? '' : 's') + ' for the price chart.' : 'No Claude usage.') + ' Click again within 2 minutes to refresh anyway.';
  }
  ldForce.delete(key);
  const needCards = !researchFresh || forced;   // factor cards, Global & Macro and the summary only when stale, newer news exists, or forced
  Object.assign(c, { pend, withGaps, gfMissing, needCards });
}

// 1. Missing metrics not available in the CSV.
async function ldFillMissingMetrics(c){
  const { s, key, set, notes, failed, offNote, fc, factors, headFor, ask, withGaps } = c;
  const upd = {};   // factor key -> { score?, note?, metrics?, research? }
  let metricsFilled = 0;
  if(withGaps.length && !offNote('missingMetrics', 'missing metrics')){
    set(34, 'Looking for missing metrics in the TradingView data…');
    try {
      const r = await ask(headFor(withGaps.map(x => x.key), ['fin', 'fc']) + 'TASK: These metrics are "n/a" in the screener.in CSV import: ' + withGaps.map(x => '[' + x.key + '] ' + x.missing.join(', ')).join('; ') + '.\nFor each, give a value ONLY when the TradingView data above directly provides it or it follows from it by simple arithmetic you can state. Otherwise leave it out; do not estimate. Format a value the way a similar metric on the card is shown, with its unit (for example "12.4%" or "Rs 5,076 Cr"), and add the basis in "note".\nReply with only JSON: {"factors":{"<factor key>":{"metrics":{"<metric label exactly as listed>":"<value>"},"note":"<one sentence on the basis>"}}}', 34, 46, 1200);
      withGaps.forEach(x => {
        const o = r && r.factors && r.factors[x.key];
        if(!o || !o.metrics || typeof o.metrics !== 'object') return;
        const m = {};
        x.missing.forEach(label => {
          const val = o.metrics[label];
          if((typeof val === 'string' || typeof val === 'number') && String(val).trim() && String(val).trim().toLowerCase() !== 'n/a'){ m[label] = String(val).trim().slice(0, 60); metricsFilled++; }
        });
        if(Object.keys(m).length){ upd[x.key] = { metrics: m, note: typeof o.note === 'string' ? o.note.slice(0, 300) : undefined }; }
      });
      notes.push(metricsFilled ? metricsFilled + ' missing metric' + (metricsFilled === 1 ? '' : 's') + ' filled' : 'no missing metric could be found in the TradingView data');
    } catch(e){
      if(e && e.code === 'cancelled') throw e;
      failed.push('missing metrics (' + ldErrText(e) + ')');
    }
  } else {
    set(46, 'No missing metrics to look up.');
  }
  Object.assign(c, { upd, metricsFilled });
}

// 2. Every factor card: Traditional Analysis and Buffett-Style Analysis. Moat and Governance may get a new score.
async function ldRefreshCards(c){
  const { s, key, today, set, notes, failed, offNote, news, allowedUrls, stories, factors, headFor, ask, pend, needCards, upd } = c;
  // ---- 2. Every factor card: Traditional Analysis and Buffett-Style Analysis ----
  // Moat and Governance (and any other data-proxy factor) may get a new score. The engine-scored factors keep their CSV score;
  // only their written research (headline, summary, positives, negatives, sources, date) is refreshed.
  const SCORABLE = new Set(['moat', 'gov']);
  pend.forEach(x => { if(x.proxy) SCORABLE.add(x.key); });
  const TRAD = ['fin', 'prof', 'growth', 'val'];
  const groups = [
    { step: 'tradCards', label: 'Traditional Analysis', keys: factors.filter(f => TRAD.includes(f.key)).map(f => f.key), from: 48, to: 60, tier: 'quick', tv: ['fin', 'fcLite', 'newsLite'] },
    { step: 'buffettCards', label: 'Buffett-Style Analysis', keys: factors.filter(f => !TRAD.includes(f.key)).map(f => f.key), from: 60, to: 74, tier: 'quick', tv: ['finLite', 'fcLite', 'news', 'stories', 'docs'] }
  ].filter(g => g.keys.length);
  const cardGroups = needCards ? groups.filter(g => !offNote(g.step, g.label)) : [];
  const scoreNotes = [];
  let cardsRefreshed = 0;
  for(const g of cardGroups){
    set(g.from, 'Refreshing ' + g.label + '…');
    try {
      const listing = g.keys.map(k => '"' + k + '" (' + (SCORABLE.has(k) ? 'you may re-score it' : 'scored mechanically, do not return a score') + ')').join(', ');
      const r = await ask(headFor(g.keys, g.tv) + 'TASK: Refresh the written analysis on these Fundamental Score factor cards (' + g.label + '): ' + listing + '.\nFor each, write a one-sentence plain-English headline, 3 or 4 short bullet "points" on what it means for the business (these replace a paragraph), and up to 4 positives and up to 4 negatives as short bullets, based on the latest TradingView data above (TTM and fiscal-year financials, current price, forecasts, news, filings) together with that factor\'s own metrics. Replace out-of-date statements with what the latest data shows.\nMoat: brand and pricing power, market position, switching costs, scale or cost advantages, threats, durability of returns on capital. Governance: promoter record, related-party dealings, auditor and disclosure quality, regulatory or legal actions, capital allocation, management changes, pledge and holding trend.\nScoring: for a factor marked "you may re-score it", give a new score between 0 and its weight and change it from the current score only when the supplied data supports that; otherwise return the current score. For every other factor do not return a score; if the latest data clearly disagrees with its mechanical score, say so in the summary. Never invent figures. Say plainly when a figure is not available instead of treating the gap as a strength. "sources" may list only items from the supplied news or filings (title plus the exact url given), otherwise an empty list.\nReply with only JSON: {"factors":{"<key>":{"score":<number, only where allowed>,"note":"<one sentence, only where a score is returned>","research":{"headline":"<one plain sentence>","points":["<short bullet>"],"positives":["<short bullet>"],"negatives":["<short bullet>"],"sources":[{"title":"...","url":"..."}]}}}}', g.from, g.to, 3800, g.tier);
      g.keys.forEach(k => {
        const o = r && r.factors && r.factors[k], f = factors.find(x => x.key === k);
        if(!o || !f || !o.research || typeof o.research.headline !== 'string' || !o.research.headline.trim()) return;
        const strs = (a, n) => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && x.trim()).slice(0, n).map(x => x.trim().slice(0, 300));
        const srcs = (Array.isArray(o.research.sources) ? o.research.sources : []).filter(x => x && typeof x.url === 'string' && allowedUrls.has(x.url)).slice(0, 5).map(x => ({ title: String(x.title || x.url).slice(0, 160), url: x.url }));
        let pts = strs(o.research.points, 4);
        if(!pts.length && typeof o.research.summary === 'string') pts = (o.research.summary.match(/[^.!?]+[.!?]*/g) || []).map(x => x.trim()).filter(Boolean).slice(0, 3).map(x => x.slice(0, 200));
        const entry = upd[k] || {};
        const w = Number(f.weight);
        if(SCORABLE.has(k)){
          let sc = Number(o.score);
          sc = isFinite(sc) && isFinite(w) ? Math.round(Math.max(0, Math.min(w, sc)) * 100) / 100 : undefined;
          entry.score = sc;
          if(typeof o.note === 'string' && o.note.trim()) entry.note = o.note.trim().slice(0, 300);
          const nm = String(f.name).replace(/&amp;/g, '&');
          scoreNotes.push(sc !== undefined && typeof f.score === 'number' && Math.abs(sc - f.score) >= 0.005 ? nm + ' ' + f.score.toFixed(2) + ' → ' + sc.toFixed(2) : null);
        }
        entry.research = { asof: today, headline: o.research.headline.trim().slice(0, 240), points: pts, positives: strs(o.research.positives, 4), negatives: strs(o.research.negatives, 4), sources: srcs };
        upd[k] = entry;
        cardsRefreshed++;
      });
    } catch(e){
      if(e && e.code === 'cancelled') throw e;
      failed.push(g.label + ' (' + ldErrText(e) + ')');
    }
  }
  if(cardsRefreshed) notes.push(cardsRefreshed + ' factor card' + (cardsRefreshed === 1 ? '' : 's') + ' refreshed');
  else if(cardGroups.length && !failed.length) failed.push('factor cards (Claude returned nothing usable)');
  const scoreChanges = scoreNotes.filter(Boolean);
  Object.assign(c, { scoreChanges });
}

// Saves the fundamental findings now, so a later failure in Global & Macro does not lose them.
async function ldSaveResearch(c){
  const { s, sym0, docId, today, set, notes, db, factors, upd, metricsFilled, scoreChanges } = c;
  // Save the fundamental findings now, so a later failure in Global & Macro does not lose them.
  if(Object.keys(upd).length){
    set(76, 'Saving fundamental research…');
    setLdPhase('tv');
    const rref = db.doc('stockResearch/' + docId);
    const rcur = await rref.get();
    const rdata = rcur && rcur.exists ? rcur.data() : null;
    const merged = Object.assign({}, (rdata && rdata.factors) || {});
    Object.keys(upd).forEach(k => {
      const o = merged[k] ? Object.assign({}, merged[k]) : {}, n = upd[k];
      if(n.score !== undefined) o.score = n.score;
      if(n.note) o.note = n.note;
      if(n.research) o.research = n.research;
      if(n.metrics) o.metrics = Object.assign({}, o.metrics || {}, n.metrics);
      merged[k] = o;
    });
    const changeNote = (scoreChanges.concat(metricsFilled ? [metricsFilled + ' metric(s) filled'] : [])).join('; ') || 'Refreshed from the screener page';
    const body = { ticker: sym0, asof: today, changeNote, factors: merged };
    if(rdata) await rref.update(body); else await rref.set(body);
    if(scoreChanges.length) notes.push(scoreChanges.join(', '));
  }
}

// 3. Global & Macro plus recent news.
async function ldGlobalMacro(c){
  const { s, sym0, docId, today, set, notes, failed, db, offNote, news, allowedUrls, stories, headFor, ask, gfMissing, needCards } = c;
  // ---- 3. Global & Macro plus recent news ----
  setLdPhase('claude');
  let gfOut = null;
  const needGlobal = (needCards || gfMissing) && !offNote('globalMacro', 'Global & Macro');
  if(needGlobal) set(78, 'Researching Global & Macro and recent news…');
  if(needGlobal) try {
    const g0 = s.globalFactors || {};
    const r = await ask(headFor(null, ['news', 'stories', 'docs']) + 'TASK: Write this company\'s Global & Macro Information: macro, commodity, currency and trade-policy linkages that could move its price, plus recent company-specific news and events from the last few weeks that matter for a decision now.\nRules: at most 5 positive and 5 negative items, each one short bullet-style sentence under 25 words. Each item needs "source": a news item or filing from the supplied data (use "<provider>, <date>" and its exact url), or, for a general sector or macro linkage the supplied data does not cover, the source "Claude analysis, no live source" with url "". Never invent a url. Prefer items backed by the supplied news. Current stored sector label: ' + (g0.sectorLabel || 'none') + '.\nALSO add "events": up to 4 CRITICAL news items or world events (wars and geopolitical conflicts, sanctions, oil or commodity shocks, major policy, tariff or regulatory changes, big currency or interest-rate moves) that could materially affect THIS company, even indirectly (for example how a Middle East conflict could change crude oil, freight or input costs for this business). Use events found in the supplied news first; you may add well-known major events from your own knowledge, but say so in the source ("Claude knowledge, may be dated") and never claim a recent event you cannot support. Each event: "headline" (under 12 words), "impact" ("positive", "negative" or "mixed"), "why" (one plain sentence under 30 words on how it reaches this company: cost, demand, currency or regulation), "source" and "url" as above. If nothing critical applies, return an empty list.\nReply with only JSON: {"positive":[{"text":"...","source":"...","url":"..."}],"negative":[{"text":"...","source":"...","url":"..."}],"events":[{"headline":"...","impact":"negative","why":"...","source":"...","url":"..."}]}', 78, 83, 3200, 'quick');
    const clean = a => (Array.isArray(a) ? a : []).filter(x => x && typeof x.text === 'string' && x.text.trim()).slice(0, 5).map(x => {
      const url = typeof x.url === 'string' && allowedUrls.has(x.url) ? x.url : '';
      return { text: escapeHtml(x.text.trim().slice(0, 400)), source: escapeHtml(String(x.source || 'Claude analysis, no live source').slice(0, 120)), url };
    });
    const pos = clean(r && r.positive), neg = clean(r && r.negative);
    const events = (Array.isArray(r && r.events) ? r.events : []).filter(x => x && typeof x.headline === 'string' && x.headline.trim()).slice(0, 4).map(x => ({
      headline: escapeHtml(x.headline.trim().slice(0, 160)),
      impact: ['positive', 'negative', 'mixed'].indexOf(x.impact) >= 0 ? x.impact : 'mixed',
      why: escapeHtml(String(x.why || '').trim().slice(0, 400)),
      source: escapeHtml(String(x.source || 'Claude analysis, no live source').slice(0, 120)),
      url: typeof x.url === 'string' && allowedUrls.has(x.url) ? x.url : ''
    }));
    if(!pos.length && !neg.length) throw new Error('Claude returned no usable items.');
    const sourced = pos.concat(neg).some(x => x.url);
    const gf = { scope: sourced ? 'company' : (g0.scope || 'sector'), asof: today, positive: pos, negative: neg, events };
    if(!sourced && g0.sectorLabel) gf.sectorLabel = g0.sectorLabel;
    setLdPhase('tv');
    set(84, 'Saving Global & Macro…');
    const uref = db.doc('stockUpdates/' + docId);
    const ucur = await uref.get();
    if(ucur && ucur.exists) await uref.update({ globalFactors: gf }); else await uref.set({ ticker: sym0, globalFactors: gf });
    gfOut = { pos, neg };
    notes.push('Global & Macro: ' + pos.length + ' positive, ' + neg.length + ' negative, ' + events.length + ' critical event' + (events.length === 1 ? '' : 's') + (sourced ? '' : ' (no source links, general analysis only)'));
  } catch(e){
    if(e && e.code === 'cancelled') throw e;
    failed.push('Global & Macro (' + ldErrText(e) + ')');
  }
  Object.assign(c, { gfOut });
}

// 4. Technical signals: fill in what is missing from TradingView bars.
async function ldTechnicalSignals(c){
  const { s, key, set, halt, notes, failed } = c;
  // ---- 4. Technical signals: fill in what is missing from TradingView bars ----
  setLdPhase('tv');
  try {
    const tp = technicalPendingItems(s);
    if(tp.none || tp.keys.length || tp.noScore){
      set(85, 'Technical signals are incomplete, updating them from TradingView…');
      await refreshOneNow(s);
      halt();
      const jt = priceJobs.get(key);
      if(!jt || jt.state !== 'ok') throw new Error((jt && jt.msg) ? jt.msg : 'The price history refresh did not finish.');
      notes.push('Technical signals updated (' + jt.msg + ')');
    } else {
      notes.push('Technical signals already complete');
    }
  } catch(e){
    if(e && e.code === 'cancelled') throw e;
    failed.push('Technical signals (' + ldErrText(e) + ')');
  }
}

// 5. Strengths and Watch-outs box, rewritten from everything above.
async function ldStrengths(c){
  const { s, key, sym0, docId, today, set, notes, failed, db, offNote, news, factors, headFor, ask, needCards, upd, metricsFilled, gfOut } = c;
  // ---- 5. Strengths and Watch-outs box, rewritten from everything above ----
  setLdPhase('claude');
  const doStrengths = (needCards || metricsFilled) && !offNote('strengths', 'Strengths and Watch-outs');
  if(doStrengths) set(90, 'Reviewing the Strengths and Watch-outs…');
  if(doStrengths) try {
    const v = s.valuation || {};
    const ivNow = typeof v.intrinsicValue === 'number' && v.intrinsicValue > 0 ? v.intrinsicValue : null;
    const pxNow = typeof v.currentPrice === 'number' ? v.currentPrice : null;
    const mosNow = marginOfSafety(ivNow, pxNow);
    const state = factors.map(f => {
      const u = upd[f.key] || {};
      const score = u.score !== undefined ? u.score : f.score;
      const hl = (u.research && u.research.headline) || (f.research && f.research.headline) || '';
      return '- ' + String(f.name).replace(/&amp;/g, '&') + ' (key "' + f.key + '"): ' + (typeof score === 'number' ? Number(score).toFixed(2) : 'n/a') + ' of ' + f.weight + (hl ? ' | ' + hl : '') + ' | metrics ' + ldJson(f.metrics || [], 500);
    }).join('\n');
    const gfText = gfOut ? 'POSITIVE: ' + gfOut.pos.map(x => x.text).join(' | ') + '\nNEGATIVE: ' + gfOut.neg.map(x => x.text).join(' | ') : ldJson(s.globalFactors || null, 1500);
    const r = await ask(headFor(null, ['newsLite']) + 'LATEST FACTOR STATE (scores include the changes made just now):\n' + state + '\n\nPRICE AND VALUE: current price ' + (pxNow != null ? pxNow : 'n/a') + ', CSV intrinsic value ' + (ivNow != null ? ivNow : 'n/a') + ', margin of safety ' + (mosNow != null ? mosNow.toFixed(1) + '%' : 'n/a') + '.\n\nGLOBAL & MACRO JUST WRITTEN:\n' + gfText + '\n\nTASK: Write the Strengths and Watch-outs box shown at the top of this stock\'s Fundamental Score panel, for an investor who is not a specialist.\nRules: at most 4 strengths and 4 watch-outs, one short plain-English bullet each (under 20 words). Base every point on a factor above, the margin of safety, or the supplied TradingView data and news; mention a recent event only if the news supports it. Merge overlapping points. A missing or incalculable figure is never a strength; mention it as a watch-out only when it genuinely limits how far the score can be trusted, and say that in plain words. Do not restate scores as numbers unless a ratio helps. "tone" for a strength is "strong" or "good"; for a watch-out "caution" or "concern".\nReply with only JSON: {"strengths":[{"text":"...","tone":"strong"}],"watchouts":[{"text":"...","tone":"caution"}]}', 90, 95, 1500);
    const take = (a, ok, dflt) => (Array.isArray(a) ? a : []).filter(x => x && typeof x.text === 'string' && x.text.trim()).slice(0, 4)
      .map(x => ({ text: x.text.trim().slice(0, 260), tone: ok.includes(x.tone) ? x.tone : dflt }));
    const strengths = take(r && r.strengths, ['strong', 'good'], 'good');
    const watchouts = take(r && r.watchouts, ['caution', 'concern'], 'caution');
    if(!strengths.length && !watchouts.length) throw new Error('Claude returned no usable points.');
    setLdPhase('tv');
    set(97, 'Saving the Strengths and Watch-outs…');
    const sref = db.doc('stockResearch/' + docId);
    const scur = await sref.get();
    const summary = { asof: today, strengths, watchouts };
    if(scur && scur.exists) await sref.update({ summary }); else await sref.set({ ticker: sym0, asof: today, factors: {}, summary });
    notes.push('Strengths and Watch-outs rewritten (' + strengths.length + ' and ' + watchouts.length + ')');
  } catch(e){
    if(e && e.code === 'cancelled') throw e;
    failed.push('Strengths and Watch-outs (' + ldErrText(e) + ')');
  }
}

// The answer shown when the run ends: what was done, what was not, and what was switched off in Settings.
function ldFinish(c){
  const { notes, failed, skippedOff, useClaude } = c;
  if(!notes.length && failed.length) throw new Error('Nothing was saved. ' + failed.join('; ') + '.');
  const offText = skippedOff.length ? ' Turned off in Settings: ' + skippedOff.join(', ') + '.' : '';
  return (notes.join('. ') || 'Finished') + '.' + (failed.length ? ' Not done: ' + failed.join('; ') + '.' : '') + offText + (useClaude ? ' Based on TradingView data and Claude, without web search.' : ' Based on TradingView data only.');
}

// The run is a fixed sequence of steps that share one `c` (the stock, the progress and cancel helpers, the notes and failures so far, and what
// each step found). A step that cannot go on throws; one that only fails to add something records it in `c.failed` and the run carries on.
async function ldRunFundamental(s){
  const key = pcTickerKey(s), sym0 = tickerSymbol(s), docId = sanitizeDocId(sym0), today = tvIstDate();
  const set = (pct, msg) => ldSet(key, 'fund', { state: 'running', pct, msg });
  const ctl = new AbortController();
  ldAbort.set(key + '|fund', ctl);
  const signal = ctl.signal;
  const halt = () => { if(signal.aborted) throw { code: 'cancelled' }; };
  const c = { s, key, sym0, docId, today, set, halt, signal, notes: [], failed: [], labelled: 0 };   // labelled: news headlines labelled by Claude in this run
  try {
    setLdPhase('tv');
    set(2, 'Preparing…');
    await ldPrepare(c);
    await ldGather(c);
    await ldSaveEvents(c);
    ldPromptKit(c);
    const upToDate = ldCheckFresh(c);
    if(upToDate) return upToDate;
    await ldFillMissingMetrics(c);
    await ldRefreshCards(c);
    await ldSaveResearch(c);
    await ldGlobalMacro(c);
    await ldTechnicalSignals(c);
    await ldStrengths(c);
    return ldFinish(c);
  } finally {
    ldAbort.delete(key + '|fund');
  }
}


// The refresh kit asks for these stocks because they are out of date for their tier, so the 30-day skip must not apply to them.
function ldForceKeys(keys){ keys.forEach(k => { ldForce.add(k); setTimeout(() => ldForce.delete(k), 3600000); }); }
export { ldForceKeys, ldRunFundamental };
