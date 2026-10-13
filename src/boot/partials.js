// Static page text (Help, Data Refresh, Knowledge Base) lives in partials/*.html and is filled into the empty
// <section data-partial="..."> elements. A section that already has content (or was already loaded) is left alone.

// The progress panel of an import or sync job: one template for all three (ids carry the job's prefix).
function importPanelHtml(pfx, title, label, backups){
  return '<div class="upload-panel fi-panel" id="' + pfx + 'fundImportPanel" hidden aria-live="polite">' +
    '<div class="fi-head"><div class="upload-title" id="' + pfx + 'fiTitle">' + title + '</div><div class="fi-pct" id="' + pfx + 'fiPct">0%</div></div>' +
    '<div class="fi-bar" id="' + pfx + 'fiBar" role="progressbar" aria-label="' + label + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fi-bar-fill" id="' + pfx + 'fiBarFill"></div></div>' +
    '<ol class="fi-steps" id="' + pfx + 'fiSteps"></ol><div id="' + pfx + 'fiPrompt"></div><div class="fi-result" id="' + pfx + 'fiResult"></div></div>' +
    (backups ? '<div class="upload-panel" id="' + pfx + 'fiBackups" hidden aria-live="polite"></div>' : '');
}
function fillImportPanels(root){
  root.querySelectorAll('[data-import-panel]').forEach(h => {
    const d = h.dataset;
    h.outerHTML = importPanelHtml(d.importPanel, d.title, d.label, 'backups' in d);
  });
}

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
      el.innerHTML = text; fillImportPanels(el); el.dataset.partialLoaded = '1';
    }).finally(() => { loading.delete(el); }));
  }
  return loading.get(el);
}

export { ensurePartial };
