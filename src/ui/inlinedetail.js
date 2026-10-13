// Opens a stock's detail page right where you are (Analysis, Strategies, Explorer). The shared detail panel is moved
// into the page you are on; the page's own content is only hidden, so its filters, open rows and scroll position are
// still there when you press Back.
import { detailEl } from '../core/dom.js';
import { stocks } from '../core/stocks.js';
import { renderDetail, setDetailBackTo } from '../detail/render.js';
import { syncStockHash } from './deeplink.js';
import { tickerSymbol } from '../core/util.js';
import { recordView } from './viewstack.js';

// Where the detail panel rests (a hidden holder in the page) when no stock is open; it is handed back here when a detail view closes.
const detailHome = detailEl.parentNode;
let current = null;   // { section, host, scroll } while a stock is open in place

// Hands the panel back to its holder and shows the page again. restoreScroll: go back to where the page was.
function closeInlineDetail(restoreScroll){
  if(!current) return;
  const { section, host, scroll } = current;
  current = null;
  if(detailEl.parentNode === host){ detailHome.appendChild(detailEl); detailEl.innerHTML = ''; }
  host.remove();
  section.classList.remove('inline-detail-open');
  setDetailBackTo(null);
  syncStockHash(null);
  if(restoreScroll) requestAnimationFrame(() => { window.scrollTo(0, scroll); });
}

// The key of the page a stock is currently open in ("analysis", "business", ...), or null.
function inlineOpenIn(){ return current ? current.section.id.replace(/^section-/, '') : null; }

// The page lives in a frame, and the keyboard goes to whichever window has focus. If the frame lost it (so Esc went to the
// claude.ai bar above), take it back and put the focus on the Back button, which is also what Esc and Enter then act on.
function takeKeyboardFocus(){
  const grab = () => {
    try { if(!document.hasFocus()) window.focus(); } catch(e){}
    const b = document.getElementById('detailBackBtn');
    if(b && document.activeElement !== b){ try { b.focus({ preventScroll: true }); } catch(e){} }
  };
  grab(); setTimeout(grab, 60); setTimeout(grab, 400);
}

function openStockInline(section, label, idx){
  if(!stocks[idx]) return;
  const scroll = current ? current.scroll : window.scrollY;
  if(!current){
    const host = document.createElement('div');
    host.className = 'inline-detail-host';
    section.appendChild(host);
    section.classList.add('inline-detail-open');
    host.appendChild(detailEl);
    current = { section, host, scroll };
  }
  // No label (a stock opened from a link, e.g. in a new tab): there is no page to go back to, so no Back button.
  // Back / Esc closes the detail and shows the page again, whatever the browser history holds (it does not depend on the history working inside the frame).
  setDetailBackTo(label ? { label, onBack: () => { const key = section.id.replace(/^section-/, ''); closeInlineDetail(true); recordView({ s: key }); } } : null);
  renderDetail(idx);
  syncStockHash(stocks[idx]);
  recordView({ s: section.id.replace(/^section-/, ''), t: tickerSymbol(stocks[idx]), i: label });
  window.scrollTo(0, 0);
  takeKeyboardFocus();
}

export { closeInlineDetail, inlineOpenIn, openStockInline };
