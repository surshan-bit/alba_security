// The plain-English line shown under each factor: a headline per factor, worded by score band, built only from
// the existing scores and metrics. Presentation only: it does not change scoring, weights or any stored field.
import { escapeHtml } from '../core/util.js';
import { scoreBand } from '../list/metrics.js';
import { fundMetricVal } from './fundmetrics.js';

const PROXY_FACTOR_KEYS = new Set(['moat','gov']);
// A Moat/Governance factor stops being a "Data proxy" once it carries a `research` object
// (written by the on-demand "Research Moat & Governance now" request — see
// the research prompts). Everything proxy-related in the UI keys off this.
function isProxyFactor(f){ return !!f && PROXY_FACTOR_KEYS.has(f.key) && !f.research; }

// IMPORTANT: fin/prof/growth/val/moat/gov/reinvest are all scored as an INDUSTRY-RELATIVE
// percentile (see the fundamental-score-csv-refresh skill, section 3) — a stock's own absolute
// metric can be perfectly healthy in isolation while still scoring low simply because its
// industry peers are even stronger on that metric (e.g. a company with D/E of 0.21x can still
// rank poorly if its industry typically runs near-zero debt). So every tier below is phrased as
// a comparison to peers, never as an absolute judgement on the number shown next to it — that
// keeps the headline from contradicting the metric it's grounded in. Only Earnings Predictability
// (a fixed global curve, not peer-relative) and Margin of Safety (a direct price-vs-intrinsic-value
// read, population-wide) are phrased in absolute terms, because those really are absolute reads.
const FUND_BUSINESS_TEXT = {
  fin: (f, band) => {
    const de = fundMetricVal(f, 'D/E');
    const suffix = de ? ` (D/E ${de})` : '';
    return {
      'fs-buy':   `Stronger balance sheet than most industry peers${suffix}.`,
      'fs-mbuy':  `Healthier balance sheet than typical industry peers${suffix}.`,
      'fs-hold':  `Balance sheet roughly in line with industry peers${suffix}.`,
      'fs-avoid': `Weaker balance sheet than most industry peers${suffix}.`,
    }[band];
  },
  prof: (f, band) => {
    const roce = fundMetricVal(f, 'ROCE');
    const suffix = roce ? ` (ROCE ${roce})` : '';
    return {
      'fs-buy':   `More profitable than most industry peers${suffix}.`,
      'fs-mbuy':  `Solidly profitable versus industry peers${suffix}.`,
      'fs-hold':  `Profitability roughly in line with industry peers${suffix}.`,
      'fs-avoid': `Less profitable than most industry peers${suffix}.`,
    }[band];
  },
  growth: (f, band) => {
    const g = fundMetricVal(f, 'Profit growth TTM');
    const suffix = g ? ` (profit growth ${g})` : '';
    return {
      'fs-buy':   `Growing faster than most industry peers, and cash-backed${suffix}.`,
      'fs-mbuy':  `Healthy growth versus industry peers${suffix}.`,
      'fs-hold':  `Growth roughly in line with industry peers${suffix}.`,
      'fs-avoid': `Growth lagging most industry peers${suffix}.`,
    }[band];
  },
  val: (f, band) => {
    const pe = fundMetricVal(f, 'P/E');
    const suffix = pe ? ` (P/E ${pe})` : '';
    return {
      'fs-buy':   `Cheaper than most industry peers${suffix}.`,
      'fs-mbuy':  `Reasonably priced versus industry peers${suffix}.`,
      'fs-hold':  `Fairly valued versus industry peers${suffix}.`,
      'fs-avoid': `Pricier than most industry peers${suffix}.`,
    }[band];
  },
  moat: (f, band) => ({
    'fs-buy':   'Wider moat than most industry peers — among the most capital-efficient.',
    'fs-mbuy':  'Decent competitive positioning versus industry peers.',
    'fs-hold':  'Competitive positioning roughly in line with industry peers.',
    'fs-avoid': 'Narrower moat than most industry peers on capital efficiency.',
  }[band]),
  gov: (f, band) => ({
    'fs-buy':   'Stronger governance signals than most peers, no red flags.',
    'fs-mbuy':  'Reasonable governance profile versus peers.',
    'fs-hold':  'Governance roughly in line with peers — some flags worth watching.',
    'fs-avoid': 'Weaker governance signals than peers — flags on pledge/promoter activity.',
  }[band]),
  predict: (f, band) => ({
    'fs-buy':   'Highly predictable earnings trajectory.',
    'fs-mbuy':  'Fairly consistent earnings.',
    'fs-hold':  'Earnings are somewhat volatile year to year.',
    'fs-avoid': 'Earnings are volatile and hard to predict.',
  }[band]),
  reinvest: (f, band) => ({
    'fs-buy':   'Reinvests capital more efficiently than most peers.',
    'fs-mbuy':  'Reinvests capital efficiently versus peers.',
    'fs-hold':  'Capital reinvestment efficiency roughly in line with peers.',
    'fs-avoid': 'Reinvests capital less efficiently than most peers.',
  }[band]),
  dcf: (f, band) => {
    const mos = fundMetricVal(f, 'Margin of safety');
    const suffix = mos ? ` (margin of safety ${mos})` : '';
    return {
      'fs-buy':   `Trading well below estimated intrinsic value — attractive margin of safety${suffix}.`,
      'fs-mbuy':  `Reasonable margin of safety versus intrinsic value${suffix}.`,
      'fs-hold':  `Trading close to its estimated intrinsic value${suffix}.`,
      'fs-avoid': `Trading above estimated intrinsic value — limited or no margin of safety${suffix}.`,
    }[band];
  },
};

function fundBusinessSummary(f) {
  const normalized = f.weight ? (f.score / f.weight) * 10 : null;
  const band = scoreBand(normalized);
  const fn = FUND_BUSINESS_TEXT[f.key];
  if (!fn || band === 'fs-pending') return null;
  // Researched factors carry their own headline (the peer-relative wording above describes the proxy).
  if (f.research && f.research.headline) return { band, text: escapeHtml(f.research.headline) };
  const text = fn(f, band);
  return text ? { band, text } : null;
}

export { fundBusinessSummary, isProxyFactor };
