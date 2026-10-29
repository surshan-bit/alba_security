// Green / red / grey dot for each metric row of the Fundamental Score cards (Traditional, Buffett, Valuation).
// Fixed thresholds on each number, read from the stored chip text; anything not clearly good or bad is grey.
// Pure helpers: they never change a stored value or a score.

function numOf(v) {
  if (v == null || /^n\/a/i.test(String(v))) return null;
  const n = parseFloat(String(v).replace(/[₹,%x\s]/g, '').replace(/Cr.*$/i, ''));
  return Number.isFinite(n) ? n : null;
}
// n >= good -> pos, n < bad -> neg, otherwise neutral
const atLeast = (good, bad) => n => (n >= good ? 'pos' : n < bad ? 'neg' : 'neu');
// n <= good -> pos, n > bad -> neg, otherwise neutral
const atMost = (good, bad) => n => (n <= good ? 'pos' : n > bad ? 'neg' : 'neu');
const sign = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu');
const growth = atLeast(10, 0);
const returns = atLeast(15, 10);
const percentile = atLeast(60, 35);

const RULES = {
  'D/E': atMost(1, 2),
  'Interest coverage': atLeast(3, 1.5),
  'Quick ratio': atLeast(1, 0.7),
  'Altman Z': atLeast(3, 1.8),
  'Current ratio': atLeast(1.5, 1),
  'Avg debtor days 3yr': atMost(60, 120),
  'Contingent liabilities': n => (n > 0 ? 'neg' : 'neu'),
  'ROCE': returns, 'ROE': returns, 'Median ROCE 10yr': returns, 'Avg ROE 7yr': returns,
  'ROIC': returns, 'CROIC': returns,
  'OPM': atLeast(15, 8),
  'Sales growth 3yr': growth, 'Profit growth 3yr': growth, 'Profit growth TTM': growth,
  '3yr avg': growth, '5yr avg': growth,
  'FCF 3yr': sign, 'OCF 3yr': sign,
  'PEG': n => (n <= 0 ? 'neg' : n < 1 ? 'pos' : n > 2 ? 'neg' : 'neu'),
  'Industry-relative capital efficiency percentile': percentile,
  'Piotroski F-Score percentile': percentile,
  'Promoter pledge': atMost(5, 9.99),
  'Promoter holding change': n => (n >= 0.5 ? 'pos' : n <= -2 ? 'neg' : 'neu'),
  'FII change last quarter': sign,
  'FII change 3yr': atLeast(1, -3), 'DII change 3yr': atLeast(1, -3),
  'Margin of safety': atLeast(15, 0)
};

// Chips whose reading depends on another chip of the same stock.
function relative(k, n, num) {
  const pe = num('P/E');
  switch (k) {
    case 'P/E': {
      const ind = num('Industry P/E');
      if (n <= 0) return 'neg';
      if (ind == null || ind <= 0) return 'neu';
      return n <= ind * 0.85 ? 'pos' : n >= ind * 1.25 ? 'neg' : 'neu';
    }
    case 'Historical PE 5yr':
      if (pe == null || pe <= 0 || n <= 0) return 'neu';
      return pe <= n * 0.85 ? 'pos' : pe >= n * 1.25 ? 'neg' : 'neu';
    case 'Intrinsic Value (Screener.in)': case 'Graham Number': {
      const px = num('Current price');
      if (px == null || px <= 0) return 'neu';
      return k === 'Graham Number' ? (n >= px ? 'pos' : 'neg') : (n >= px * 1.15 ? 'pos' : n < px ? 'neg' : 'neu');
    }
    default: return null;
  }
}

// factor: { metrics: [[label, value], ...] }. Returns 'pos' | 'neg' | 'neu'.
function metricTone(factor, k, v) {
  const n = numOf(v);
  if (n == null) return 'neu';
  const num = label => { const m = (factor.metrics || []).find(([x]) => x === label); return m ? numOf(m[1]) : null; };
  const rel = relative(k, n, num);
  if (rel) return rel;
  const rule = RULES[k];
  return rule ? rule(n) : 'neu';
}

const TONE_TITLE = { pos: 'Positive', neg: 'Negative', neu: 'Neutral or no clear signal' };
function metricDotHtml(factor, k, v) {
  const t = metricTone(factor, k, v);
  return `<i class="mdot mdot-${t}" role="img" aria-label="${TONE_TITLE[t]}" title="${TONE_TITLE[t]}"></i>`;
}

export { metricDotHtml };
