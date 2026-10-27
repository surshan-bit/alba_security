// Phones: the filters and the toolbar buttons of Explorer and Analysis open from a "Filters" button as a bottom sheet.
// sheetFrame() wraps a screen's filter controls in the sheet (backdrop, header, a slot for the buttons, a Done footer). After each draw,
// syncSheets() moves the screen's own button group into the slot, so its ids, listeners and menus keep working. On wide screens nothing
// moves and the frame is hidden by the stylesheet.
const PHONE = '(max-width: 900px)';
const phone = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches;

// [the panel that holds the sheet, the button group that moves into it]
const SHEETS = [['.biz-side', '.biz-actions'], ['.analysis-filters-panel', '.analysis-actions']];
let savedScroll = 0;   // the sheet is redrawn when a filter is tapped; this keeps its scroll position

function sheetFrame(controlsHtml){
  return '<div class="sheet-backdrop" data-sheet-close></div><div class="sheet-panel" role="dialog" aria-label="Filters">'
    + '<div class="sheet-head"><span class="sheet-title">Filters</span><button type="button" class="sheet-close" data-sheet-close aria-label="Close filters">&times;</button></div>'
    + controlsHtml + '<div class="sheet-slot"></div>'
    + '<div class="sheet-foot"><button type="button" class="sheet-done" data-sheet-close>Done</button></div></div>';
}

function syncSheet(panelSel, actionsSel){
  const panel = document.querySelector(panelSel), slot = panel && panel.querySelector('.sheet-slot');
  if(!panel || !slot) return;
  const inPage = Array.from(document.querySelectorAll(actionsSel)).find(a => !a.closest('.sheet-slot'));
  if(phone()){
    if(inPage){ inPage._home = { parent: inPage.parentNode, next: inPage.nextSibling }; slot.replaceChildren(inPage); }
    const box = panel.querySelector('.sheet-panel');
    if(box && savedScroll) box.scrollTop = savedScroll;
  } else {   // back on a wide screen (the phone was turned): put the buttons where they were
    Array.from(slot.children).forEach(a => {
      const h = /** @type {any} */ (a)._home;
      if(h && h.parent && h.parent.isConnected) h.parent.insertBefore(a, h.next && h.next.parentNode === h.parent ? h.next : null);
    });
  }
}
function syncSheets(){ SHEETS.forEach(([p, a]) => syncSheet(p, a)); }

function closeSheet(from){
  const host = from.closest('.biz-side, .analysis-filters-panel, .strat-filters-panel');
  // Analysis docks its Filters chip into the toolbar row, outside the panel that holds the sheet.
  const toggle = (host && host.querySelector('.biz-filters-toggle, .filters-toggle')) || (host && host.classList.contains('analysis-filters-panel') ? document.getElementById('analysisFiltersToggle') : null);
  savedScroll = 0;
  if(toggle) /** @type {HTMLElement} */ (toggle).click();
}

function init_ui_phonesheet(){
  document.addEventListener('click', (e) => {
    const t = /** @type {Element | null} */ (e.target), c = t && t.closest && t.closest('[data-sheet-close]');
    if(c) closeSheet(c);
  });
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Escape' || !phone()) return;
    const open = document.querySelector('.biz-side:not(.filters-collapsed) .sheet-panel, .analysis-filters-panel:not(.filters-collapsed) .sheet-panel, .strat-filters-panel:not(.filters-collapsed) .sheet-panel');
    if(open) closeSheet(open);
  });
  document.addEventListener('scroll', (e) => {
    const t = /** @type {Element | null} */ (e.target);
    if(t && t.classList && t.classList.contains('sheet-panel')) savedScroll = /** @type {HTMLElement} */ (t).scrollTop;
  }, true);
  if(typeof window.matchMedia === 'function') window.matchMedia(PHONE).addEventListener('change', syncSheets);
}

export { init_ui_phonesheet, sheetFrame, syncSheets };
