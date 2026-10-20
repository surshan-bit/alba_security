// Fundamental Score import: the integrity checks run before anything is written (the saved check_fundamental + precheck_data scripts).
// Pure functions with no page code, so the tests can load them directly. Shared by the Fundamental and Technical imports.
const albaFiSym = s => s.ticker.split('·')[0].trim();
// pillars.val (the valuation anchor the Technical Score uses) comes from the Margin of Safety, which needs a positive Intrinsic Value
// and a price. A stock whose file row has no Intrinsic Value has no anchor: that is allowed, and the technical import leaves it
// frozen. A stock that DOES have a valuation but no anchor is a real fault.
const albaFiHasValuation = s => { const v = s.valuation; return !!v && typeof v.intrinsicValue === 'number' && v.intrinsicValue > 0 && typeof v.currentPrice === 'number'; };
function albaFiPrevInfo(stocks){
  const m = new Map(), n = g => g && ((g.positive || []).length + (g.negative || []).length);
  for(const s of stocks) m.set(albaFiSym(s), { score: s.score, verdict: s.verdict, hasGlobal: !!n(s.globalFactors), hasTech: !!(s.technical && s.technical.score != null) });
  return m;
}
function albaFiCheck(stocks, prev){
  const hard = [], soft = [];
  const band = x => x >= 8 ? 'buy' : x >= 6 ? 'mbuy' : x >= 5 ? 'hold' : 'avoid';
  const list = a => a.slice(0, 5).join(', ') + (a.length > 5 ? ' …' : '');
  const seen = new Set(), dups = [], badShape = [], badNum = [], badSum = [], badVerdict = [], badPillar = [];
  if(stocks.length < 2000) hard.push('only ' + stocks.length + ' stocks in the result');
  for(const s of stocks){
    const t = albaFiSym(s); const u = t.toUpperCase();
    if(seen.has(u)) dups.push(t); seen.add(u);
    const f = s.fundamentals && s.fundamentals.factors;
    if(!Array.isArray(f) || f.length !== 9 || typeof s.score !== 'number'){ badShape.push(t); continue; }
    if(f.some(x => typeof x.score !== 'number' || !isFinite(x.score))) badNum.push(t);
    const sum = f.reduce((a, x) => a + (typeof x.score === 'number' ? x.score : 0), 0), w = f.reduce((a, x) => a + x.weight, 0);
    if(Math.abs(sum - s.score) > 0.05 || Math.abs(w - 10) > 0.02) badSum.push(t);
    if(s.verdict !== band(s.score)) badVerdict.push(t);
    if((!s.pillars || typeof s.pillars.val !== 'number') && albaFiHasValuation(s)) badPillar.push(t);
  }
  if(dups.length) hard.push(dups.length + ' duplicate tickers: ' + list(dups));
  if(badShape.length) hard.push(badShape.length + ' stocks without a complete 9-factor block: ' + list(badShape));
  if(badNum.length) hard.push(badNum.length + ' stocks with a non-numeric factor score: ' + list(badNum));
  if(badSum.length) hard.push(badSum.length + ' stocks where the factors do not add up to the score: ' + list(badSum));
  if(badVerdict.length) hard.push(badVerdict.length + ' verdicts that disagree with the score bands: ' + list(badVerdict));
  if(badPillar.length) hard.push(badPillar.length + ' stocks with a non-numeric pillars.val: ' + list(badPillar));
  let moved = 0, maxMove = 0; const lostGlobal = [], lostTech = [];
  const now = new Set();
  for(const s of stocks){
    const t = albaFiSym(s); now.add(t);
    const p = prev.get(t); if(!p) continue;
    if(typeof s.score === 'number' && typeof p.score === 'number'){ const d = Math.abs(s.score - p.score); if(d >= 1.0) moved++; if(d > maxMove) maxMove = d; }
    const n = g => g && ((g.positive || []).length + (g.negative || []).length);
    if(p.hasGlobal && !n(s.globalFactors)) lostGlobal.push(t);
    if(p.hasTech && !(s.technical && s.technical.score != null)) lostTech.push(t);
  }
  const lost = []; for(const t of prev.keys()) if(!now.has(t)) lost.push(t);
  if(lost.length) hard.push(lost.length + ' stocks would disappear: ' + list(lost));
  if(lostGlobal.length) hard.push(lostGlobal.length + ' stocks would lose their Global & Macro content: ' + list(lostGlobal));
  if(lostTech.length) hard.push(lostTech.length + ' stocks would lose their technical score: ' + list(lostTech));
  if(moved > 40) soft.push(moved + ' stocks moved by 1.0 point or more (normally under 40). That can be real after a big data change, or a sign of a wrong file.');
  return { hard, soft, moved, maxMove };
}

export { albaFiCheck, albaFiHasValuation, albaFiPrevInfo, albaFiSym };
