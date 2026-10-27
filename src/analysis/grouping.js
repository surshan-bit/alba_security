// Analysis leaderboard grouping: splits the ranked stocks into industries (or industry groups).
// Pure functions of the ranked list, so they are easy to test. The ranking itself (pins first, then "Sort by") is done by the caller.
import { tickerIndustry } from '../core/util.js';

// 'industry' is the fine label saved with the ticker; 'group' is the wider Industry Group (the same two choices Explorer has).
const groupNameOf = (s, by) => by === 'group' ? (s.industryGroup || '—') : tickerIndustry(s);

// Groups in the order their best-ranked stock appears, and the stocks of each group in ranked order. Each group: { name, members }.
function groupRanked(ranked, by){
  const groups = new Map();
  ranked.forEach(s => {
    const name = groupNameOf(s, by);
    if(!groups.has(name)) groups.set(name, []);
    groups.get(name).push(s);
  });
  return Array.from(groups, ([name, members]) => ({ name, members }));
}

export { groupRanked };
