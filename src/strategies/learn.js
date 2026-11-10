// Finds technical rules that, in the past, were followed by the goal more often than chance.
// Method: every past week of every stock is a sample (see samples.js). The older 70% of the timeline is used to
// search; the newest 30% is kept aside and only used to check the rules found. Rules are built from a fixed menu of
// simple conditions, adding up to three (one per field), keeping the best few at each step. Candidates are ranked by
// the lower end of a 95% confidence interval on their hit rate, so a rule seen only a few times cannot rank high.
import { MACD_STATES } from './indicators.js';
import { DAY } from './samples.js';

const COLUMN = { weekRsi: 'wr', monthRsi: 'mr', weekPct: 'wp', monthPct: 'mp', weekMacd: 'wm', monthMacd: 'mm' };
const FIELD_ORDER = ['weekRsi', 'monthRsi', 'weekMacd', 'monthMacd', 'weekPct', 'monthPct'];
const rule = (field, op, value) => ({ field, op, value });
const BULL = ['bull_above', 'bull_below'], BEAR = ['bear_above', 'bear_below'];

// The menu of conditions the search may use. Same shapes the rule editor produces.
function atomMenu(){
  const out = [];
  for(const f of ['weekRsi', 'monthRsi']){
    out.push(rule(f, '<=', 30), rule(f, 'between', [30, 40]), rule(f, 'between', [40, 50]), rule(f, 'between', [50, 60]), rule(f, 'between', [60, 70]), rule(f, '>=', 70));
  }
  for(const f of ['weekMacd', 'monthMacd']){
    MACD_STATES.forEach(s => out.push(rule(f, 'in', [s])));
    out.push(rule(f, 'in', BULL), rule(f, 'in', BEAR));
  }
  out.push(rule('weekPct', '<=', -5), rule('weekPct', 'between', [-5, 0]), rule('weekPct', 'between', [0, 5]), rule('weekPct', '>=', 5));
  out.push(rule('monthPct', '<=', -10), rule('monthPct', 'between', [-10, 0]), rule('monthPct', 'between', [0, 10]), rule('monthPct', '>=', 10));
  return out;
}
// Same meaning as testRule() in rules.js, applied to one sample's column value. Missing values fail.
function predicateFor(r){
  if(r.op === 'in'){
    const codes = new Set(r.value.map(v => MACD_STATES.indexOf(v)));
    return (x) => codes.has(x);
  }
  if(r.op === 'between'){ const lo = Math.min(...r.value), hi = Math.max(...r.value); return (x) => x >= lo && x <= hi; }
  if(r.op === '<=') return (x) => x <= r.value;
  if(r.op === '>=') return (x) => x >= r.value;
  return () => false;
}

// Lower end of the 95% Wilson interval for a hit rate.
function wilsonLow(hits, n){
  if(!n) return 0;
  const z = 1.96, p = hits / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}
function stats(data, idx, withStocks){
  let hits = 0;
  for(let k = 0; k < idx.length; k++) hits += data.hit[idx[k]];
  const o = { n: idx.length, hits, rate: idx.length ? hits / idx.length : 0, low: wilsonLow(hits, idx.length) };
  if(withStocks){ const seen = new Set(); for(let k = 0; k < idx.length; k++) seen.add(data.tk[idx[k]]); o.stocks = seen.size; }
  return o;
}
function filterIdx(data, idx, atom){
  const col = data[COLUMN[atom.rule.field]], out = [];
  for(let k = 0; k < idx.length; k++){ const x = col[idx[k]]; if(x === x && atom.test(x)) out.push(idx[k]); }   // x === x drops NaN
  return Int32Array.from(out);
}
function quantile(arr, q){ const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

const MIN_SAMPLES = 400, MIN_TRAIN = 300, MIN_HOLD = 100;   // less history than this is too little to test rules on
const MIN_STOCKS = 8;                                         // a candidate must have shown up in at least this many stocks

// Splits the samples at the trainFrac point of the timeline: { tCut, train, hold } as sample indexes, or null when either side is too thin.
function splitByTime(data, H, trainFrac){
  const tCut = quantile(data.t, trainFrac);
  const trainAll = [], holdAll = [];
  for(let i = 0; i < data.n; i++){
    if(data.t[i] + H * 7 * DAY <= tCut) trainAll.push(i);   // its outcome window ended before the cut, so no peeking
    else if(data.t[i] >= tCut) holdAll.push(i);
  }
  if(trainAll.length < MIN_TRAIN || holdAll.length < MIN_HOLD) return null;
  return { tCut, train: Int32Array.from(trainAll), hold: Int32Array.from(holdAll) };
}

// One more condition added to each of the best few combinations so far (the beam). Candidates worth ranking go to search.all.
// search = { data, atoms, minN, beam, baseTrain, all }.
function extendLevel(search, level){
  const { data, atoms, minN, beam } = search;
  level.sort((x, y) => y.st.low - x.st.low);
  const parents = level.slice(0, beam), next = [];
  for(const p of parents){
    const used = new Set(p.atoms.map(a => a.rule.field));
    for(const a of atoms){
      if(used.has(a.rule.field)) continue;
      const idx = filterIdx(data, p.idx, a);
      if(idx.length < minN) continue;
      const st = stats(data, idx, true);
      if(st.low < p.st.low + 0.003) continue;   // adding the condition must clearly help
      const node = { atoms: [...p.atoms, a], idx, st };
      next.push(node); considerNode(search, node);
    }
  }
  return next;
}
function considerNode({ all, minN, baseTrain }, node){
  if(node.st.n >= minN && node.st.stocks >= MIN_STOCKS && node.st.low > baseTrain.rate) all.push(node);
}

// Searches the older samples for combinations of up to maxAtoms conditions; returns every candidate worth ranking.
function searchCandidates(data, train, { beam, maxAtoms, minN, baseTrain }){
  const atoms = atomMenu().map(r => ({ rule: r, key: JSON.stringify(r), test: predicateFor(r) }));
  const search = { data, atoms, minN, beam, baseTrain, all: [] };
  let level = [];
  for(const a of atoms){
    const idx = filterIdx(data, train, a);
    const node = { atoms: [a], idx, st: stats(data, idx, true) };
    if(node.st.n >= minN){ level.push(node); considerNode(search, node); }
  }
  for(let depth = 2; depth <= maxAtoms; depth++){
    level = extendLevel(search, level);
    if(!level.length) break;
  }
  return search.all;
}

// Best first; drops a longer rule that is barely better than a shorter one already chosen.
function chooseCandidates(all, top){
  all.sort((x, y) => y.st.low - x.st.low);
  const chosen = [];
  for(const node of all){
    const keys = new Set(node.atoms.map(a => a.key));
    const dup = chosen.some(c => c.atoms.every(a => keys.has(a.key)) && node.st.low - c.st.low < 0.01);
    const seen = chosen.some(c => c.atoms.length === node.atoms.length && c.atoms.every(a => keys.has(a.key)));
    const same = chosen.some(c => c.st.n === node.st.n && c.st.hits === node.st.hits);   // the same past cases, worded differently
    if(dup || seen || same) continue;
    chosen.push(node);
    if(chosen.length >= top) break;
  }
  return chosen;
}

// Checks each chosen rule on the newest samples, which the search never saw. Rules that held up come first.
function checkOnHoldout(data, chosen, { hold, baseHold, minN }){
  const suggestions = chosen.map(node => {
    let idx = hold;
    for(const a of node.atoms) idx = filterIdx(data, idx, a);
    const rules = node.atoms.map(a => a.rule).sort((p, q) => FIELD_ORDER.indexOf(p.field) - FIELD_ORDER.indexOf(q.field));
    const holdSt = stats(data, idx, true);
    return { rules, train: node.st, hold: holdSt, holds: holdSt.n >= Math.max(30, Math.round(minN / 3)) && holdSt.low > baseHold.rate };
  });
  suggestions.sort((a, b) => (b.holds ? 1 : 0) - (a.holds ? 1 : 0));   // stable: keeps the search ranking inside each group
  return suggestions;
}

// data: finished sample set. H: weeks in the horizon. -> null when there is too little history.
function learnRules(data, H, opts = {}){
  const trainFrac = opts.trainFrac || 0.7, beam = opts.beam || 8, maxAtoms = opts.maxAtoms || 3, top = opts.top || 5;
  if(!data || data.n < MIN_SAMPLES) return null;
  const split = splitByTime(data, H, trainFrac);
  if(!split) return null;
  const { tCut, train, hold } = split;
  const baseTrain = stats(data, train), baseHold = stats(data, hold);
  const minN = Math.max(60, Math.round(0.003 * train.length));
  const chosen = chooseCandidates(searchCandidates(data, train, { beam, maxAtoms, minN, baseTrain }), top);
  return {
    baseTrain, baseHold, suggestions: checkOnHoldout(data, chosen, { hold, baseHold, minN }), minN,
    samples: data.n, from: data.t.reduce((a, b) => Math.min(a, b), Infinity), to: data.t.reduce((a, b) => Math.max(a, b), -Infinity), cut: tCut
  };
}

// Did weeks with positive / negative news do better? Only weeks after a stock's news record began are counted.
// Uses all of those weeks (no older / newer split): the record is short, so this is a hint that grows with each refresh.
function newsEffect(data){
  const g = { pos: { n: 0, hits: 0 }, neg: { n: 0, hits: 0 }, both: { n: 0, hits: 0 }, none: { n: 0, hits: 0 } };
  const stocksSeen = new Set();
  let covered = 0;
  for(let i = 0; i < data.n; i++){
    if(!data.cov[i]) continue;
    covered++; stocksSeen.add(data.tk[i]);
    const k = data.np[i] && data.nn[i] ? 'both' : data.np[i] ? 'pos' : data.nn[i] ? 'neg' : 'none';
    g[k].n++; g[k].hits += data.hit[i];
  }
  return { covered, stocks: stocksSeen.size, groups: g };
}

export { learnRules, newsEffect };
