// An in-page confirmation box. The browser's own confirm() pop-up is blocked inside the published page's sandbox (it
// silently answers "no"), so buttons that asked it appeared to do nothing.
function askConfirm(message, okLabel){
  return new Promise((resolve) => {
    const old = document.getElementById('albaConfirm');
    if(old) old.remove();
    const box = document.createElement('div');
    box.id = 'albaConfirm';
    box.className = 'alba-confirm';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = '<div class="alba-confirm-card"><div class="alba-confirm-msg"></div><div class="alba-confirm-btns"><button type="button" class="strat-btn" id="albaConfirmNo">Cancel</button><button type="button" class="strat-btn alba-confirm-ok" id="albaConfirmOk"></button></div></div>';
    box.querySelector('.alba-confirm-msg').textContent = message;
    box.querySelector('#albaConfirmOk').textContent = okLabel || 'OK';
    const done = (v) => { document.removeEventListener('keydown', onKey, true); box.remove(); resolve(v); };
    const onKey = (e) => { if(e.key === 'Escape'){ e.stopPropagation(); done(false); } };
    box.addEventListener('click', (e) => {
      if(e.target.closest('#albaConfirmOk')) done(true);
      else if(e.target.closest('#albaConfirmNo') || e.target === box) done(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(box);
    box.querySelector('#albaConfirmOk').focus();
  });
}

export { askConfirm };
