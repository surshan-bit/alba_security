// "Standard practice" rule sets: asks Claude (live, on the viewer's account) for well-known screening approaches for a
// short, medium or long holding period, written with the fields a strategy can use. Claude cannot browse, so this is its
// own knowledge of common practice, not a web search. Every rule is checked here before it is shown.
import { escapeHtml } from '../core/util.js';
import { stocks } from '../core/stocks.js';
import { ldAskJson, ldEnsureClaudeAccess, ldErrText } from '../livedata/claude.js';
import { claudeStepOn } from '../livedata/claudegate.js';
import { FIELDS, FIELD_BY_ID } from './fields.js';
import { OPS, describeRule, qualifyingStocks } from './rules.js';
import { saveStrategies } from './state.js';

const HORIZONS = {
  short: { label: 'Short term', span: 'a few days to about 6 weeks', style: 'momentum and technical set-ups (RSI, weekly and monthly trend, recent price change), with only a light quality filter' },
  medium: { label: 'Medium term', span: 'about 3 to 12 months', style: 'a balance: sound fundamentals and a margin of safety, with the weekly and monthly trend turning or already up' },
  long: { label: 'Long term', span: '3 years or more', style: 'quality and value: financial health, profitability, growth, moat, governance, a positive margin of safety; the technical trend matters little' }
};
const SKIP = new Set(['industry', 'pinned', 'price', 'researchAge', 'resultsAge', 'corpAge', 'newsPos', 'newsNeg', 'newsAll']);
const results = new Map();   // horizon -> { sets } | { error }
const running = new Set();

function fieldGuide(){
  return FIELDS.filter(f => !SKIP.has(f.id)).map(f => {
    if(f.type === 'enum') return `- ${f.id} (${f.label}): choice, op "in", value = list of ids from [${f.options.map(o => o[0] + '=' + o[1]).join(', ')}]${f.noneLabel ? ", plus 'none' for no rating" : ''}`;
    return `- ${f.id} (${f.label}): number${f.unit ? ' in ' + f.unit.trim() : ''}, op one of >=, <=, >, <, between (value [low, high])`;
  }).join('\n');
}
function promptFor(key){
  const h = HORIZONS[key];
  return `You help an investor who screens Indian listed stocks. Give 4 well-known, different screening approaches that practitioners use for a ${h.label.toLowerCase()} holding (${h.span}), centred on ${h.style}.
Write each approach ONLY with these fields (use the ids exactly; 3 to 6 rules each; sensible thresholds; the fundamental score and factors are 0-10, RSI is 0-100):
${fieldGuide()}
Reply with only a JSON array of 4 objects: {"name": short name of the approach, "why": one plain sentence on the idea behind it, "rules": [{"field": id, "op": operator, "value": number | [low, high] | [ids]}]}.`;
}
// Keep only rules that are valid for their field; an approach needs at least 2 valid rules.
function cleanSet(raw){
  if(!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) return null;
  const rules = [];
  raw.rules.forEach(r => {
    const f = r && FIELD_BY_ID.get(r.field);
    if(!f || SKIP.has(f.id)) return;
    if(f.type === 'enum'){
      if(!Array.isArray(r.value)) return;
      const ok = new Set(f.options.map(o => o[0])); if(f.noneLabel) ok.add('none');
      const v = [...new Set(r.value.filter(x => ok.has(x)))];
      if(v.length) rules.push({ field: f.id, op: 'in', value: v });
    } else if(f.type === 'num'){
      const num = (x) => (typeof x === 'number' && isFinite(x));
      if(r.op === 'between' && Array.isArray(r.value) && num(r.value[0]) && num(r.value[1])) rules.push({ field: f.id, op: 'between', value: [r.value[0], r.value[1]] });
      else if(['>=', '<=', '>', '<'].includes(r.op) && OPS.num.some(o => o[0] === r.op) && num(r.value)) rules.push({ field: f.id, op: r.op, value: r.value });
    }
  });
  if(rules.length < 2) return null;
  return { name: String(raw.name || 'Approach').slice(0, 60), why: String(raw.why || '').slice(0, 240), rules, now: qualifyingStocks(stocks, rules).length };
}

async function runPractice(key, done, refresh){
  if(running.has(key)) return;
  running.add(key); done();
  try {
    if(!claudeStepOn('practice')){ results.set(key, { error: 'Strategy practice ideas are turned off in Settings > Claude controls.' }); return; }
    await ldEnsureClaudeAccess();
    const sample = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('sample').catch(() => null) : null;
    if(!sample) throw { fromClaude: true, code: 'not_declared', message: 'Claude is not available here.' };
    const arr = await ldAskJson(sample, promptFor(key), { cache: refresh ? { gcTime: 3600000, refresh: true } : { gcTime: 3600000 } });
    const sets = (Array.isArray(arr) ? arr : []).map(cleanSet).filter(Boolean);
    results.set(key, sets.length ? { sets } : { error: 'Claude\'s reply had no usable rules. Try again.' });
  } catch(e){
    results.set(key, { error: ldErrText(e) });
  } finally { running.delete(key); done(); }
}

function practiceHtml(key){
  const h = HORIZONS[key];
  if(running.has(key)) return `<div class="learn-status">Asking Claude for common ${h.label.toLowerCase()} approaches&hellip;</div>`;
  const r = results.get(key);
  if(!r) return '';
  if(r.error) return `<div class="learn-status">${escapeHtml(r.error)}</div><button type="button" class="strat-btn pr-ask" data-h="${key}">Try again</button>`;
  const cards = r.sets.map((s, k) => `<div class="learn-card learn-ok">
      <div class="pr-name">${escapeHtml(s.name)}</div>
      ${s.why ? `<div class="learn-sub pr-why">${escapeHtml(s.why)}</div>` : ''}
      <ul class="learn-rules">${s.rules.map(x => `<li>${escapeHtml(describeRule(x))}</li>`).join('')}</ul>
      <div class="learn-stats"><span><b>${s.now}</b> stock${s.now === 1 ? '' : 's'} qualify today</span></div>
      <button type="button" class="strat-btn learn-apply" data-pr="${key}" data-k="${k}">Use these rules</button>
    </div>`).join('');
  return `<div class="learn-meta">Common ${h.label.toLowerCase()} approaches (${h.span}), asked from Claude just now. They are starting points from general practice, not advice, and Claude cannot browse the web. Using one replaces this strategy's rules.</div>
    <div class="learn-cards">${cards}</div>
    <button type="button" class="strat-btn pr-ask" data-h="${key}" data-refresh="1">Ask again</button>`;
}
function hasPractice(key){ return results.has(key); }

function applyPractice(st, key, k){
  const r = results.get(key);
  if(!r || !r.sets || !r.sets[k]) return false;
  const s = r.sets[k];
  st.rules = JSON.parse(JSON.stringify(s.rules));
  st.learned = `${HORIZONS[key].label} approach "${s.name}"${s.why ? ': ' + s.why : '.'}`;
  saveStrategies();
  return true;
}

export { HORIZONS, applyPractice, hasPractice, practiceHtml, runPractice };
