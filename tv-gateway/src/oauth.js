// OAuth 2.1 sign-in to a remote MCP server, the way the MCP authorization spec describes it:
//   discover (protected-resource metadata -> authorization-server metadata) -> register a client (dynamic registration)
//   -> send the person to authorize with PKCE -> swap the code for tokens -> refresh when the access token runs out.
// Everything that must survive between requests lives in env.TV_KV under these keys.
const K = { client: 'client', pending: s => 'pending:' + s, tokens: 'tokens', meta: 'meta' };

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function challenge(verifier){ return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))); }

async function getJson(url, f){
  const r = await f(url, { headers: { Accept: 'application/json' } });
  if(!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
  return r.json();
}

// Finds the authorization server's endpoints. The MCP server may answer a bare request with 401 + WWW-Authenticate pointing at its
// metadata; failing that, the well-known paths are tried.
export async function discover(mcpUrl, f = fetch){
  const u = new URL(mcpUrl);
  let prm = null;
  const probe = await f(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }) });
  const hdr = probe.headers.get('WWW-Authenticate') || '';
  const m = /resource_metadata="([^"]+)"/.exec(hdr);
  const tries = [m && m[1], u.origin + '/.well-known/oauth-protected-resource' + u.pathname, u.origin + '/.well-known/oauth-protected-resource'].filter(Boolean);
  for(const t of tries){ try { prm = await getJson(t, f); break; } catch(e){} }
  const issuer = (prm && prm.authorization_servers && prm.authorization_servers[0]) || u.origin;
  const iu = new URL(issuer);
  const asTries = [iu.origin + '/.well-known/oauth-authorization-server' + (iu.pathname === '/' ? '' : iu.pathname),
    iu.origin + '/.well-known/oauth-authorization-server', iu.origin + '/.well-known/openid-configuration'];
  let as = null;
  for(const t of asTries){ try { as = await getJson(t, f); break; } catch(e){} }
  if(!as) throw new Error('No authorization-server metadata found for ' + issuer);
  return { issuer, resource: (prm && prm.resource) || mcpUrl, authorization_endpoint: as.authorization_endpoint, token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint || null, scopes: (prm && prm.scopes_supported) || as.scopes_supported || [] };
}

// Dynamic client registration (RFC 7591). The answer is kept: a client is registered once per redirect address.
export async function ensureClient(env, meta, redirectUri, f = fetch){
  const saved = await env.TV_KV.get(K.client, 'json');
  if(saved && saved.redirectUri === redirectUri && saved.token_endpoint === meta.token_endpoint) return saved;
  if(!meta.registration_endpoint) throw new Error('The server offers no dynamic client registration; a client id must be issued by TradingView');
  const r = await f(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Alba TV gateway (spike)', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  if(!r.ok) throw new Error('Client registration refused: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const reg = await r.json();
  const client = { client_id: reg.client_id, client_secret: reg.client_secret || null, redirectUri, token_endpoint: meta.token_endpoint };
  await env.TV_KV.put(K.client, JSON.stringify(client));
  return client;
}

// Step 1: the address to send the browser to.
export async function startAuthorize(env, mcpUrl, redirectUri, f = fetch){
  const meta = await discover(mcpUrl, f);
  const client = await ensureClient(env, meta, redirectUri, f);
  const state = rand(16), verifier = rand(48);
  await env.TV_KV.put(K.pending(state), JSON.stringify({ verifier, redirectUri }), { expirationTtl: 600 });
  await env.TV_KV.put(K.meta, JSON.stringify(meta));
  const a = new URL(meta.authorization_endpoint);
  a.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: await challenge(verifier),
    code_challenge_method: 'S256', resource: meta.resource, ...(meta.scopes.length ? { scope: meta.scopes.join(' ') } : {}) }).toString();
  return a.toString();
}

const keep = async (env, t, now) => {
  const tokens = { access_token: t.access_token, refresh_token: t.refresh_token || null, expires_at: t.expires_in ? now + Number(t.expires_in) * 1000 : null };
  await env.TV_KV.put(K.tokens, JSON.stringify(tokens));
  return tokens;
};
async function tokenCall(env, params, f){
  const meta = await env.TV_KV.get(K.meta, 'json'), client = await env.TV_KV.get(K.client, 'json');
  if(!meta || !client) throw new Error('Not connected yet: open /tv/connect first');
  const body = new URLSearchParams({ ...params, client_id: client.client_id, resource: meta.resource });
  if(client.client_secret) body.set('client_secret', client.client_secret);
  const r = await f(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
  if(!r.ok) throw new Error('Token request refused: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

// Step 2: the browser comes back with ?code=&state=.
export async function finishAuthorize(env, code, state, f = fetch, now = Date.now()){
  const pending = await env.TV_KV.get(K.pending(state), 'json');
  if(!pending) throw new Error('Unknown or expired sign-in (state)');
  await env.TV_KV.delete(K.pending(state));
  const t = await tokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier }, f);
  return keep(env, t, now);
}

// A usable access token, refreshed a minute early; null when never connected.
export async function accessToken(env, f = fetch, now = Date.now()){
  const t = await env.TV_KV.get(K.tokens, 'json');
  if(!t) return null;
  if(!t.expires_at || t.expires_at - 60000 > now) return t.access_token;
  if(!t.refresh_token) throw new Error('Access token expired and there is no refresh token: sign in again at /tv/connect');
  const n = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: t.refresh_token }, f);
  return (await keep(env, { refresh_token: t.refresh_token, ...n }, now)).access_token;
}
