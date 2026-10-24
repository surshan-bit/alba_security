// News page: the plain logic (no page, no database), so it can be tested on its own.
// Three saved records in the collection "news":
//   news/pulse   written by the page's Refresh News button: { at, tiles, reading, readingAt }
//   news/macro   written from a research session: { asof, calendar, briefings, sources }
//   news/events  written from a research session: { asof, items }   (upcoming results, dividends, board meetings, company events)

// The market pulse tiles. `bad: true` means a rise is bad news for Indian stocks (shown red when it goes up).
const PULSE_TILES = [
  { id: 'nifty', label: 'Nifty 50', sym: 'NSE:NIFTY', dp: 0 },
  { id: 'sensex', label: 'Sensex', sym: 'BSE:SENSEX', dp: 0 },
  { id: 'vix', label: 'India VIX', sym: 'NSE:INDIAVIX', dp: 2, bad: true },
  { id: 'usdinr', label: 'USD / INR', sym: 'FX_IDC:USDINR', dp: 2, bad: true },
  { id: 'brent', label: 'Brent crude', sym: 'ICEEUR:BRN1!', dp: 2, bad: true, unit: '$' },
  { id: 'us10y', label: 'US 10-yr yield', sym: 'TVC:US10Y', dp: 2, bad: true, unit: '%', after: true },
  { id: 'dxy', label: 'Dollar index', sym: 'TVC:DXY', dp: 2, bad: true },
  { id: 'spx', label: 'S&P 500', sym: 'SP:SPX', dp: 0 },
  { id: 'gold', label: 'Gold', sym: 'TVC:GOLD', dp: 0 }
];
const PULSE_SYMBOLS = PULSE_TILES.map(t => t.sym);
const READING_MAX = 3;

const isNum = (v) => typeof v === 'number' && isFinite(v);

// `data` is the symbol map of get-symbol-data-batch: { 'NSE:NIFTY': { close, change, ... }, ... }.
// Returns the tiles that have a price, in the order above: [{ id, close, change }].
function buildTiles(data){
  const out = [];
  PULSE_TILES.forEach(t => {
    const q = data && data[t.sym];
    if(!q || !isNum(q.close)) return;
    out.push({ id: t.id, close: q.close, change: isNum(q.change) ? q.change : null });
  });
  return out;
}

// How a tile is shown: { label, value, change, tone } where tone is 'up' (good for the market), 'down' (bad) or ''.
function tileView(tile){
  const def = PULSE_TILES.find(t => t.id === tile.id);
  if(!def) return null;
  const v = tile.close.toLocaleString('en-IN', { minimumFractionDigits: def.dp, maximumFractionDigits: def.dp });
  const value = def.unit === '$' ? '$' + v : def.after ? v + '%' : v;
  const c = tile.change;
  const change = c === null ? '' : (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
  let tone = '';
  if(c !== null && Math.abs(c) >= 0.005) tone = (c > 0) === !def.bad ? 'up' : 'down';
  if(def.id === 'gold') tone = '';   // gold is not good or bad for Indian stocks on its own
  return { id: def.id, label: def.label, value, change, tone };
}

// The prompt for the three "why" lines. Claude only sees the numbers and the next events given here.
function readingPrompt(tiles, nextEvents){
  const lines = tiles.map(t => { const v = tileView(t); return v ? `${v.label}: ${v.value} (${v.change || 'no change'})` : ''; }).filter(Boolean);
  const ev = (nextEvents || []).slice(0, 4).map(e => `${e.date}: ${e.title}`);
  return 'You explain, for a retail investor in Indian stocks, in very simple words, what is most likely moving the Indian market today.\n' +
    'Use ONLY the numbers below. Do not mention any news, event or fact that is not in the data. A rise in India VIX, USD/INR, Brent crude, the US 10-year yield or the dollar index is usually negative for Indian stocks.\n' +
    'Market data (latest quote and change):\n' + lines.join('\n') + '\n' +
    (ev.length ? 'Upcoming events:\n' + ev.join('\n') + '\n' : '') +
    `Write at most ${READING_MAX} lines. Each line is ONE cause and its effect, under 160 characters, plain words, with the number that shows it. If the picture is mixed or the moves are small, say so in one line.\n` +
    'Reply with JSON only: {"lines": ["...", "..."]}';
}
// Claude's reply -> up to three clean lines of plain text (no markup).
function cleanReading(r){
  const arr = r && Array.isArray(r.lines) ? r.lines : Array.isArray(r) ? r : [];
  return arr.map(x => String(x == null ? '' : x).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, READING_MAX);
}

// ---- calendar ----
const IMPORTANCE = { 1: 'High', 0: 'Medium', '-1': 'Low' };
// Rows (already filtered by the research session) grouped by IST date, soonest first: [{ date, rows }].
function groupCalendar(rows, minImportance){
  const keep = (rows || []).filter(r => r && r.date && r.title && (minImportance === undefined || (isNum(r.importance) ? r.importance : -1) >= minImportance));
  keep.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const groups = [];
  keep.forEach(r => {
    const d = istDate(r.date);
    let g = groups[groups.length - 1];
    if(!g || g.date !== d){ g = { date: d, rows: [] }; groups.push(g); }
    g.rows.push(r);
  });
  return groups;
}
// ISO time -> 'YYYY-MM-DD' in IST.
function istDate(iso){
  const t = Date.parse(iso);
  if(!isFinite(t)) return String(iso || '').slice(0, 10);
  return new Date(t + 19800000).toISOString().slice(0, 10);
}
// The next high-importance events at or after `nowMs`: [{ date, title }].
function nextBigEvents(rows, nowMs, n){
  return (rows || []).filter(r => r && r.title && isNum(r.importance) && r.importance >= 1 && Date.parse(r.date) >= nowMs - 6 * 3600000)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, n || 3).map(r => ({ date: istDate(r.date), title: r.title }));
}
// '2026-10-28' -> '28 Oct'
function shortDate(d){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  if(!m) return String(d || '');
  return +m[3] + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1];
}
// A number with its unit as the calendar rows show it ('4.0%', '29K'); null when absent.
function calValue(v, unit){
  if(v === null || v === undefined || v === '') return '';
  return String(v) + (unit === '%' ? '%' : '');
}

// ---- stock events ----
const EVENT_TYPES = [
  { id: 'results', label: 'Results', tag: 'RESULTS' },
  { id: 'dividend', label: 'Dividend', tag: 'DIVIDEND' },
  { id: 'board', label: 'Board meeting', tag: 'BOARD' },
  { id: 'company', label: 'Company event', tag: 'COMPANY' },
  { id: 'news', label: 'News', tag: 'NEWS' }
];
const TYPE_OF_SAVED = { earn: 'results', corp: 'company', news: 'news' };   // kinds saved on each stock (s.__events)
const typeTag = (id) => (EVENT_TYPES.find(t => t.id === id) || { tag: String(id).toUpperCase() }).tag;

// Upcoming items saved by research: keep valid ones, dated today or later, soonest first.
// items: [{ ticker, name, type, date, text, url, src }]
function upcomingItems(items, today){
  return (items || []).filter(x => x && x.ticker && x.date && /^\d{4}-\d{2}-\d{2}/.test(x.date) && x.date.slice(0, 10) >= today && EVENT_TYPES.some(t => t.id === x.type))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.ticker).localeCompare(String(b.ticker)));
}
// Recent events already saved on stocks (results, company events, news), newest first, within `days` days before today.
// stocks: [{ ticker, name, events: [{ k, d, t, src, url, s }] }]
function recentItems(stocks, today, days){
  const from = shiftDate(today, -days), out = [];
  (stocks || []).forEach(s => (s.events || []).forEach(e => {
    const type = e && TYPE_OF_SAVED[e.k];
    if(!type || !e.d || e.d < from || e.d > today) return;
    out.push({ ticker: s.ticker, name: s.name, type, date: e.d, text: e.t || '', url: e.url || '', src: e.src || '', sentiment: e.s || '' });
  }));
  return out.sort((a, b) => b.date.localeCompare(a.date) || String(a.ticker).localeCompare(String(b.ticker)));
}
// 'YYYY-MM-DD' shifted by whole days.
function shiftDate(d, days){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if(!m) return d;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
// Applies the screen's filters to a list of items: { type: 'all' | id, upto: days ahead for upcoming (0 = no limit) }.
function filterItems(items, f, today){
  const limit = f.upto > 0 ? shiftDate(today, f.upto) : null;
  return items.filter(x => (f.type === 'all' || x.type === f.type) && (!limit || x.date <= limit || x.date < today));
}

export { EVENT_TYPES, IMPORTANCE, PULSE_SYMBOLS, buildTiles, calValue, cleanReading, filterItems, groupCalendar, nextBigEvents, readingPrompt, recentItems, shortDate, tileView, typeTag, upcomingItems };
