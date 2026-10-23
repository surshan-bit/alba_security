// Renders the stock detail page and wires its buttons.
import { keepScroll } from '../ui/scrollkeep.js';
import { LINK_ICON } from './icons.js';
import { detailEl } from '../core/dom.js';
import { stocks } from '../core/stocks.js';
import { isPinned, togglePin } from '../core/pins.js';
import { escapeHtml, screenerUrl } from '../core/util.js';
import { renderValuationPanel } from './valuation.js';
import { renderFundamentals } from './fundamentals.js';
import { renderTvChart } from '../tv/links.js';
import { renderTechPanel } from './technical.js';
import { renderStockResearchBar } from './pending.js';
import { renderGlobalFactorsPanel } from './globalfactors.js';
import { renderPeersPanel } from './peers.js';
import { bindDetailJumpNav, renderDetailJumpNav } from './jumpnav.js';
import { loadPriceBarsFor } from '../prices/store.js';
import { initPriceChart } from '../prices/chart.js';
import { bindLiveDataBar } from '../livedata/bar.js';
import { showSection } from '../ui/navigation.js';
import { copyText, stockShareLink, syncStockHash } from '../ui/deeplink.js';
import { getRefreshKit } from '../refresh/hook.js';

// Set when a stock is opened from the Analysis screen (chart dot or leaderboard row), so the detail
// view can offer a one-tap "Back to Analysis" that returns to the same filters and scroll position.
let detailBackTo = null;
function detailBackToAnalysis(){
  if(!detailBackTo) return;
  if(detailBackTo.onBack){ const back = detailBackTo.onBack; detailBackTo = null; back(); return; }
  const y = detailBackTo.scroll, to = detailBackTo.section || 'analysis';
  detailBackTo = null;
  showSection(to);
  requestAnimationFrame(()=>{ window.scrollTo(0, y); });
}
// The stock the detail panel is showing right now (opened from Analysis, Strategies, Explorer or the search box).
let shownIdx = -1;
function getShownIndex(){ return shownIdx; }
// Redraws whatever stock is open, e.g. after saved research or a pin change; does nothing if none is open.
// Set by the research overlay: called with the stock each time its page is drawn.
let detailOpenHook = null;
function setDetailOpenHook(fn){ detailOpenHook = fn; }
function rerenderDetail(){ if(stocks[shownIdx]) keepScroll(detailEl, () => renderDetail(shownIdx)); }
function renderDetail(idx){
  shownIdx = idx;
  const s = stocks[idx];
  if(detailOpenHook) detailOpenHook(s);
  const pinned = isPinned(s);
  detailEl.innerHTML = `
    ${detailBackTo ? `<div class="detail-back-bar"><button type="button" class="detail-back" id="detailBackBtn" title="Back (Esc)">&larr; Back to ${detailBackTo.label || 'Analysis'}<span class="detail-back-key">Esc</span></button></div>` : ''}
    <div class="detail-top">
      <div class="detail-title">
        <button type="button" class="detail-star${pinned?' pinned':''}" id="detailPinBtn" aria-pressed="${pinned?'true':'false'}" aria-label="${pinned?'Unpin from top':'Pin to top'}" title="${pinned?'Pinned — click to unpin':'Pin to top'}">${pinned?'★':'☆'}</button>
        <div class="detail-title-text"><div class="detail-name">${escapeHtml(s.name)}</div><div class="detail-ticker">${escapeHtml(s.ticker)}</div></div>
      </div>
    <div class="detail-meta">
     <div class="detail-meta-row detail-meta-links">
      <a href="${screenerUrl(s)}" target="_blank" rel="noopener noreferrer">${LINK_ICON}<span>View on screener.in</span></a>
      ${renderTvChart(s)}
      <a href="#" id="copyStockLinkBtn" class="share-link-btn" title="Copy a link that opens this stock"><svg class="link-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg><span class="share-link-label">Share link</span></a>
      ${getRefreshKit() ? getRefreshKit().stockBtn(s) : ''}
     </div>
    </div>
    </div>
    ${renderDetailJumpNav(s)}
    ${renderStockResearchBar(s)}
    ${renderValuationPanel(s)}
    ${renderGlobalFactorsPanel(s)}
    ${renderFundamentals(s)}
    ${renderTechPanel(s)}
    ${renderPeersPanel(s, idx)}
  `;

  initPriceChart(s);
  loadPriceBarsFor(s, idx);
  bindDetailJumpNav(detailEl);
  const peersPanel = document.getElementById('peersPanel');
  if(peersPanel){
    peersPanel.querySelectorAll('tbody tr[data-idx]').forEach(tr => {
      tr.addEventListener('click', () => {
        const i = Number(/** @type {HTMLElement} */ (tr).dataset.idx);
        if(i !== idx){ renderDetail(i); syncStockHash(stocks[i]); }
      });
    });
    const scroller = peersPanel.querySelector('.peers-scroll');
    const selfRow = /** @type {HTMLElement} */ (peersPanel.querySelector('tr.peers-self'));
    if(scroller && selfRow){
      scroller.scrollTop = Math.max(0, selfRow.offsetTop - scroller.clientHeight / 2 + selfRow.offsetHeight / 2);
    }
  }

  const howCalculatedLink = document.getElementById('howCalculatedLink');
  if(howCalculatedLink){
    howCalculatedLink.addEventListener('click', (e)=>{
      e.preventDefault();
      showSection('knowledgebase').then(() => document.getElementById('kb-fundamental')?.scrollIntoView({block:'start'}));
    });
  }

  detailEl.querySelectorAll('.proxy-tag-link').forEach(tag => {
    tag.addEventListener('click', (e)=>{
      e.preventDefault();
      showSection('help').then(() => document.getElementById('glossary-data-proxy')?.scrollIntoView({block:'start'}));
    });
  });

  const copyLinkBtn = document.getElementById('copyStockLinkBtn');
  if(copyLinkBtn){
    copyLinkBtn.onclick = (e) => {
      e.preventDefault();
      const shareLabel = copyLinkBtn.querySelector('.share-link-label') || copyLinkBtn;
      copyText(stockShareLink(s)).then(() => { shareLabel.textContent = 'Link copied ✓'; }, () => { shareLabel.textContent = stockShareLink(s); })
        .then(() => setTimeout(() => { shareLabel.textContent = 'Share link'; }, 2500));
    };
  }
  const detailPinBtn = document.getElementById('detailPinBtn');
  if(detailPinBtn){
    detailPinBtn.onclick = () => togglePin(s.ticker);
  }

  bindLiveDataBar(s);   // Live Data Refresh buttons (js/livedata.js)

}

function setDetailBackTo(v){ detailBackTo = v; }

export { detailBackToAnalysis, getShownIndex, renderDetail, rerenderDetail, setDetailBackTo, setDetailOpenHook };
