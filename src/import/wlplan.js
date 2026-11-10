// TradingView watchlist sync, the pure part: which symbol each stock gets on which list, the steps shown while it runs, and the small comparisons the
// sync makes between what it wants and what TradingView holds. No page, no network: src/import/wlsync.js does the talking.
import { qualifyingStocks } from '../strategies/rules.js';

const WL_CONFIRMED = { 'KLBRENG-B': 'NSE:KLBRENG_B', 'NAM-INDIA': 'NSE:NAM_INDIA', 'J&KBANK': 'NSE:J&KBANK', 'GVT&D': 'NSE:GVT&D' };
const BSE_MAP_META_KEYS = ['version', 'updatedAt', '__version', '_version'];
const RAW_BSE_SYMBOL = /^BSE:\d+$/;
const LOOKUP_COMPANY_WORDS = /\b(limited|ltd|the|co|company|pvt|private)\b/g;
const SYNC_STEPS_FIXED_WEIGHT = 10, SYNC_STEPS_LISTS_WEIGHT = 80;

/**
 * The TradingView symbol for one ticker code.
 * @param {string} code the ticker without its exchange note
 * @param {Record<string, string>} alpha BSE code -> TradingView alpha symbol
 * @returns {{ sym?: string, unverified?: boolean, missing?: boolean }} `missing` is a BSE-only stock with no saved symbol
 */
function symbolFor(code, alpha){
  if(/^\d+$/.test(code)) return alpha[code] ? { sym: 'BSE:' + String(alpha[code]).replace(/^BSE:/, '') } : { missing: true };
  if(WL_CONFIRMED[code]) return { sym: WL_CONFIRMED[code] };
  if(/[-&]/.test(code)) return { sym: 'NSE:' + code.replace(/[-&]/g, '_'), unverified: true };
  return { sym: 'NSE:' + code };
}

// Adds one strategy's list to `state` = { alpha, lookedUp, out }.
function addPick(pick, universe, state){
  const { alpha, lookedUp, out } = state, seen = new Set();
  out.lists[pick.name] = [];
  for(const s of qualifyingStocks(universe, pick.rules)){
    const code = String(s.ticker).split('·')[0].trim(), r = symbolFor(code, alpha);
    if(r.missing){
      if(!lookedUp.has(code)){ lookedUp.add(code); out.needsLookup.push({ code, name: s.name }); }
      continue;
    }
    if(r.unverified && !out.unverified.includes(code)) out.unverified.push(code);
    if(seen.has(r.sym)){ out.notes.push('duplicate symbol skipped: ' + r.sym); continue; }
    seen.add(r.sym); out.lists[pick.name].push(r.sym);
  }
}

/**
 * Which stocks go where.
 * @param {object[]} universe the stocks to choose from
 * @param {Record<string, string> | null | undefined} bseMap stockMeta/bseAlpha: BSE code -> TradingView symbol (version fields are ignored)
 * @param {{ name: string, rules: object[] }[]} picks the strategies to sync
 * @returns {{ lists: Record<string, string[]>, needsLookup: { code: string, name: string }[], unverified: string[], notes: string[] }}
 */
function wlBuild(universe, bseMap, picks){
  const alpha = Object.assign({}, bseMap || {});
  for(const k of BSE_MAP_META_KEYS) delete alpha[k];
  const out = { lists: {}, needsLookup: [], unverified: [], notes: [] }, state = { alpha, lookedUp: new Set(), out };
  for(const pick of picks) addPick(pick, universe, state);
  const raw = Object.values(out.lists).flat().find(x => RAW_BSE_SYMBOL.test(x));
  if(raw) throw new Error('refusing to send a raw BSE code (' + raw + ')');
  return out;
}

/**
 * A company name for comparing: lower case, "Ltd" / "Limited" and punctuation ignored.
 * @param {unknown} t
 * @returns {string}
 */
const wlNorm = t => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(LOOKUP_COMPANY_WORDS, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Do two symbol lists hold the same symbols, whatever the order?
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function wlSame(a, b){
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every(v => y.has(v));
}

/**
 * The wanted symbols that a list does not hold.
 * @param {string[]} wanted
 * @param {string[]} got
 * @returns {string[]}
 */
function wlMissing(wanted, got){
  const have = new Set(got);
  return wanted.filter(x => !have.has(x));
}

/**
 * Of the symbols that did not land, the ones still absent once the same ticker on the other form (_ or &) is taken into account.
 * @param {string[]} missing
 * @param {string[]} got what the list holds now
 * @returns {string[]}
 */
function wlStillDropped(missing, got){
  const have = new Set(got), tickers = new Set(got.map(x => x.split(':')[1]));
  return missing.filter(sym => {
    const tk = sym.split(':')[1];
    return !have.has(sym) && !tickers.has(tk) && !tickers.has(tk.replace(/_/g, '&'));
  });
}

/**
 * How many symbols TradingView may refuse before the old list is left alone.
 * @param {number} total symbols wanted
 * @returns {number}
 */
const wlDropLimit = total => Math.max(10, total * 0.03);

/**
 * How many symbols a rebuilt list gained and lost.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {{ added: number, removed: number }}
 */
function wlDiff(before, after){
  const was = new Set(before), now = new Set(after);
  return { added: after.filter(x => !was.has(x)).length, removed: before.filter(x => !now.has(x)).length };
}

/**
 * The progress steps of a sync run.
 * @param {{ name: string }[]} picks
 * @returns {{ key: string, label: string, w: number }[]}
 */
function wlSteps(picks){
  return [{ key: 'build', label: 'Match the stocks', w: SYNC_STEPS_FIXED_WEIGHT }]
    .concat(picks.map((p, i) => ({ key: 'l' + i, label: p.name, w: Math.max(1, SYNC_STEPS_LISTS_WEIGHT / picks.length) })), [{ key: 'old', label: 'Remove the old fixed lists', w: SYNC_STEPS_FIXED_WEIGHT }]);
}

/**
 * What is wrong with the ticked strategies, or '' when the sync may start.
 * @param {{ name: string }[]} picks
 * @returns {string}
 */
function wlPicksProblem(picks){
  if(!picks.length) return 'Tick at least one strategy to sync.';
  const names = picks.map(p => p.name);
  if(names.some(n => !n) || new Set(names).size !== names.length) return 'Each ticked strategy needs its own name, because the TradingView list takes the strategy name.';
  return '';
}

export { wlBuild, wlDiff, wlDropLimit, wlMissing, wlNorm, wlPicksProblem, wlSame, wlSteps, wlStillDropped };
