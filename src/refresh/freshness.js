// Freshness of a stock's Fundamental and Technical information: how old it is, which tier the stock is in (pinned, matches a
// strategy, everything else), what makes it worth refreshing early, and the order to refresh a list in. Reads only data on the page.
import { daysSinceEvent, newsCounts } from '../strategies/news.js';
import { isPinned } from '../core/pins.js';
import { publishedStrategies } from '../strategies/state.js';
import { qualifyingStocks } from '../strategies/rules.js';
import { stockResearchAgeDays } from '../research/status.js';
import { daysSinceDate, escapeHtml } from '../core/util.js';
import { stocks } from '../core/stocks.js';

const esc = escapeHtml;
// Up to the first number is fresh, up to the second is ageing. Pinned stocks are checked most often; Technical is fresh for a day for all.
const TIERS = {
  priority: { label: "Pinned", rank: 0, fund: [7, 21], tech: [1, 3] },
  match: { label: "Matches a strategy", rank: 1, fund: [7, 21], tech: [1, 3] },
  core: { label: "Everything else", rank: 2, fund: [30, 90], tech: [1, 3] },
};
// Every stock that passes the rules of any published strategy (kept for half a minute: working it out walks the whole list).
let matchCache = { t: 0, n: -1, set: new Set() };
function strategyMatches() {
  const now = Date.now();
  if (now - matchCache.t < 30000 && matchCache.n === stocks.length) return matchCache.set;
  const set = new Set();
  try { for (const st of publishedStrategies()) for (const s of qualifyingStocks(stocks, st.rules)) set.add(s); }
  catch (e) { console.error("Could not work out which stocks match a strategy", e); }
  matchCache = { t: now, n: stocks.length, set };
  return set;
}
const tierOf = (s) => isPinned(s) ? "priority" : strategyMatches().has(s) ? "match" : "core";
// Things that make a stock worth a Fundamental refresh whatever its age: results or a company event newer than the research,
// a run of negative headlines since then, or a big price move. Uses only data already on the page.
function attention(s) {
  const age = stockResearchAgeDays(s), out = [];
  if (age === null || age < 1) return out;
  const er = daysSinceEvent(s, "earn"), cr = daysSinceEvent(s, "corp");
  if (er !== null && er < age) out.push("new results");
  if (cr !== null && cr < age) out.push("company event");
  const nc = newsCounts(s, age);
  if (nc && nc.neg >= 2 && nc.neg > nc.pos) out.push("negative news");
  const raw = (s.technical && s.technical.raw) || {};
  if (age >= 3 && (Math.abs(raw.weekPctChange) >= 10 || Math.abs(raw.monthPctChange) >= 20)) out.push("big price move");
  return out;
}

function ageState(kind, age, tier) {
  if (age === null) return "none";
  const [fresh, ageing] = TIERS[tier || "core"][kind];
  return age <= fresh ? "fresh" : age <= ageing ? "aging" : "stale";
}
function freshness(s) {
  const fund = stockResearchAgeDays(s);
  let tech = null;
  for (const d of [s.__livePrice && s.__livePrice.asof, s.technical && s.technical.asof]) {
    const n = d ? daysSinceDate(d) : null;
    if (n !== null && (tech === null || n < tech)) tech = n;
  }
  const tier = tierOf(s), why = attention(s);
  let fs = ageState("fund", fund, tier);
  if (fs === "fresh" && why.length) fs = "attn";
  return { tier, why, fund: { age: fund, state: fs }, tech: { age: tech, state: ageState("tech", tech, tier) } };
}
const ago = (n) => n === null ? "never" : n === 0 ? "today" : n === 1 ? "1 day ago" : n + " days ago";
const needs = (kind, s) => freshness(s)[kind].state !== "fresh";
function freshText(s) {
  const f = freshness(s);
  return "Fundamental info: " + (f.fund.age === null ? "not researched yet" : "researched " + ago(f.fund.age)) + ". Technical info: " + (f.tech.age === null ? "no price date on file" : "price as of " + ago(f.tech.age)) + ".";
}
function dots(s) {
  return "";  // F/T badges removed from the grids (too much information)
  /* eslint-disable-next-line no-unreachable */
  const f = freshness(s), t = freshText(s);
  return '<span class="rk-dots" role="img" aria-label="' + esc(t) + '" title="' + esc(t) + '"><i class="rk-dot ' + f.fund.state + '">F</i><i class="rk-dot ' + f.tech.state + '">T</i></span>';
}
function counts(list) {
  let fund = 0, tech = 0, attn = 0;
  for (const s of list) { const f = freshness(s); if (f.fund.state !== "fresh") fund++; if (f.tech.state !== "fresh") tech++; if (f.why.length) attn++; }
  return { n: list.length, fund, tech, attn };
}
// Most important and most overdue first: stocks with something new, then pinned, strategy matches, the rest; oldest research first within each.
function priorityOrder(kind, list) {
  const key = (s) => { const f = freshness(s); return [kind === "fund" && f.why.length ? 0 : 1, TIERS[f.tier].rank, -(f[kind].age === null ? 1e6 : f[kind].age)]; };
  const k = new Map(list.map((s) => [s, key(s)]));
  return list.slice().sort((a, b) => { const x = k.get(a), y = k.get(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
}

export { ago, counts, dots, freshness, needs, priorityOrder };
