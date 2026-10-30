// The Events panel on the stock page: what is coming up (saved news/events list) and what happened in the last 90 days
// (results, company events and news saved on the stock by Refresh Fundamental Info).
import { escapeHtml } from '../core/util.js';
import { panelIcon } from './icons.js';
import { dateNote, shortDate, typeTag } from '../news/model.js';
import { upcomingFor } from '../news/upcoming.js';

const TYPE_OF_SAVED = { earn: 'results', corp: 'company', news: 'news' };
const RECENT_DAYS = 90, RECENT_MAX = 8;
const SENTIMENT = { pos: ['positive', 'positive'], neg: ['negative', 'negative'], neu: ['neutral', ''] };
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
const todayIst = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

// One line per event, like the News page: the kind of event, then its text (a link to the source when there is one; the whole text is the tooltip).
function row(type, text, src, url, sentiment){
  const nt = dateNote(text || ''), t = nt || (text ? 'Expected date' : src || ''), u = safeUrl(url);
  const textHtml = u ? `<a class="news-link" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t || 'Source')}</a>` : escapeHtml(t);
  const tag = sentiment && SENTIMENT[sentiment] && SENTIMENT[sentiment][1] ? `<span class="news-tag news-${SENTIMENT[sentiment][1]}">${SENTIMENT[sentiment][0]}</span>` : '';
  return `<div class="row-line"><span class="news-et news-et-${escapeHtml(type)}">${escapeHtml(typeTag(type))}</span><span class="row-text" title="${escapeHtml((text || '') + (src ? ' \u00b7 ' + src : ''))}">${textHtml}</span>${tag}</div>`;
}
// The rows under one heading per date: the date is said once, with how many things happened on it.
function grouped(items){
  const days = [];
  items.forEach(x => { const last = days[days.length - 1]; if(last && last.d === x.d) last.rows.push(x); else days.push({ d: x.d, rows: [x] }); });
  return days.map(g => `<div class="day-head"><b>${escapeHtml(shortDate(g.d))}</b><span>${g.rows.length}</span></div>` + g.rows.map(x => row(x.type, x.text, x.src, x.url, x.s)).join('')).join('');
}

function renderEventsPanel(s){
  const today = todayIst(), from = new Date(Date.parse(today + 'T00:00:00Z') - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const up = upcomingFor(s);
  const past = (Array.isArray(s.__events) ? s.__events : []).filter(e => e && TYPE_OF_SAVED[e.k] && e.d >= from && e.d <= today).slice(0, RECENT_MAX);
  const upHtml = up.length ? grouped(up.map(x => ({ d: String(x.date).slice(0, 10), type: x.type, text: x.text, src: x.src, url: x.url }))) : '<p class="peers-empty">Nothing coming up is saved for this stock. Use Refresh events on the News page.</p>';
  const pastHtml = past.length ? grouped(past.map(e => ({ d: e.d, type: TYPE_OF_SAVED[e.k], text: e.t, src: e.src, url: e.url, s: e.s }))) : '<p class="peers-empty">No results, company events or news saved in the last 90 days. Refresh Fundamental Info saves them.</p>';
  return `<div class="tech-panel" id="eventsPanel"><div class="tech-panel-head"><div class="tech-panel-title">${panelIcon('events')}Events</div>${up.length ? `<span class="completeness-badge complete">${up.length} coming up</span>` : ''}</div>
    <div class="ev-sub">Coming up</div>${upHtml}<div class="ev-sub">Last ${RECENT_DAYS} days</div>${pastHtml}</div>`;
}

export { renderEventsPanel };
