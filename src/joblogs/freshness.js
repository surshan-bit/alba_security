// Data Freshness bars on the Data Refresh page.
import { stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';
import { setHtml } from '../core/safehtml.js';

// Parses a stock's top-level `asof` field (the Fundamental Score / Valuation / Global Factors
// last-touched date), in either the ISO form written by onboarding scripts ("2026-09-20") or the
// "D Mon YYYY" / "D Sept YYYY" form written by research-merge scripts ("21 Sep 2026"), and returns
// a Date at IST midnight, or null if unparseable.
function parseFundamentalAsof(raw){
  if(!raw) return null;
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(raw + 'T00:00:00+05:30');
  const m = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if(!m) return null;
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
  const mo = months[m[2].toLowerCase()];
  if(mo == null) return null;
  return new Date(Date.UTC(+m[3], mo, +m[1]) - 5.5 * 3600 * 1000);
}

// Renders a "how old is each stock's data" freshness summary on a Data Refresh Schedule panel:
// buckets every tracked stock by days since the date `cfg.getAsof(stock)` returns (computed live
// against today, not baked in at publish time, so this stays accurate between refresh runs).
// Shared by the Fundamental and Technical freshness panels — both used to be separate, near-
// identical functions differing only in which field they read and which elements/copy they wrote.
const DAY_MS = 86400000;
const FRESH_DAYS = 3;   // "refreshed" on the summary line means within this many days
const AGE_BUCKETS = [
  { label: 'Today', test: d => d === 0 },
  { label: '1–3 days', test: d => d >= 1 && d <= 3 },
  { label: '4–7 days', test: d => d >= 4 && d <= 7 },
  { label: '8–14 days', test: d => d >= 8 && d <= 14 },
  { label: '15–30 days', test: d => d >= 15 && d <= 30 },
  { label: '31+ days', test: d => d >= 31 }
];
const plural = (n) => (n === 1 ? '' : 's');
// Days since each stock's date, and how many stocks have no readable date.
function stockAges(getAsof, now){
  const ages = [];
  let unparsed = 0;
  stocks.forEach(s => {
    const d = parseFundamentalAsof(getAsof(s));
    if(!d){ unparsed++; return; }
    ages.push(Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS)));
  });
  return { ages, unparsed };
}
function summaryText(ages, unparsed){
  const avgAge = ages.reduce((a, d) => a + d, 0) / ages.length, oldestAge = Math.max(...ages);
  const freshCount = ages.filter(d => d <= FRESH_DAYS).length;
  return `Average ${avgAge.toFixed(1)} day${avgAge.toFixed(1) === '1.0' ? '' : 's'} old, oldest ${oldestAge} day${plural(oldestAge)}, ${freshCount} of ${ages.length} (${Math.round(100 * freshCount / ages.length)}%) refreshed in the last ${FRESH_DAYS} days`
    + (unparsed ? ` · ${unparsed} stock${plural(unparsed)} with no parseable refresh date` : '') + '.';
}
function barRowHtml(label, count, maxCount){
  const pct = Math.round(100 * count / maxCount);
  return `
      <div class="refreshlog-freshness-row">
        <span class="refreshlog-freshness-label">${escapeHtml(label)}</span>
        <span class="refreshlog-freshness-track"><span class="refreshlog-freshness-fill" data-css="--w:${count ? Math.max(pct, 3) : 0}%"></span></span>
        <span class="refreshlog-freshness-count">${count} stock${plural(count)}</span>
      </div>
    `;
}
function renderFreshnessPanel(cfg){
  const summaryEl = document.getElementById(cfg.summaryElId);
  const barsEl = document.getElementById(cfg.barsElId);
  if(!summaryEl || !barsEl) return;
  const { ages, unparsed } = stockAges(cfg.getAsof, new Date());
  if(ages.length === 0){
    summaryEl.textContent = cfg.noDataText;
    barsEl.textContent = '';
    return;
  }
  const counts = AGE_BUCKETS.map(b => ages.filter(b.test).length), maxCount = Math.max(...counts, 1);
  summaryEl.textContent = summaryText(ages, unparsed);
  setHtml(barsEl, AGE_BUCKETS.map((b, i) => barRowHtml(b.label, counts[i], maxCount)).join(''));
}

// The day a stock's technical data was last confirmed: its score's date, or the day TradingView's snapshot last covered it if that is later.
function techConfirmedOn(s){
  const a = s.technical && s.technical.asof, b = s.__snapAsof;
  return typeof a === 'string' && typeof b === 'string' ? (b > a ? b : a) : (a || b);
}

function paintFreshness(){
renderFreshnessPanel({summaryElId:'fundFreshnessSummary', barsElId:'fundFreshnessBars', getAsof: s => s.asof, noDataText: 'No fundamental refresh dates recorded yet.'});
renderFreshnessPanel({summaryElId:'techFreshnessSummary', barsElId:'techFreshnessBars', getAsof: techConfirmedOn, noDataText: 'No technical refresh dates recorded yet.'});
}

function init_joblogs_freshness(){ paintFreshness(); }

export { init_joblogs_freshness, paintFreshness };
