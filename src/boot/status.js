// What the person sees while the page starts: the loading / error cover, and the "data updated" banner.

// The cover's Retry button reloads the page. It is wired from code, not an inline handler, and boot() does it first, before anything can fail.
function wireBootRetry(){
  const btn = document.querySelector('#bootStatus .boot-retry');
  if(btn) btn.addEventListener('click', () => location.reload());
}

// Shows `text` on the cover (#bootStatus in index.html); with isError a Retry button is offered.
function bootMessage(text, isError){
  const el = document.getElementById('bootStatus'); if(!el) return;
  el.hidden = false;
  el.querySelector('.boot-msg').textContent = text;
  /** @type {HTMLElement} */ (el.querySelector('.boot-retry')).hidden = !isError;
  el.classList.toggle('boot-error', !!isError);
}
function hideBootMessage(){
  const el = document.getElementById('bootStatus'); if(el) el.hidden = true;
}
// The start-up sequence failed. A more specific "Could not load the stock data" message already on the cover is kept.
function showBootFailure(e){
  const el = document.getElementById('bootStatus'), m = document.querySelector('#bootStatus .boot-msg');
  if(el && m && !/Could not load the stock data/.test(m.textContent)){ el.hidden = false; m.textContent = 'Could not start the dashboard: ' + ((e && e.message) || e) + '.'; }
}
// Shown (once) when somebody publishes new stock data while this page is open.
function showUpdateBanner(){
  if(document.getElementById('dataUpdateBanner')) return;
  const b = document.createElement('div');
  b.id = 'dataUpdateBanner';
  b.className = 'toast-banner';
  const t = document.createElement('span'); t.textContent = 'Stock data was updated.';
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Reload';
  btn.className = 'toast-banner__btn';
  btn.addEventListener('click', () => location.reload());
  b.appendChild(t); b.appendChild(btn); document.body.appendChild(b);
}

export { bootMessage, hideBootMessage, showBootFailure, showUpdateBanner, wireBootRetry };
