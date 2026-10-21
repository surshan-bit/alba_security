// TradingView connector calls: retries, symbol resolution, bar parsing and validation.
import { isinOf, isinSymbolCached, resolveIsinSymbols } from './isin.js';

// ---- Price and technical refresh from the page (added 2026-10-07) ----
// Pulls weekly and monthly bars straight from the viewer's TradingView connector (the page declares the `mcp`
// capability), validates them, saves them to the priceHistory collection exactly as Part D does, then computes the
// technical block from those bars (computeTechnical above) and saves it to stockUpdates. No Claude run is needed.
// Each connector call takes about 20 s and now and then fails with a TradingView connection error, so every call is
// retried, and stocks are processed two at a time.
const TV_SERVER = 'TradingView';
var tvMcpPromise = null;
function tvMcp(){
  if(!tvMcpPromise) tvMcpPromise = (typeof claude !== 'undefined' && claude && typeof claude.use === 'function') ? claude.use('mcp').catch(() => null) : Promise.resolve(null);
  return tvMcpPromise;
}
const tvSleep = ms => new Promise(r => setTimeout(r, ms));
async function tvCall(tool, input){
  const mcp = await tvMcp();
  if(!mcp) throw Object.assign(new Error('The TradingView connector is not available in this view.'), { code: 'no_mcp' });
  let last;
  for(let attempt = 0; attempt < 4; attempt++){
    try {
      const r = await mcp.callTool(TV_SERVER, tool, input, { cache: false });
      const p = r.payload;
      // The batch and screener tools answer a rate limit or backend error as a normal reply with success=false (no exception), so it is turned into one here.
      if(p && typeof p === 'object' && p.success === false) throw Object.assign(new Error(String(p.error || p.message || (Array.isArray(p.warnings) && p.warnings.join('; ')) || 'TradingView reported a failure')), { code: 'tool_error' });
      return p;
    } catch(e){
      last = e;
      const msg = String(e && e.message);
      const transient = e && !tvIsQuota(e) && (e.retryable || (e.code === 'tool_error' && /tvws|websocket|handshake|timeout|timed out|connection|EOF|reset|unavailable|429|too many|rate.?limit|\b5\d\d\b|backend/i.test(msg)) || e.code === 'server_unavailable');
      if(!transient) throw e;
      await tvSleep((/429|too many|rate.?limit/i.test(msg) ? 4000 : 1500) * (attempt + 1) + Math.random() * 800);
    }
  }
  throw last;
}
// The daily tool-call quota is spent: every further call fails until it resets, so a run should stop rather than try the rest.
function tvIsQuota(e){ return !!e && /quota|exhausted/i.test(String(e.message)); }
// An error after which no further call in this run can work (quota, connector missing or not signed in).
function tvIsFatal(e){ const c = e && e.code; return tvIsQuota(e) || ['no_mcp', 'not_granted', 'capability_disabled', 'not_in_manifest', 'consent_required', 'server_not_connected', 'server_not_found', 'needs_reauth'].includes(c); }
function tvErrorText(e){
  if(tvIsQuota(e)) return 'TradingView tool-call quota is used up (the dashboard\'s own calls are blocked; calls from elsewhere may still work). TradingView says: ' + String(e.message).replace(/^tool_pre_invoke blocked by plugin ToolQuotaPlugin:\s*/i, '').slice(0, 600);
  const c = e && e.code;
  if(c === 'no_mcp' || c === 'not_granted' || c === 'capability_disabled') return 'The TradingView connector is not available in this view.';
  if(c === 'not_in_manifest' || c === 'consent_required') return 'This page is not allowed to use TradingView. Allow it when asked (or in the page permissions) and try again.';
  if(c === 'server_not_connected' || c === 'server_not_found') return 'TradingView is not connected. Add it in claude.ai Settings, Connectors, then try again.';
  if(c === 'needs_reauth') return 'TradingView needs to be reconnected in claude.ai Settings, Connectors.';
  if(c === 'tool_error') { let m = String(e.message || ''); try { const j = JSON.parse(m); m = j.error || m; } catch(_){} return 'TradingView reported: ' + m.slice(0, 140) + ' (tried 4 times).'; }
  return (e && e.message ? String(e.message) : 'Unknown error').slice(0, 160);
}
function tvIstDate(sec){ return new Date(((sec == null ? Date.now() / 1000 : sec) + 19800) * 1000).toISOString().slice(0, 10); }
function tvToRows(p, label){
  const b = p && p.bars;
  if(!b || !Array.isArray(b.t)) throw new Error(label + ': unexpected reply from TradingView');
  const n = b.t.length;
  for(const k of ['o', 'h', 'l', 'c', 'v']) if(!Array.isArray(b[k]) || b[k].length !== n) throw new Error(label + ': bar columns do not line up');
  return b.t.map((t, i) => [t, b.o[i], b.h[i], b.l[i], b.c[i], b.v[i]]);
}
function tvValidate(rows, label){
  if(!rows.length) throw new Error(label + ': no bars returned');
  let prev = -Infinity;
  for(const r of rows){
    if(!r.every(Number.isFinite)) throw new Error(label + ': a bar has a missing number');
    if(r[0] <= prev) throw new Error(label + ': bars are not in ascending order or contain a duplicate');
    prev = r[0];
    const eps = Math.max(1e-4, 1e-6 * Math.abs(r[2]));
    if(r[2] < Math.max(r[1], r[4]) - eps || r[3] > Math.min(r[1], r[4]) + eps) throw new Error(label + ': high/low do not bracket open/close on ' + tvIstDate(r[0]));
    if(r[5] < 0) throw new Error(label + ': negative volume');
  }
}
// Delta merge: keep stored bars before the first fetched bar, append the fetched ones; every CLOSED stored bar that overlaps
// must match within 0.01 % (otherwise a split or adjustment happened and the caller does a full refetch). Returns null on mismatch.
// `bucket` (optional) maps a bar time to its week or month, so a saved bar whose time was only estimated still lines up with the real bar of that period.
function tvMergeDelta(stored, fetched, bucket){
  const key = bucket || (t => t);
  const first = key(fetched[0][0]);
  const byT = new Map(fetched.map(b => [key(b[0]), b]));
  let overlap = 0;
  for(let i = 0; i < stored.length - 1; i++){
    const f = byT.get(key(stored[i][0])); if(!f) continue;
    overlap++;
    for(let j = 1; j <= 4; j++) if(Math.abs(f[j] - stored[i][j]) > 1e-4 * Math.abs(stored[i][j]) + 1e-9) return null;
  }
  if(!overlap) return null;
  return stored.filter(b => key(b[0]) < first).concat(fetched);
}
// The TradingView symbol for a stock, found by its ISIN (see tv/isin.js). A stock with no ISIN or no match is an error, not a guess from its code.
async function tvResolveSymbol(s){
  const missing = await resolveIsinSymbols([s]);
  if(missing.length) throw new Error(s.name + ' has ' + (isinOf(s) ? 'no TradingView match for ISIN ' + isinOf(s) : 'no ISIN (import the Fundamental CSV to add it)') + '.');
  return isinSymbolCached(s);
}

export { TV_SERVER, tvCall, tvErrorText, tvIsFatal, tvIsQuota, tvIstDate, tvMcp, tvMergeDelta, tvResolveSymbol, tvToRows, tvValidate };
