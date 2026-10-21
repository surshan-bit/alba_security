// alba-tv-gateway (spike): proves a Worker can sign in to the TradingView MCP server and call a tool for the owner.
//   GET /                       status
//   GET /tv/connect?key=...     start the TradingView sign-in (owner only)
//   GET /tv/callback            TradingView sends the browser back here
//   GET /tv/tools?key=...       tools/list
//   GET /tv/search?q=...&key=.. calls mcp-tv-search-symbols
// Secret: SPIKE_KEY (at least 16 characters). Storage: the KV namespace TV_KV. Var: TV_MCP_URL.
import { startAuthorize, finishAuthorize, accessToken } from './oauth.js';
import { mcpCall } from './mcp.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

function owner(url, env){
  const want = String(env.SPIKE_KEY || ''), got = url.searchParams.get('key') || '';
  if(want.length < 16 || got.length !== want.length) return false;
  let d = 0;
  for(let i = 0; i < want.length; i++) d |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return d === 0;
}

export async function handle(request, env, f = fetch){
  const url = new URL(request.url);
  const mcpUrl = env.TV_MCP_URL || 'https://mcp.tradingview.com/mcp';
  try {
    if(url.pathname === '/') return new Response('alba-tv-gateway spike is running');
    if(url.pathname === '/tv/callback'){
      // Only a sign-in this Worker started can finish: the state value was stored by /tv/connect.
      if(url.searchParams.get('error')) return json({ ok: false, error: url.searchParams.get('error'), detail: url.searchParams.get('error_description') }, 400);
      await finishAuthorize(env, url.searchParams.get('code') || '', url.searchParams.get('state') || '', f);
      return json({ ok: true, connected: true });
    }
    if(!owner(url, env)) return new Response('Unauthorized', { status: 401 });
    if(url.pathname === '/tv/connect') return Response.redirect(await startAuthorize(env, mcpUrl, url.origin + '/tv/callback', f), 302);
    const token = await accessToken(env, f);
    if(!token) return json({ ok: false, error: 'Not connected: open /tv/connect first' }, 409);
    if(url.pathname === '/tv/tools'){
      const r = await mcpCall(mcpUrl, token, 'tools/list', {}, f);
      return json({ ok: true, tools: (r.tools || []).map(t => t.name) });
    }
    if(url.pathname === '/tv/search'){
      const q = url.searchParams.get('q') || '';
      if(!q) return json({ ok: false, error: 'Add ?q=' }, 400);
      const r = await mcpCall(mcpUrl, token, 'tools/call', { name: 'mcp-tv-search-symbols', arguments: { query: q } }, f);
      return json({ ok: !r.isError, result: r });
    }
    return new Response('Not found', { status: 404 });
  } catch(e){
    return json({ ok: false, error: String((e && e.message) || e) }, e && e.status === 401 ? 401 : 502);
  }
}

export default { fetch: (request, env) => handle(request, env) };
