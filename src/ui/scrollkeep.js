// Background updates (saved prices arriving, a refresh writing results, another device saving) redraw a whole screen. Two rules keep
// that from fighting the viewer:
//  - keepScroll: a redraw that rebuilds a screen's HTML puts every scrolled table, chart and filter row back where it was, so a wide
//    grid scrolled to the right does not jump back to the left.
//  - redrawWhenIdle: a redraw that nobody asked for waits until the viewer has stopped scrolling (and many requests become one), so
//    the screen does not flicker under a finger or a mouse wheel. A user's own click (a filter button) still redraws at once.
const AREAS = ['strat-table-wrap', 'analysis-chart-wrap', 'biz-scroll', 'help-table-wrap', 'filter-group-row', 'analysis-leaderboard'];

function marksIn(root){
  const marks = [];
  for(const cls of AREAS){
    root.querySelectorAll('.' + cls).forEach((el, n) => { if(el.scrollLeft || el.scrollTop) marks.push({ cls, n, left: el.scrollLeft, top: el.scrollTop }); });
  }
  return marks;
}
// Runs `redraw` and then restores the scroll position of every scrolled area inside `root` (matched by kind and order).
function keepScroll(root, redraw){
  if(!root){ redraw(); return; }
  const marks = marksIn(root);
  try { redraw(); }
  finally {
    for(const m of marks){
      const el = root.querySelectorAll('.' + m.cls)[m.n];
      if(el){ el.scrollLeft = m.left; el.scrollTop = m.top; }
    }
  }
}

const IDLE_MS = 350, MAX_WAIT_MS = 5000, SETTLE_MS = 60;
// While the saved data is still arriving (the first seconds after launch) its snapshots come one by one; waiting a little longer turns
// them into one redraw instead of one per snapshot.
const LAUNCH_MS = 12000, LAUNCH_SETTLE_MS = 2500;
const launchedAt = performance.now();
let lastScrollAt = -Infinity, listening = false;   // performance.now() values: a monotonic clock, unaffected by the system clock being changed
const waiting = new Map();   // key -> timer: one redraw per key covers every request made while it waits
function listen(){
  if(listening) return;
  listening = true;
  document.addEventListener('scroll', () => { lastScrollAt = performance.now(); }, { capture: true, passive: true });
}
// Runs `redraw` once the viewer has not scrolled for a moment (at most MAX_WAIT_MS later). Calls with the same key are merged.
function redrawWhenIdle(key, redraw){
  listen();
  if(waiting.has(key)) return;
  const start = performance.now();
  const tick = () => {
    const quiet = performance.now() - lastScrollAt;
    if(quiet < IDLE_MS && performance.now() - start < MAX_WAIT_MS){ waiting.set(key, setTimeout(tick, IDLE_MS - quiet + 20)); return; }
    waiting.delete(key);
    try { redraw(); } catch(e){ console.error('Could not redraw after an update', e); }
  };
  waiting.set(key, setTimeout(tick, performance.now() - launchedAt < LAUNCH_MS ? LAUNCH_SETTLE_MS : SETTLE_MS));
}

export { keepScroll, redrawWhenIdle };
