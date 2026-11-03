// The Screener and TradingView links in the stock grids sit inside a clickable row. A click on the link follows the link and must not also open the
// stock. This replaces an inline onclick="event.stopPropagation()" on each link (inline handlers are not allowed: CLAUDE.md section 3).
import { closestEl } from '../core/evt.js';

function init_ui_linkguard(){
  document.addEventListener('click', (evt) => {
    if (closestEl(evt, 'a.analysis-lb-link')) evt.stopPropagation();   // the link's own default action (opening the page) is not cancelled
  }, true);
}

export { init_ui_linkguard };
