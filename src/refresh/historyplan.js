// Which stocks need price bars when "Refresh all stocks" runs its history stages (v1.200). Pure, so it can be tested on its own.
//   none    = stocks with no saved weekly bars: their full history (about 5 years, up to today) is downloaded.
//   stale   = stocks with saved bars where a weekly or monthly bar has finished since the newest saved one: only the new bars are downloaded.
//   current = everything else: nothing to do (the bar in progress is not used by the completed-weeks score, so it is not chased every day).
// Bar times are unix seconds (the bar's open). Weeks start on Monday and months on the 1st, in Indian time.
const IST = 19800, DAY = 86400, TOLERANCE = 12 * 3600;   // a bar may open a few hours before midnight Indian time

// Midnight (Indian time) at the start of the Monday of the week containing `nowS`, as unix seconds.
function weekStartS(nowS){
  const dayStart = Math.floor((nowS + IST) / DAY) * DAY - IST;
  const dow = (new Date((nowS + IST) * 1000).getUTCDay() + 6) % 7;   // Monday = 0
  return dayStart - dow * DAY;
}
// Midnight (Indian time) at the start of the month containing `nowS`.
function monthStartS(nowS){
  const d = new Date((nowS + IST) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - IST;
}
const lastBar = rows => (Array.isArray(rows) && rows.length ? rows[rows.length - 1][0] : null);

// `have` = { '1W': bars, '1M': bars } for one stock, or null / empty when nothing is saved.
function barsNeeded(have, nowS){
  const w = have && lastBar(have['1W']);
  if(w == null) return 'none';
  const m = lastBar(have['1M']);
  if(m == null || w < weekStartS(nowS) - TOLERANCE || m < monthStartS(nowS) - TOLERANCE) return 'stale';
  return 'current';
}
function planHistory(list, haveOf, nowS){
  const plan = { none: [], stale: [], current: [] };
  for(const s of list) plan[barsNeeded(haveOf(s), nowS)].push(s);
  return plan;
}

export { planHistory, weekStartS, monthStartS, TOLERANCE };
