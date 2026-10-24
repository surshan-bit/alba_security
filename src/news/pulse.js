// Refresh News: the market pulse tiles (TradingView quotes) and the three "why" lines (Claude, from those numbers only).
// The briefings, the economic calendar and the upcoming stock events are written from a research session, not by this button.
import { dbCapabilityPromise } from '../core/store.js';
import { tvCall, tvErrorText, tvMcp } from '../tv/connector.js';
import { ldAskJson, ldEnsureClaudeAccess, ldErrText } from '../livedata/claude.js';
import { claudeStepOn } from '../livedata/claudegate.js';
import { PULSE_SYMBOLS, buildTiles, cleanReading, nextBigEvents, readingPrompt } from './model.js';
import { news } from './store.js';

/** @type {{ state: string, msg: string }} */
let run = { state: 'idle', msg: '' };
const getPulseRun = () => run;

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
    if(claudeStepOn('newsPulse')){
      run = { state: 'running', msg: 'Writing the reading…' };
      onChange();
      try {
        const sample = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('sample').catch(() => null) : null;
        if(!sample) throw { code: 'not_declared', message: 'Claude is not available in this view.', fromClaude: true };
        await ldEnsureClaudeAccess();
        const lines = cleanReading(await ldAskJson(sample, readingPrompt(tiles, nextBigEvents((news.macro && news.macro.calendar) || [], Date.now(), 3)), { modelTier: 'quick', cache: false }));
        if(!lines.length) throw new Error('Claude wrote no usable lines.');
        await ref.update({ reading: lines, readingAt: new Date().toISOString() });
        note += ' Reading updated.';
      } catch(e){
        note += ' The reading was not updated (' + ldErrText(e) + ').';
      }
    } else {
      note += ' The reading step is switched off in Settings.';
    }
    run = { state: 'done', msg: note };
  } catch(e){
    run = { state: 'error', msg: tvErrorText(e) || String((e && e.message) || e) };
  }
  onChange();
}

export { getPulseRun, refreshPulse };
