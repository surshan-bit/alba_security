// The "Best swing trades for the day" section of the Rocky page: a ranked grid built from the `swing` document that Rocky's daily run writes.
// Candidates are the stocks that qualify the saved Positive MoS strategy; then the rules: weekly MACD above its signal line, and the 2-hour and 1-day MACD (30, 60, 5) above their signal lines. Pure: takes that document, returns markup (all saved text is escaped).
import { TIER_LABEL, e, fmt, list, num, table } from './fmt.js';

const NO_IDEAS = 'No Positive MoS stock meets the rules today: weekly MACD above its signal line, and the 2-hour and 1-day MACD (30, 60, 5) above their signal lines. Staying in cash is a valid call.';
const NOT_YET = 'The best swing trades appear after the next daily run.';
const CAVEAT = 'A ranking of candidates, not a prediction: in testing, about 4 in 10 comparable swing trades hit their stop within three weeks. Only the rules above select a stock; the dashboard\'s own view is shown for reference. Confirm the 2-hour chart before buying, use limit orders (especially on thin stocks), size by the stop and never risk more than your tier allows. This is a paper ledger\'s analysis, not advice.';

const price = (v) => num(v) ? '₹' + fmt(v, 2) : '–';
const lakhs = (c) => '₹' + fmt(c / 100000) + 'L';
// Bars since the MACD last crossed up; 'below' when it is under its signal line now; a dash when unknown.
const crossBars = (m) => !m ? '–' : num(m.h) && m.h <= 0 ? 'below' : num(m.since) ? String(m.since) : '–';

// One row per idea. The lead columns are the rules (weekly MACD, 2-hour and 1-day MACD cross ages), the monthly RSI (which only sets the tier), the weekly RSI and the 3-hour MACD cross age (information only); then the levels, the sizes and the warnings.
function columns(caps){
  return [
    { h: '#', f: (i) => String(i.rank) },
    { h: 'Stock', f: (i) => '<b>' + e(i.k) + '</b><br><span class="rky-sub">' + e(i.n) + '</span>' },
    { h: 'W RSI', n: true, f: (i) => fmt(i.wrsi) },
    { h: 'M RSI', n: true, f: (i) => fmt(i.mrsi) },
    { h: '1-day cross (bars ago)', n: true, f: (i) => crossBars(i.m1d) },
    { h: '2-hr cross (bars ago)', n: true, f: (i) => crossBars(i.m2h) },
    { h: '3-hr cross (bars ago)', n: true, f: (i) => crossBars(i.m3h) },
    { h: 'Tier', f: (i) => e(TIER_LABEL[i.tier] || 'Unrated') },
    { h: 'Entry', n: true, f: (i) => price(list(i.entry)[0]) },
    { h: 'Stop', n: true, f: (i) => price(i.stop) + ' (−' + fmt(i.stopPct, 1) + '%)' },
    { h: 'T1 +10%', n: true, f: (i) => price(i.t1) },
    { h: 'T2 +20%', n: true, f: (i) => price(i.t2) },
    { h: 'Shares at ' + caps.map(lakhs).join(' / '), n: true, f: (i) => caps.map(c => fmt((i.qty || {})[String(c)])).join(' / ') },
    { h: 'Notes', f: (i) => list(i.warn).length ? list(i.warn).map(e).join('; ') : '–' }
  ];
}

function summary(sw, n){
  return '<p class="rky-sub">' + e(sw.pool) + ' stocks qualify your Positive MoS strategy and have the weekly MACD above its signal line (any monthly RSI). ' + e(sw.checked) +
    ' got the 2-hour MACD check; ' + n + ' meet all the rules, freshest 2-hour cross first. Data as of ' + e(sw.dataAsof || '?') + '.</p>';
}

function swingHtml(sw){
  if(!sw) return '<p class="rky-empty">' + NOT_YET + '</p>';
  const ideas = list(sw.ideas), head = summary(sw, ideas.length);
  if(!ideas.length) return head + '<p class="rky-empty">' + NO_IDEAS + '</p>';
  const caps = list(sw.capitals);
  const rows = ideas.map((i, n) => Object.assign({}, i, { rank: n + 1 }));
  return head + table(columns(caps), rows, '') + '<p class="rky-note">' + CAVEAT + '</p>';
}

export { swingHtml };
