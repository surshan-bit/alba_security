// Settings > Claude controls: which steps may send data to Claude. Everything is on until it is switched off.
// Read straight from the browser mirror of the saved preference, so a change applies to the very next call.
import { prefSet } from '../identity/prefs.js';

const CLAUDE_CONTROLS_KEY = 'albaDashboard.claudeControls.v1';
const CLAUDE_STEPS = [
  { id: 'missingMetrics', label: 'Fill missing metrics', sub: 'Looks for metrics the screener.in file left blank, in the TradingView data.' },
  { id: 'tradCards', label: 'Write Traditional factor cards', sub: 'Headline and bullets for Financial Health, Profitability, Growth and Valuation. Scores are never changed.' },
  { id: 'buffettCards', label: 'Write Buffett factor cards and re-score Moat and Governance', sub: 'Also the only step that can change a factor score. Without it Moat and Governance stay out of the score.' },
  { id: 'globalMacro', label: 'Write Global & Macro', sub: 'Macro, commodity and policy links, recent news and critical world events for one stock.' },
  { id: 'strengths', label: 'Write Strengths and Watch-outs', sub: 'The summary box at the top of the Fundamental Score panel.' },
  { id: 'newsLabels', label: 'Label news headlines', sub: 'Marks each headline on the price chart positive, negative or neutral.' },
  { id: 'practice', label: 'Strategy practice ideas', sub: 'Asks Claude to suggest rule sets on the Strategies screen.' }
];

function readControls(){
  try { const o = JSON.parse(localStorage.getItem(CLAUDE_CONTROLS_KEY)); return o && typeof o === 'object' ? o : {}; } catch(e){ return {}; }
}
function claudeMasterOn(){ return readControls().all !== false; }
function claudeStepOn(id){ const o = readControls(); return o.all !== false && o[id] !== false; }
// True when at least one step may still use Claude (so the page still asks for Claude access).
function claudeAnyOn(){ return CLAUDE_STEPS.some(s => claudeStepOn(s.id)); }
function setClaudeStep(id, on){
  const o = readControls();
  if(on) delete o[id]; else o[id] = false;
  prefSet(CLAUDE_CONTROLS_KEY, JSON.stringify(o));
}

export { CLAUDE_STEPS, claudeAnyOn, claudeMasterOn, claudeStepOn, setClaudeStep };
