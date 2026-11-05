// Live Data Refresh: Claude access, errors and JSON replies.
import { tvErrorText } from '../tv/connector.js';

// Error text. TradingView errors carry the connector codes, Claude errors the sample codes; ldAskJson marks a failed Claude call
// with fromClaude, which is how the two are told apart.
function ldIsClaudeError(e){ return !!(e && e.fromClaude); }
function ldErrText(e){
  const c = e && e.code;
  if(ldIsClaudeError(e)){
    if(c === 'not_granted') return 'Asking Claude was not allowed for this page. Allow it when asked, then try again.';
    if(c === 'sampling_disabled' || c === 'capability_disabled' || c === 'not_declared' || c === 'capability_removed') return 'Asking Claude from this page is not available for this account.';
    if(c === 'rate_limited') return 'Your Claude usage limit was reached. Try again later.';
    if(c === 'invalid_json') return 'Claude\'s reply could not be read as data. Try again.';
    if(c === 'session_expired') return 'Please sign in again.';
    if(c === 'prompt_too_large') return 'The data for this stock was too large to send. Try again later.';
    // Any other Claude error: show what the runtime said, with its code, so it can be diagnosed.
    return (e && e.message ? String(e.message) : 'Unknown error').slice(0, 150) + (c ? ' [' + c + ']' : '');
  }
  return tvErrorText(e);
}

// Asks the viewer for the page's Claude permission up front (one dialog), instead of leaving it to the first call.
// A denial is final for the page load; the call below then reports it and the "Open permissions" button appears.
async function ldEnsureClaudeAccess(){
  const perms = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? await claude.use('permissions').catch(() => null) : null;
  if(!perms) return;
  let st = null;
  try { st = await perms.state('sample'); } catch(e){ /* permission state unknown: asked for below */ }
  if(st == null || st === 'granted' || st === 'unavailable') return;
  try { await perms.request(['sample']); } catch(e){ /* the person can still allow it from the page */ }
}

// Asks Claude for one JSON value. Works with the current call style, sample(prompt, options), and falls back to the older
// sample({prompt, ...options}) style when the runtime rejects the first as malformed. The reply is parsed here, so it does
// not depend on sample.json existing.
function ldParseJson(text){
  const t = String(text || '').trim();
  const tryParse = x => { try { return { v: JSON.parse(x) }; } catch(e){ return null; } };
  let r = tryParse(t); if(r) return r.v;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence){ r = tryParse(fence[1].trim()); if(r) return r.v; }
  const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if(a >= 0 && b > a){ r = tryParse(t.slice(a, b + 1)); if(r) return r.v; }
  throw { code: 'invalid_json', message: 'The reply held no JSON value.', text: t };
}
async function ldAskJson(sample, prompt, opts){
  const textOf = r => (r && typeof r === 'object' && 'text' in r) ? r.text : r;
  let reply;
  const fromClaude = e => { if(e && typeof e === 'object') e.fromClaude = true; return e; };
  try {
    try { reply = await sample(prompt, opts); }
    catch(e){
      if(e && e.code === 'invalid_request') reply = await sample(Object.assign({ prompt }, opts));
      else throw e;
    }
    return ldParseJson(textOf(reply));
  } catch(e){ throw fromClaude(e); }
}

export { ldIsClaudeError, ldAskJson, ldEnsureClaudeAccess, ldErrText };
