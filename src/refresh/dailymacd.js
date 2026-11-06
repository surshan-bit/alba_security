// The daily (1D) MACD 30/60/5 import of Refresh all stocks (v1.355, batched in v1.356). Daily bars are saved only for the stocks of ONE chosen strategy (the stocks that pass its rules other
// than the daily one), in the collection priceHistory1D (see dailystore.js): the first import of a stock fetches its last DAILY_KEEP bars (about 2 years) and later runs fetch
// the new days only: from the batch call, 50 stocks at a time (dailybatch.js), or, when that does not line up, from a call of its own for the days since; they are merged in and saved. The reading is calculated from the saved bars and kept with the stock's technical block (see barchunks.js, saveDailyStates).
import { qualifyingStocks, ruleReady } from '../strategies/rules.js';
import { techDailyAboveBars, techDailyCrossState } from '../engine/technical.js';
import { alignDaily, dailyBatchBars } from './dailybatch.js';
import { tvCall, tvIsQuota, tvIstDate, tvMergeDelta, tvToRows, tvValidate } from '../tv/connector.js';

const DAILY_FIELD = 'dayMacd3060';   // the strategy rule this import serves (src/strategies/fields.js)
const DAILY_KEEP = 500;              // daily bars saved per stock: about 2 years
const DAILY_EXTRA = 3;               // bars asked on top of the days since the newest saved bar, so the newest saved bars are fetched again and checked
const DAILY_WORKERS = 2;             // stocks fetched at the same time (few, so TradingView does not see a burst of calls)
const DAILY_PAUSE_MS = 65000;        // wait after TradingView suspends the connector (it says "for one minute")
const DAILY_PAUSES = 2;              // waits allowed in one run before the read stops: TradingView warns that more calls while suspended mean a longer suspension
const DAILY_OWN_MAX = 100;           // stocks fetched on their own per run (a first import, or a stock that did not line up); the rest are left for the next run
// True when TradingView says the suspension lasts one minute; a longer one ("until 00:00 UTC") is not waited out.
const briefLimit = e => /for one minute/i.test(String((e && e.message) || ''));
const DAILY_MAX = 600;               // stocks per run, so one run cannot use up the TradingView quota
const IST_SECONDS = 19800;
const dayBucket = t => Math.floor((t + IST_SECONDS) / 86400);   // the Indian day a bar belongs to
const dayNo = ymd => Math.floor(Date.parse(ymd + 'T00:00:00Z') / 86400000);

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

// How many daily bars to ask TradingView for: all DAILY_KEEP for a stock with none saved, else the days since its newest saved bar and a few more (at least 10).
function dailyFetchCount(have, today){
  if(!have) return DAILY_KEEP;
  const days = dayNo(today) - dayNo(tvIstDate(have[have.length - 1][0]));
  return Math.min(DAILY_KEEP, Math.max(10, days + DAILY_EXTRA));
}

async function fetchDaily(sym, count){
  const rows = tvToRows(await tvCall('mcp-tv-get-ohlcv', { symbol: sym, interval: '1D', count, format: 'columns' }), 'daily');
  tvValidate(rows, 'daily');
  return rows;
}

// A stock's daily bars brought up to date, at most DAILY_KEEP: the saved bars with the new days merged in. When the fetched days do not match the saved ones (a split or an
// adjustment since), or nothing is saved yet, the whole history is fetched.
async function dailyBarsFor(sym, have, today){
  if(have){
    const merged = tvMergeDelta(have, await fetchDaily(sym, dailyFetchCount(have, today)), dayBucket);
    if(merged) return merged.slice(-DAILY_KEEP);
  }
  return (await fetchDaily(sym, DAILY_KEEP)).slice(-DAILY_KEEP);
}
// True when the bars to save are what is saved already (same count, same first and newest bar).
const sameDailyBars = (a, b) => !!a && a.length === b.length && JSON.stringify(a[0]) === JSON.stringify(b[0]) && JSON.stringify(a[a.length - 1]) === JSON.stringify(b[b.length - 1]);

const BATCH = 50;                    // stocks per batch call
const LOADERS = 8;                   // saved bar records read at the same time
// Runs fn over the items, `n` at a time.
async function pool(items, n, fn){
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while(next < items.length) await fn(items[next++]); }));
}

// The pieces of one read: its result (`out`), the progress `tick`, and how a stock is read from the batch call (`batched`, a chunk at a time) or from a call of its own (`single`).
function dailyReader(total, io, progress){
  /** @type {{ results: { key: string, state: string, asof: string, bars: number | null }[], failures: { stock: any, reason: string }[], abort: string, stored: number, storeFailed: number, pauses: number, batched: number, deferred: number }} */
  const out = { results: [], failures: [], abort: '', stored: 0, storeFailed: 0, pauses: 0, batched: 0, deferred: 0 };
  let done = 0, resting = null;
  const tick = () => progress(++done, total, out.batched);
  const rest = () => { if(!resting){ out.pauses++; resting = Promise.resolve(io.pause(DAILY_PAUSE_MS)).finally(() => { resting = null; }); } return resting; };
  const withRest = async fn => {
    for(;;){
      try { return await fn(); } catch(e){ if(!(tvIsQuota(e) && briefLimit(e) && (resting || out.pauses < DAILY_PAUSES) && !io.stop())) throw e; await rest(); }   // wait for TradingView, then again
    }
  };
  const fail = (s, e) => {
    if(tvIsQuota(e) || (e && e.code === 'no_mcp')) out.abort = e.message;
    else out.failures.push({ stock: s, reason: String((e && e.message) || e).slice(0, 80) });
  };
  const keep = async (s, sym, old, bars) => {
    if(sameDailyBars(old, bars)) return;
    try { await io.saveBars(s, sym, bars, !old); out.stored++; } catch(e){ out.storeFailed++; }
  };
  const finish = async ({ s, sym, old }, bars) => {
    const closes = bars.map(r => r[4]), state = techDailyCrossState(closes);
    if(state) out.results.push({ key: io.keyOf(s), state, asof: tvIstDate(bars[bars.length - 1][0]), bars: techDailyAboveBars(closes) }); else out.failures.push({ stock: s, reason: 'fewer than 65 daily bars' });
    await keep(s, sym, old, bars);
  };
  const single = async x => { try { await finish(x, await withRest(() => dailyBarsFor(x.sym, x.old, io.today()))); } catch(e){ fail(x.s, e); } tick(); };
  const batched = async chunk => {   // returns the stocks of the chunk that need a call of their own
    let data;
    try { data = await withRest(() => io.batch(chunk.map(x => x.sym))); } catch(e){ if(tvIsQuota(e) || (e && e.code === 'no_mcp')){ out.abort = e.message; return []; } data = null; }
    const own = [], aligned = [];
    for(const x of chunk){
      const bars = data ? alignDaily(x.old, dailyBatchBars(data[x.sym]), io.nowS()) : null;
      if(bars) aligned.push({ x, bars }); else own.push(x);
    }
    out.batched += aligned.length;   // counted at once, so the progress line shows the batch before the saves, which run LOADERS at a time
    await pool(aligned, LOADERS, async a => { await finish(a.x, a.bars); tick(); });
    return own;
  };
  return { out, tick, batched, single };
}

/**
 * The daily MACD reading of each stock in `list` and their bars saved. A stock with saved bars is brought up to date from the batch call (BATCH stocks per call, no
 * fetch of its own); one with no saved bars, or whose saved bars do not line up with the batch answer, is fetched on its own, DAILY_WORKERS at a time.
 * `io` = { symbolOf(stock), keyOf(stock), stop(), today(), nowS(), loadBars(stock, sym), saveBars(stock, sym, bars, isNew), batch(symbols) -> { symbol: row }, pause(ms) };
 * progress(done, total, batched) after each stock (`batched` = stocks brought up to date from the batch call so far). A stock that fails is listed with its reason and the rest go on; no connection stops the whole read (`abort` says why). When
 * TradingView refuses a call for its quota, all workers wait io.pause(DAILY_PAUSE_MS) and the call is tried again, up to DAILY_PAUSES waits (`pauses` counts them); after that
 * the read stops with the quota message. A suspension that is not "for one minute" stops the read at once. At most DAILY_OWN_MAX stocks are fetched on their own per run (`deferred` counts the rest). A bar document that cannot be read is fetched in full; one that cannot be saved is counted (`storeFailed`), its reading still counts.
 * @returns {Promise<{ results: { key: string, state: string, asof: string, bars: number | null }[], failures: { stock: any, reason: string }[], abort: string, stored: number, storeFailed: number, pauses: number, batched: number, deferred: number }>}
 */
async function readDailyStates(list, io, progress){
  const rd = dailyReader(list.length, io, progress), loaded = [];
  await pool(list, LOADERS, async s => {
    const sym = io.symbolOf(s);
    if(!sym){ rd.out.failures.push({ stock: s, reason: 'no TradingView symbol' }); rd.tick(); return; }
    try { loaded.push({ s, sym, old: await io.loadBars(s, sym) }); } catch(e){ loaded.push({ s, sym, old: null }); }   // unreadable: the whole history is fetched again
  });
  const own = loaded.filter(x => !x.old || x.old.length < 2), known = loaded.filter(x => x.old && x.old.length >= 2);
  for(let i = 0; i < known.length && !io.stop() && !rd.out.abort; i += BATCH) own.push(...await rd.batched(known.slice(i, i + BATCH)));
  rd.out.deferred = Math.max(0, own.length - DAILY_OWN_MAX);   // the first import of many stocks is spread over several runs
  await pool(own.slice(0, DAILY_OWN_MAX), DAILY_WORKERS, async x => { if(!io.stop() && !rd.out.abort) await rd.single(x); });
  return rd.out;
}

const num = x => x.toLocaleString('en-IN');
// The line of the Refresh all stocks result about the daily import: `d` = the run's daily result, { name, stocks, total, read, changed, failed, pauses, deferred, stored, storeFailed, notSaved, abort }
// or { name?, problem }. Returns { text, problem } (a problem is shown in bold).
function dailyReportLine(d){
  const head = 'Daily MACD 30/60/5' + (d.name ? ' (' + d.name + ')' : '') + ': ';
  if(d.problem) return { text: head + d.problem, problem: true };
  const parts = [num(d.read) + ' of ' + num(d.stocks) + ' stocks read', num(d.changed) + ' changed'];
  if(d.total > d.stocks) parts.push('only the first ' + num(d.stocks) + ' of ' + num(d.total) + ' this run');
  if(d.stored) parts.push(num(d.stored) + ' daily records saved');
  if(d.batched) parts.push(num(d.batched) + ' updated in batches');
  if(d.deferred) parts.push(num(d.deferred) + ' more stocks wait for the next run');
  if(d.pauses) parts.push('waited ' + num(d.pauses) + ' time' + (d.pauses > 1 ? 's' : '') + ' for the TradingView call limit');
  if(d.failed) parts.push(num(d.failed) + ' failed');
  if(d.storeFailed) parts.push(num(d.storeFailed) + ' daily records could not be saved');
  if(d.notSaved) parts.push(num(d.notSaved) + ' batches not saved');
  return { text: head + parts.join(', ') + (d.abort ? '. Stopped: ' + d.abort : ''), problem: !!d.abort || d.notSaved > 0 || d.storeFailed > 0 };
}

export { dailyReportLine, dailyStocksOf, readDailyStates };
