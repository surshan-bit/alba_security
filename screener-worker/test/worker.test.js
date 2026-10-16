import test from 'node:test';
import assert from 'node:assert/strict';
import { toNumber, toRecord, norm } from '../src/fields.js';
import { parseTable, warehouseId, pageHasData } from '../src/html.js';
import { handle } from '../src/index.js';

// The peer table as the PASUPTAC check returned it (headings and the company's own values), plus one made-up peer row.
const HEADS = ['S.No.', 'Name', 'CMP Rs.', 'P/E', 'Debt / Eq', 'Interest coverage', 'Quick Rat', 'Current ratio', 'Altman Z Scr', 'Debtor days 3yrs', 'Cont Liab Rs.Cr.',
  'ROCE %', 'ROE %', 'OPM %', 'Med ROCE 10Yr %', 'ROE 7Yr %', 'ROE 10Yr %', 'Sales Var 3Yrs %', 'Profit Var 3Yrs %', 'Profit Var 5Yrs %', 'Profit growth %',
  'Free Cash Flow 3Yrs Rs.Cr.', 'Free Cash Flow 5Yrs Rs.Cr.', 'CF Opr 3Yrs Rs.Cr.', 'CF Opr 5Yrs Rs.Cr.', 'Ind PE', 'PEG', '5Yrs PE', 'IV Rs.', 'Graham Price Rs.', 'NCAVPS Rs.',
  'Piotski Scr', 'Pledged %', 'Change in Prom Hold %', 'Chg in FII Hold 3Yr %', 'Chg in DII Hold 3Yr %', 'CROIC %', 'ROIC %'];
const OWN = ['1.', 'Pasupati Acrylon', '79.45', '7.39', '0.25', '12.43', '2.04', '3.24', '5.44', '30.95', '103.99', '21.15', '17.58', '13.96', '23.22', '12.73', '14.56', '6.85', '25.1', '10.31', '270.9',
  '-78.26', '-70.55', '130.92', '145.1', '13.74', '0.29', '9.99', '113.66', '108.55', '21.69', '8', '0.0', '0.0', '0.4', '0.02', '-5.14', '17.94'];
const PEER = ['2.', 'Other Chem Ltd', '1,234.5', '15.2', '0.8', '3.1', '1.1', '1.5', '2.9', '55', '10', '12', '11', '9', '14', '10', '12', '5', '8', '7', '4', '-', '-', '20', '25', '13.74', '1.9', '14', '900', '700', '3', '5', '0.0', '0.0', '0.1', '0.1', '2', '9'];
const row = (cells, href) => '<tr>' + cells.map((c, i) => i === 1 && href ? `<td class="text"><a href="${href}">${c}</a></td>` : `<td>${c}</td>`).join('') + '</tr>';
const PEERS_HTML = '<table class="data-table"><thead><tr>' + HEADS.map(h => `<th>${h.replace('&', '&amp;')}</th>`).join('') + '</tr></thead><tbody>' +
  row(PEER, '/company/OTHERCHEM/consolidated/') + row(OWN, '/company/PASUPTAC/') + '</tbody></table>';
const COMPANY_HTML = '<div id="company-info" data-warehouse-id="777"></div><ul id="top-ratios"><li>Current Price</li></ul><h1>Pasupati Acrylon</h1>';
const EMPTY_HTML = '<h1>Pasupati Acrylon</h1><div id="company-info" data-warehouse-id="777"></div>';

test('numbers: thousands separators, percent signs and blanks', () => {
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber('12.3%'), 12.3);
  assert.equal(toNumber('-'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('-5.14'), -5.14);
  assert.equal(norm('Debt / Eq'), 'debteq');
});

test('table parser: headings, rows and links', () => {
  const t = parseTable(PEERS_HTML);
  assert.equal(t.headers.length, HEADS.length);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[1].links, ['/company/PASUPTAC/']);
  assert.equal(t.rows[0].cells[2], '1,234.5');
  assert.equal(warehouseId(COMPANY_HTML), '777');
  assert.ok(pageHasData(COMPANY_HTML));
  assert.ok(!pageHasData(EMPTY_HTML));
});

test('record: every engine field is read from the PASUPTAC row', () => {
  const { record, unmatched, missing } = toRecord(HEADS, OWN);
  assert.deepEqual(unmatched, []);
  assert.deepEqual(missing, []);
  const want = { de: 0.25, interestCoverage: 12.43, quickRatio: 2.04, currentRatio: 3.24, altmanZ: 5.44, avgDebtorDays3: 30.95, contingentLiabilities: 103.99, roce: 21.15, roe: 17.58, opm: 13.96,
    medianRoce10: 23.22, avgRoe7: 12.73, avgRoe10: 14.56, salesGrowth3: 6.85, profitGrowth3: 25.1, profitGrowth5: 10.31, profitGrowthTTM: 270.9, fcf3: -78.26, fcf5: -70.55, ocf3: 130.92, ocf5: 145.1,
    pe: 7.39, industryPe: 13.74, peg: 0.29, histPe5: 9.99, intrinsicValue: 113.66, graham: 108.55, ncavps: 21.69, piotroski: 8, pledgePct: 0, promoterHoldingChange: 0, fiiChange3: 0.4, diiChange3: 0.02,
    croic: -5.14, roic: 17.94, currentPrice: 79.45 };
  for(const [k, v] of Object.entries(want)) assert.equal(record[k], v, k);
});

test('record: a heading nobody reads is reported, a missing column is listed', () => {
  const heads = HEADS.filter(h => h !== 'PEG').concat(['Some New Column']);
  const cells = OWN.filter((_, i) => HEADS[i] !== 'PEG').concat(['1']);
  const r = toRecord(heads, cells);
  assert.deepEqual(r.unmatched, ['Some New Column']);
  assert.ok(r.missing.includes('peg'));
  assert.equal(r.record.peg, null);
});

// A pretend Screener: login page, login POST, company pages and the peers fragment.
function fakeScreener(opts = {}){
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname; calls.push((init.method || 'GET') + ' ' + p);
    const res = (body, status = 200, headers = {}) => new Response(body, { status, headers });
    if(p === '/login/' && (init.method || 'GET') === 'GET') return res('<form><input name="csrfmiddlewaretoken" value="TOK"></form>', 200, { 'Set-Cookie': 'csrftoken=abc; Path=/' });
    if(p === '/login/'){
      if(!String(init.body).includes('csrfmiddlewaretoken=TOK') || !String(init.body).includes('username=me')) return res('bad', 200);
      return res('', 302, { Location: '/', 'Set-Cookie': 'sessionid=SESS; Path=/; HttpOnly' });
    }
    if(!String(init.headers.Cookie).includes('sessionid=SESS')) return res('', 302, { Location: '/login/?next=' + p });
    if(p === '/company/PASUPTAC/consolidated/') return res(opts.hasConsolidated ? COMPANY_HTML : EMPTY_HTML);
    if(p === '/company/PASUPTAC/') return res(COMPANY_HTML);
    if(p === '/api/company/777/peers/') return res(PEERS_HTML);
    return res('missing', 404);
  };
  return { fn, calls };
}
const ENV = { MCP_TOKEN: 'a-long-random-token-1234', SCREENER_USERNAME: 'me', SCREENER_PASSWORD: 'pw', BATCH_MAX: '20' };
const post = (body, path = '/mcp/a-long-random-token-1234') => new Request('https://w.example' + path, { method: 'POST', body: JSON.stringify(body) });

test('server: rejects a wrong or missing token', async () => {
  assert.equal((await handle(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp/wrong-token-wrong-token'), ENV)).status, 401);
  assert.equal((await handle(post({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp'), ENV)).status, 401);
  assert.equal((await handle(post({ jsonrpc: '2.0', id: 1, method: 'ping' }), { ...ENV, MCP_TOKEN: 'short' })).status, 401, 'a short secret is refused');
});

test('server: initialize, tools/list and notifications', async () => {
  const init = await (await handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), ENV)).json();
  assert.equal(init.result.serverInfo.name, 'alba-screener');
  const list = await (await handle(post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), ENV)).json();
  assert.deepEqual(list.result.tools.map(t => t.name), ['fundamentals_batch', 'diagnose']);
  assert.equal((await handle(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), ENV)).status, 202);
});

test('server: fundamentals_batch logs in once, falls back to standalone and returns the record', async () => {
  const f = fakeScreener();
  const res = await (await handle(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fundamentals_batch', arguments: { symbols: ['pasupTac', 'NOPE'] } } }), ENV, { fetch: f.fn, gap: 0 })).json();
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.processed, 2); assert.deepEqual(out.remaining, []);
  const [a, b] = out.results;
  assert.equal(a.ok, true); assert.equal(a.financialType, 'standalone');
  assert.match(a.warnings[0], /standalone/);
  assert.equal(a.record.intrinsicValue, 113.66); assert.equal(a.record.piotroski, 8);
  assert.equal(a.peerRows, 2);
  assert.equal(b.ok, false); assert.equal(b.error, 'not_found');
  assert.equal(f.calls.filter(c => c === 'POST /login/').length, 1, 'one login');
});

test('server: more symbols than the batch allows come back as remaining', async () => {
  const f = fakeScreener({ hasConsolidated: true });
  const syms = Array.from({ length: 25 }, () => 'PASUPTAC');
  const res = await (await handle(post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fundamentals_batch', arguments: { symbols: syms } } }), ENV, { fetch: f.fn, gap: 0 })).json();
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.processed, 20); assert.equal(out.remaining.length, 5);
  assert.equal(out.results[0].financialType, 'consolidated');
  assert.ok(out.screener_requests <= 45, 'inside the free plan limit of 50: ' + out.screener_requests);
});

test('server: a saved session cookie is used without logging in; no login at all is a clear error', async () => {
  const f = fakeScreener({ hasConsolidated: true });
  const env = { MCP_TOKEN: ENV.MCP_TOKEN, SCREENER_SESSIONID: 'SESS' };
  const res = await (await handle(post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'diagnose', arguments: { symbol: 'PASUPTAC' } } }), env, { fetch: f.fn, gap: 0 })).json();
  assert.equal(JSON.parse(res.result.content[0].text).ok, true);
  assert.ok(!f.calls.includes('POST /login/'));
  const bad = await (await handle(post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'diagnose', arguments: { symbol: 'X' } } }), { MCP_TOKEN: ENV.MCP_TOKEN }, { fetch: f.fn, gap: 0 })).json();
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /No Screener login/);
});
