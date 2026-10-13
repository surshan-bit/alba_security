// Dated events for the price-chart tags: news headlines, results dates and corporate events read from TradingView during
// Refresh Fundamental Info. They are kept on the stock's research document (field `events`) and grow with every refresh.
import { tvIstDate } from '../tv/connector.js';

const EVENT_KEEP = 250;   // most events kept per stock (newest first)

// allHeads: TradingView news headlines; earnDocs / corpDocs: results of get-documents for event "earning" / "corporate_event".
function ldBuildEvents(allHeads, earnDocs, corpDocs){
  const out = [];
  (allHeads || []).forEach(h => {
    if(h && h.published && h.title) out.push({ k: 'news', d: tvIstDate(h.published), t: String(h.title).slice(0, 140), src: h.provider && h.provider.name ? String(h.provider.name).slice(0, 40) : '', url: /^https?:\/\//i.test(h.link || '') ? h.link : '' });
  });
  // Each results announcement or corporate event comes as several documents (report, slides, transcript): keep one per event.
  const fromDocs = (docs, k, prefix) => {
    const seen = new Set();
    (docs && Array.isArray(docs.items) ? docs.items : []).forEach(x => {
      if(!x || !x.reported || !x.title) return;
      const id = x.correlation_id || (x.reported + '|' + x.title);
      if(seen.has(id)) return;
      seen.add(id);
      out.push({ k, d: tvIstDate(x.reported), t: (prefix ? prefix + ' · ' : '') + String(x.title).slice(0, 100), src: x.provider && x.provider.name ? String(x.provider.name).slice(0, 40) : '', url: '' });
    });
  };
  fromDocs(earnDocs, 'earn', 'Results');
  fromDocs(corpDocs, 'corp', '');
  return out;
}

// Adds new events to the stored ones (same kind, date and text counts as the same event) and keeps the newest EVENT_KEEP.
function ldMergeEvents(stored, fresh){
  const map = new Map();
  (Array.isArray(stored) ? stored : []).concat(fresh || []).forEach(e => {
    if(!e || typeof e.d !== 'string' || typeof e.k !== 'string' || typeof e.t !== 'string') return;
    const key = e.k + '|' + e.d + '|' + e.t, prev = map.get(key);
    map.set(key, prev && prev.s && !e.s ? Object.assign({}, e, { s: prev.s }) : e);   // keep a label already given to this headline
  });
  return Array.from(map.values()).sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)).slice(0, EVENT_KEEP);
}

// ---- Positive / negative labels for news headlines (one small Claude call, only for headlines that have no label yet) ----
const LABEL_MAX = 60;
const ldUnlabeledNews = (list) => list.filter(e => e.k === 'news' && !e.s).slice(0, LABEL_MAX);
function ldLabelPrompt(company, items){
  return 'TASK: Label each news headline about ' + company + ' by how it is likely to affect the company\'s share price.\n"positive": for example an order win, profit growth, capacity expansion, upgrade, dividend, debt cut or promoter buying. "negative": for example a loss, penalty, probe, downgrade, lawsuit, fraud, promoter selling or a demerger problem. "neutral": routine, unclear, or general market news. Judge only from the headline text and never invent facts.\n'
    + 'NEWS HEADLINES TO LABEL (id, date, headline):\n' + items.map((e, i) => i + ' | ' + e.d + ' | ' + e.t).join('\n')
    + '\nReply with only JSON: {"labels":{"<id>":"positive"|"negative"|"neutral"}}';
}
// Writes the labels from Claude's reply onto the events (positive -> pos, negative -> neg, neutral -> neu); returns how many were set.
function ldApplyLabels(items, reply){
  const map = reply && typeof reply === 'object' ? reply.labels : null;
  let n = 0;
  if(!map || typeof map !== 'object') return 0;
  items.forEach((e, i) => {
    const v = map[String(i)], s = v === 'positive' ? 'pos' : v === 'negative' ? 'neg' : v === 'neutral' ? 'neu' : null;
    if(s){ e.s = s; n++; }
  });
  return n;
}

export { ldApplyLabels, ldBuildEvents, ldLabelPrompt, ldMergeEvents, ldUnlabeledNews };
