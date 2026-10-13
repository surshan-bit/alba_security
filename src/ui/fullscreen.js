// Full screen for the big grids (the Analysis leaderboard and the Explorer table). Each screen keeps its own "full" state and layout;
// this asks the browser for its own full screen too (a page inside claude.ai may not be allowed it, and the window-filling layout works
// either way) and tells every screen to leave full screen when Esc is pressed or the browser leaves it.
const watchers = [];
function browserFullscreen(on){
  try {
    if(on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    else if(!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  } catch(e){ /* the layout alone is enough */ }
}
// The text of a screen's full-screen button.
const fullscreenLabel = (on) => on ? 'Exit full screen' : 'Full screen';
// `isOn()` says whether the screen is in full screen; `leave()` takes it out.
function watchFullscreenExit(isOn, leave){ watchers.push({ isOn, leave }); }
function init_ui_fullscreen(){
  const leaveAll = () => watchers.forEach(w => { if(w.isOn()) w.leave(); });
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape') leaveAll(); });
  document.addEventListener('fullscreenchange', () => { if(!document.fullscreenElement) leaveAll(); });
}

export { browserFullscreen, fullscreenLabel, init_ui_fullscreen, watchFullscreenExit };
