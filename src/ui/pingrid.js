// The pin star in the stock grids other than Analysis (Strategies, Industry, a stock's peers). Analysis wires its own star (it also redraws
// its list, as pinned stocks sort first there); here the star flips in place and the click does not open the stock.
import { isPinned, togglePin } from '../core/pins.js';
import { closestEl } from '../core/evt.js';

function init_ui_pingrid(){
  document.addEventListener('click', (evt) => {
    const btn = closestEl(evt, '.strat-table .pin-btn');
    if(!btn || btn.closest('#analysisLeaderboardBody')) return;
    evt.stopPropagation();
    const ticker = /** @type {HTMLElement} */ (btn).dataset.ticker;
    if(!ticker) return;
    togglePin(ticker);
    const on = isPinned({ ticker });
    btn.classList.toggle('pinned', on);
    btn.textContent = on ? '\u2605' : '\u2606';
    btn.title = on ? 'Unpin' : 'Pin to top';
  }, true);
}

export { init_ui_pingrid };
