// The notification bell at the top right of every screen, next to the search box. The panel under it is closed until you open it.
// It lists a Live Data Refresh that is running (progress, Stop, View) and the notices left by refreshes that ended. The bell shows a
// badge with the number of notices you have not opened yet: green when everything finished well, amber if something failed in part,
// red if a run failed outright.
// This module only displays. The code that runs a refresh (livedata/batch.js, livedata/bar.js) reports into it and
// supplies what Stop does; nothing here knows how a refresh works.
import { escapeHtml } from '../core/util.js';

const MAX_NOTICES = 20;
const running = new Map();   // id -> { title, text, pct, section, onStop, stopping }
var notices = [];            // newest first: { id, tone: 'ok' | 'warn' | 'error', title, text, section, at, read }
var noticeSeq = 0;
var panelOpen = false;
var shownSignature = null;   // which items the panel was last built for; text and bars are updated in place, so a click is never lost to a redraw
var lastUnread = 0;

const byId = (id) => document.getElementById(id);

// "View" opens the screen that started the refresh.
function openSection(section){
  const btn = section ? document.querySelector('.nav-item[data-section="' + section + '"]') : null;
  if(btn) btn.click();
}

function itemHtml(id, kind, section){
  const view = section ? '<button type="button" class="activity-btn" data-act="view">View</button>' : '';
  const attrs = 'data-id="' + escapeHtml(id) + '" data-section="' + escapeHtml(section || '') + '"';
  if(kind === 'run'){
    return '<div class="activity-item is-running" ' + attrs + '>'
      + '<div class="activity-main"><div class="activity-title"></div><div class="activity-text"></div>'
      + '<div class="activity-progress"><div class="activity-fill"></div></div></div>'
      + '<div class="activity-actions">' + view + '<button type="button" class="activity-btn" data-act="stop">Stop</button></div></div>';
  }
  return '<div class="activity-item" ' + attrs + '>'
    + '<div class="activity-main"><div class="activity-title"></div><div class="activity-text"></div><div class="activity-time"></div></div>'
    + '<div class="activity-actions">' + view + '<button type="button" class="activity-btn activity-close" data-act="close" aria-label="Dismiss this notice">&times;</button></div></div>';
}

function timeText(ms){
  try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch(e){ return ''; }
}

// Builds the open panel; on later calls only the text, bars and buttons of the items already there are updated.
function paintPanel(panel){
  const items = [];
  running.forEach((r, id) => items.push({ id, kind: 'run', data: r, section: r.section }));
  notices.forEach(n => items.push({ id: n.id, kind: 'note', data: n, section: n.section }));
  const signature = items.map(i => i.id + '|' + i.kind + '|' + (i.section || '') + '|' + (i.kind === 'run' && i.data.onStop ? 's' : '')).join(';');
  if(signature !== shownSignature){   // (null at first: with nothing to list the signature is '', and the "Nothing running" text must still be drawn)
    shownSignature = signature;
    panel.innerHTML = '<div class="activity-head"><span class="activity-head-title">Notifications</span>'
      + (notices.length ? '<button type="button" class="activity-btn" data-act="clearall">Clear all</button>' : '') + '</div>'
      + (items.length ? '<div class="activity-list">' + items.map(i => itemHtml(i.id, i.kind, i.section)).join('') + '</div>'
        : '<div class="activity-empty">Nothing running. Finished refreshes show up here.</div>');
  }
  const list = panel.querySelector('.activity-list');
  if(!list) return;
  for(const i of items){
    const el = Array.from(list.children).find(c => c.dataset.id === i.id);
    if(!el) continue;
    el.classList.remove('is-ok', 'is-warn', 'is-error');
    if(i.kind === 'note') el.classList.add('is-' + i.data.tone);
    el.querySelector('.activity-title').textContent = i.data.title;
    el.querySelector('.activity-text').textContent = i.data.text || '';
    if(i.kind === 'note') el.querySelector('.activity-time').textContent = timeText(i.data.at);
    else {
      el.querySelector('.activity-fill').style.width = Math.max(0, Math.min(100, i.data.pct || 0)) + '%';
      const stop = el.querySelector('[data-act="stop"]');
      if(stop){ stop.hidden = !i.data.onStop; stop.disabled = !!i.data.stopping; stop.textContent = i.data.stopping ? 'Stopping…' : 'Stop'; }
    }
  }
}

function render(){
  const bell = byId('activityBell'), badge = byId('activityBadge'), panel = byId('activityPanel');
  if(!bell || !badge || !panel) return;
  if(panelOpen) notices.forEach(n => { n.read = true; });   // what is on show counts as seen
  const unread = notices.filter(n => !n.read);
  const worst = unread.some(n => n.tone === 'error') ? 'error' : unread.some(n => n.tone === 'warn') ? 'warn' : 'ok';
  badge.hidden = unread.length === 0;
  badge.textContent = unread.length > 99 ? '99+' : String(unread.length);
  badge.className = 'activity-badge is-' + worst;
  if(unread.length > lastUnread){ void badge.offsetWidth; badge.classList.add('pop'); }   // a small pop when a new notice arrives
  lastUnread = unread.length;
  const first = running.size ? Array.from(running.values())[0] : null;
  bell.classList.toggle('is-running', !!first);
  const label = 'Notifications' + (first ? ': a refresh is running (' + Math.round(first.pct || 0) + '%)' : '') + (unread.length ? (first ? ', ' : ': ') + unread.length + ' new' : '');
  bell.setAttribute('aria-label', label);
  bell.title = label;
  bell.setAttribute('aria-expanded', String(panelOpen));
  panel.hidden = !panelOpen;
  if(panelOpen) paintPanel(panel);
}

function setOpen(open){
  panelOpen = open;
  if(!open) shownSignature = null;   // built afresh the next time it opens
  render();
}

// A refresh that is running: call again with the same id on every step. info = { title, text, pct, section, onStop, stopping }.
function activityRun(id, info){
  running.set(id, info);
  render();
}
// The refresh ended (finished, stopped or failed): take it off the list.
function activityEnd(id){
  if(running.delete(id)) render();
}
// A notice that stays in the panel until it is closed. info = { tone: 'ok' | 'warn' | 'error', title, text, section }.
function activityNotify(info){
  notices.unshift(Object.assign({ id: 'note-' + (++noticeSeq), read: false, at: Date.now() }, info));
  notices = notices.slice(0, MAX_NOTICES);
  const live = byId('activityLive');
  if(live && !info.silent) live.textContent = info.title + '. ' + (info.text || '');   // read out by screen readers while the panel is closed
  render();
}

function init_ui_activity(){
  const bell = byId('activityBell'), panel = byId('activityPanel');
  if(!bell || !panel) return;
  bell.addEventListener('click', () => setOpen(!panelOpen));
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if(!btn) return;
    const item = btn.closest('.activity-item'), act = btn.dataset.act;
    if(act === 'clearall'){ notices = []; render(); return; }
    if(!item) return;
    const id = item.dataset.id;
    if(act === 'view'){ openSection(item.dataset.section); setOpen(false); }
    else if(act === 'stop'){ const r = running.get(id); if(r && r.onStop) r.onStop(); }
    else if(act === 'close'){ notices = notices.filter(n => n.id !== id); render(); }
  });
  document.addEventListener('mousedown', (e) => { if(panelOpen && !e.target.closest('#activityWrap')) setOpen(false); });
  // Esc closes the panel first (capture phase, and marked handled so "Back to ..." does not also act on it).
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Escape' || !panelOpen) return;
    e.preventDefault();
    setOpen(false);
    bell.focus();
  }, true);
  render();
}

export { activityEnd, activityNotify, activityRun, init_ui_activity };
