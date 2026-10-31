// Sidebar and section navigation.
import { detailEl } from '../core/dom.js';
import { getUiStateTracking } from '../core/view.js';
import { renderAnalysisSection } from '../analysis/section.js';
import { setDetailBackTo, detailBackToAnalysis } from '../detail/render.js';
import { closeInlineDetail } from './inlinedetail.js';
import { recordView } from './viewstack.js';
import { uiStateSet } from '../identity/prefs.js';
import { ensurePartial } from '../boot/partials.js';
import { definePart, isPart, loadedPart, openPart, warmParts } from '../core/lazy.js';
import { closestEl } from '../core/evt.js';

// ---- Sidebar / hamburger menu / section navigation ----
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const navItems = Array.from(document.querySelectorAll('.nav-item'));
const appSections = {
  help: document.getElementById('section-help'),
  refreshlog: document.getElementById('section-refreshlog'),
  analysis: document.getElementById('section-analysis'),
  strategies: document.getElementById('section-strategies'),
  business: document.getElementById('section-business'),
  news: document.getElementById('section-news'),
  trackrecord: document.getElementById('section-trackrecord'),
  knowledgebase: document.getElementById('section-knowledgebase'),
  settings: document.getElementById('section-settings')
};

// "Alba Securities > Analysis": the page name lives in the top bar, so the big heading above each page is hidden (CSS).
const SECTION_LABELS = { analysis: 'Analysis', strategies: 'Strategies', business: 'Explorer', news: 'News', trackrecord: 'Trade Log', refreshlog: 'Data Refresh', help: 'Help', knowledgebase: 'Knowledge Base', settings: 'Settings' };
function updateTopbarSection(){
  const el = document.getElementById('topbarSection');
  const active = Object.keys(appSections).find(k => appSections[k] && appSections[k].classList.contains('active'));
  if(el && active) el.textContent = SECTION_LABELS[active] || '';
}

function openSidebar(){
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('show');
}
function closeSidebar(){
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('show');
}

// Pages that are only needed sometimes load their code the first time they are opened (core/lazy.js).
definePart('refreshlog', { before: () => ensurePartial(document.getElementById('section-refreshlog')), load: () => import('../sections/refreshlog.js') });
definePart('strategies', { load: () => import('../sections/strategies.js') });
definePart('business', { load: () => import('../sections/business.js') });
definePart('news', { load: () => import('../sections/news.js') });
definePart('trackrecord', { load: () => import('../sections/tradelog.js') });

// A page whose code could not be downloaded: say so in the page, with a way to try again.
function showLoadError(key, e){
  const el = appSections[key]; if(!el) return;
  let box = el.querySelector('.section-load-error');
  if(!box){
    box = document.createElement('div'); box.className = 'section-load-error';
    const msg = document.createElement('span'); msg.className = 'section-load-msg';
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Retry';
    btn.addEventListener('click', () => { box.remove(); showSection(key); });
    box.appendChild(msg); box.appendChild(btn); el.prepend(box);
  }
  box.querySelector('.section-load-msg').textContent = 'Could not load this page: ' + ((e && e.message) || e) + '.';
}

// Switches page at once; resolves when the page's own code is loaded and drawn.
function showSection(key){
  recordView({ s: key });
  closeInlineDetail(false);
  Object.entries(appSections).forEach(([k, el])=>{
    if(el) el.classList.toggle('active', k === key);
  });
  navItems.forEach(btn=> btn.classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.section === key));
  if(getUiStateTracking()) uiStateSet({ section: key }, 300);
  if(key === 'analysis') renderAnalysisSection();
  if(isPart(key)){
    const m = loadedPart(key);
    if(m){ m.render(); return Promise.resolve(); }
    return openPart(key).then(mod => { if(appSections[key].classList.contains('active')) mod.render(); }).catch(e => showLoadError(key, e));
  }
  return ensurePartial(appSections[key]).catch(e => showLoadError(key, e));   // Help and Knowledge Base text is fetched when the page is first opened
}

// Knowledge Base intentionally cross-references specific Help sections (e.g. "see Help §1")
// rather than duplicating that content. Help lives in a different app-section, hidden via
// display:none while inactive, so a plain <a href="#help-f1"> can't jump straight there —
// this switches to Help first, then scrolls to the anchor once it's visible.
const kbSection = document.getElementById('section-knowledgebase');

// Data Refresh page cross-references both Help (e.g. "Help §6") and Knowledge Base (e.g.
// "Knowledge Base §4") sections. Both live in their own app-section, hidden via display:none
// while inactive, so a plain <a href="#help-technical"> or <a href="#kb-technical"> can't jump
// straight there — this switches to the right section first, then scrolls once it's visible.
const refreshlogSection = document.getElementById('section-refreshlog');

// Help links to Knowledge Base sections (e.g. Technical Score -> KB section 4): switch section first, then scroll.
const helpSectionEl = document.getElementById('section-help');

// A link inside one page that points at text in another page (Help, Knowledge Base): switch to that page first, then scroll to the anchor.
// destOf(anchorId) names the page the anchor lives in.
function wireJumpLinks(sectionEl, linkSelector, destOf){
  if(!sectionEl) return;
  sectionEl.addEventListener('click', (e)=>{
    const a = closestEl(e, linkSelector);
    if(!a) return;
    e.preventDefault();
    const targetId = a.getAttribute('href').slice(1);
    showSection(destOf(targetId)).then(()=>{
      closeSidebar();
      requestAnimationFrame(()=>{
        const target = document.getElementById(targetId);
        if(target){ target.scrollIntoView({block:'start'}); }
      });
    });
  });
}

function init_ui_navigation(){
warmParts(['strategies', 'news', 'trackrecord', 'refreshlog']);
// Sections are switched in a few places (menu, links, "Back to ..."), so follow the active class rather than each caller.
const topbarObserver = new MutationObserver(updateTopbarSection);
Object.values(appSections).forEach(el => { if(el) topbarObserver.observe(el, { attributes: true, attributeFilter: ['class'] }); });
updateTopbarSection();
menuToggle.addEventListener('click', ()=>{
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});
sidebarOverlay.addEventListener('click', closeSidebar);
detailEl.addEventListener('click', (e)=>{
  if(closestEl(e, '.detail-back')) detailBackToAnalysis();
});
// Esc is the keyboard shortcut for the "Back to ..." button (not while typing in a box or choosing from a list).
document.addEventListener('keydown', (e)=>{
  if(e.key !== 'Escape' || e.defaultPrevented) return;
  if(e.target && /** @type {Element} */ (e.target).closest && closestEl(e, 'input, textarea, select')) return;
  if(document.querySelector('.alba-confirm')) return;
  if(document.getElementById('detailBackBtn')) detailBackToAnalysis();
});
navItems.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    // Using the menu is a fresh navigation: drop the "Back to Analysis" shortcut.
    setDetailBackTo(null);
    document.querySelectorAll('.detail-back-bar, .detail-back').forEach(b=>b.remove());
    showSection(/** @type {HTMLElement} */ (btn).dataset.section);
    closeSidebar();
  });
});
// The Tools drop-down in the top bar.
const toolsGroup = document.getElementById('navToolsGroup'), toolsToggle = document.getElementById('navToolsToggle');
const setToolsOpen = (open) => { toolsGroup.classList.toggle('open', open); toolsToggle.setAttribute('aria-expanded', String(open)); };
toolsToggle.addEventListener('click', (e)=>{ e.stopPropagation(); setToolsOpen(!toolsGroup.classList.contains('open')); });
document.addEventListener('click', (e)=>{ if(!closestEl(e, '#navToolsGroup')) setToolsOpen(false); });
document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape') setToolsOpen(false); });
toolsGroup.querySelectorAll('.nav-item').forEach(btn=> btn.addEventListener('click', ()=> setToolsOpen(false)));
wireJumpLinks(kbSection, 'a[href^="#help"]', () => 'help');
wireJumpLinks(refreshlogSection, 'a[href^="#help"], a[href^="#kb"]', (id) => id.startsWith('kb') ? 'knowledgebase' : 'help');
wireJumpLinks(helpSectionEl, 'a[href^="#kb"]', () => 'knowledgebase');
}

export { appSections, init_ui_navigation, showSection };
