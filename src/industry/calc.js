// Industry page numbers: the roll-up of a group of stocks (scores, valuation, verdicts, factors), their combined news
// and global / macro notes, and the average weekly / monthly % change series. Pure functions of the stocks handed in.
import { tickerSymbol } from '../core/util.js';
import { mosPct, scoreBand } from '../list/metrics.js';
import { eventTime } from '../prices/events.js';

const IST = 19800;
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Average Fundamental and Technical score, average margin of safety, verdict counts and the average of each Fundamental factor.
function industryFactors(members){
  const score = members.map(s => s.score).filter(v => Number.isFinite(v));
  const tech = members.map(s => s.technical && s.technical.score).filter(v => Number.isFinite(v));
  const mos = members.map(mosPct).filter(v => Number.isFinite(v));
  const verdicts = { buy: 0, mbuy: 0, hold: 0, avoid: 0 };
  score.forEach(v => { verdicts[scoreBand(v).replace('fs-', '')]++; });
  const by = new Map();
  members.forEach(s => {
    const fs = s.fundamentals && Array.isArray(s.fundamentals.factors) ? s.fundamentals.factors : [];
    fs.forEach(f => {
      if(f.excluded || !(f.weight > 0) || !Number.isFinite(f.score)) return;
      if(!by.has(f.key)) by.set(f.key, { key: f.key, name: f.name, vals: [] });
      by.get(f.key).vals.push(f.score / f.weight * 10);
    });
  });
  const factors = Array.from(by.values()).map(x => ({ key: x.key, name: x.name, avg: mean(x.vals), n: x.vals.length }));
  return {
    count: members.length,
    score: mean(score), scoreN: score.length,
    tech: mean(tech), techN: tech.length,
    mos: mean(mos), mosN: mos.length, undervalued: mos.filter(v => v > 0).length,
    verdicts, factors
  };
}

// News (and results / company events) of all the stocks, newest first. Each item: { d, t, k, src, url, s, stock, ticker }.
function industryNews(members){
  const out = [];
  members.forEach(s => {
    (Array.isArray(s.__events) ? s.__events : []).forEach(e => {
      if(!e || (e.k !== 'news' && e.k !== 'earn' && e.k !== 'corp') || !e.t || eventTime(e.d) === null) return;
      out.push({ d: String(e.d).slice(0, 10), t: String(e.t), k: e.k, src: e.src || '', url: e.url || '', s: e.s || '', stock: s.name, ticker: tickerSymbol(s) });
    });
  });
  return out.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
}

// The Global & Macro notes written for the member stocks, as one list per side: { text, source, url, stocks: [names] }.
// Notes with the same text (ignoring case) are joined and name every stock that has them; the most shared come first.
function industryGlobal(members){
  const side = (key) => {
    const by = new Map();
    members.forEach(s => {
      const g = s.globalFactors, list = g && Array.isArray(g[key]) ? g[key] : [];
      list.forEach(f => {
        if(!f || typeof f.text !== 'string' || !f.text.trim()) return;
        const k = f.text.trim().toLowerCase();
        if(!by.has(k)) by.set(k, { text: f.text, source: f.source || '', url: f.url || '', stocks: [] });
        by.get(k).stocks.push(s.name);
      });
    });
    return Array.from(by.values()).sort((a, b) => b.stocks.length - a.stocks.length);
  };
  const researched = members.filter(s => s.globalFactors && ((s.globalFactors.positive || []).length || (s.globalFactors.negative || []).length)).length;
  return { positive: side('positive'), negative: side('negative'), researched };
}

// Average % change per bar of the member stocks. bars: each stock's bars [t, o, h, l, c, v] for one interval ('W' or 'M').
// Bars of different stocks for the same week / month are matched by calendar period. Returns [[t, avgPct, stocksCounted], ...] oldest first.
function industrySeries(barLists, interval){
  const DAY = 86400, WEEK = 7 * DAY;
  const bucket = (t) => {
    if(interval === 'W') return Math.floor((t + IST) / WEEK);
    const d = new Date((t + IST) * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  const by = new Map();
  barLists.forEach(bars => {
    if(!Array.isArray(bars)) return;
    for(let i = 1; i < bars.length; i++){
      const prev = bars[i - 1][4], cur = bars[i][4];
      if(!(prev > 0) || !(cur > 0)) continue;
      const b = bucket(bars[i][0]);
      if(!by.has(b)) by.set(b, { t: bars[i][0], sum: 0, n: 0 });
      const e = by.get(b); e.sum += (cur / prev - 1) * 100; e.n++; if(bars[i][0] < e.t) e.t = bars[i][0];
    }
  });
  return Array.from(by.entries()).sort((a, b) => a[0] - b[0]).map(([, e]) => [e.t, e.sum / e.n, e.n]);
}

export { industryFactors, industryGlobal, industryNews, industrySeries };
