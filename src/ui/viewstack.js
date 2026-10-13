// Browser history for the app's own navigation: every page switch and every opened stock is one history entry, so the
// browser's Back and Forward buttons retrace the same route. The entries hold only a small description of the view;
// historyrestore.js knows how to show one. No imports, so any module can record a view.
let current = null, pending = null, restoring = false, ready = false, restorer = null;
const same = (a, b) => !!a && !!b && a.s === b.s && (a.t || null) === (b.t || null) && (a.i || null) === (b.i || null);

function flush(){
  const v = pending; pending = null;
  if(!v || restoring || !ready) return;
  try {
    if(same(v, current)){ history.replaceState({ alba: v }, ''); }
    else { history.pushState({ alba: v }, ''); }
    current = v;
  } catch(e){ /* history unavailable: Back simply leaves the app as before */ }
}
// view: { s: page key, t: stock ticker (optional), i: label of the page it was opened from (optional) }.
// Several records in the same moment (a page switch followed by opening a stock) become one entry.
function recordView(view){
  if(restoring || !ready) return;
  const first = !pending;
  pending = view;
  if(first) Promise.resolve().then(flush);
}

function setViewRestorer(fn){ restorer = fn; }
function init_ui_viewstack(startView){
  try {
    current = startView; history.replaceState({ alba: startView }, '');
    window.addEventListener('popstate', (e) => {
      const v = e.state && e.state.alba;
      if(!v || !restorer) return;
      restoring = true;
      try { restorer(v, current); } finally { restoring = false; }
      current = v;
    });
    ready = true;
  } catch(e){ ready = false; }
}

export { init_ui_viewstack, recordView, setViewRestorer };
