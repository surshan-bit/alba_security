// News and company events saved on each stock by Refresh Fundamental Info (s.__events, see livedata/events.js):
// news items with a positive / negative / neutral label, results dates, and other company events.
// A stock that has never had a Fundamental refresh has no event record at all, which is different from having one with
// nothing recent in it, so these helpers return null for "unknown".
const DAY_MS = 86400000;
const NEWS_DAYS = 14;

function eventMs(d){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
const eventsOf = (s) => (Array.isArray(s.__events) ? s.__events : null);

// News counted in the last `days` days: { pos, neg, neu, total } (unlabelled items count only in total), or null if unknown.
function newsCounts(s, days = NEWS_DAYS){
  const evs = eventsOf(s);
  if(!evs) return null;
  const now = Date.now(), out = { pos: 0, neg: 0, neu: 0, total: 0 };
  evs.forEach(e => {
    if(!e || e.k !== 'news') return;
    const ms = eventMs(e.d);
    if(ms === null || now - ms > days * DAY_MS || ms - now > DAY_MS) return;
    out.total++;
    if(e.s === 'pos') out.pos++; else if(e.s === 'neg') out.neg++; else if(e.s === 'neu') out.neu++;
  });
  return out;
}
// The recent headlines of a stock for the Buy / Sell ideas cards: negative first, then the newest, at most `max`.
// Each is { d (date), t (headline), s ('pos' | 'neg' | 'neu' | ''), src, url }. Null when the stock has no saved news record at all.
function recentNews(s, days = NEWS_DAYS, max = 4){
  const evs = eventsOf(s);
  if(!evs) return null;
  const now = Date.now(), list = [];
  evs.forEach(e => {
    if(!e || e.k !== 'news' || typeof e.t !== 'string') return;
    const ms = eventMs(e.d);
    if(ms === null || now - ms > days * DAY_MS || ms - now > DAY_MS) return;
    list.push({ d: String(e.d).slice(0, 10), t: e.t, s: e.s === 'pos' || e.s === 'neg' || e.s === 'neu' ? e.s : '', src: e.src || '', url: /^https?:\/\//i.test(e.url || '') ? e.url : '' });
  });
  const rank = x => (x.s === 'neg' ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b) || (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  return list.slice(0, max);
}
// Days since the latest event of a kind ('earn' = results, 'corp' = company event); null if none is known.
function daysSinceEvent(s, kind){
  const evs = eventsOf(s);
  if(!evs) return null;
  let latest = /** @type {number | null} */ (null);
  evs.forEach(e => { if(e && e.k === kind){ const ms = eventMs(e.d); if(ms !== null && (latest === null || ms > latest)) latest = ms; } });
  if(latest === null) return null;
  const now = new Date();
  return Math.max(0, Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - latest) / DAY_MS));
}
// For the history search: news times (unix seconds) with their label, and when the record starts.
function newsTimeline(s){
  const evs = eventsOf(s);
  if(!evs) return null;
  const list = [];
  evs.forEach(e => { if(e && e.k === 'news'){ const ms = eventMs(e.d); if(ms !== null) list.push({ t: ms / 1000, s: e.s || '' }); } });
  if(!list.length) return null;
  const first = list.reduce((a, b) => Math.min(a, b.t), Infinity);
  return { first, list };
}

// The "News 14d" table cell: positive and negative items in the last 14 days ("—" when no news was ever saved).
function newsCellHtml(s){
  const c = newsCounts(s);
  if(!c) return '<td class="num"></td>';
  if(!c.total) return '<td class="num">0</td>';
  return `<td class="num"><span class="news-pos">+${c.pos}</span> <span class="news-neg">&minus;${c.neg}</span></td>`;
}

export { NEWS_DAYS, daysSinceEvent, eventMs, newsCellHtml, newsCounts, newsTimeline, recentNews };
