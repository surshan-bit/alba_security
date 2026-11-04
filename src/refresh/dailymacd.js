// The daily (1D) MACD 30/60/5 import of Refresh all stocks (v1.355). Daily bars are not saved: they are fetched from TradingView, one call per stock, for the stocks
// of ONE chosen strategy only (the stocks that pass its rules other than the daily one), and only the resulting reading is saved (see barchunks.js, saveDailyStates).
import { qualifyingStocks, ruleReady } from '../strategies/rules.js';
import { techDailyCrossState } from '../engine/technical.js';
import { tvCall, tvIsQuota, tvIstDate, tvToRows, tvValidate } from '../tv/connector.js';

const DAILY_FIELD = 'dayMacd3060';   // the strategy rule this import serves (src/strategies/fields.js)
const DAILY_BARS = 400;              // daily bars asked for: about 19 months, enough for the 60-day average to settle
const DAILY_WORKERS = 4;             // stocks fetched at the same time
const DAILY_MAX = 600;               // stocks per run, so one run cannot use up the TradingView quota

/**
 * The stocks of a strategy that need daily bars: those passing its rules other than the daily one, in the order given, at most DAILY_MAX.
 * @returns {{ list: any[], total: number, needsOtherRule: boolean }}
 */
function dailyStocksOf(universe, strategy){
  const rules = ((strategy && strategy.rules) || []).filter(r => r.field !== DAILY_FIELD && ruleReady(r));
  if(!rules.length) return { list: [], total: 0, needsOtherRule: true };
  const all = qualifyingStocks(universe, rules);
  return { list: all.slice(0, DAILY_MAX), total: all.length, needsOtherRule: false };
}

// One stock's daily reading from TradingView: { state, asof } (asof = the day of its newest bar), or null with fewer than 65 daily bars.
async function readDailyOf(sym){
  const rows = tvToRows(await tvCall('mcp-tv-get-ohlcv', { symbol: sym, interval: '1D', count: DAILY_BARS, format: 'columns' }), 'daily');
  tvValidate(rows, 'daily');
  const state = techDailyCrossState(rows.map(r => r[4]));
  return state ? { state, asof: tvIstDate(rows[rows.length - 1][0]) } : null;
}

/**
 * The daily MACD reading of each stock in `list`, DAILY_WORKERS at a time. `io` = { symbolOf(stock), keyOf(stock), stop() }; progress(done, total) after each stock.
 * A stock that fails is listed with its reason and the rest go on; no connection or no quota stops the whole read (`abort` says why).
 * @returns {Promise<{ results: { key: string, state: string, asof: string }[], failures: { stock: any, reason: string }[], abort: string }>}
 */
async function readDailyStates(list, io, progress){
  /** @type {{ results: { key: string, state: string, asof: string }[], failures: { stock: any, reason: string }[], abort: string }} */
  const out = { results: [], failures: [], abort: '' };
  let next = 0, done = 0;
  const one = async s => {
    const sym = io.symbolOf(s);
    if(!sym){ out.failures.push({ stock: s, reason: 'no TradingView symbol' }); return; }
    try {
      const r = await readDailyOf(sym);
      if(r) out.results.push({ key: io.keyOf(s), state: r.state, asof: r.asof }); else out.failures.push({ stock: s, reason: 'fewer than 65 daily bars' });
    } catch(e){
      if(tvIsQuota(e) || (e && e.code === 'no_mcp')) out.abort = e.message;
      else out.failures.push({ stock: s, reason: String((e && e.message) || e).slice(0, 80) });
    }
  };
  const worker = async () => { while(next < list.length && !io.stop() && !out.abort){ await one(list[next++]); progress(++done, list.length); } };
  await Promise.all(Array.from({ length: Math.min(DAILY_WORKERS, list.length) }, worker));
  return out;
}

const num = x => x.toLocaleString('en-IN');
// The line of the Refresh all stocks result about the daily import: `d` = the run's daily result, { name, stocks, total, read, changed, failed, abort } or { name?, problem }.
// Returns { text, problem } (a problem is shown in bold).
function dailyReportLine(d){
  const head = 'Daily MACD 30/60/5' + (d.name ? ' (' + d.name + ')' : '') + ': ';
  if(d.problem) return { text: head + d.problem, problem: true };
  const parts = [num(d.read) + ' of ' + num(d.stocks) + ' stocks read', num(d.changed) + ' changed'];
  if(d.total > d.stocks) parts.push('only the first ' + num(d.stocks) + ' of ' + num(d.total) + ' this run');
  if(d.failed) parts.push(num(d.failed) + ' failed');
  if(d.notSaved) parts.push(num(d.notSaved) + ' batches not saved');
  return { text: head + parts.join(', ') + (d.abort ? '. Stopped: ' + d.abort : ''), problem: !!d.abort || d.notSaved > 0 };
}

export { dailyReportLine, dailyStocksOf, readDailyStates };
