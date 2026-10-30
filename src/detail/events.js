// The Events panel on the stock page: what is coming up (saved news/events list) and what happened in the last 90 days
// (results, company events and news saved on the stock by Refresh Fundamental Info).
import { escapeHtml } from '../core/util.js';
import { panelIcon } from './icons.js';
import { shortDate, typeTag } from '../news/model.js';
import { upcomingFor } from '../news/upcoming.js';

const TYPE_OF_SAVED = { earn: 'results', corp: 'company', news: 'news' };
const RECENT_DAYS = 90, RECENT_MAX = 8;
const SENTIMENT = { pos: ['positive', 'positive'], neg: ['negative', 'negative'], neu: ['neutral', ''] };
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');
const todayIst = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

function row(date, type, text, src, url, sentiment){
  const link = safeUrl(url) ? ` &middot; <a class="news-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(src || 'Source')} &#8599;</a>` : (src ? ' &middot; ' + escapeHtml(src) : '');
  const tag = sentiment && SENTIMENT[sentiment] && SENTIMENT[sentiment][1] ? ` <span class="news-tag news-${SENTIMENT[sentiment][1]}">${SENTIMENT[sentiment][0]}</span>` : '';
  return `<div class="news-row"><div class="news-date">${escapeHtml(shortDate(date))}</div><div class="news-text"><span class="news-et news-et-${escapeHtml(type)}">${escapeHtml(typeTag(type))}</span>${escapeHtml(text)}${link}${tag}</div></div>`;
}

function renderEventsPanel(s){
  const today = todayIst(), from = new Date(Date.parse(today + 'T00:00:00Z') - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const up = upcomingFor(s);
  const past = (Array.isArray(s.__events) ? s.__events : []).filter(e => e && TYPE_OF_SAVED[e.k] && e.d >= from && e.d <= today).slice(0, RECENT_MAX);
  const upHtml = up.length ? up.map(x => row(x.date, x.type, x.text || '', x.src, x.url)).join('') : '<p class="peers-empty">Nothing coming up is saved for this stock. Use Refresh events on the News page.</p>';
  const pastHtml = past.length ? past.map(e => row(e.d, TYPE_OF_SAVED[e.k], e.t || '', e.src, e.url, e.s)).join('') : '<p class="peers-empty">No results, company events or news saved in the last 90 days. Refresh Fundamental Info saves them.</p>';
  return `<div class="tech-panel" id="eventsPanel"><div class="tech-panel-head"><div class="tech-panel-title">${panelIcon('events')}Events</div>${up.length ? `<span class="completeness-badge complete">${up.length} coming up</span>` : ''}</div>
    <div class="ev-sub">Coming up</div>${upHtml}<div class="ev-sub">Last ${RECENT_DAYS} days</div>${pastHtml}</div>`;
}

export { renderEventsPanel };
