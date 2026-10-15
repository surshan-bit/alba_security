// The progress panel shared by the Fundamental import, Technical import and watchlist sync: steps, bar, prompt and result.
// Each job has its own copy of the panel in the page (ids carry the prefix: '' = Fundamental, 'ti_' = Technical, 'wl_' = Watchlist);
// setFiPfx picks the one the next calls draw into.
const FI_STEPS = [
  { key: 'read', label: 'Read the uploaded file', w: 3 },
  { key: 'load', label: 'Load the current stock data', w: 25 },
  { key: 'score', label: 'Score every stock', w: 10 },
  { key: 'check', label: 'Run integrity checks', w: 5 },
  { key: 'write', label: 'Write the updated data', w: 52 },
  { key: 'verify', label: 'Verify and finish', w: 5 }
];
let fiCur = null;   // the step list of the job being shown (set by fiReset)
let fiState = null;
let fiPfx = '';   // id prefix of the panel being driven: '' = Fundamental section, 'ti_' = Technical section
const fiEl = id => document.getElementById(fiPfx + id);
function fiReset(title, steps){
  fiCur = steps || FI_STEPS;
  fiState = { title, status: {}, detail: {}, frac: {}, error: null };
  fiCur.forEach(s => { fiState.status[s.key] = 'pending'; fiState.detail[s.key] = ''; fiState.frac[s.key] = 0; });
  const p = fiEl('fundImportPanel'); if(p) p.hidden = false;
  const r = fiEl('fiResult'); if(r){ r.innerHTML = ''; r.className = 'fi-result'; }
  const q = fiEl('fiPrompt'); if(q) q.innerHTML = '';
  fiPaint();
}
function fiSet(key, status, detail, frac){
  if(!fiState) return;
  fiState.status[key] = status;
  if(detail != null) fiState.detail[key] = detail;
  fiState.frac[key] = status === 'done' ? 1 : (frac || 0);
  fiPaint();
}
function fiPaint(){
  if(!fiState) return;
  let pct = 0;
  for(const s of fiCur) pct += s.w * (fiState.status[s.key] === 'done' ? 1 : (fiState.status[s.key] === 'running' ? fiState.frac[s.key] : 0));
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  const fill = fiEl('fiBarFill'), pctEl = fiEl('fiPct'), title = fiEl('fiTitle'), list = fiEl('fiSteps'), bar = fiEl('fiBar');
  if(fill) fill.style.width = pct + '%';
  if(bar) bar.setAttribute('aria-valuenow', String(pct));
  if(pctEl) pctEl.textContent = pct + '%';
  if(title) title.textContent = fiState.title;
  if(fill) fill.classList.toggle('fi-bar-error', !!fiState.error);
  if(!list) return;
  list.textContent = '';
  for(const s of fiCur){
    const li = document.createElement('li'); li.className = 'fi-step fi-' + fiState.status[s.key];
    const mark = document.createElement('span'); mark.className = 'fi-mark';
    mark.textContent = fiState.status[s.key] === 'done' ? '✓' : fiState.status[s.key] === 'error' ? '✕' : fiState.status[s.key] === 'running' ? '…' : '·';
    const lab = document.createElement('span'); lab.className = 'fi-label'; lab.textContent = s.label;
    const det = document.createElement('span'); det.className = 'fi-detail'; det.textContent = fiState.detail[s.key] || '';
    li.appendChild(mark); li.appendChild(lab); li.appendChild(det); list.appendChild(li);
  }
}
function fiAsk(message, okLabel){
  return new Promise(resolve => {
    const host = fiEl('fiPrompt'); if(!host){ resolve(false); return; }
    host.textContent = '';
    const msg = document.createElement('div'); msg.className = 'fi-prompt-msg'; msg.textContent = message;
    const row = document.createElement('div'); row.className = 'fi-prompt-row';
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'select-mode-btn fi-btn-primary'; ok.textContent = okLabel;
    const no = document.createElement('button'); no.type = 'button'; no.className = 'select-mode-btn'; no.textContent = 'Cancel';
    ok.addEventListener('click', () => { host.textContent = ''; resolve(true); });
    no.addEventListener('click', () => { host.textContent = ''; resolve(false); });
    row.appendChild(ok); row.appendChild(no); host.appendChild(msg); host.appendChild(row);
  });
}
function fiShowResult(kind, lines, noReload){
  const r = fiEl('fiResult'); if(!r) return;
  r.textContent = ''; r.className = 'fi-result fi-result-' + kind;
  for(const ln of lines){
    const d = document.createElement('div'); d.className = ln.cls || 'fi-line'; d.textContent = ln.text; r.appendChild(d);
  }
  if(kind === 'ok' && !noReload){
    const b = document.createElement('button'); b.type = 'button'; b.className = 'select-mode-btn fi-btn-primary'; b.textContent = 'Reload dashboard with the new data';
    b.addEventListener('click', () => location.reload()); r.appendChild(b);
  }
}
function getFiState(){ return fiState; }
function setFiPfx(v){ fiPfx = v; }
export { fiAsk, fiEl, fiReset, fiSet, fiShowResult, getFiState, setFiPfx };
