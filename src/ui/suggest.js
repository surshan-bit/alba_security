// Ranking and highlighting for stock-name suggestions (the top-bar search and the Trade Log form).
import { stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';

function sgEsc(t){ return escapeHtml(String(t)); }
function sgMark(text, q){
  const i = text.toLowerCase().indexOf(q);
  if(i < 0) return sgEsc(text);
  return sgEsc(text.slice(0,i)) + '<mark>' + sgEsc(text.slice(i,i+q.length)) + '</mark>' + sgEsc(text.slice(i+q.length));
}
const NO_MATCH = 9;   // the rank of a stock that does not match
const MAX_SUGGESTIONS = 8;

// How well a stock matches the typed text q (lower case): 0 symbol starts with it, 1 name starts with it, 2 a word of the name starts with it,
// 3 symbol or name contains it, 4 industry contains it, NO_MATCH otherwise.
function rankOf(s, q){
  const name = (s.name||'').toLowerCase();
  const parts = String(s.ticker||'').split('·');
  const sym = (parts[0]||'').trim().toLowerCase();
  const ind = (parts[1]||'').trim().toLowerCase();
  if(sym.startsWith(q)) return 0;
  if(name.startsWith(q)) return 1;
  if(name.split(/[\s&.\-]+/).some(w=>w.startsWith(q))) return 2;
  if(sym.includes(q) || name.includes(q)) return 3;
  if(ind.includes(q)) return 4;
  return NO_MATCH;
}

/**
 * The stocks to suggest for the typed text q (lower case): best match first, then higher score, at most eight.
 * @param {string} q
 * @returns {any[]}
 */
function buildSuggestions(q){
  const out = [];
  for(const s of stocks){
    const rank = rankOf(s, q);
    if(rank < NO_MATCH) out.push({s, rank});
  }
  out.sort((a,b)=> a.rank-b.rank || b.s.score-a.s.score);
  return out.slice(0, MAX_SUGGESTIONS).map(o=>o.s);
}

export { buildSuggestions, sgMark };
