// Click-to-sort headers for a stock grid that is drawn once and not redrawn from data (a stock's Industry Peers table). Its rows carry data-idx (the stock's
// place in the list) and its <table> carries data-cols (the column ids, comma separated). A click on a header sorts the rows in place; a second click reverses.
import { stocks } from '../core/stocks.js';
import { columnHeaderHtml, compareByColumn, nextSort } from '../analysis/columns.js';

// A header state with no column picked yet: the headers are clickable, none shows an arrow.
const NO_SORT = { col: '', dir: 'desc' };

function wireStockGridSort(table){
  const head = table.querySelector('thead tr'), body = table.querySelector('tbody'), colIds = (table.dataset.cols || '').split(',').filter(Boolean);
  if(!head || !body || !colIds.length) return;
  let sort = NO_SORT;
  head.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-sort-col]'));
    if(!btn) return;
    sort = nextSort(sort, btn.dataset.sortCol || '');
    const cmp = compareByColumn(sort.col, sort.dir);
    Array.from(body.rows)
      .sort((a, b) => cmp(stocks[Number(a.dataset.idx)], stocks[Number(b.dataset.idx)]))
      .forEach(r => body.appendChild(r));
    body.querySelectorAll('.analysis-lb-rank').forEach((td, i) => { td.textContent = String(i + 1); });
    head.innerHTML = colIds.map(id => columnHeaderHtml(id, sort)).join('');
  });
}

export { NO_SORT, wireStockGridSort };
