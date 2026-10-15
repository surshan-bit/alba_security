// Search box in the top bar: find any stock from any page and open its detail view.
import { stockIndex } from '../core/stocks.js';
import { buildSuggestions, sgMark } from './suggest.js';
import { appSections, showSection } from './navigation.js';
import { openStockInline } from './inlinedetail.js';
import { closestEl } from '../core/evt.js';

function init_ui_globalsearch(){
  const input = document.getElementById('globalSearch'), box = document.getElementById('globalSuggest'), clear = document.getElementById('globalSearchClear');
  if(!input || !box) return;
  let items = [], active = -1;
  const hide = () => { box.classList.remove('show'); input.setAttribute('aria-expanded', 'false'); items = []; active = -1; };
  const setActive = (i) => {
    active = i;
    Array.from(box.children).forEach((el, k) => el.classList.toggle('active', k === i));
    const el = box.children[i]; if(el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  };
  const show = () => {
    const q = /** @type {HTMLInputElement} */ (input).value.trim().toLowerCase();
    clear.classList.toggle('show', /** @type {HTMLInputElement} */ (input).value.length > 0);
    if(!q){ hide(); return; }
    items = buildSuggestions(q); active = -1;
    if(!items.length){ box.innerHTML = '<div class="sg-empty">No stock found</div>'; box.classList.add('show'); return; }
    box.innerHTML = items.map((s, i) => {
      const parts = String(s.ticker || '').split('·'), sub = parts[0].trim() + (parts[1] ? ' · ' + parts[1].trim() : '');
      return '<div class="sg-item" role="option" data-i="' + i + '"><div class="sg-main"><div class="sg-name">' + sgMark(s.name || '', q) + '</div><div class="sg-sub">' + sgMark(sub, q) + '</div></div><div class="sg-score">' + Number(s.score).toFixed(2) + '</div></div>';
    }).join('');
    box.classList.add('show'); input.setAttribute('aria-expanded', 'true');
  };
  const pick = (s) => {
    const idx = stockIndex.get(s);
    hide(); /** @type {HTMLInputElement} */ (input).value = ''; clear.classList.remove('show'); input.blur();
    if(idx === undefined) return;
    // The full-width detail view, with "Back to <page>" to return to where the search was made.
    const labels = { analysis: 'Analysis', strategies: 'Strategies', business: 'Explorer' };
    const here = Object.keys(labels).find(k => appSections[k] && appSections[k].classList.contains('active'));
    if(here){ openStockInline(appSections[here], labels[here], idx); return; }
    showSection('business');
    openStockInline(appSections.business, 'Explorer', idx);
  };
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('keydown', (e) => {
    if(e.key === 'Escape'){ hide(); input.blur(); return; }
    if(!box.classList.contains('show') || !items.length) return;
    if(e.key === 'ArrowDown'){ e.preventDefault(); setActive((active + 1) % items.length); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
    else if(e.key === 'Enter'){ e.preventDefault(); pick(items[active >= 0 ? active : 0]); }
  });
  box.addEventListener('mousedown', (e) => {
    const it = closestEl(e, '.sg-item'); if(!it) return;
    e.preventDefault(); pick(items[Number(it.dataset.i)]);
  });
  clear.addEventListener('click', () => { /** @type {HTMLInputElement} */ (input).value = ''; clear.classList.remove('show'); hide(); input.focus(); });
  document.addEventListener('mousedown', (e) => { if(!closestEl(e, '.topbar-search')) hide(); });
  // "/" jumps to the box from anywhere (unless typing in another field).
  document.addEventListener('keydown', (e) => {
    if(e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target; if(t && (/** @type {HTMLElement} */ (t).tagName === 'INPUT' || /** @type {HTMLElement} */ (t).tagName === 'TEXTAREA' || /** @type {HTMLElement} */ (t).tagName === 'SELECT' || /** @type {HTMLElement} */ (t).isContentEditable)) return;
    e.preventDefault(); input.focus();
  });
}

export { init_ui_globalsearch };
