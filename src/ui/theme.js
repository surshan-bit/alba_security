import { prefSet } from '../identity/prefs.js';
// Theme choice.

// ---- Appearance (Dark or Light theme) ----
// A per-viewer display preference, same localStorage convenience as the filters and last-open
// section above. A tiny inline script in <head> applies the saved choice before this main
// script runs, so a Light-theme viewer doesn't see a flash of the dark theme on load.
const THEME_PREF_KEY = 'albaDashboard.theme.v1';
const THEME_CHOICES = new Set(['dark', 'light', 'indigo']);
const themeToggleBtns = Array.from(document.querySelectorAll('.theme-toggle-btn'));
function saveThemePref(theme){
  prefSet(THEME_PREF_KEY, theme);
}
function applyTheme(theme){
  const resolved = THEME_CHOICES.has(theme) ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', resolved);
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
