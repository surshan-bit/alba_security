// Refresh News: the market pulse tiles (TradingView quotes) and the three "why" lines (Claude, from those numbers only).
// The same button refreshes the economic calendar (TradingView) and the briefings (TradingView headlines, summarised by Claude). The upcoming stock events are written from a research session.
import { dbCapabilityPromise } from '../core/store.js';
import { tvCall, tvErrorText, tvMcp } from '../tv/connector.js';
import { ldAskJson, ldEnsureClaudeAccess, ldErrText } from '../livedata/claude.js';
import { claudeStepOn } from '../livedata/claudegate.js';
import { BRIEFING_FEEDS, PULSE_SYMBOLS, briefingsPrompt, buildCalendar, buildTiles, cleanBriefings, cleanReading, mergeHeadlines, nextBigEvents, readingPrompt } from './model.js';
import { news } from './store.js';

const MIN_TILES = 3;     // fewer quotes than this is treated as a failed fetch
const BIG_EVENTS = 3;    // upcoming events handed to Claude for the reading
/** @type {{ state: string, msg: string }} */
let run = { state: 'idle', msg: '' };
const getPulseRun = () => run;

// The next 30 days of India (medium and high) and US (high) events from TradingView. Needs the economic calendar tool in the page's TradingView permission.
async function fetchCalendar(){
  const from = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 19800000 + 30 * 86400000).toISOString().slice(0, 10);
  const get = async (countries, min) => { const p = await tvCall('mcp-tv-get-economic-calendar', { countries, date_from: from, date_to: to, min_importance: min }); return p && p.result; };
  const rows = buildCalendar(await get('IN', 0), 'IN').concat(buildCalendar(await get('US', 1), 'US'));
  if(!rows.length) throw new Error('TradingView returned no events.');
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// Recent headlines from several market feeds; a feed that fails or has no news is skipped.
async function fetchHeadlines(){
  const errors = [];
  const got = await Promise.all(BRIEFING_FEEDS.map(async sym => {
    try {
      const p = await tvCall('mcp-tv-get-news', { symbol: sym, limit: 15 });
      const d = p && p.data !== undefined ? p.data : p;
      return d && Array.isArray(d.headlines) ? d.headlines : [];
    } catch(e){ errors.push(e); return []; }
  }));
  if(errors.length === BRIEFING_FEEDS.length) throw errors[0];   // every feed failed: report why, not "no headlines"
  return mergeHeadlines(got);
}

// Shows what the run is doing now.
function progress(msg, onChange){
  run = { state: 'running', msg };
  onChange();
}

// Adds fields to news/macro, creating the document when it does not exist yet.
async function mergeMacro(db, fields){
  const ref = db.doc('news/macro'), cur = await ref.get();
  if(cur && cur.exists) await ref.update(fields); else await ref.set(fields);
}

// Step 1: the market quotes. Keeps the reading already written. Fails the whole run when there is nothing to show.
async function quotesStep(){
  if(!(await tvMcp())) throw new Error('The TradingView connector is not available in this view.');
  const db = await dbCapabilityPromise;
  if(!db) throw new Error('The database is not available in this view.');
  const p = await tvCall('mcp-tv-get-symbol-data-batch', { symbols: PULSE_SYMBOLS, columns: ['name', 'close', 'change', 'change_abs'] });
  const tiles = buildTiles(p && p.data);
  if(tiles.length < MIN_TILES) throw new Error('TradingView returned too few quotes (' + tiles.length + ').');
  const ref = db.doc('news/pulse'), cur = await ref.get();
  const prev = cur && cur.exists ? (cur.data() || {}) : {};
  await ref.set({ at: new Date().toISOString(), tiles, reading: Array.isArray(prev.reading) ? prev.reading : [], readingAt: prev.readingAt || null });
  return { db, ref, tiles };
}

// Step 2: the economic calendar. A failure is a note, not a stop.
async function calendarStep(db, onChange){
  try {
    progress('Getting the economic calendar…', onChange);
    const rows = await fetchCalendar();
    await mergeMacro(db, { calendar: rows, calendarAt: new Date().toISOString() });
    return ' Calendar updated: ' + rows.length + ' events.';
  } catch(e){
    return ' The calendar was not updated (' + (tvErrorText(e) || String((e && e.message) || e)) + ').';
  }
}

// Asks the runtime for Claude. Returns { sample, note }: sample is null, with the reason in the note, when Claude cannot be used.
async function claudeAccess(){
  try {
    const sample = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('sample').catch(() => null) : null;
    if(!sample) throw { code: 'not_declared', message: 'Claude is not available in this view.', fromClaude: true };
    await ldEnsureClaudeAccess();
    return { sample, note: '' };
  } catch(e){
    return { sample: null, note: ' Claude steps skipped (' + ldErrText(e) + ').' };
  }
}

// Step 3: the briefings, written by Claude from recent headlines.
async function briefingsStep(db, sample, onChange){
  progress('Writing the briefings…', onChange);
  try {
    const heads = await fetchHeadlines();
    if(!heads.length) throw new Error('TradingView returned no headlines.');
    const items = cleanBriefings(await ldAskJson(sample, briefingsPrompt(heads), { modelTier: 'quick', cache: false }), heads);
    if(!items.length) throw new Error('Claude wrote no usable briefings.');
    const at = new Date().toISOString();
    await mergeMacro(db, { briefings: items, briefingsAt: at, asof: at.slice(0, 10) });
    return ' Briefings updated: ' + items.length + '.';
  } catch(e){
    return ' The briefings were not updated (' + (tvErrorText(e) || ldErrText(e)) + ').';
  }
}

// Step 4: the three "why" lines, written by Claude from the quotes and the next big events.
async function readingStep(ref, sample, tiles, onChange){
  progress('Writing the reading…', onChange);
  try {
    const events = nextBigEvents((news.macro && news.macro.calendar) || [], Date.now(), BIG_EVENTS);
    const lines = cleanReading(await ldAskJson(sample, readingPrompt(tiles, events), { modelTier: 'quick', cache: false }));
    if(!lines.length) throw new Error('Claude wrote no usable lines.');
    await ref.update({ reading: lines, readingAt: new Date().toISOString() });
    return ' Reading updated.';
  } catch(e){
    return ' The reading was not updated (' + ldErrText(e) + ').';
  }
}

// A Claude step: its note when the step is switched off in Settings, nothing when Claude is unavailable (that was already noted), otherwise what the step reports.
async function claudeStep(want, sample, offNote, step){
  if(!want) return offNote;
  return sample ? step() : '';
}

// The whole run; returns the sentence shown when it is done.
async function runSteps(onChange){
  const { db, ref, tiles } = await quotesStep();
  let note = tiles.length + ' quotes saved.' + await calendarStep(db, onChange);
  const wantReading = claudeStepOn('newsPulse'), wantBriefings = claudeStepOn('newsBriefings');
  const access = wantReading || wantBriefings ? await claudeAccess() : { sample: null, note: '' };
  note += access.note;
  note += await claudeStep(wantBriefings, access.sample, ' The briefings step is switched off in Settings.', () => briefingsStep(db, access.sample, onChange));
  note += await claudeStep(wantReading, access.sample, ' The reading step is switched off in Settings.', () => readingStep(ref, access.sample, tiles, onChange));
  return note;
}

async function refreshPulse(onChange){
  if(run.state === 'running') return;
  progress('Getting market quotes…', onChange);
  try {
    run = { state: 'done', msg: await runSteps(onChange) };
  } catch(e){
    run = { state: 'error', msg: tvErrorText(e) || String((e && e.message) || e) };
  }
  onChange();
}

export { getPulseRun, refreshPulse };
