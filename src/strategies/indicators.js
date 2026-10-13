// EMA, MACD(12,26,9) and RSI(14) as full series, using exactly the rules of the Technical Score engine
// (src/engine/technical.js): EMAs are seeded with the first close, RSI is Wilder-smoothed and seeded with a simple
// average. `peek` gives the reading you would see if one more, still unfinished, bar closed at a given price, which is
// how the live Technical Score treats the current week or month.
const K12 = 2 / 13, K26 = 2 / 27, K9 = 2 / 10;
const MACD_STATES = ['bull_above', 'bull_below', 'bear_above', 'bear_below'];
const MIN_MACD_BARS = 35, MIN_RSI_BARS = 15;   // same minimums as the engine

const rsiOf = (ag, al) => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));
const macdCode = (level, signal) => (level > signal ? 0 : 2) + (level > 0 ? 0 : 1);

function buildIndicators(c){
  const n = c.length;
  const e12 = new Float64Array(n), e26 = new Float64Array(n), macd = new Float64Array(n), sig = new Float64Array(n);
  const ag = new Float64Array(n), al = new Float64Array(n);
  for(let i = 0; i < n; i++){
    e12[i] = i ? c[i] * K12 + e12[i - 1] * (1 - K12) : c[0];
    e26[i] = i ? c[i] * K26 + e26[i - 1] * (1 - K26) : c[0];
    macd[i] = e12[i] - e26[i];
    sig[i] = i ? macd[i] * K9 + sig[i - 1] * (1 - K9) : macd[0];
  }
  if(n > 14){
    let g = 0, l = 0;
    for(let i = 1; i <= 14; i++){ const d = c[i] - c[i - 1]; if(d > 0) g += d; else l -= d; }
    ag[14] = g / 14; al[14] = l / 14;
    for(let i = 15; i < n; i++){ const d = c[i] - c[i - 1]; ag[i] = (ag[i - 1] * 13 + Math.max(d, 0)) / 14; al[i] = (al[i - 1] * 13 + Math.max(-d, 0)) / 14; }
  }
  return { c, n, e12, e26, macd, sig, ag, al };
}
// Reading after bar i has closed (NaN / -1 when there is too little history).
function readingAt(ind, i){
  return {
    rsi: i + 1 >= MIN_RSI_BARS ? rsiOf(ind.ag[i], ind.al[i]) : NaN,
    macd: i + 1 >= MIN_MACD_BARS ? macdCode(ind.macd[i], ind.sig[i]) : -1
  };
}
// Reading if one more bar followed bar i and closed at `price`.
function peek(ind, i, price){
  const j = i + 1;
  const e12 = price * K12 + ind.e12[i] * (1 - K12), e26 = price * K26 + ind.e26[i] * (1 - K26);
  const level = e12 - e26, signal = level * K9 + ind.sig[i] * (1 - K9);
  let rsi = NaN;
  if(j + 1 >= MIN_RSI_BARS){
    if(i >= 14){ const d = price - ind.c[i]; rsi = rsiOf((ind.ag[i] * 13 + Math.max(d, 0)) / 14, (ind.al[i] * 13 + Math.max(-d, 0)) / 14); }
    else {   // exactly 14 bars before it: seed the average from the first 14 changes
      let g = 0, l = 0;
      for(let k = 1; k <= 14; k++){ const d = (k <= i ? ind.c[k] : price) - ind.c[k - 1]; if(d > 0) g += d; else l -= d; }
      rsi = rsiOf(g / 14, l / 14);
    }
  }
  return { rsi, macd: j + 1 >= MIN_MACD_BARS ? macdCode(level, signal) : -1 };
}

export { MACD_STATES, buildIndicators, peek, readingAt };
