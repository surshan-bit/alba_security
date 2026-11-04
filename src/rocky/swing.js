// The "Best swing trades for the day" section of the Rocky page: ranked cards built from the `swing` document that Rocky's daily run writes.
// Candidates are the stocks that qualify the saved Positive MoS strategy; then two rules: monthly RSI 66-76, and a 3-hour MACD above its signal line and above zero. Pure: takes that document, returns markup (all saved text is escaped).
import { TIER_LABEL, e, fmt, list, num } from './fmt.js';

const NO_IDEAS = 'No Positive MoS stock meets both rules today: monthly RSI 66-76, and a 3-hour MACD above its signal line and above zero. Staying in cash is a valid call.';
const NOT_YET = 'The best swing trades appear after the next daily run.';
const CAVEAT = 'A ranking of candidates, not a prediction: in testing, about 4 in 10 comparable swing trades hit their stop within three weeks. Only the two rules above select a stock; the dashboard\'s own view is shown for reference. Confirm the 3-hour chart before buying, use limit orders (especially on thin stocks), size by the stop and never risk more than your tier allows. This is a paper ledger\'s analysis, not advice.';

const price = (v) => num(v) ? '₹' + fmt(v, 2) : '–';
const actionClass = (a) => /^Buy/.test(a || '') ? 'rky-act-buy' : '';
const lakhs = (c) => '₹' + fmt(c / 100000) + 'L';
const crossAge = (m) => m && num(m.since) ? m.since + (m.since === 1 ? ' bar ago' : ' bars ago') : 'a while ago';

function levels(i, caps){
  const entry = list(i.entry), q = i.qty || {};
  const cells = [
    ['Entry zone', price(entry[0]) + ' – ' + fmt(entry[1], 2)],
    ['Stop', price(i.stop) + ' (−' + fmt(i.stopPct, 1) + '%)'],
    ['Target 1 (+10%)', price(i.t1)], ['Target 2 (+20%)', price(i.t2)],
    ['Reward : risk to T2', fmt(i.rr, 1) + ' : 1'],
    ['Shares at ' + caps.map(lakhs).join(' / '), caps.map(c => fmt(q[String(c)])).join(' / ')]
  ];
  return '<div class="rky-levels">' + cells.map(c => '<div><b>' + c[0] + '</b><span>' + c[1] + '</span></div>').join('') + '</div>';
}

function chips(i){
  return '<span class="rky-act ' + actionClass(i.action) + '">' + e(i.action) + '</span><span class="rky-chip">3-hour cross ' + crossAge(i.m3h) + '</span>' +
    '<span class="rky-chip">' + e(TIER_LABEL[i.tier] || 'Unrated') + ' risk tier</span>' + (i.thin ? '<span class="rky-chip">Thin</span>' : '');
}

function ideaCard(i, n, caps){
  return '<div class="rky-idea' + (n === 1 ? ' rky-idea-top' : '') + '"><h3 class="rky-idea-head"><span class="rky-rank">' + n + '</span><b>' + e(i.k) + '</b><span class="rky-sub">' + e(i.n) + ' · ' + e(i.g) + '</span>' + chips(i) + '</h3>' +
    levels(i, caps) + '<ul class="rky-why">' + list(i.why).map(w => '<li>' + e(w) + '</li>').join('') + '</ul>' + list(i.warn).map(w => '<div class="rky-warn">' + e(w) + '</div>').join('') + '</div>';
}

function summary(sw, n){
  const band = list(sw.band);
  return '<p class="rky-sub">' + e(sw.pool) + ' stocks qualify your Positive MoS strategy and have a monthly RSI of ' + e(band[0]) + '-' + e(band[1]) + '. ' + e(sw.shortlisted) + ' passed a first pass on the 2-hour and 4-hour MACD and ' + e(sw.checked) +
    ' got the exact 3-hour check; ' + n + ' meet both rules, freshest 3-hour cross first. Data as of ' + e(sw.dataAsof || '?') + '.</p>';
}

function swingHtml(sw){
  if(!sw) return '<p class="rky-empty">' + NOT_YET + '</p>';
  const ideas = list(sw.ideas), head = summary(sw, ideas.length);
  if(!ideas.length) return head + '<p class="rky-empty">' + NO_IDEAS + '</p>';
  const caps = list(sw.capitals);
  return head + ideas.map((i, n) => ideaCard(i, n + 1, caps)).join('') + '<p class="rky-note">' + CAVEAT + '</p>';
}

export { swingHtml };
