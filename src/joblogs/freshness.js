// Data Freshness bars on the Data Refresh page.
import { stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';

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
function renderFreshnessPanel(cfg){
  const summaryEl = document.getElementById(cfg.summaryElId);
  const barsEl = document.getElementById(cfg.barsElId);
  if(!summaryEl || !barsEl) return;

  const now = new Date();
  const ages = [];
  let unparsed = 0;
  stocks.forEach(s => {
    const d = parseFundamentalAsof(cfg.getAsof(s));
    if(!d){ unparsed++; return; }
    ages.push(Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86400000)));
  });

  if(ages.length === 0){
    summaryEl.textContent = cfg.noDataText;
    barsEl.innerHTML = '';
    return;
  }

  const buckets = [
    {label:'Today', test: d => d === 0},
    {label:'1–3 days', test: d => d >= 1 && d <= 3},
    {label:'4–7 days', test: d => d >= 4 && d <= 7},
    {label:'8–14 days', test: d => d >= 8 && d <= 14},
    {label:'15–30 days', test: d => d >= 15 && d <= 30},
    {label:'31+ days', test: d => d >= 31}
  ];
  const counts = buckets.map(b => ages.filter(b.test).length);
  const maxCount = Math.max(...counts, 1);

  const avgAge = (ages.reduce((a, d) => a + d, 0) / ages.length);
  const oldestAge = Math.max(...ages);
  const freshCount = ages.filter(d => d <= 3).length;

  summaryEl.textContent = `Average ${avgAge.toFixed(1)} day${avgAge.toFixed(1) === '1.0' ? '' : 's'} old, oldest ${oldestAge} day${oldestAge === 1 ? '' : 's'}, ${freshCount} of ${ages.length} (${Math.round(100 * freshCount / ages.length)}%) refreshed in the last 3 days`
    + (unparsed ? ` · ${unparsed} stock${unparsed === 1 ? '' : 's'} with no parseable refresh date` : '') + '.';

  barsEl.innerHTML = buckets.map((b, i) => {
    const count = counts[i];
    const pct = Math.round(100 * count / maxCount);
    return `
      <div class="refreshlog-freshness-row">
        <span class="refreshlog-freshness-label">${escapeHtml(b.label)}</span>
        <span class="refreshlog-freshness-track"><span class="refreshlog-freshness-fill" style="width:${count ? Math.max(pct, 3) : 0}%"></span></span>
        <span class="refreshlog-freshness-count">${count} stock${count === 1 ? '' : 's'}</span>
      </div>
    `;
  }).join('');
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
