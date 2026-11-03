// What a caller may send to the worker (CLAUDE.md section 3, A04): size, count and shape are checked before anything is fetched.
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_SYMBOLS = 2000;
export const MAX_SYMBOL_LENGTH = 20;
// NSE tickers (letters, digits, & . - _) and numeric BSE codes. Anything else, such as a path or markup, is refused.
const SYMBOL_PATTERN = /^[A-Za-z0-9&._-]+$/;

/** @param {unknown} symbol @returns {string} the trimmed symbol; throws when it is not a plain ticker or code */
export function cleanSymbol(symbol){
  const s = typeof symbol === 'string' ? symbol.trim() : '';
  if(!s || s.length > MAX_SYMBOL_LENGTH || !SYMBOL_PATTERN.test(s)) throw new Error('Invalid symbol: use NSE tickers or BSE codes only.');
  return s;
}

/** @param {unknown} list @returns {string[]} the symbols, blanks dropped; throws when there are too many or one has the wrong shape */
export function cleanSymbols(list){
  const raw = Array.isArray(list) ? list : [];
  if(raw.length > MAX_SYMBOLS) throw new Error('Too many symbols: at most ' + MAX_SYMBOLS + ' per call.');
  return raw.filter(s => !(typeof s === 'string' && !s.trim())).map(cleanSymbol);
}
