// The user's strategies: loaded from the saved preferences, with a few starter strategies the first time.
// Saved per user through the same preference path as the other settings.
import { FIELD_BY_ID } from './fields.js';
import { DEFAULT_GOAL, cleanGoal } from './goal.js';
import { uiStateGet, uiStateSet } from '../identity/prefs.js';
import { strategiesSave } from '../identity/strategies.js';

const STRATEGIES_KEY = 'albaDashboard.strategies.v1';

const r = (field, op, value) => ({ field, op, value });
const STARTERS = [
  { id: 'starter-quality-momentum', name: 'Quality + Momentum', note: 'Strong fundamentals that are already trending up on both the weekly and monthly view.',
    rules: [r('score', '>=', 7), r('monthRsi', '>=', 50), r('weekRsi', 'between', [50, 70]), r('weekMacd', 'in', ['bull_above', 'bull_below'])] },
  { id: 'starter-turning-up', name: 'Turning up early', note: 'Decent fundamentals where the weekly trend has just turned bullish but the monthly RSI is still low.',
    rules: [r('score', '>=', 6), r('weekMacd', 'in', ['bull_below']), r('weekRsi', '>=', 50), r('monthRsi', '<', 55)] },
  { id: 'starter-pullback', name: 'Pullback in an uptrend', note: 'The monthly trend is strong, but the weekly RSI has cooled off.',
    rules: [r('score', '>=', 6), r('monthMacd', 'in', ['bull_above']), r('monthRsi', '>=', 55), r('weekRsi', 'between', [35, 50])] },
  { id: 'starter-oversold-quality', name: 'Oversold quality', note: 'Strong fundamentals that are cheap and beaten down on the weekly RSI.',
    rules: [r('score', '>=', 7), r('weekRsi', '<=', 35), r('mos', '>=', 0)] },
  { id: 'starter-deep-value', name: 'Value with a cushion', note: 'A wide margin of safety on decent fundamentals, whatever the chart says.',
    rules: [r('score', '>=', 6), r('mos', '>=', 20)] }
];
const starterCopy = () => STARTERS.map(x => ({ ...JSON.parse(JSON.stringify(x)), goal: { ...DEFAULT_GOAL }, learned: '', published: true }));

function cleanRule(x){
  if(!x || !FIELD_BY_ID.has(x.field) || typeof x.op !== 'string') return null;
  return { field: x.field, op: x.op, value: x.value === undefined ? null : x.value };
}
function loadStrategies(){
  try {
    const raw = localStorage.getItem(STRATEGIES_KEY);
    if(!raw) return starterCopy();
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return starterCopy();
    return parsed.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string').map(p => ({
      id: p.id, name: p.name, note: typeof p.note === 'string' ? p.note : '', goal: cleanGoal(p.goal), learned: typeof p.learned === 'string' ? p.learned : '', published: p.published !== false,
      rules: (Array.isArray(p.rules) ? p.rules : []).map(cleanRule).filter(Boolean)
    }));
  } catch(e){ return starterCopy(); }
}

const strategies = loadStrategies();
// Only published strategies show in Explorer, Analysis and the other screens that offer a strategy; the Strategies screen lists all.
const publishedStrategies = () => strategies.filter(x => x.published);
let edited = false;   // true once this page has changed a strategy (a late-arriving saved copy must not overwrite that)
function saveStrategies(){ edited = true; strategiesSave(JSON.stringify(strategies)); }
// The saved copy can arrive after the page has started (slow connection): swap it in if nothing has been changed yet.
window.addEventListener('alba-strategies-synced', () => {
  if(edited) return;
  strategies.splice(0, strategies.length, ...loadStrategies());
  window.dispatchEvent(new Event('alba-strategies-reloaded'));
});

function newStrategyId(){ return 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function strategyById(id){ return strategies.find(x => x.id === id) || null; }
let selectedId = uiStateGet().stratSel || null;
function selectedStrategy(){ return strategyById(selectedId) || strategies[0] || null; }
function selectStrategy(id){ selectedId = id; uiStateSet({ stratSel: id }, 300); }

function addStrategy(){
  const s = { id: newStrategyId(), name: 'New strategy', note: '', goal: { ...DEFAULT_GOAL }, learned: '', published: false, rules: [] };
  strategies.push(s); saveStrategies(); selectStrategy(s.id);
  return s;
}
function duplicateStrategy(s){
  const c = { id: newStrategyId(), name: s.name + ' (copy)', note: s.note, goal: { ...s.goal }, learned: s.learned, published: false, rules: JSON.parse(JSON.stringify(s.rules)) };
  strategies.push(c); saveStrategies(); selectStrategy(c.id);
  return c;
}
function deleteStrategy(s){
  const i = strategies.indexOf(s);
  if(i >= 0) strategies.splice(i, 1);
  saveStrategies();
  if(strategies[0]) selectStrategy(strategies[Math.min(i, strategies.length - 1)].id);
}
// Put back the starter strategies, keeping any strategy of your own.
function restoreStarters(){
  const mine = strategies.filter(x => !x.id.startsWith('starter-'));
  strategies.splice(0, strategies.length, ...starterCopy(), ...mine);
  saveStrategies(); selectStrategy(strategies[0].id);
}

export { addStrategy, deleteStrategy, duplicateStrategy, publishedStrategies, restoreStarters, saveStrategies, selectStrategy, selectedStrategy, strategies };
