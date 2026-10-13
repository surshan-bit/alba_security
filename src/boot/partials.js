// Static page text (Help, Data Refresh, Knowledge Base) lives in partials/*.html and is filled into the empty
// <section data-partial="..."> elements. A section that already has content (or was already loaded) is left alone.

const loading = new WeakMap();   // section element -> the load in progress

async function fetchPartial(file){
  const r = await fetch(file);
  if(!r.ok) throw new Error('could not load ' + file + ' (' + r.status + ')');
  return r.text();
}

// Loads the partial of one section element; resolves when its content is in place. A failed load can be retried.
function ensurePartial(el){
  if(!el || !el.dataset.partial || el.dataset.partialLoaded || el.innerHTML.trim()) return Promise.resolve();
  if(!loading.has(el)){
    loading.set(el, fetchPartial(el.dataset.partial).then(text => {
      el.innerHTML = text; el.dataset.partialLoaded = '1';
    }).finally(() => { loading.delete(el); }));
  }
  return loading.get(el);
}

export { ensurePartial };
