// The "Best swing trades for the day" section of the Rocky page: ranked cards built from the `swing` document that Rocky's daily run writes.
// Pure: takes that document, returns markup (all saved text is escaped). A ranking of candidates, not a prediction.
import { TIER_LABEL, e, fmt, list, num, table } from './fmt.js';

const NO_IDEAS = 'No stock fits today: monthly RSI 66-76, positive margin of safety, daily MACD above its signal line and the entry filters. Staying in cash is a valid call.';
const NOT_YET = 'The best swing trades appear after the next daily run.';
const CAVEAT = 'A ranking of candidates, not a prediction: in testing, about 4 in 10 comparable swing trades hit their stop within three weeks. Confirm the 3-hour chart before buying, use limit orders (especially on thin stocks), size by the stop and never risk more than your tier allows. This is a paper ledger\'s analysis, not advice.';

const price = (v) => num(v) ? '₹' + fmt(v, 2) : '–';
const actionClass = (a) => /^Buy/.test(a || '') ? 'rky-act-buy' : /^Wait/.test(a || '') ? 'rky-act-wait' : '';
const lakhs = (c) => '₹' + fmt(c / 100000) + 'L';

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
  return '<span class="rky-act ' + actionClass(i.action) + '">' + e(i.action) + '</span><span class="rky-chip">Score ' + fmt(i.score) + '</span>' +
    '<span class="rky-chip">' + e(TIER_LABEL[i.tier] || 'Unrated') + ' risk tier</span>' + (i.thin ? '<span class="rky-chip">Thin</span>' : '') + (i.spike ? '<span class="rky-chip">Earnings spike</span>' : '') + (i.inU ? '' : '<span class="rky-chip">Outside Rocky universe</span>');
}

function ideaCard(i, n, caps){
  return '<div class="rky-idea' + (n === 1 ? ' rky-idea-top' : '') + '"><h3 class="rky-idea-head"><span class="rky-rank">' + n + '</span><b>' + e(i.k) + '</b><span class="rky-sub">' + e(i.n) + ' · ' + e(i.g) + '</span>' + chips(i) + '</h3>' +
    levels(i, caps) + '<ul class="rky-why">' + list(i.why).map(w => '<li>' + e(w) + '</li>').join('') + '</ul>' + list(i.warn).map(w => '<div class="rky-warn">' + e(w) + '</div>').join('') + '</div>';
}

function alsoList(also){
  if(!also.length) return '';
  return '<h3 class="rky-h3">Also on the list</h3>' + table([
    { h: 'Stock', f: r => '<b>' + e(r.k) + '</b> <span class="rky-sub">' + e(r.n) + '</span>' + (r.thin ? ' <span class="rky-chip">Thin</span>' : '') },
    { h: 'Score', n: true, f: r => fmt(r.score) }, { h: 'Close ₹', n: true, f: r => fmt(r.close, 2) }, { h: 'M RSI', n: true, f: r => fmt(r.mrsi) },
    { h: 'MoS %', n: true, f: r => fmt(r.mos) }, { h: 'Status', f: r => e(r.action) }
  ], also, '');
}

function skippedNote(skipped){
  if(!skipped.length) return '';
  return '<p class="rky-sub">Matched your band but skipped by Rocky\'s filters: ' + skipped.map(s => e(s.k) + ' (' + e(s.why) + ')').join('; ') + '.</p>';
}

function summary(sw){
  const when = sw.m3hAsof ? ' · 3-hour check ' + e(sw.m3hAsof) : ' · no 3-hour check yet';
  return '<p class="rky-sub">' + e(sw.pool) + ' stocks fit your rule today (monthly RSI ' + e(list(sw.band)[0]) + '-' + e(list(sw.band)[1]) + ', positive margin of safety, daily MACD above its signal line). Data as of ' + e(sw.dataAsof || '?') + when + '.</p>';
}

function swingHtml(sw){
  if(!sw) return '<p class="rky-empty">' + NOT_YET + '</p>';
  const ideas = list(sw.ideas);
  if(!ideas.length) return '<p class="rky-empty">' + NO_IDEAS + '</p>';
  const caps = list(sw.capitals);
  return summary(sw) + ideas.map((i, n) => ideaCard(i, n + 1, caps)).join('') + alsoList(list(sw.also)) + skippedNote(list(sw.skipped)) + '<p class="rky-note">' + CAVEAT + '</p>';
}

export { swingHtml };
