// TradingView watchlist sync, the wording: the lines shown in the progress panel and the note kept in the sync log. Pure text from numbers and names.
const LIST_MAX = { dropped: 15, lookup: 8 };
const plural = n => n === 1 ? 'y' : 'ies';

/**
 * The summary line for one rebuilt list.
 * @param {string} name
 * @param {{ action: string, count: number, added: number, removed: number }} r
 * @returns {string}
 */
const wlDoneLine = (name, r) => name + ': ' + (r.action === 'unchanged' ? r.count + ' symbols, unchanged' : r.count + ' symbols (+' + r.added + ' / −' + r.removed + ')');

/**
 * The short status shown beside a list's progress step.
 * @param {{ action: string, added: number, removed: number }} r
 * @returns {string}
 */
const wlStepDetail = r => r.action === 'unchanged' ? 'unchanged' : '+' + r.added + ' / −' + r.removed;

/**
 * The note kept in the sync log: the size of each list, and how many BSE-only stocks still have no TradingView symbol.
 * @param {string[]} names
 * @param {{ lists: Record<string, string[]>, needsLookup: unknown[] }} plan
 * @returns {string}
 */
const wlNote = (names, plan) => names.map(n => n + ' ' + plan.lists[n].length).join(', ') + '.' + (plan.needsLookup.length ? ' No TradingView symbol yet for ' + plan.needsLookup.length + ' BSE-only stocks.' : '');

// "a, b … +3" when the list is longer than `max`.
const clipped = (items, max, sep) => items.slice(0, max).join(sep) + (items.length > max ? ' … +' + (items.length - max) : '');

/**
 * The lines of the result panel after a finished run.
 * @param {{ picks: unknown[], done: string[], added: number, removed: number, dropped: string[], partial: boolean,
 *   plan: { needsLookup: { code: string, name: string }[], unverified: string[] } }} run
 * @returns {{ text: string, cls?: string }[]}
 */
function wlResultLines(run){
  const { picks, done, added, removed, dropped, partial, plan } = run;
  const lines = [{ text: partial ? 'Sync finished with gaps.' : 'Sync complete.', cls: 'fi-line fi-line-strong' }, ...done.map(text => ({ text })),
    { text: picks.length + ' strateg' + plural(picks.length) + ' · ' + added + ' added · ' + removed + ' removed in total.' }];
  const muted = text => lines.push({ text, cls: 'fi-line fi-line-muted' });
  if(dropped.length) muted('TradingView could not resolve: ' + clipped(dropped, LIST_MAX.dropped, ', ') + '.');
  if(plan.needsLookup.length) muted('No TradingView symbol yet (left out): ' + clipped(plan.needsLookup.map(x => x.code + ' ' + x.name), LIST_MAX.lookup, '; ') + '.');
  if(plan.unverified.length) muted('Symbols with - or & that were not checked beforehand: ' + plan.unverified.join(', ') + '.');
  return lines;
}

/**
 * The lines of the result panel after a run that stopped.
 * @param {string} msg why it stopped
 * @param {string[]} done what finished before the stop
 * @returns {{ text: string, cls: string }[]}
 */
const wlStoppedLines = (msg, done) => [{ text: 'Sync stopped: ' + msg, cls: 'fi-line fi-line-strong' }].concat(done.map(t => ({ text: 'Done before the stop — ' + t, cls: 'fi-line fi-line-muted' })));

export { wlDoneLine, wlNote, wlResultLines, wlStepDetail, wlStoppedLines };
