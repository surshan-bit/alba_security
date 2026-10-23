import { prefSet } from '../identity/prefs.js';
// Theme choice.

// ---- Appearance (Dark or Light theme) ----
// A per-viewer display preference, same localStorage convenience as the filters and last-open
// section above. A tiny inline script in <head> applies the saved choice before this main
// script runs, so a Light-theme viewer doesn't see a flash of the dark theme on load.
const THEME_PREF_KEY = 'albaDashboard.theme.v1';
const THEME_CHOICES = new Set(['dark', 'light', 'indigo', 'white']);
const themeToggleBtns = Array.from(document.querySelectorAll('.theme-toggle-btn'));
function saveThemePref(theme){
  prefSet(THEME_PREF_KEY, theme);
}
// The White theme's wordmark uses Quicksand from Google Fonts. No other theme does, so the stylesheet is added only when White is in use
// (as a plain <link> in index.html it held up the first paint of every page).
function ensureBrandFont(){
  if(document.getElementById('brandFont')) return;
  const link = document.createElement('link');
  link.id = 'brandFont'; link.rel = 'stylesheet'; link.href = 'https://fonts.googleapis.com/css2?family=Quicksand:wght@700&display=swap';
  document.head.appendChild(link);
}
function applyTheme(theme){
  const resolved = THEME_CHOICES.has(theme) ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', resolved);
  if(resolved === 'white') ensureBrandFont();
  themeToggleBtns.forEach(btn => btn.classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.themeChoice === resolved));
}

function init_ui_theme(){
themeToggleBtns.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const theme = /** @type {HTMLElement} */ (btn).dataset.themeChoice;
    applyTheme(theme);
    saveThemePref(theme);
  });
});
// Reflect whatever the head script already applied (or default to dark) so the toggle buttons
// show the correct active state even though the head script ran before these buttons existed.
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
}

export { init_ui_theme };
