// The News page: a "Global & Macro" tab (market pulse, briefings, economic calendar) and a "Stock events" tab.
import { escapeHtml, tickerSymbol } from '../core/util.js';
import { stockByTickerSymbol, stockIndex, stocks } from '../core/stocks.js';
import { qualifyingStocks } from '../strategies/rules.js';
import { publishedStrategies } from '../strategies/state.js';
import { readingTone, IMPORTANCE, EVENT_TYPES, calValue, filterItems, groupCalendar, nextBigEvents, recentItems, shortDate, tileView, typeTag, upcomingItems } from './model.js';
import { news } from './store.js';
import { getPulseRun } from './pulse.js';
import { getEventsRun } from './stockevents.js';
import { dropMenuHtml } from '../ui/dropmenu.js';
import { allTrades } from '../core/store.js';
import { isPinned } from '../core/pins.js';

const BRIEFING_GROUPS = [
  { id: 'market', label: 'Market wrap' },
  { id: 'india', label: 'India policy & RBI' },
  { id: 'data', label: 'Inflation & data' },
  { id: 'commodities', label: 'Currency, crude & commodities' },
  { id: 'flows', label: 'FII & DII flows' },
  { id: 'trade', label: 'Trade policy & geopolitics' },
  { id: 'global', label: 'US & global markets' }
];
const SCOPE_STRATEGY = 'Positive MoS';

/** The screen's own choices (kept only while the page is open). */
const view = { strategy: '', tab: 'macro', when: 'upcoming', type: 'all', upto: 30, calAll: false, openGroups: new Set() };

const IST_MS = 19800000;
const todayIst = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const isoDay = (iso) => String(iso || '').slice(0, 10);
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
const link = (label, url, cls) => { const u = safeUrl(url); return u ? `<a class="news-link${cls ? ' ' + cls : ''}" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || 'Source')} &#8599;</a>` : ''; };
const impactTag = (v) => (v === 'positive' || v === 'negative' || v === 'mixed' ? `<span class="news-tag news-${v}">${v}</span>` : '');
// The time of a section's own refresh, said only when it is not the one already shown at the top of the page (same day and minute).
const sameStamp = (iso) => { const p = news.pulse && news.pulse.at; return !!p && Math.abs(Date.parse(iso) - Date.parse(p)) < 120000; };
const stamp = (iso) => {
  const t = Date.parse(iso);
  if(!isFinite(t)) return '';
  const d = new Date(t + IST_MS), h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0');
  return shortDate(d.toISOString().slice(0, 10)) + ', ' + ((h + 11) % 12 + 1) + ':' + m + ' ' + (h >= 12 ? 'pm' : 'am');
};

// Which stocks the Stock events tab covers: the strategy picked in the drop-down ("all" = every stock). The first time, the "Positive MoS" strategy if there is one.
const PICK_KEY = 'albaDashboard.newsStrategy.v1';
function savedPick(){ try { return localStorage.getItem(PICK_KEY) || ''; } catch(e){ return ''; } }
function setPick(v){ view.strategy = v; try { localStorage.setItem(PICK_KEY, v); } catch(e){ /* storage unavailable: the choice lasts until the page closes */ } }
function pickedStrategy(){
  const list = publishedStrategies(), want = view.strategy || savedPick();
  if(want === 'all') return 'all';
  const st = list.find(x => x.id === want) || (want ? null : list.find(x => x.name === SCOPE_STRATEGY));
  return st || list.find(x => x.name === SCOPE_STRATEGY) || 'all';
}
function scopeInfo(){
  const st = pickedStrategy();
  if(st === 'all') return { list: stocks.slice(), label: 'in the dashboard (all stocks)', pick: 'all' };
  const rules = Array.isArray(st.rules) ? st.rules : [];
  return { list: rules.length ? qualifyingStocks(stocks, rules) : stocks.slice(), label: 'from your "' + st.name + '" strategy', pick: st.id };
}

function pulseHtml(){
  const p = news.pulse, run = getPulseRun();
  const tiles = p && Array.isArray(p.tiles) ? p.tiles.map(tileView).filter(Boolean) : [];
  let h = '<h2 data-icon="trend">Market pulse</h2>';
  if(!tiles.length){
    h += '<p class="news-empty">No market quotes yet. Press <b>Refresh News</b> to load them.</p>';
  } else {
    h += '<div class="news-tiles">' + tiles.map(t => `<div class="news-tile"><b>${escapeHtml(t.label)}</b><span>${escapeHtml(t.value)}</span>${t.change ? `<i class="news-ch ${t.tone}">${t.change[0] === '-' ? '&#9660;' : '&#9650;'} ${escapeHtml(t.change.replace(/^[+-]/, ''))}</i>` : ''}</div>`).join('') + '</div>';
    h += '<div class="news-hint">Red means the move is bad for Indian stocks; green means it is good.</div>';
  }
  const lines = p && Array.isArray(p.reading) ? p.reading : [];
  if(lines.length){
    h += '<div class="news-why"><b class="news-why-h">Why it matters</b><ul>' + lines.map(l => `<li class="news-tone-${readingTone(l)}">${escapeHtml(l)}</li>`).join('') + '</ul><small>An informed guess from the numbers above, not a fact.</small></div>';
  }
  const next = nextBigEvents((news.macro && news.macro.calendar) || [], Date.now(), 1)[0];
  if(next) h += `<div class="news-watch"><b>Watch next:</b> ${escapeHtml(next.title)}, ${escapeHtml(shortDate(next.date))}</div>`;
  if(run.state === 'running') h += `<div class="news-status">${escapeHtml(run.msg)}</div>`;
  else if(run.msg) h += `<div class="news-status${run.state === 'error' ? ' news-err' : ''}">${escapeHtml(run.msg)}</div>`;
  return h;
}

function briefingsHtml(){
  const m = news.macro, items = m && Array.isArray(m.briefings) ? m.briefings.filter(b => b && b.headline) : [];
  let h = '<h2 data-icon="globe">Briefings</h2>';
  if(!items.length) return h + '<p class="news-empty">No briefings yet. Press <b>Refresh News</b> to write them from the latest market headlines.</p>';
  if(m.asof) h += `<div class="news-hint">${m.briefingsAt ? (sameStamp(m.briefingsAt) ? 'From TradingView headlines' : 'Updated ' + escapeHtml(stamp(m.briefingsAt)) + ' from TradingView headlines') : 'Researched ' + escapeHtml(shortDate(m.asof))}. Each card says why it matters; links go to the source.</div>`;
  const known = new Set(BRIEFING_GROUPS.map(g => g.id));
  BRIEFING_GROUPS.concat([{ id: '_other', label: 'Other' }]).forEach(g => {
    const rows = items.filter(b => (known.has(b.group) ? b.group : '_other') === g.id);
    if(!rows.length) return;
    h += `<details class="news-grpbox" data-news-grp="${g.id}"${view.openGroups.has(g.id) ? ' open' : ''}><summary class="news-grp">${escapeHtml(g.label)}<small>${rows.length}</small></summary>`;
    rows.forEach(b => {
      const links = (Array.isArray(b.links) ? b.links : []).map(l => link(l && l.label, l && l.url, l && l.kind === 'video' ? 'news-video' : '')).join('');
      const dot = b.impact === 'positive' || b.impact === 'negative' || b.impact === 'mixed' ? b.impact : 'none';
      const meta = [b.date ? shortDate(isoDay(b.date)) : '', dot === 'none' ? '' : dot[0].toUpperCase() + dot.slice(1)].filter(Boolean).map(escapeHtml).join(' &middot; ');
      const body = (b.why ? `<p><b>Why it matters</b> ${escapeHtml(b.why)}</p>` : '') + (links ? `<div class="news-links">${links}</div>` : '');
      h += `<details class="news-brief" open><summary><i class="news-dot news-dot-${dot}"></i><span class="news-bhead">${escapeHtml(b.headline)}<small class="news-bmeta news-bm-${dot}">${meta}</small></span></summary>` + (body ? `<div class="news-bbody">${body}</div>` : '') + '</details>';
    });
    h += '</details>';
  });
  return h;
}

// "US" -> flag + code (a country code is two letters, so the flag is made from them).
function countryHtml(c){
  const code = String(c || '').trim().toUpperCase();
  if(!code) return '';
  const flag = /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65)) : '';
  return (flag ? `<span class="news-flag" aria-hidden="true">${flag}</span>` : '') + `<b>${escapeHtml(code)}</b>`;
}
// The saved text of a results date says "TradingView date, can change" on every row; that is said once above the list instead.
const dateNote = (t) => /^Results expected \(TradingView/.test(t) ? '' : /^Results date \(confirmed\)/.test(t) ? 'Confirmed' : t;

function calendarHtml(){
  const m = news.macro, rows = m && Array.isArray(m.calendar) ? m.calendar : [];
  let h = '<h2 data-icon="calendar">Economic calendar</h2>';
  h += '<div class="news-hint">Next 30 days' + (m && m.calendarAt ? (sameStamp(m.calendarAt) ? ', from TradingView' : ', updated ' + escapeHtml(stamp(m.calendarAt)) + ' from TradingView') : '') + '.</div>';
  if(!rows.length) return h + '<p class="news-empty">No calendar yet. It is saved from a Claude session.</p>';
  const groups = groupCalendar(rows, view.calAll ? -1 : 0), today = todayIst();
  const shown = groups.filter(g => g.date >= today);
  if(!shown.length) return h + '<p class="news-empty">No upcoming events in the saved calendar. Ask Claude to refresh the news.</p>';
  shown.forEach(g => {
    h += `<div class="day-head"><b>${escapeHtml(shortDate(g.date))}</b><span>${g.rows.length}</span></div>`;
    g.rows.forEach(r => {
      const imp = IMPORTANCE[r.importance] || '', lvl = r.importance >= 1 ? 'hi' : r.importance === 0 ? 'md' : 'lo';
      const bits = [r.forecast !== undefined && r.forecast !== null ? 'forecast ' + calValue(r.forecast, r.unit) : '', r.previous !== undefined && r.previous !== null ? 'previous ' + calValue(r.previous, r.unit) : '', r.actual !== undefined && r.actual !== null ? 'actual ' + calValue(r.actual, r.unit) : ''].filter(Boolean).join(' \u00b7 ');
      const u = safeUrl(r.url), more = (r.country ? r.country + ' \u00b7 ' : '') + bits + (r.source ? ' \u00b7 ' + r.source : '');
      h += `<div class="row-line"><span class="row-cc">${countryHtml(r.country)}</span>${imp ? `<span class="news-lvl news-lvl-${lvl}" role="img" aria-label="${escapeHtml(imp)} importance" title="${escapeHtml(imp)} importance">${{ hi: '\u25b2', md: '\u25ac', lo: '\u25bc' }[lvl]}</span>` : ''}<span class="row-name">${u ? `<a class="news-stock" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title)}</a>` : `<span class="news-stock">${escapeHtml(r.title)}</span>`}</span><span class="row-text" title="${escapeHtml(more)}">${escapeHtml(bits)}</span></div>`;
    });
  });
  h += `<button type="button" class="news-more" data-news-cal-all>${view.calAll ? 'Show only medium and high importance' : 'Show all'}</button>`;
  return h;
}

function macroTab(){ return pulseHtml() + briefingsHtml() + calendarHtml(); }

// ---- Stock events ----
let heldNow = new Set();   // the stocks in an open trade, worked out once per draw
const holdTags = (s) => (s && heldNow.has(s) ? '<span class="news-own news-held">HELD</span>' : '') + (s && isPinned(s) ? '<span class="news-own news-pinned">PINNED</span>' : '');
// One line per event: the stock, what kind of event, and its text (a link to the source when there is one; the whole text is the tooltip).
function eventRowHtml(x){
  const s = stockByTickerSymbol.get(x.ticker), idx = s ? stockIndex.get(s) : undefined;
  const name = s ? s.name : (x.name || x.ticker);
  const nameHtml = (idx !== undefined ? `<a class="news-stock" href="#" data-news-open="${idx}">${escapeHtml(name)}</a>` : `<span class="news-stock">${escapeHtml(name)}</span>`) + holdTags(s);
  const text = dateNote(x.text || x.src || ''), u = safeUrl(x.url);
  const textHtml = u ? `<a class="news-link" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text || 'Source')}</a>` : escapeHtml(text);
  const tone = x.sentiment ? impactTag({ pos: 'positive', neg: 'negative', mix: 'mixed' }[x.sentiment]) : '';
  return `<div class="row-line"><span class="row-name">${nameHtml}</span><span class="news-et news-et-${escapeHtml(x.type)}">${escapeHtml(typeTag(x.type))}</span><span class="row-text" title="${escapeHtml(text)}">${textHtml}</span>${tone}</div>`;
}
// The rows under one heading per date (the rows come sorted by date): the date is said once, with how many stocks have something on it.
function groupedRows(rows){
  const days = [];
  rows.forEach(x => { const d = String(x.date).slice(0, 10), last = days[days.length - 1]; if(last && last.d === d) last.rows.push(x); else days.push({ d, rows: [x] }); });
  return days.map(g => `<div class="day-head"><b>${escapeHtml(shortDate(g.d))}</b><span>${g.rows.length}</span></div>` + g.rows.map(eventRowHtml).join('')).join('');
}
function eventsTab(){
  const today = todayIst(), scope = scopeInfo(), inScope = new Set(scope.list.map(s => tickerSymbol(s)));
  const stratItems = [{ attrs: 'data-news-strategy="all"', title: 'All stocks', current: scope.pick === 'all' }].concat(publishedStrategies().map(x => ({ attrs: `data-news-strategy="${escapeHtml(x.id)}"`, title: x.name, current: scope.pick === x.id })));
  const typeItems = [{ id: 'all', label: 'All types' }].concat(EVENT_TYPES).map(t => ({ attrs: `data-news-type="${escapeHtml(t.id)}"`, title: t.label, current: view.type === t.id }));
  const rangeItems = [[7, 'Next 7 days'], [30, 'Next 30 days'], [90, 'Next 90 days'], [0, 'Any date']].map(([v, l]) => ({ attrs: `data-news-upto="${v}"`, title: String(l), current: view.upto === v }));
  const menu = (label, items, extra) => { const cur = items.find(i => i.current) || items[0]; return dropMenuHtml({ btnHtml: `<small>${label}</small> <b>${escapeHtml(cur.title)}</b> <span class="dm-caret" aria-hidden="true">&#9662;</span>`, label, items, extraClass: extra }); };
  let h = `<div class="choices"><button type="button" class="choice${view.when === 'upcoming' ? ' on' : ''}" data-news-when="upcoming">Upcoming</button><button type="button" class="choice${view.when === 'recent' ? ' on' : ''}" data-news-when="recent">Recent</button></div>` +
    '<div class="news-menus">' + menu('Strategy', stratItems, 'dm-news') + menu('Type', typeItems, 'dm-news') + (view.when === 'upcoming' ? menu('Range', rangeItems, 'dm-news') : '') + '</div>';
  heldNow = new Set(); for(const t of allTrades()){ if(t.status === 'closed' && t.sell) continue; const hs = stockByTickerSymbol.get(t.ticker); if(hs) heldNow.add(hs); }
  h += `<div class="news-hint">Covers ${scope.list.length.toLocaleString('en-IN')} stocks ${escapeHtml(scope.label)}.${view.when === 'upcoming' ? ' Dates come from TradingView and can change: check the source link.' : ''}</div>`;
  if(view.when === 'upcoming'){
    const er = getEventsRun(), ev0 = news.events;
    const stampTxt = er.msg || (ev0 && ev0.tvAt ? 'Updated ' + stamp(ev0.tvAt) : 'Not refreshed yet');
    h += `<div class="news-head"><span class="news-stamp">${escapeHtml(stampTxt)}</span><button type="button" class="refresh-btn news-refresh" data-news-events-refresh${er.state === 'running' ? ' disabled' : ''}>${er.state === 'running' ? 'Refreshing\u2026' : 'Refresh events'}</button></div>`;
    const ev = news.events, all = ev && Array.isArray(ev.items) ? ev.items : [];
    const rows = filterItems(upcomingItems(all, today).filter(x => inScope.has(x.ticker)), { type: view.type, upto: view.upto }, today);
    if(!all.length) return h + '<p class="news-empty">No upcoming events saved yet. Press <b>Refresh events</b> to read them from TradingView.</p>';
    if(!rows.length) return h + '<p class="news-empty">Nothing matches these filters.</p>';
    return h + groupedRows(rows);
  }
  const withEvents = scope.list.map(s => ({ ticker: tickerSymbol(s), name: s.name, events: Array.isArray(s.__events) ? s.__events : [] }));
  const rows = filterItems(recentItems(withEvents, today, 30), { type: view.type, upto: 0 }, today).slice(0, 60);
  h += '<div class="news-hint">The last 30 days, from the results, company events and news already saved on each stock.</div>';
  if(!rows.length) return h + '<p class="news-empty">No saved events in the last 30 days for these stocks.</p>';
  return h + groupedRows(rows);
}

function newsHtml(){
  const p = news.pulse, run = getPulseRun();
  const stampTxt = p && p.at ? 'Updated ' + stamp(p.at) : 'Not refreshed yet';
  const head = `<div class="news-head"><span class="news-stamp">${escapeHtml(stampTxt)}</span><button type="button" class="refresh-btn news-refresh" data-news-refresh${run.state === 'running' ? ' disabled' : ''}>${run.state === 'running' ? 'Refreshing…' : 'Refresh News'}</button></div>` +
    `<div class="tabs" role="tablist"><button type="button" role="tab" class="tab${view.tab === 'macro' ? ' on' : ''}" aria-selected="${view.tab === 'macro'}" data-news-tab="macro">Global &amp; Macro</button><button type="button" role="tab" class="tab${view.tab === 'events' ? ' on' : ''}" aria-selected="${view.tab === 'events'}" data-news-tab="events">Stock events</button></div>`;
  if(!news.ready) return head + '<p class="news-empty">Loading…</p>';
  return head + (view.tab === 'events' ? eventsTab() : macroTab());
}

export { newsHtml, scopeInfo, setPick, view };
