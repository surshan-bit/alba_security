// One headline in a news list (the Explorer's industry list and the industry page's timeline): date, an optional kind marker,
// the positive / negative label, the title (a link when it has a web address) and the stock and source.
import { escapeHtml } from '../core/util.js';

function newsItemHtml(n, kindHtml = ''){
  const tag = n.s === 'pos' ? '<span class="news-pos">positive</span>' : n.s === 'neg' ? '<span class="news-neg">negative</span>' : '';
  const title = /^https?:\/\//i.test(n.url) ? '<a href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(n.t) + '</a>' : escapeHtml(n.t);
  return '<li><span class="biz-news-date">' + escapeHtml(n.d) + '</span> ' + (kindHtml ? kindHtml + ' ' : '') + tag + ' ' + title + '<span class="biz-news-meta"> · ' + escapeHtml(n.stock) + (n.src ? ' · ' + escapeHtml(n.src) : '') + '</span></li>';
}

export { newsItemHtml };
