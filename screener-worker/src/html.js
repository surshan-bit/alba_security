// Small HTML helpers for Screener's pages and its peer-table fragment. Workers have no DOM, and these two pages are simple enough for patterns.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s){
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if(e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export const text = html => decode(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// The first <table> in `html` as { headers: [text], rows: [{ cells: [text], links: [href] }] }. The first row (or the thead row) is the header.
export function parseTable(html){
  const m = /<table[\s\S]*?<\/table>/i.exec(html);
  if(!m) return { headers: [], rows: [] };
  const trs = m[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const all = trs.map(tr => {
    const cells = [], links = [];
    const re = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let c;
    while((c = re.exec(tr))){
      cells.push(text(c[2]));
      const a = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(c[2]);
      if(a) links.push(decode(a[1]));
    }
    return { cells, links, header: /<th\b/i.test(tr) && !/<td\b/i.test(tr) };
  }).filter(r => r.cells.length);
  const headRow = all.find(r => r.header) || all[0];
  if(!headRow) return { headers: [], rows: [] };
  return { headers: headRow.cells, rows: all.filter(r => r !== headRow && !r.header).map(({ cells, links }) => ({ cells, links })) };
}

// The id the peers endpoint needs: <div id="company-info" data-warehouse-id="...">
export function warehouseId(html){
  const tag = /<[^>]*\bid\s*=\s*["']company-info["'][^>]*>/i.exec(html);
  const m = tag && /data-warehouse-id\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
  return m ? m[1] : null;
}
// A company page has data when the top ratios list carries a price or the profit-and-loss table has values.
export function pageHasData(html){
  const top = /id\s*=\s*["']top-ratios["'][\s\S]{0,4000}?(?:Current Price|Market Cap)/i.test(html);
  const pl = /id\s*=\s*["']profit-loss["'][\s\S]{0,20000}?<td/i.test(html);
  return top || pl;
}
export const pageTitle = html => { const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html); return m ? text(m[1]) : ''; };
