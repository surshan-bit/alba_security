// Refresh kit: the floating menu that the Refresh buttons open (placing it, closing it, focus, and the shared menu-item markup).

let menuEl = null, menuAnchor = null, menuState = null;
function closeMenu(focusBack) {
  if (!menuEl) return;
  menuEl.remove();
  const a = menuAnchor;
  menuEl = null; menuAnchor = null; menuState = null;
  if (a) a.setAttribute("aria-expanded", "false");
  if (focusBack && a && a.isConnected) a.focus();
}
function placeMenu() {
  if (!menuEl) return;
  const m0 = menuEl.getBoundingClientRect();
  if (!menuAnchor || !menuAnchor.isConnected) {
    menuEl.style.left = Math.max(8, (window.innerWidth - m0.width) / 2) + "px"; menuEl.style.top = Math.max(8, (window.innerHeight - m0.height) / 3) + "px";
    return;
  }
  const r = menuAnchor.getBoundingClientRect(), m = m0;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - m.width - 8));
  let top = r.bottom + 6;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 6);
  menuEl.style.left = left + "px"; menuEl.style.top = top + "px";
}
function openMenu(anchor, html, state) {
  closeMenu(false);
  menuEl = document.createElement("div");
  menuEl.className = "rk-menu"; menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = html;
  document.body.appendChild(menuEl);
  menuAnchor = anchor; menuState = state || {};
  if (anchor) anchor.setAttribute("aria-expanded", "true");
  placeMenu();
  const first = menuEl.querySelector("button:not(:disabled), input");
  if (first) /** @type {HTMLElement} */ (first).focus();
}
function refillMenu(html) {
  if (!menuEl) return;
  menuEl.innerHTML = html; placeMenu();
}
const item = (act, attrs, label, small, off) => '<button type="button" role="menuitem" class="rk-item" data-rk-act="' + act + '" ' + attrs + (off ? " disabled" : "") + ">" + label + (small ? "<small>" + small + "</small>" : "") + "</button>";
const menuIsOpen = () => !!menuEl;
const menuOpenAt = (anchor) => !!menuEl && menuAnchor === anchor;
const getMenuAnchor = () => menuAnchor;
const getMenuState = () => menuState;
const menuQuery = (selector) => (menuEl ? menuEl.querySelector(selector) : null);
const menuQueryAll = (selector) => (menuEl ? Array.from(menuEl.querySelectorAll(selector)) : []);

export { closeMenu, getMenuAnchor, getMenuState, item, menuIsOpen, menuOpenAt, menuQuery, menuQueryAll, openMenu, refillMenu };
