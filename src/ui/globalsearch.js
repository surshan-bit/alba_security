// Search box in the top bar: find any stock from any page and open its detail view.
import { stockIndex } from '../core/stocks.js';
import { buildSuggestions, sgMark } from './suggest.js';
import { appSections, showSection } from './navigation.js';
import { openStockInline } from './inlinedetail.js';
import { closestEl } from '../core/evt.js';
import { setHtml } from '../core/safehtml.js';

const PHONE_QUERY = '(max-width: 900px)';
const SEARCH_PAGES = { analysis: 'Analysis', strategies: 'Strategies', business: 'Explorer' };   // pages the search can open a stock on top of
const TYPING_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

// The three elements of the box, and the suggestions shown for what is typed: items (stocks) and active (the highlighted one, -1 for none).
/** @type {HTMLInputElement} */ let input;
/** @type {HTMLElement} */ let box;
/** @type {HTMLElement} */ let clear;
let items = [], active = -1;

function hide(){
  box.classList.remove('show'); input.setAttribute('aria-expanded', 'false'); items = []; active = -1;
}
function setActive(i){
  active = i;
  Array.from(box.children).forEach((el, k) => el.classList.toggle('active', k === i));
  const el = box.children[i]; if(el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}
function suggestionHtml(s, i, q){
  const parts = String(s.ticker || '').split('·'), sub = parts[0].trim() + (parts[1] ? ' · ' + parts[1].trim() : '');
  return '<div class="sg-item" role="option" data-i="' + i + '"><div class="sg-main"><div class="sg-name">' + sgMark(s.name || '', q) + '</div><div class="sg-sub">' + sgMark(sub, q) + '</div></div><div class="sg-score">' + Number(s.score).toFixed(2) + '</div></div>';
}
function show(){
  const q = input.value.trim().toLowerCase();
  clear.classList.toggle('show', input.value.length > 0);
  if(!q){ hide(); return; }
  items = buildSuggestions(q); active = -1;
  if(!items.length){ setHtml(box, '<div class="sg-empty">No stock found</div>'); box.classList.add('show'); return; }
  setHtml(box, items.map((s, i) => suggestionHtml(s, i, q)).join(''));
  box.classList.add('show'); input.setAttribute('aria-expanded', 'true');
}
// Opens the stock as the full-width detail view, with "Back to <page>" to return to where the search was made.
function pick(s){
  const idx = stockIndex.get(s);
  hide(); input.value = ''; clear.classList.remove('show'); input.blur();
  if(idx === undefined) return;
  const here = Object.keys(SEARCH_PAGES).find(k => appSections[k] && appSections[k].classList.contains('active'));
  if(here){ openStockInline(appSections[here], SEARCH_PAGES[here], idx); return; }
  showSection('business');
  openStockInline(appSections.business, SEARCH_PAGES.business, idx);
}
function onSearchKey(e){
  if(e.key === 'Escape'){ hide(); input.blur(); return; }
  if(!box.classList.contains('show') || !items.length) return;
  if(e.key === 'ArrowDown'){ e.preventDefault(); setActive((active + 1) % items.length); return; }
  if(e.key === 'ArrowUp'){ e.preventDefault(); setActive((active - 1 + items.length) % items.length); return; }
  if(e.key === 'Enter'){ e.preventDefault(); pick(items[active >= 0 ? active : 0]); }
}
// "/" jumps to the box from anywhere (unless typing in another field).
function onSlashKey(e){
  if(e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = /** @type {HTMLElement | null} */ (e.target);
  if(t && (TYPING_TAGS.includes(t.tagName) || t.isContentEditable)) return;
  e.preventDefault(); input.focus();
}

function init_ui_globalsearch(){
  const inputEl = document.getElementById('globalSearch'), boxEl = document.getElementById('globalSuggest'), clearEl = document.getElementById('globalSearchClear');
  if(!inputEl || !boxEl || !clearEl) return;
  input = /** @type {HTMLInputElement} */ (inputEl); box = boxEl; clear = clearEl;
  // A shorter prompt on phones, so the whole of it fits in the box.
  const longHint = input.getAttribute('placeholder') || '', phoneQuery = window.matchMedia(PHONE_QUERY);
  const setHint = () => input.setAttribute('placeholder', phoneQuery.matches ? 'Search a company' : longHint);
  setHint(); phoneQuery.addEventListener('change', setHint);
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('keydown', onSearchKey);
  box.addEventListener('mousedown', (e) => {
    const it = closestEl(e, '.sg-item'); if(!it) return;
    e.preventDefault(); pick(items[Number(it.dataset.i)]);
  });
  clear.addEventListener('click', () => { input.value = ''; clear.classList.remove('show'); hide(); input.focus(); });
  document.addEventListener('mousedown', (e) => { if(!closestEl(e, '.topbar-search')) hide(); });
  document.addEventListener('keydown', onSlashKey);
}

export { init_ui_globalsearch };
