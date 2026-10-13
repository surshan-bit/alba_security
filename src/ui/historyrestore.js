// Shows a view from the browser history (see viewstack.js) when Back / Forward is used.
import { stocks } from '../core/stocks.js';
import { tickerSymbol } from '../core/util.js';
import { appSections, showSection } from './navigation.js';
import { closeInlineDetail, inlineOpenIn, openStockInline } from './inlinedetail.js';
import { stockCodeFromAddress } from './deeplink.js';
import { uiStateGet } from '../identity/prefs.js';
import { getUid } from '../identity/session.js';
import { init_ui_viewstack, setViewRestorer } from './viewstack.js';

const idxOf = (t) => stocks.findIndex(s => tickerSymbol(s) === t);

function restore(v){
  if(!v.t){
    // A page, with no stock open. If a stock is open in that same page, close it and return to where the page was.
    if(inlineOpenIn() === v.s){ closeInlineDetail(true); return; }
    showSection(v.s);
    return;
  }
  const idx = idxOf(v.t);
  if(idx < 0){ showSection(v.s); return; }
  if(inlineOpenIn() !== v.s) showSection(v.s);
  if(appSections[v.s]) openStockInline(appSections[v.s], v.i || '', idx);
}

function init_ui_historyrestore(){
  // The landing page: a stock opened by a link (inside Explorer), else the page you were last on (signed-in members), else Analysis.
  // Decided once, here, so a refresh goes straight to it without flashing Analysis first.
  let active = 'analysis';
  if(stockCodeFromAddress()) active = 'business';
  else {
    try { const saved = uiStateGet().section; if(getUid() && saved && appSections[saved]) active = saved; }
    catch(e){ console.error('Could not restore the last page', e); }
    showSection(active);
  }
  setViewRestorer(restore);
  init_ui_viewstack({ s: active });
}

export { init_ui_historyrestore };
