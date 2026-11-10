// Turns one stock's weekly and monthly bars into one "sample" per past week: what the technical picture looked like
// at that week's close, and whether buying at the NEXT week's open reached the target within the horizon.
// Only information available at that week's close is used: the month in progress is treated as an unfinished bar
// closing at that week's close, just as the live Technical Score sees the current month.
import { buildIndicators, peek, readingAt } from './indicators.js';

const DAY = 86400;
const MIN_WEEKS = 40;

// Columns shared by all stocks; typed arrays are made at the end (build -> finish).
function newSampleSet(){
  return { wr: [], mr: [], wp: [], mp: [], wm: [], mm: [], hit: [], t: [], tk: [], np: [], nn: [], cov: [], n: 0 };
}
// The highest high in the H weeks after week i.
function reachedTop(week, i, H){
  let top = 0;
  for(let j = i + 1; j <= i + H; j++) if(week[j][2] > top) top = week[j][2];
  return top;
}
// The month in progress at a week's end = the last monthly bar that started on or before it. kk only moves forward.
function monthAt(month, kk, weekEnd){
  while(kk + 1 < month.length && month[kk + 1][0] <= weekEnd) kk++;
  return kk;
}
// The monthly RSI and MACD the week's close would give, and the move since the month's start; blanks before there are two monthly bars.
function monthReading(mInd, mc, kk, price){
  if(!mInd || kk < 1) return { mr: NaN, mm: -1, mp: NaN };
  const r = peek(mInd, kk - 1, price);
  return { mr: r.rsi, mm: r.macd, mp: (price / mc[kk - 1] - 1) * 100 };
}
// The positive and negative news items of the week ending at weekEnd.
function weekNews(news, weekEnd){
  let np = 0, nn = 0;
  if(!news) return { np, nn };
  for(const e of news.list){
    if(!(e.t > weekEnd - 7 * DAY && e.t <= weekEnd)) continue;
    if(e.s === 'pos') np++; else if(e.s === 'neg') nn++;
  }
  return { np, nn };
}

// stock = { week, month, H, target, news }. week / month: bars [t, o, h, l, c, v] in time order. H = weeks in the horizon. target = percent.
// news: optional { first, list: [{ t, s }] } (see news.js). A sample records the positive / negative news of that week and
// whether the news record already existed then (before its first item, "no news" is just "not recorded").
function addStockSamples(set, tkIdx, { week, month, H, target, news }){
  if(!week || week.length < MIN_WEEKS + H + 1) return 0;
  const wc = week.map(b => b[4]);
  const wInd = buildIndicators(wc);
  const mc = month && month.length ? month.map(b => b[4]) : [];
  const mInd = mc.length ? buildIndicators(mc) : null;
  const mult = 1 + target / 100;
  let added = 0, kk = -1;
  for(let i = 1; i + H < week.length; i++){
    const wRead = readingAt(wInd, i);
    if(wRead.macd < 0 && !(wRead.rsi >= 0)) continue;
    const entry = week[i + 1][1];
    if(!(entry > 0)) continue;
    const weekEnd = week[i][0] + 5 * DAY;
    if(mInd) kk = monthAt(month, kk, weekEnd);
    const m = monthReading(mInd, mc, kk, wc[i]), n = weekNews(news, weekEnd);
    set.wr.push(wRead.rsi); set.wm.push(wRead.macd); set.wp.push((wc[i] / wc[i - 1] - 1) * 100);
    set.mr.push(m.mr); set.mm.push(m.mm); set.mp.push(m.mp);
    set.np.push(n.np); set.nn.push(n.nn); set.cov.push(news && week[i][0] >= news.first ? 1 : 0);
    set.hit.push(reachedTop(week, i, H) >= entry * mult ? 1 : 0);
    set.t.push(week[i][0]); set.tk.push(tkIdx);
    added++;
  }
  set.n += added;
  return added;
}
function finishSampleSet(set){
  return { n: set.n, wr: Float32Array.from(set.wr), mr: Float32Array.from(set.mr), wp: Float32Array.from(set.wp), mp: Float32Array.from(set.mp),
    wm: Int8Array.from(set.wm), mm: Int8Array.from(set.mm), np: Int8Array.from(set.np), nn: Int8Array.from(set.nn), cov: Uint8Array.from(set.cov), hit: Uint8Array.from(set.hit), t: Float64Array.from(set.t), tk: Int32Array.from(set.tk) };
}

export { DAY, addStockSamples, finishSampleSet, newSampleSet };
