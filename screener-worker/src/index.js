// alba-screener: a small remote MCP server (Streamable HTTP, JSON replies only) that returns the Alba fundamental score's input fields for
// a list of stocks, read from the signed-in Screener.in account's peer-comparison table. Built for the Workers free plan: at most
// BATCH_MAX stocks per call (about 2 requests to Screener per stock, and the plan allows 50 outgoing requests per call), so a caller
// asks again with the `remaining` list until it is empty.
//
// Secrets (Cloudflare dashboard > the Worker > Settings > Variables and Secrets):
//   MCP_TOKEN                        long random text; the connector address is  https://<worker>/mcp/<MCP_TOKEN>
//   SCREENER_SESSIONID               the sessionid cookie of a signed-in Screener browser session (preferred), or
//   SCREENER_USERNAME + SCREENER_PASSWORD
import { Screener } from './screener.js';

const PROTOCOL = '2025-06-18';
const DEFAULT_BATCH = 20;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const rpcError = (id, code, message) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export const TOOLS = [
  { name: 'fundamentals_batch', description: 'Fundamental score input fields (about 38 numbers each) for NSE symbols or BSE codes, from the Screener.in peer-comparison table. Handles at most batch_max symbols per call and returns `remaining` for the rest.',
    inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'NSE tickers or BSE codes' } }, required: ['symbols'] } },
  { name: 'diagnose', description: 'Raw peer-table headings and the company row for one symbol, to check which Screener columns the account returns.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
];

function authorised(request, env){
  const url = new URL(request.url);
  const want = String(env.MCP_TOKEN || '');
  if(want.length < 16) return false;
  const got = url.pathname.startsWith('/mcp/') ? decodeURIComponent(url.pathname.slice(5)) : (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if(got.length !== want.length) return false;
  let diff = 0;
  for(let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export async function callTool(name, args, env, opts = {}){
  const sc = new Screener(env, opts);
  if(name === 'diagnose'){
    await sc.login();
    const r = await sc.company(String(args.symbol || ''));
    return r;
  }
  if(name === 'fundamentals_batch'){
    const max = Math.max(1, Math.min(Number(env.BATCH_MAX) || DEFAULT_BATCH, 24));
    const all = (Array.isArray(args.symbols) ? args.symbols : []).map(s => String(s).trim()).filter(Boolean);
    const todo = all.slice(0, max), remaining = all.slice(max);
    await sc.login();
    const results = [];
    for(const s of todo){
      try { results.push(await sc.company(s)); }
      catch(e){ results.push({ sym: s.toUpperCase(), ok: false, error: String((e && e.message) || e).slice(0, 120) }); }
    }
    const unmatched = [...new Set(results.flatMap(r => r.unmatched || []))];
    return { batch_max: max, processed: todo.length, remaining, results, unmatched_headings: unmatched, screener_requests: sc.requests };
  }
  throw new Error('Unknown tool ' + name);
}

export async function handle(request, env, opts = {}){
  const url = new URL(request.url);
  if(request.method === 'GET' && url.pathname === '/') return new Response('alba-screener is running', { status: 200 });
  if(!url.pathname.startsWith('/mcp')) return new Response('Not found', { status: 404 });
  if(!authorised(request, env)) return new Response('Unauthorized', { status: 401 });
  if(request.method !== 'POST') return new Response('Use POST', { status: 405, headers: { Allow: 'POST' } });
  let msg;
  try { msg = await request.json(); } catch(e){ return rpcError(null, -32700, 'Parse error'); }
  if(Array.isArray(msg)) return rpcError(null, -32600, 'Batches are not supported');
  const { id, method, params } = msg || {};
  if(id === undefined) return new Response(null, { status: 202 });   // notifications (initialized, cancelled ...)
  switch(method){
    case 'initialize': return json({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'alba-screener', version: '1.0.0' } } });
    case 'ping': return json({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list': return json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call': {
      try {
        const out = await callTool(params && params.name, (params && params.arguments) || {}, env, opts);
        return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
      } catch(e){
        return json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] } });
      }
    }
    default: return rpcError(id, -32601, 'Method not found: ' + method);
  }
}

export default { fetch: (request, env) => handle(request, env) };
