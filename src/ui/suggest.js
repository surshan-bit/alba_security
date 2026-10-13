// Ranking and highlighting for stock-name suggestions (the top-bar search and the Trade Log form).
import { stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';

function sgEsc(t){ return escapeHtml(String(t)); }
function sgMark(text, q){
  const i = text.toLowerCase().indexOf(q);
  if(i < 0) return sgEsc(text);
  return sgEsc(text.slice(0,i)) + '<mark>' + sgEsc(text.slice(i,i+q.length)) + '</mark>' + sgEsc(text.slice(i+q.length));
}
function buildSuggestions(q){
  const out = [];
  for(const s of stocks){
    const name = (s.name||'').toLowerCase();
    const parts = String(s.ticker||'').split('·');
    const sym = (parts[0]||'').trim().toLowerCase();
    const ind = (parts[1]||'').trim().toLowerCase();
    let rank = 9;
    if(sym.startsWith(q)) rank = 0;
    else if(name.startsWith(q)) rank = 1;
    else if(name.split(/[\s&.\-]+/).some(w=>w.startsWith(q))) rank = 2;
    else if(sym.includes(q) || name.includes(q)) rank = 3;
    else if(ind.includes(q)) rank = 4;
    if(rank < 9) out.push({s, rank});
  }
  out.sort((a,b)=> a.rank-b.rank || b.s.score-a.s.score);
  return out.slice(0,8).map(o=>o.s);
}

export { buildSuggestions, sgMark };
