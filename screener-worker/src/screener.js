// Screener.in access for the Worker: log in (or reuse a saved session cookie), read a company page for its warehouse id, load the peers
// table (/api/company/<id>/peers/) and take the company's own row. Requests are paced and a 429 or 503 is retried after a pause.
import { parseTable, warehouseId, pageHasData, pageTitle } from './html.js';
import { toRecord } from './fields.js';

const BASE = 'https://www.screener.in';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cookiesFrom(res){
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const jar = {};
  for(const line of raw) for(const part of String(line).split(/,(?=\s*[A-Za-z0-9_-]+=)/)){ const m = /^\s*([A-Za-z0-9_-]+)=([^;]*)/.exec(part); if(m) jar[m[1]] = m[2]; }
  return jar;
}
const cookieHeader = jar => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');

export class Screener {
  constructor(env, opts = {}){
    this.env = env; this.jar = {}; this.loggedIn = false; this.last = 0; this.gap = opts.gap ?? 300; this.fetch = opts.fetch || ((u, i) => fetch(u, i));
    this.requests = 0;
    if(env.SCREENER_SESSIONID){ this.jar.sessionid = env.SCREENER_SESSIONID; this.loggedIn = true; }
  }
  async raw(path, init = {}, retries = 3){
    const wait = this.gap - (Date.now() - this.last);
    if(wait > 0) await sleep(wait);
    this.last = Date.now();
    this.requests++;
    const headers = Object.assign({ 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9', Referer: BASE + '/', Cookie: cookieHeader(this.jar) }, init.headers || {});
    const res = await this.fetch(path.startsWith('http') ? path : BASE + path, Object.assign({ redirect: 'manual' }, init, { headers }));
    Object.assign(this.jar, cookiesFrom(res));
    if((res.status === 429 || res.status === 503) && retries > 0){
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000, 8000));
      return this.raw(path, init, retries - 1);
    }
    return res;
  }
  // Follows redirects by hand so cookies set on the way are kept; a redirect to the login page is reported as 'login'.
  async get(path, init = {}, hops = 4){
    const res = await this.raw(path, init);
    if(res.status >= 300 && res.status < 400){
      const loc = res.headers.get('location') || '';
      if(/\/login\//.test(loc)) return { status: 401, text: '', login: true };
      if(hops > 0 && loc) return this.get(loc.startsWith('http') ? loc : BASE + loc, init, hops - 1);
    }
    return { status: res.status, text: await res.text(), login: false };
  }
  async login(){
    if(this.loggedIn) return true;
    const { SCREENER_USERNAME: u, SCREENER_PASSWORD: p } = this.env;
    if(!u || !p) throw new Error('No Screener login: set SCREENER_SESSIONID or SCREENER_USERNAME and SCREENER_PASSWORD as secrets.');
    const page = await this.get('/login/');
    const m = /name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i.exec(page.text) || /value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken["']/i.exec(page.text);
    const token = (m && m[1]) || this.jar.csrftoken || '';
    const res = await this.raw('/login/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + '/login/' }, body: new URLSearchParams({ username: u, password: p, csrfmiddlewaretoken: token, next: '/' }).toString() });
    const loc = res.headers.get('location') || '';
    this.loggedIn = res.status >= 300 && res.status < 400 && !/\/login\//.test(loc) && !!this.jar.sessionid;
    if(!this.loggedIn) throw new Error('Screener login failed (status ' + res.status + '). Check the username and password secrets.');
    return true;
  }
  // The company's own peer-table row as engine fields. Falls back to the standalone page when the consolidated one has no data.
  async company(symbol){
    const sym = String(symbol).trim().toUpperCase();
    const warnings = [];
    let type = 'consolidated', page = await this.get('/company/' + encodeURIComponent(sym) + '/consolidated/');
    if(page.login){ this.loggedIn = false; await this.login(); page = await this.get('/company/' + encodeURIComponent(sym) + '/consolidated/'); }
    if(page.status === 404) return { sym, ok: false, error: 'not_found', warnings };
    if(page.status >= 400) return { sym, ok: false, error: 'http_' + page.status, warnings };
    if(!pageHasData(page.text)){
      const alt = await this.get('/company/' + encodeURIComponent(sym) + '/');
      if(alt.status < 400 && pageHasData(alt.text)){ page = alt; type = 'standalone'; warnings.push('no consolidated financials on Screener.in, standalone figures used'); }
    }
    const wid = warehouseId(page.text);
    if(!wid) return { sym, ok: false, error: 'no_warehouse_id', warnings };
    const peers = await this.get('/api/company/' + wid + '/peers/', { headers: { Accept: 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' } });
    if(peers.status >= 400 || !peers.text) return { sym, ok: false, error: 'peers_http_' + peers.status, warnings };
    const t = parseTable(peers.text);
    // the company's own line links to /company/<symbol>/ ; failing that, the row whose name is the page heading
    const slug = '/company/' + sym.toLowerCase() + '/';
    const title = pageTitle(page.text).toLowerCase();
    const own = t.rows.find(r => r.links.some(l => l.toLowerCase().startsWith(slug))) || t.rows.find(r => title && r.cells.some(c => c.toLowerCase() === title));
    if(!own) return { sym, ok: false, error: 'own_row_not_found', headers: t.headers, rowCount: t.rows.length, warnings };
    const { record, unmatched, missing } = toRecord(t.headers, own.cells);
    return { sym, ok: true, financialType: type, record, missing, unmatched, peerRows: t.rows.length, warnings };
  }
}
