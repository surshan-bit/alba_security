// Parts of the app that load the first time they are opened (in the built page each is its own file, fetched on demand).
//
// A part is a module with two functions:
//   init()    wires the part's page; runs once, after the module (and the page text it needs) has loaded
//   render()  draws the part's page from the current data; runs every time the page is opened
// Code that learns of new data while the part may not have loaded yet calls renderLoadedPart(): it redraws the page if the
// part is there and does nothing otherwise (opening the page later draws it from the same data).

const parts = new Map();   // key -> { load, before, module, promise, fetched }

// spec.load: () => import('...')  (the part's module)      spec.before: optional () => Promise, run before the module loads
function definePart(key, spec){ parts.set(key, { load: spec.load, before: spec.before || null, module: null, promise: null, fetched: null }); }
function isPart(key){ return parts.has(key); }
function loadedPart(key){ const p = parts.get(key); return p ? p.module : null; }

// Downloads the part's code (and the page text it needs) once, without starting it. A failed download can be tried again.
function fetchPart(p){
  if(!p.fetched) p.fetched = Promise.resolve(p.before ? p.before() : null).then(() => p.load()).catch(e => { p.fetched = null; throw e; });
  return p.fetched;
}
// Loads the part once and resolves with its module. A failed load can be tried again by calling this again.
function openPart(key){
  const p = parts.get(key);
  if(!p) return Promise.reject(new Error('unknown part ' + key));
  if(!p.promise){
    p.promise = fetchPart(p).then(m => { m.init(); p.module = m; return m; })
      .catch(e => { p.promise = null; throw e; });
  }
  return p.promise;
}
// v1.323: downloads the parts' code one after another while the page is idle, so the first visit to each page draws at once, like every later visit,
// instead of showing it blank or as "Loading…" until the download ends (which looked like flicker). Only downloads: nothing starts until the page is opened.
function warmParts(keys){
  const queue = keys.filter(k => parts.has(k)), idle = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 4000 }) : (fn) => setTimeout(fn, 1500);
  const next = () => {
    const key = queue.shift(); if(!key) return;
    const p = parts.get(key);
    (p.module ? Promise.resolve() : fetchPart(p)).catch(() => {}).then(() => idle(next));   // a failure is retried when the page is opened
  };
  idle(next);
}
function renderLoadedPart(key){
  const m = loadedPart(key);
  if(m) m.render();
}

export { definePart, isPart, loadedPart, openPart, renderLoadedPart, warmParts };
