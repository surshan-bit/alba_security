// A minimal MCP client over Streamable HTTP: initialize, then one request. Replies may be plain JSON or a server-sent-event stream.
const PROTOCOL = '2025-06-18';

async function readReply(r, id){
  const ct = r.headers.get('Content-Type') || '';
  const text = await r.text();
  if(ct.includes('text/event-stream')){
    for(const block of text.split(/\r?\n\r?\n/)){
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
      if(!data) continue;
      try { const m = JSON.parse(data); if(m.id === id) return m; } catch(e){}
    }
    throw new Error('No reply with id ' + id + ' in the event stream');
  }
  return JSON.parse(text);
}

export async function mcpCall(url, token, method, params, f = fetch){
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token };
  const post = (body, extra) => f(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'alba-tv-gateway', version: '0.1.0' } } });
  if(init.status === 401) throw Object.assign(new Error('TradingView rejected the token (401)'), { status: 401 });
  if(!init.ok) throw new Error('initialize -> ' + init.status + ' ' + (await init.text()).slice(0, 200));
  const sid = init.headers.get('Mcp-Session-Id');
  await readReply(init, 1);
  const extra = sid ? { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': PROTOCOL } : { 'MCP-Protocol-Version': PROTOCOL };
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra);
  const r = await post({ jsonrpc: '2.0', id: 2, method, params }, extra);
  if(!r.ok) throw new Error(method + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const m = await readReply(r, 2);
  if(m.error) throw new Error(method + ': ' + (m.error.message || JSON.stringify(m.error)));
  return m.result;
}
