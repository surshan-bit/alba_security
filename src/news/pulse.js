// Refresh News: the market pulse tiles (TradingView quotes) and the three "why" lines (Claude, from those numbers only).
// The same button refreshes the economic calendar (TradingView) and the briefings (TradingView headlines, summarised by Claude). The upcoming stock events are written from a research session.
import { dbCapabilityPromise } from '../core/store.js';
import { tvCall, tvErrorText, tvMcp } from '../tv/connector.js';
import { ldAskJson, ldEnsureClaudeAccess, ldErrText } from '../livedata/claude.js';
import { claudeStepOn } from '../livedata/claudegate.js';
import { BRIEFING_FEEDS, PULSE_SYMBOLS, briefingsPrompt, buildCalendar, buildTiles, cleanBriefings, cleanReading, mergeHeadlines, nextBigEvents, readingPrompt } from './model.js';
import { news } from './store.js';

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

async function refreshPulse(onChange){
  if(run.state === 'running') return;
  run = { state: 'running', msg: 'Getting market quotes…' };
  onChange();
  try {
    if(!(await tvMcp())) throw new Error('The TradingView connector is not available in this view.');
    const db = await dbCapabilityPromise;
    if(!db) throw new Error('The database is not available in this view.');
    const p = await tvCall('mcp-tv-get-symbol-data-batch', { symbols: PULSE_SYMBOLS, columns: ['name', 'close', 'change', 'change_abs'] });
    const tiles = buildTiles(p && p.data);
    if(tiles.length < 3) throw new Error('TradingView returned too few quotes (' + tiles.length + ').');
    const at = new Date().toISOString();
    const ref = db.doc('news/pulse');
    const cur = await ref.get();
    const prev = cur && cur.exists ? (cur.data() || {}) : {};
    await ref.set({ at, tiles, reading: Array.isArray(prev.reading) ? prev.reading : [], readingAt: prev.readingAt || null });
    let note = tiles.length + ' quotes saved.';
    try {
      run = { state: 'running', msg: 'Getting the economic calendar…' };
      onChange();
      const rows = await fetchCalendar();
      const mref = db.doc('news/macro'), mcur = await mref.get(), upd = { calendar: rows, calendarAt: new Date().toISOString() };
      if(mcur && mcur.exists) await mref.update(upd); else await mref.set(upd);
      note += ' Calendar updated: ' + rows.length + ' events.';
    } catch(e){
      note += ' The calendar was not updated (' + (tvErrorText(e) || String((e && e.message) || e)) + ').';
    }
    const wantReading = claudeStepOn('newsPulse'), wantBriefings = claudeStepOn('newsBriefings');
    let sample = null;
    if(wantReading || wantBriefings){
      try {
        sample = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('sample').catch(() => null) : null;
        if(!sample) throw { code: 'not_declared', message: 'Claude is not available in this view.', fromClaude: true };
        await ldEnsureClaudeAccess();
      } catch(e){
        sample = null;
        note += ' Claude steps skipped (' + ldErrText(e) + ').';
      }
    }
    if(wantBriefings && sample){
      run = { state: 'running', msg: 'Writing the briefings…' };
      onChange();
      try {
        const heads = await fetchHeadlines();
        if(!heads.length) throw new Error('TradingView returned no headlines.');
        const items = cleanBriefings(await ldAskJson(sample, briefingsPrompt(heads), { modelTier: 'quick', cache: false }), heads);
        if(!items.length) throw new Error('Claude wrote no usable briefings.');
        const mref = db.doc('news/macro'), mcur = await mref.get(), at2 = new Date().toISOString(), upd = { briefings: items, briefingsAt: at2, asof: at2.slice(0, 10) };
        if(mcur && mcur.exists) await mref.update(upd); else await mref.set(upd);
        note += ' Briefings updated: ' + items.length + '.';
      } catch(e){
        note += ' The briefings were not updated (' + (tvErrorText(e) || ldErrText(e)) + ').';
      }
    } else if(!wantBriefings){
      note += ' The briefings step is switched off in Settings.';
    }
    if(wantReading && sample){
      run = { state: 'running', msg: 'Writing the reading…' };
      onChange();
      try {
        const lines = cleanReading(await ldAskJson(sample, readingPrompt(tiles, nextBigEvents((news.macro && news.macro.calendar) || [], Date.now(), 3)), { modelTier: 'quick', cache: false }));
        if(!lines.length) throw new Error('Claude wrote no usable lines.');
        await ref.update({ reading: lines, readingAt: new Date().toISOString() });
        note += ' Reading updated.';
      } catch(e){
        note += ' The reading was not updated (' + ldErrText(e) + ').';
      }
    } else if(!wantReading){
      note += ' The reading step is switched off in Settings.';
    }
    run = { state: 'done', msg: note };
  } catch(e){
    run = { state: 'error', msg: tvErrorText(e) || String((e && e.message) || e) };
  }
  onChange();
}

export { getPulseRun, refreshPulse };
