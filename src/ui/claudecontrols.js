import { CLAUDE_STEPS, claudeMasterOn, claudeStepOn, setClaudeStep } from '../livedata/claudegate.js';
// Settings > Claude controls: one switch per step that sends data to Claude, and a master switch.

function row(id, title, sub, on, disabled){
  const lab = document.createElement('label');
  lab.className = 'settings-row claude-ctl-row';
  lab.innerHTML = '<div class="settings-row-text"><div class="settings-row-title"></div><div class="settings-row-sub"></div></div>' +
    '<input type="checkbox" class="claude-ctl-box" data-claude-step="' + id + '" aria-label="' + title.replace(/"/g, '&quot;') + '">';
  lab.querySelector('.settings-row-title').textContent = title;
  lab.querySelector('.settings-row-sub').textContent = sub;
  const box = /** @type {HTMLInputElement} */ (lab.querySelector('input'));
  box.checked = on; box.disabled = disabled;
  return lab;
}

function init_ui_claudecontrols(){
  const host = document.getElementById('claudeControls');
  if(!host) return;
  const paint = () => {
    const master = claudeMasterOn();
    host.textContent = '';
    host.appendChild(row('all', 'Allow Claude', 'Master switch. Off sends nothing to Claude from this page. TradingView data and the CSV import are not affected.', master, false));
    CLAUDE_STEPS.forEach(s => host.appendChild(row(s.id, s.label, s.sub, claudeStepOn(s.id), !master)));
  };
  host.addEventListener('change', e => {
    const box = /** @type {HTMLInputElement} */ (e.target);
    const id = box && box.dataset ? box.dataset.claudeStep : '';
    if(!id) return;
    setClaudeStep(id, box.checked);
    paint();
  });
  paint();
}

export { init_ui_claudecontrols };
