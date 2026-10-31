// The News page: market pulse, briefings, economic calendar and stock events. Loads the first time the page is opened (see core/lazy.js).
import { openStockInline } from '../ui/inlinedetail.js';
import { newsHtml, scopeInfo, setPick, view } from '../news/render.js';
import { startNewsSync } from '../news/store.js';
import { refreshPulse } from '../news/pulse.js';
import { refreshStockEvents } from '../news/stockevents.js';
import { newsChanged } from '../news/store.js';

const section = () => /** @type {HTMLElement} */ (document.getElementById('section-news'));
const body = () => document.getElementById('newsBody');

function render(){
  const el = body(); if(!el) return;
  el.innerHTML = newsHtml();
}

function init(){
  const el = body(); if(!el) return;
  el.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target); if(!t || !t.closest) return;
    const open = t.closest('[data-news-open]');
    if(open){ e.preventDefault(); openStockInline(section(), 'News', Number(open.getAttribute('data-news-open'))); return; }
    const pickS = t.closest('[data-news-strategy]');
    if(pickS){ setPick(pickS.getAttribute('data-news-strategy') || 'all'); render(); return; }
    const pickT = t.closest('[data-news-type]');
    if(pickT){ view.type = pickT.getAttribute('data-news-type') || 'all'; render(); return; }
    const pickU = t.closest('[data-news-upto]');
    if(pickU){ view.upto = +(pickU.getAttribute('data-news-upto') || 30); render(); return; }
    const tab = t.closest('[data-news-tab]');
    if(tab){ view.tab = tab.getAttribute('data-news-tab') === 'events' ? 'events' : 'macro'; render(); return; }
    const when = t.closest('[data-news-when]');
    if(when){ view.when = when.getAttribute('data-news-when') === 'recent' ? 'recent' : 'upcoming'; render(); return; }
    if(t.closest('[data-news-cal-all]')){ view.calAll = !view.calAll; render(); return; }
    if(t.closest('[data-news-events-refresh]')){ refreshStockEvents(scopeInfo().list, () => { render(); newsChanged(); }); return; }
    if(t.closest('[data-news-refresh]')) refreshPulse(render);
  });
  // a briefing section opens and closes on its own; which ones are open is kept across redraws
  el.addEventListener('toggle', (e) => {
    const d = /** @type {HTMLDetailsElement} */ (e.target); if(!d || !d.matches || !d.matches('[data-news-grp]')) return;
    const id = d.getAttribute('data-news-grp') || '';
    if(d.open) view.openGroups.add(id); else view.openGroups.delete(id);
  }, true);
  startNewsSync(true);
  render();
}

export { init, render };
