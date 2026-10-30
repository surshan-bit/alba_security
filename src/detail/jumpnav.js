// Jump-to navigation row on the stock detail page.
import { verdictLabel } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';
import { scoreBand } from '../list/metrics.js';

// Quick links under the stock header: jump straight to a section instead of scrolling the long page.
// The small score and status shown inside the Fundamental / Technical links, so the verdicts can be read without scrolling.
function jumpPreview(score, status){
  if(score == null) return status ? '<span class="jump-preview fs-pending">' + escapeHtml(status) + '</span>' : '';
  return '<span class="jump-preview ' + scoreBand(score) + '"><b>' + score.toFixed(2) + '</b>' + (status ? ' &middot; ' + escapeHtml(status) : '') + '</span>';
}
function jumpPreviewFor(id, s){
  if(id === 'jump-fund') return s.fundamentals && s.score != null ? jumpPreview(s.score, verdictLabel[s.verdict] || '') : '';
  if(id === 'jump-tech'){
    const t = s.technical;
    if(!t) return '';
    return t.score == null ? jumpPreview(null, 'Insufficient data') : jumpPreview(t.score, verdictLabel[scoreBand(t.score).replace('fs-', '')] || '');
  }
  return '';
}

function renderDetailJumpNav(s){
  const links = [['jump-val', 'Valuation'], ['jump-global', 'Global & Macro'], ['jump-fund', 'Fundamental Score'], ['jump-tech', 'Technical Score'], ['eventsPanel', 'Events'], ['peersPanel', 'Peers']];
  // The stock's name and ticker stay in view while the page scrolls, so it is always clear which stock is open.
  const who = '<div class="detail-jump-who"><span class="detail-jump-name">' + escapeHtml(s.name) + '</span><span class="detail-jump-ticker">' + escapeHtml(s.ticker) + '</span></div>';
  return '<nav class="detail-jump" aria-label="Jump to section">' + who + '<span class="detail-jump-label">Jump to</span>' +
    links.map(l => '<a href="#" data-jump="' + l[0] + '">' + escapeHtml(l[1]) + jumpPreviewFor(l[0], s) + '</a>').join('') + '</nav>';
}
var whoObserver = null;
var spyHandler = null;
// Scroll spy: the link of the section being read is marked (the White theme shows it with an underline); at the very top the name tab is the current one.
function bindJumpSpy(root){
  const tb = document.querySelector('.topbar');
  const h = tb ? Math.round(tb.getBoundingClientRect().height) : 0;
  const nav = root.querySelector('.detail-jump');
  if(spyHandler) window.removeEventListener('scroll', spyHandler);
  const links = Array.from(root.querySelectorAll('.detail-jump a[data-jump]'));
  const who = root.querySelector('.detail-jump-who');
  if(nav && links.length){
    spyHandler = () => {
      if(!nav.isConnected) return;
      const line = h + nav.getBoundingClientRect().height + 24;
      let cur = null;
      links.forEach(a => { const el = document.getElementById(a.dataset.jump); if(el && el.getBoundingClientRect().top <= line) cur = a; });
      links.forEach(a => a.classList.toggle('is-current', a === cur));
      if(who) who.classList.toggle('is-current', !cur);
    };
    window.addEventListener('scroll', spyHandler, { passive: true });
    spyHandler();
  }
}
function bindDetailJumpNav(root){
  // Pin the row exactly under the top bar, whatever its real height is, so no gap shows above it while scrolling.
  const tb = document.querySelector('.topbar');
  const h = tb ? Math.round(tb.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--jump-top', Math.max(0, h - 1) + 'px');
  // The name line in the bar only shows once the big header above has scrolled out of view, so it is never shown twice at once.
  if(whoObserver){ whoObserver.disconnect(); whoObserver = null; }
  const nav = root.querySelector('.detail-jump');
  const top = root.querySelector('.detail-top');
  if(nav && top && typeof IntersectionObserver === 'function'){
    whoObserver = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      nav.classList.toggle('show-who', !e.isIntersecting && e.boundingClientRect.height > 0 && e.boundingClientRect.bottom < h + 1);
    }, { rootMargin: '-' + h + 'px 0px 0px 0px', threshold: 0 });
    whoObserver.observe(top);
  }
  bindJumpSpy(root);
  root.querySelectorAll('.detail-jump a[data-jump]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const el = document.getElementById(a.dataset.jump);
      if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

export { bindDetailJumpNav, bindJumpSpy, renderDetailJumpNav };
