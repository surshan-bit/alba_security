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
  const keep = el.querySelector('.news-select:focus');   // do not redraw under a menu that is open
  if(keep) return;
  el.innerHTML = newsHtml();
}

function init(){
  const el = body(); if(!el) return;
  el.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target); if(!t || !t.closest) return;
    const open = t.closest('[data-news-open]');
    if(open){ e.preventDefault(); openStockInline(section(), 'News', Number(open.getAttribute('data-news-open'))); return; }
    const tab = t.closest('[data-news-tab]');
    if(tab){ view.tab = tab.getAttribute('data-news-tab') === 'events' ? 'events' : 'macro'; render(); return; }
    const when = t.closest('[data-news-when]');
    if(when){ view.when = when.getAttribute('data-news-when') === 'recent' ? 'recent' : 'upcoming'; render(); return; }
    if(t.closest('[data-news-cal-all]')){ view.calAll = !view.calAll; render(); return; }
    if(t.closest('[data-news-events-refresh]')){ refreshStockEvents(scopeInfo().list, () => { render(); newsChanged(); }); return; }
    if(t.closest('[data-news-refresh]')) refreshPulse(render);
  });
  el.addEventListener('change', (e) => {
    const t = /** @type {HTMLElement} */ (e.target); if(!t || !t.closest) return;
    const sel = /** @type {HTMLSelectElement} */ (t);
    if(t.matches('[data-news-strategy]')){ setPick(sel.value); render(); }
    else if(t.matches('[data-news-type]')){ view.type = sel.value; render(); }
    else if(t.matches('[data-news-upto]')){ view.upto = +sel.value; render(); }
  });
  startNewsSync();
  render();
}

export { init, render };
