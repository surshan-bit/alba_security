// Analysis leaderboard grouping: splits the ranked stocks into industries (or industry groups) and works out each group's figures.
// Pure functions of the ranked list, so they are easy to test. The ranking itself (pins first, then "Sort by") is done by the caller.
import { tickerIndustry } from '../core/util.js';

// 'industry' is the fine label saved with the ticker; 'group' is the wider Industry Group (the same two choices Explorer has).
const groupNameOf = (s, by) => by === 'group' ? (s.industryGroup || '—') : tickerIndustry(s);

const finite = (v) => Number.isFinite(v) ? v : null;
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const median = (xs) => { if(!xs.length) return null; const a = xs.slice().sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const changeOf = (s, key) => finite(s.technical && s.technical.raw ? s.technical.raw[key] : null);

// Groups in the order their best-ranked stock appears, and the stocks of each group in ranked order.
// Each group: { name, members, meanW, meanM, medianW, up, down } (changes are weekly; a figure no stock has is null).
function groupRanked(ranked, by){
  const groups = new Map();
  ranked.forEach(s => {
    const name = groupNameOf(s, by);
    if(!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  });
  return Array.from(groups, ([name, members]) => {
    const w = members.map(s => changeOf(s, 'weekPctChange')).filter(v => v !== null);
    const m = members.map(s => changeOf(s, 'monthPctChange')).filter(v => v !== null);
    return { name, members, meanW: mean(w), meanM: mean(m), medianW: median(w), up: w.filter(v => v > 0).length, down: w.filter(v => v < 0).length };
  });
}

export { groupRanked };
