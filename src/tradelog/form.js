// Trade Log: add, sell and remove forms.
import { stockByTickerSymbol, stocks } from '../core/stocks.js';
import { getTrade, getTradeDb } from '../core/store.js';
import { escapeHtml, formatDate, sanitizeDocId, tickerSymbol } from '../core/util.js';
import { fundamentalCompleteness, technicalCompleteness } from '../detail/completeness.js';
import { buildSuggestions, sgMark } from '../ui/suggest.js';
import { holdingDaysBetween, tlSetView } from './panel.js';
import { tradeCol } from '../identity/session.js';
import { tellUser } from '../ui/confirm.js';

// ---- Trade Log: add / sell / remove from this page (added 2026-10-06) ----
function tlToday(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function tlSnapshot(s){
  const v = s.valuation || {};
  const price = v.currentPrice != null ? v.currentPrice : null;
  const iv = v.intrinsicValue != null ? v.intrinsicValue : null;
  const fc = fundamentalCompleteness(s), tc = technicalCompleteness(s);
  return {
    score: s.score != null ? s.score : null,
    verdict: s.verdict || null,
    currentPriceAtSnapshot: price,
    intrinsicValue: iv,
    marginOfSafetyPct: (iv && price != null) ? ((iv - price) / iv) * 100 : null,
    fundamentalFactorsComplete: fc.complete,
    fundamentalFactorsTotal: fc.total,
    technicalComponentsComplete: tc.complete,
    technicalComponentsTotal: tc.total
  };
}
function tlLabel(s){ return s.name + ' (' + tickerSymbol(s) + ')'; }
function tlSetMsg(text, isErr){
  const m = document.getElementById('tlMsg');
  if(m){ m.textContent = text || ''; m.className = 'tl-msg' + (isErr ? ' err' : ''); }
}
function tlCloseForm(){ const h = document.getElementById('tradeFormHost'); if(h) h.innerHTML = ''; }

function tlOpenAddForm(){
  const host = document.getElementById('tradeFormHost');
  if(!host) return;
  tlSel = null; tlItems = []; tlActive = -1; tlAutoPrice = null;
  host.innerHTML = `
    <div class="tl-form" data-tl-form="add">
      <div class="tl-form-title">Add a trade (buy)</div>
      <div class="tl-grid">
        <label class="tl-wide">Stock
          <div class="search-box" style="flex:none;width:100%;min-width:0;">
            <input id="tlStock" class="search-input" type="text" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="tlSuggest" placeholder="Search by ticker or company name…">
            <div class="search-suggest" id="tlSuggest" role="listbox"></div>
          </div>
        </label>
        <label>Buy date<input id="tlDate" type="date" value="${tlToday()}" max="${tlToday()}"></label>
        <label>Buy price (&#8377;)<input id="tlPrice" type="number" step="0.01" min="0" inputmode="decimal"></label>
        <label>Quantity<input id="tlQty" type="number" step="1" min="1" inputmode="numeric"></label>
      </div>
      <div class="tl-form-actions">
        <button type="button" class="refresh-btn tl-btn-primary" id="tlSave">Save trade</button>
        <button type="button" class="refresh-btn" id="tlCancel">Cancel</button>
        <span class="tl-msg" id="tlMsg">The stock's current score, verdict and data completeness are saved with the trade as a snapshot.</span>
      </div>
    </div>`;
  document.getElementById('tlStock').focus();
}
let tlSel = null, tlItems = [], tlActive = -1, tlAutoPrice = null;
function tlHideSugg(){
  const el = document.getElementById('tlSuggest'); if(el) el.classList.remove('show');
  const i = document.getElementById('tlStock'); if(i) i.setAttribute('aria-expanded', 'false');
  tlItems = []; tlActive = -1;
}
function tlSetActive(n){
  tlActive = n;
  const el = document.getElementById('tlSuggest'); if(!el) return;
  Array.from(el.children).forEach((c, k) => c.classList.toggle('active', k === n));
  const c = el.children[n]; if(c && c.scrollIntoView) c.scrollIntoView({block:'nearest'});
}
function tlShowSugg(){
  const inp = document.getElementById('tlStock'), el = document.getElementById('tlSuggest');
  if(!inp || !el) return;
  const q = inp.value.trim().toLowerCase();
  if(!q || (tlSel && inp.value === tlLabel(tlSel))){ tlHideSugg(); return; }
  tlItems = buildSuggestions(q); tlActive = -1;
  if(!tlItems.length){ tlHideSugg(); return; }
  el.innerHTML = tlItems.map((st, i) => {
    const parts = String(st.ticker || '').split('·');
    const sub = parts[0].trim() + (parts[1] ? ' · ' + parts[1].trim() : '');
    return `<div class="sg-item" role="option" data-i="${i}"><div class="sg-main"><div class="sg-name">${sgMark(st.name || '', q)}</div><div class="sg-sub">${sgMark(sub, q)}</div></div><div class="sg-score">${Number(st.score).toFixed(2)}</div></div>`;
  }).join('');
  el.classList.add('show'); inp.setAttribute('aria-expanded', 'true');
}
function tlPick(st){
  tlSel = st;
  const inp = document.getElementById('tlStock'); inp.value = tlLabel(st);
  tlHideSugg();
  const p = document.getElementById('tlPrice');
  const cur = st.valuation && st.valuation.currentPrice != null ? String(st.valuation.currentPrice) : '';
  if(p && cur && (!p.value || p.value === tlAutoPrice)){ p.value = cur; tlAutoPrice = cur; }
  tlSetMsg('');
  if(p) p.focus();
}
function tlFindStock(label){
  const v = (label || '').trim().toLowerCase();
  if(!v) return null;
  let m = stocks.find(s => tlLabel(s).toLowerCase() === v);
  if(m) return m;
  const hits = stocks.filter(s => tickerSymbol(s).toLowerCase() === v || s.name.toLowerCase() === v);
  return hits.length === 1 ? hits[0] : null;
}
async function tlSaveBuy(){
  const tradeDb = getTradeDb();
  if(!tradeDb){ tlSetMsg('The trade log database is not reachable in this view.', true); return; }
  const stockText = document.getElementById('tlStock').value;
  const s = (tlSel && stockText === tlLabel(tlSel)) ? tlSel : tlFindStock(stockText);
  const date = document.getElementById('tlDate').value;
  const price = parseFloat(document.getElementById('tlPrice').value);
  const qty = parseInt(document.getElementById('tlQty').value, 10);
  if(!s){ tlSetMsg('Pick a stock from the suggestions.', true); return; }
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ tlSetMsg('Enter the buy date.', true); return; }
  if(!(price > 0)){ tlSetMsg('Enter a buy price above 0.', true); return; }
  if(!(qty > 0)){ tlSetMsg('Enter a quantity of at least 1.', true); return; }
  const sym = tickerSymbol(s);
  const id = sanitizeDocId(sym + '-' + date);
  if(getTrade(id)){ tlSetMsg('A trade for ' + sym + ' on this date already exists. Remove it first or use another date.', true); return; }
  const btn = document.getElementById('tlSave'); btn.disabled = true;
  try {
    await tradeCol(tradeDb).doc(id).set({
      ticker: sym, name: s.name, status: 'open',
      buy: {date, price, quantity: qty, snapshot: tlSnapshot(s)},
      sell: null, loggedAt: new Date().toISOString()
    });
    tlCloseForm();
  } catch(e){
    console.error('Failed to save trade', e);
    btn.disabled = false;
    tlSetMsg('Could not save the trade. Please try again.', true);
  }
}

function tlOpenSellForm(id){
  const t = getTrade(id); const host = document.getElementById('tradeFormHost');
  if(!t || !host) return;
  const s = stockByTickerSymbol.get(t.ticker);
  const curPrice = s && s.valuation && s.valuation.currentPrice != null ? s.valuation.currentPrice : '';
  host.innerHTML = `
    <div class="tl-form" data-tl-form="sell" data-tl-id="${escapeHtml(id)}">
      <div class="tl-form-title">Sell: ${escapeHtml(t.name || t.ticker)} (bought ${escapeHtml(formatDate(t.buy.date))} at &#8377;${t.buy.price} &times; ${t.buy.quantity})</div>
      <div class="tl-grid">
        <label>Sell date<input id="tlSellDate" type="date" value="${tlToday()}" min="${escapeHtml(t.buy.date)}" max="${tlToday()}"></label>
        <label>Sell price (&#8377;)<input id="tlSellPrice" type="number" step="0.01" min="0" inputmode="decimal" value="${curPrice}"></label>
      </div>
      <div class="tl-form-actions">
        <button type="button" class="refresh-btn tl-btn-primary" id="tlSellSave">Close position</button>
        <button type="button" class="refresh-btn" id="tlCancel">Cancel</button>
        <span class="tl-msg" id="tlMsg">Sells the whole position. The return shown is before brokerage and taxes.</span>
      </div>
    </div>`;
  host.scrollIntoView({behavior:'smooth', block:'nearest'});
}
async function tlSaveSell(id){
  const t = getTrade(id), tradeDb = getTradeDb();
  if(!t || !tradeDb) return;
  const date = document.getElementById('tlSellDate').value;
  const price = parseFloat(document.getElementById('tlSellPrice').value);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < t.buy.date){ tlSetMsg('Enter a sell date on or after the buy date.', true); return; }
  if(!(price > 0)){ tlSetMsg('Enter a sell price above 0.', true); return; }
  const s = stockByTickerSymbol.get(t.ticker);
  const rec = Object.assign({}, t); delete rec._id;
  rec.status = 'closed';
  rec.sell = {
    date, price, quantity: t.buy.quantity,
    holdingDays: holdingDaysBetween(t.buy.date, date),
    realizedReturnPct: ((price - t.buy.price) / t.buy.price) * 100,
    snapshot: s ? tlSnapshot(s) : null
  };
  const btn = document.getElementById('tlSellSave'); btn.disabled = true;
  try {
    await tradeCol(tradeDb).doc(id).set(rec);
    tlCloseForm();
  } catch(e){
    console.error('Failed to close trade', e);
    btn.disabled = false;
    tlSetMsg('Could not save the sale. Please try again.', true);
  }
}
async function tlRemove(id){
  const tradeDb = getTradeDb();
  if(!tradeDb) return;
  try { await tradeCol(tradeDb).doc(id).delete(); }
  catch(e){ console.error('Failed to remove trade', e); tellUser('Could not remove the trade. Please try again.'); }
}

function init_tradelog_form(){

(function(){
  const addBtn = document.getElementById('tradeAddBtn');
  if(addBtn) addBtn.addEventListener('click', tlOpenAddForm);
  document.querySelectorAll('.tl-view-btn').forEach(b => b.addEventListener('click', () => tlSetView(b.getAttribute('data-tl-view'))));
  const host = document.getElementById('tradeFormHost');
  if(host){
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if(!b) return;
      if(b.id === 'tlCancel') tlCloseForm();
      else if(b.id === 'tlSave') tlSaveBuy();
      else if(b.id === 'tlSellSave'){ const f = b.closest('[data-tl-id]'); if(f) tlSaveSell(f.getAttribute('data-tl-id')); }
    });
    host.addEventListener('input', (e) => {
      if(e.target.id !== 'tlStock') return;
      if(tlSel && e.target.value !== tlLabel(tlSel)) tlSel = null;
      tlShowSugg();
    });
    host.addEventListener('focusin', (e) => { if(e.target.id === 'tlStock') tlShowSugg(); });
    host.addEventListener('focusout', (e) => { if(e.target.id === 'tlStock') setTimeout(tlHideSugg, 120); });
    host.addEventListener('keydown', (e) => {
      if(e.target.id !== 'tlStock') return;
      const el = document.getElementById('tlSuggest');
      if(!el || !el.classList.contains('show')) return;
      if(e.key === 'ArrowDown'){ e.preventDefault(); tlSetActive((tlActive + 1) % tlItems.length); }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); tlSetActive((tlActive - 1 + tlItems.length) % tlItems.length); }
      else if(e.key === 'Enter' && tlActive >= 0){ e.preventDefault(); tlPick(tlItems[tlActive]); }
      else if(e.key === 'Escape'){ tlHideSugg(); }
    });
    host.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.sg-item'); if(!it) return;
      e.preventDefault(); tlPick(tlItems[Number(it.dataset.i)]);
    });
  }
  const panel = document.getElementById('tradeLogPanelBody');
  if(panel){
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if(!b) return;
      if(b.hasAttribute('data-tl-sell')) tlOpenSellForm(b.getAttribute('data-tl-sell'));
      else if(b.hasAttribute('data-tl-remove')){
        if(b.classList.contains('armed')){ tlRemove(b.getAttribute('data-tl-remove')); }
        else {
          b.classList.add('armed'); b.textContent = 'Confirm remove?';
          setTimeout(() => { if(b.isConnected){ b.classList.remove('armed'); b.textContent = 'Remove'; } }, 4000);
        }
      }
    });
  }
})();
}

export { init_tradelog_form };
