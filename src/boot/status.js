// What the person sees while the page starts: the loading / error cover, and the "data updated" banner.

// Shows `text` on the cover (#bootStatus in index.html); with isError a Retry button is offered.
function bootMessage(text, isError){
  const el = document.getElementById('bootStatus'); if(!el) return;
  el.hidden = false;
  el.querySelector('.boot-msg').textContent = text;
  el.querySelector('.boot-retry').hidden = !isError;
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
  b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:80;background:var(--panel);color:var(--text);border:1px solid var(--accent);border-radius:10px;padding:10px 14px;font:600 .82rem -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);display:flex;gap:12px;align-items:center;';
  const t = document.createElement('span'); t.textContent = 'Stock data was updated.';
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Reload';
  btn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-weight:700;cursor:pointer;';
  btn.addEventListener('click', () => location.reload());
  b.appendChild(t); b.appendChild(btn); document.body.appendChild(b);
}

export { bootMessage, hideBootMessage, showBootFailure, showUpdateBanner };
