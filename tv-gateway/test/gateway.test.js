import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';

const kv = () => { const m = new Map(); return { get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, m }; };
const ENV = () => ({ TV_KV: kv(), SPIKE_KEY: 'k'.repeat(20), TV_MCP_URL: 'https://mcp.tv.test/mcp' });

// A pretend TradingView: discovery, dynamic registration, token endpoint (with refresh) and an MCP endpoint that answers as an event stream.
function fakeTv(){
  const log = []; let n = 0, issued = null;
  const f = async (url, init = {}) => {
    url = String(url); const method = init.method || 'GET'; log.push(method + ' ' + url);
    const j = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
    if(url === 'https://mcp.tv.test/mcp' && !(init.headers || {}).Authorization)
      return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.tv.test/.well-known/oauth-protected-resource/mcp"' } });
    if(url.endsWith('/oauth-protected-resource/mcp')) return j({ resource: 'https://mcp.tv.test/mcp', authorization_servers: ['https://auth.tv.test'] });
    if(url === 'https://auth.tv.test/.well-known/oauth-authorization-server') return j({ authorization_endpoint: 'https://auth.tv.test/authorize', token_endpoint: 'https://auth.tv.test/token', registration_endpoint: 'https://auth.tv.test/register' });
    if(url === 'https://auth.tv.test/register'){ const b = JSON.parse(init.body); assert.deepEqual(b.redirect_uris, ['https://gw.test/tv/callback']); return j({ client_id: 'cid-1' }, 201); }
    if(url === 'https://auth.tv.test/token'){
      const p = new URLSearchParams(init.body);
      if(p.get('grant_type') === 'authorization_code'){ assert.ok(p.get('code_verifier')); assert.equal(p.get('code'), 'abc'); issued = 'at-' + (++n); return j({ access_token: issued, refresh_token: 'rt-1', expires_in: 3600 }); }
      assert.equal(p.get('refresh_token'), 'rt-1'); issued = 'at-' + (++n); return j({ access_token: issued, expires_in: 3600 });
    }
    if(url === 'https://mcp.tv.test/mcp'){
      assert.equal(init.headers.Authorization, 'Bearer ' + issued);
      const b = JSON.parse(init.body);
      if(b.method === 'initialize') return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 's1' } });
      if(b.method === 'notifications/initialized') return new Response(null, { status: 202 });
      assert.equal(init.headers['Mcp-Session-Id'], 's1');
      if(b.method === 'tools/list') return j({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'mcp-tv-search-symbols' }] } });
      if(b.method === 'tools/call'){ assert.equal(b.params.name, 'mcp-tv-search-symbols'); assert.equal(b.params.arguments.query, 'titan');
        return j({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '[{"symbol":"NSE:TITAN"}]' }] } }); }
    }
    return new Response('?', { status: 404 });
  };
  return { f, log };
}
const req = p => new Request('https://gw.test' + p);

test('owner key is required', async () => {
  const env = ENV();
  assert.equal((await handle(req('/tv/tools'), env, fetch)).status, 401);
  assert.equal((await handle(req('/tv/tools?key=short'), env, fetch)).status, 401);
});

test('not connected yet answers 409', async () => {
  const env = ENV();
  assert.equal((await handle(req('/tv/search?q=titan&key=' + env.SPIKE_KEY), env, fakeTv().f)).status, 409);
});

test('connect, callback, then search through the MCP server', async () => {
  const env = ENV(), tv = fakeTv();
  const c = await handle(req('/tv/connect?key=' + env.SPIKE_KEY), env, tv.f);
  assert.equal(c.status, 302);
  const loc = new URL(c.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, 'https://auth.tv.test/authorize');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('client_id'), 'cid-1');
  const state = loc.searchParams.get('state');
  assert.equal((await handle(req('/tv/callback?code=abc&state=WRONG'), env, tv.f)).status, 502);   // unknown state is refused
  assert.equal((await handle(req('/tv/callback?code=abc&state=' + state), env, tv.f)).status, 200);
  assert.equal((await handle(req('/tv/callback?code=abc&state=' + state), env, tv.f)).status, 502);   // state is single use
  const tools = await (await handle(req('/tv/tools?key=' + env.SPIKE_KEY), env, tv.f)).json();
  assert.deepEqual(tools.tools, ['mcp-tv-search-symbols']);
  const s = await (await handle(req('/tv/search?q=titan&key=' + env.SPIKE_KEY), env, tv.f)).json();
  assert.equal(s.ok, true);
  assert.match(s.result.content[0].text, /NSE:TITAN/);
});

test('an expired access token is refreshed with the refresh token', async () => {
  const env = ENV(), tv = fakeTv();
  const loc = new URL((await handle(req('/tv/connect?key=' + env.SPIKE_KEY), env, tv.f)).headers.get('Location'));
  await handle(req('/tv/callback?code=abc&state=' + loc.searchParams.get('state')), env, tv.f);
  const t = JSON.parse(env.TV_KV.m.get('tokens')); t.expires_at = Date.now() - 1000; env.TV_KV.m.set('tokens', JSON.stringify(t));
  const s = await (await handle(req('/tv/search?q=titan&key=' + env.SPIKE_KEY), env, tv.f)).json();
  assert.equal(s.ok, true);
  assert.ok(tv.log.filter(l => l === 'POST https://auth.tv.test/token').length === 2);
  assert.equal(JSON.parse(env.TV_KV.m.get('tokens')).refresh_token, 'rt-1');
});
