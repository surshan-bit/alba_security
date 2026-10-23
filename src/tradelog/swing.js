// Swing setup for the Buy / Sell ideas: does the chart look like one that gains 5% within a few weeks?
// Four plain checks on the weekly bars and the weekly indicators, each worth one point (0 to 4). They are the features that
// separated good weeks from poor ones when past weeks of the Positive MoS stocks were replayed (v1.189): close to the
// 52-week high, bullish MACD above zero, enough weekly movement to reach 5%, and a firm but not stretched RSI.
import { techCompleted } from '../engine/technical.js';
import { fixedOrNull } from '../core/util.js';

const NEAR_HIGH = -10, MIN_MOVE = 4.5, RSI_LOW = 60, RSI_HIGH = 80, MIN_BARS = 14;
// How often, in those past weeks, a stock with that many points closed at least 5% higher two weeks later (close) and
// touched +5% at some point in the two weeks (touch). About 7,200 stock-weeks from 43 stocks; a guide, not a promise.
const HISTORY = [{ close: 21, touch: 48 }, { close: 25, touch: 56 }, { close: 25, touch: 56 }, { close: 28, touch: 58 }, { close: 31, touch: 63 }];

// Distance from the 52-week high (%, 0 or below) and the typical weekly move (%), from completed weekly bars; null with too little history.
function weekFeatures(weekBars, today){
  const done = techCompleted(Array.isArray(weekBars) ? weekBars : [], 'week', today);
  if(done.length < MIN_BARS) return null;
  const c = done.map(b => b[4]);
  const last = c[c.length - 1], hi = Math.max(...c.slice(-52));
  const r = [];
  for(let i = Math.max(1, c.length - 13); i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const mu = r.reduce((a, b) => a + b, 0) / r.length;
  const move = Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / r.length) * 100;
  return { fromHigh: (last / hi - 1) * 100, move };
}

// { pts, of: 4, chance, touch, hits, misses, fromHigh, move } or null when the stock has no usable weekly bars.
function swingSetup(stock, weekBars, today){
  const f = weekFeatures(weekBars, today);
  if(!f) return null;
  const t = (stock && stock.technical) || {}, rsi = t.raw && typeof t.raw.weekRsi === 'number' ? t.raw.weekRsi : null;
  const macd = t.states && t.states.weekMacd;
  const checks = [
    [f.fromHigh >= NEAR_HIGH, 'within ' + fixedOrNull(-f.fromHigh, 0) + '% of its 52-week high', f.fromHigh < NEAR_HIGH ? fixedOrNull(-f.fromHigh, 0) + '% below its 52-week high' : null],
    [macd === 'bull_above', 'weekly MACD bullish above zero', 'weekly MACD not bullish above zero'],
    [f.move >= MIN_MOVE, 'moves about ' + fixedOrNull(f.move, 1) + '% a week', 'moves only about ' + fixedOrNull(f.move, 1) + '% a week'],
    [rsi != null && rsi >= RSI_LOW && rsi <= RSI_HIGH, 'weekly RSI ' + fixedOrNull(rsi, 0) + ' (firm, not stretched)', rsi == null ? 'no weekly RSI' : 'weekly RSI ' + fixedOrNull(rsi, 0) + ' outside ' + RSI_LOW + '-' + RSI_HIGH]
  ];
  const pts = checks.filter(c => c[0]).length;
  return { pts, of: checks.length, chance: HISTORY[pts].close, touch: HISTORY[pts].touch, hits: checks.filter(c => c[0]).map(c => c[1]), misses: checks.filter(c => !c[0]).map(c => c[2]), fromHigh: f.fromHigh, move: f.move };
}

export { swingSetup };
