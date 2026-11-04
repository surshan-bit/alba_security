// The "also import daily data for a strategy" choice in the Refresh all stocks panel (partials/refreshlog.html): a tick box and, once ticked, a strategy to pick.
// The choice is remembered in this browser (a per-viewer convenience: without storage it simply starts unticked).
import { strategies } from '../strategies/state.js';
import { ruleReady } from '../strategies/rules.js';

const KEY = 'albaDailyImport';
const byId = id => document.getElementById(id);
const parts = () => ({ box: /** @type {HTMLInputElement | null} */ (byId('tvDailyOn')), sel: /** @type {HTMLSelectElement | null} */ (byId('tvDailyStrategy')), pick: byId('tvDailyPick') });

function savedChoice(){
  try { return JSON.parse(window.localStorage.getItem(KEY) || '{}') || {}; } catch(e){ return {}; }   // no storage or unreadable: start unticked
}
function rememberChoice(){
  const { box, sel } = parts();
  if(!box || !sel) return;
  try { window.localStorage.setItem(KEY, JSON.stringify({ on: box.checked, strategyId: sel.value })); } catch(e){ /* storage is optional: the choice just is not remembered */ }
}

// Fills the strategy list (the strategies that have a rule to run); the strategy picked now stays picked, and the picker shows only while the box is ticked.
function fillStrategies(){
  const { box, sel, pick } = parts();
  if(!box || !sel || !pick) return;
  const keep = sel.value || savedChoice().strategyId;
  sel.textContent = '';
  const usable = strategies.filter(st => st.rules.some(ruleReady));
  usable.forEach(st => { const o = document.createElement('option'); o.value = st.id; o.textContent = st.name; sel.appendChild(o); });
  if(usable.some(st => st.id === keep)) sel.value = keep;
  box.disabled = !usable.length;
  if(box.disabled) box.checked = false;
  pick.hidden = !box.checked;
}

function wireDailyPicker(){
  const { box, sel } = parts();
  if(!box || !sel) return;
  fillStrategies();
  box.checked = !!savedChoice().on && !box.disabled;
  fillStrategies();
  box.addEventListener('change', () => { fillStrategies(); rememberChoice(); });
  sel.addEventListener('change', rememberChoice);
  sel.addEventListener('focus', fillStrategies);   // strategies made since the page opened are in the list
  window.addEventListener('alba-strategies-reloaded', fillStrategies);
}

// The choice for the run that starts now: { strategyId }, or null when daily data was not asked for.
function dailyChoice(){
  const { box, sel } = parts();
  return box && sel && box.checked && sel.value ? { strategyId: sel.value } : null;
}

export { dailyChoice, wireDailyPicker };
