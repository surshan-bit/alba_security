// Fundamental metric chips: display names, percentile wording, and small readers/cleaners for the stored metric
// values and notes. Pure helpers, used by the factor cards, the business text and the completeness checks.
import { stocks } from '../core/stocks.js';

// Finance-ratio shorthand (D/E, ROCE, OPM...) reads as jargon to a business audience even though
// it's standard in equity research — spell each one out in the metric chips below rather than
// dropping the underlying numbers, which are exactly what backs up a factor's score.
// Percentile metrics are stored as "100th (Industry name)". Shown bare, "100th" reads like a rank
// out of 100 (impossible with fewer peers), so spell it out as a percentile; 100 = best of its peers.
const PERCENTILE_METRIC_KEYS = new Set(['Piotroski F-Score percentile','Industry-relative capital efficiency percentile']);
// Peer count behind a percentile: how many stocks had data for the same metric in the scope the
// engine ranked against (exact industry, its wider group, or all stocks — read from the label in
// brackets). Counted from the stored chips, so it stays correct after every refresh.
let peerCountCache = null;
// The stock whose Fundamental Score panel is being drawn; the percentile chips need it to count peers.
let fundRenderStock = null;
function setFundRenderStock(s){ fundRenderStock = s; }
function stockIndustryLabel(s){ const p = String(s.ticker).split('·'); return p.length > 1 ? p[1].trim() : ''; }
function peerCountFor(k, s, scopeLabel){
  if(!peerCountCache) peerCountCache = new Map();
  const hasData = x => {
    for(const f of ((x.fundamentals && x.fundamentals.factors) || []))
      for(const m of (f.metrics || []))
        if(Array.isArray(m) && m[0] === k) return !/^n\/a/.test(String(m[1]));
    return false;
  };
  let scope, test;
  if(scopeLabel === 'all stocks'){ scope = k + '|all'; test = () => true; }
  else if(/ group$/.test(scopeLabel)){ scope = k + '|g|' + s.industryGroup; test = x => x.industryGroup === s.industryGroup; }
  else { scope = k + '|i|' + s.industryGroup + '|' + scopeLabel; test = x => x.industryGroup === s.industryGroup && stockIndustryLabel(x) === scopeLabel; }
  if(!peerCountCache.has(scope)) peerCountCache.set(scope, stocks.filter(x => test(x) && hasData(x)).length);
  return peerCountCache.get(scope);
}
function fundMetricDisplay(k, v){
  if(PERCENTILE_METRIC_KEYS.has(k)){
    const m = /^(\d+(?:st|nd|rd|th))\s*\((.*)\)$/.exec(String(v));
    if(m){
      const n = fundRenderStock ? peerCountFor(k, fundRenderStock, m[2]) : 0;
      return `${m[1]} percentile of ${n || '—'} peers · ${m[2]}`;
    }
  }
  return v;
}
const FUND_METRIC_LABEL = {
  'D/E': 'Debt-to-Equity ratio',
  'ROCE': 'Return on Capital Employed',
  'ROE': 'Return on Equity',
  'ROIC': 'Return on Invested Capital',
  'OPM': 'Operating margin',
  'P/E': 'Valuation (Price-to-Earnings)',
  'PEG': 'Growth-adjusted valuation (PEG)',
  'Industry P/E': 'Industry-average valuation (P/E)',
  'Piotroski F-Score percentile': 'Financial-strength percentile vs. industry peers',
  'Industry-relative capital efficiency percentile': 'Capital efficiency percentile vs. industry peers',
  '3yr avg': '3-year average', '5yr avg': '5-year average',
  'Profit growth 3yr': '3-year profit growth', 'Profit growth TTM': 'Profit growth (last 12 months)',
  'Sales growth 3yr': '3-year sales growth',
  'Promoter pledge': 'Promoter shares pledged'
};
// Notes are written per-stock during scoring with a process-facing lead-in ("Mechanically scored
// ...") that's meaningful to whoever maintains the model but not to a business reader — strip that
// framing here at render time (never touches the stored note) and tidy a couple of remaining
// abbreviations, so the substance of the note reads as a plain finding.
function humanizeFundNote(note){
  if(!note) return note;
  let out = note
    .replace(/^Mechanically scored vs industry:\s*/i, 'Compared with industry peers — ')
    .replace(/^Data-driven mechanical proxy \(pending individual research\):\s*/i, 'Estimated from industry-wide data (not yet individually researched) — ')
    .replace(/^Mechanically scored\s*(from screener\.in data|on|from)?\s*:?\s*/i, '');
  out = out.charAt(0).toUpperCase() + out.slice(1);
  out = out.replace(/\bTTM\b/g, 'last 12 months').replace(/(\d)yr\b/g, '$1-year');
  return out;
}

function fundMetricVal(f, label) {
  const m = (f.metrics || []).find(([k]) => k === label);
  return (m && m[1] !== 'n/a') ? m[1] : null;
}

function fundNoteExtra(rawNote) {
  if (!rawNote) return null;
  // Constant methodology disclaimer, already communicated by the "Data proxy" badge/tooltip
  // on Moat & Governance cells — showing it again on every single stock adds nothing.
  const DROP_EXACT = ['Not a substitute for researched moat analysis.'];
  const splitIdx = rawNote.indexOf('. ');
  if (splitIdx === -1) return null; // whole note is one sentence — pure metric recap, nothing extra
  let rest = rawNote.slice(splitIdx + 2).trim();
  for (const d of DROP_EXACT) rest = rest.split(d).join('').trim();
  if (!rest) return null;
  return humanizeFundNote(rest);
}

function fundMetricNum(f, label) {
  const m = (f.metrics || []).find(([k]) => k === label);
  if (!m || m[1] === 'n/a') return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

export { FUND_METRIC_LABEL, PERCENTILE_METRIC_KEYS, fundMetricDisplay, fundMetricNum, fundMetricVal, fundNoteExtra, setFundRenderStock };
