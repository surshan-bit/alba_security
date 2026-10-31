// Small drop-down menus: a button that opens a short list of choices (Analysis: the View choice, and the "more" menu of the industry views).
// dropMenuHtml() draws one; the choices carry their own data attributes, so the screen that draws the menu handles the click as it does for any button.
// This file only opens and closes menus: a click on the button toggles it, a click anywhere else or Esc closes it, and choosing an item closes it.
import { escapeHtml } from '../core/util.js';

// `btnHtml` is the button's content (trusted markup); `items` = [{ attrs (data attributes, trusted), title, desc?, current? }]; `right` opens the list towards the left edge.
/** @param {{ btnHtml: string, label?: string, items: { attrs: string, title: string, desc?: string, current?: boolean, cls?: string }[], right?: boolean, extraClass?: string }} opts */
function dropMenuHtml({ btnHtml, label, items, right, extraClass }){
  const list = items.map(it => `<button type="button" role="menuitem" class="dm-item${it.current ? ' current' : ''}${it.cls ? ' ' + it.cls : ''}" ${it.attrs}><span class="dm-t">${escapeHtml(it.title)}</span>${it.desc ? `<span class="dm-d">${escapeHtml(it.desc)}</span>` : ''}</button>`).join('');
  return `<div class="dm${right ? ' dm-right' : ''}${extraClass ? ' ' + extraClass : ''}"><button type="button" class="dm-btn" data-dm-toggle aria-haspopup="menu" aria-expanded="false"${label ? ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"` : ''}>${btnHtml}</button><div class="dm-pop" role="menu" hidden>${list}</div></div>`;
}

function closeMenus(except){
  document.querySelectorAll('.dm').forEach(m => {
    if(m === except) return;
    const pop = /** @type {HTMLElement | null} */ (m.querySelector('.dm-pop')), btn = m.querySelector('.dm-btn');
    if(pop) pop.hidden = true;
    if(btn) btn.setAttribute('aria-expanded', 'false');
  });
}

function init_ui_dropmenu(){
  document.addEventListener('click', (e) => {
    const t = /** @type {Element | null} */ (e.target), toggle = t && t.closest ? t.closest('[data-dm-toggle]') : null, menu = toggle && toggle.closest('.dm');
    closeMenus(menu);
    if(!toggle || !menu) return;
    const pop = /** @type {HTMLElement | null} */ (menu.querySelector('.dm-pop'));
    if(!pop) return;
    pop.hidden = !pop.hidden;
    toggle.setAttribute('aria-expanded', String(!pop.hidden));
  });
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Escape') return;
    const open = document.querySelector('.dm .dm-pop:not([hidden])');
    if(!open) return;
    const btn = open.parentElement && open.parentElement.querySelector('.dm-btn');
    closeMenus(null);
    if(btn) /** @type {HTMLElement} */ (btn).focus();
  });
}

export { dropMenuHtml, init_ui_dropmenu };
