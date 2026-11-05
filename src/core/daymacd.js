// What the daily (1D) MACD 30/60/5 import (src/refresh/dailymacd.js) leaves on a stock's technical block, read for the screens: how fresh it is and how many daily bars
// in a row the MACD has been above its signal line (v1.361).
import { daysSinceDate } from './util.js';

// A reading older than this many days (a long weekend) counts as missing, so a screen or a rule never rests on days-old data without saying so.
const DAILY_FRESH_DAYS = 4;

/**
 * How many daily bars in a row, ending with the newest, the 1D MACD 30/60/5 of the stock has been above its signal line (1 = it crossed up on the newest bar,
 * 0 = it is at or below the signal). null when the stock has no daily reading, or only an old one.
 * @param {any} s a stock
 * @returns {number | null}
 */
function dayMacdBarsOf(s){
  const raw = s && s.technical && s.technical.raw;
  if(!raw) return null;
  const age = daysSinceDate(raw.dayMacdAsof);
  return age !== null && age <= DAILY_FRESH_DAYS && Number.isInteger(raw.dayMacdBars) && raw.dayMacdBars >= 0 ? raw.dayMacdBars : null;
}

export { DAILY_FRESH_DAYS, dayMacdBarsOf };
