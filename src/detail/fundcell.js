// One factor card of the Fundamental Score panel: score bar, business line, governance flags, note,
// researched findings and the metric chips.
import { escapeHtml } from '../core/util.js';
import { hasSource } from '../core/fundscore.js';
import { scoreBand } from '../list/metrics.js';
import { fundMissingMetrics } from './completeness.js';
import { FUND_METRIC_LABEL, PERCENTILE_METRIC_KEYS, fundMetricDisplay, fundMetricNum, fundNoteExtra } from './fundmetrics.js';
import { fundBusinessSummary, isProxyFactor } from './fundtext.js';

// Governance red-flag chips (added 2026-10-06) — surfaces the genuinely governance-relevant
// signals already in the gov factor's own metrics (promoter pledge, promoter holding change,
// FII/DII conviction) as standalone, visible alerts when they cross a concerning threshold,
// instead of leaving them buried as just another data-chip among five. This doesn't change the
// Governance score — it makes the real, credible part of that score's input more visible, per
// the discussion that the "Management & Governance" factor's credibility gap is really a
// visibility gap on the genuinely governance-relevant inputs it already has.
function govRedFlags(f) {
  if (f.key !== 'gov') return [];
  const pledge = fundMetricNum(f, 'Promoter pledge');
  const holdingChange = fundMetricNum(f, 'Promoter holding change');
  const fii = fundMetricNum(f, 'FII change 3yr');
  const dii = fundMetricNum(f, 'DII change 3yr');
  const flags = [];
  if (pledge != null && pledge >= 25) {
    flags.push({ sev: 'fs-avoid', text: `High promoter pledge (${pledge.toFixed(1)}%) — risk of forced selling if the stock falls.` });
  } else if (pledge != null && pledge >= 10) {
    flags.push({ sev: 'fs-hold', text: `Elevated promoter pledge (${pledge.toFixed(1)}%).` });
  }
  if (holdingChange != null && holdingChange <= -2) {
    flags.push({ sev: 'fs-avoid', text: `Promoters reduced their stake by ${Math.abs(holdingChange).toFixed(1)}% recently.` });
  }
  if (fii != null && fii <= -3) {
    flags.push({ sev: 'fs-hold', text: `FII holding down ${Math.abs(fii).toFixed(1)}% over 3 years.` });
  }
  if (dii != null && dii <= -3) {
    flags.push({ sev: 'fs-hold', text: `DII holding down ${Math.abs(dii).toFixed(1)}% over 3 years.` });
  }
  return flags;
}

const PROXY_NOTE_KEYS = new Set(['moat', 'gov']);
function renderFundFactorCell(f){
  const normalized = (f.score/f.weight)*10;
  const band = scoreBand(normalized);
  const pct = Math.max(0, Math.min(100, Math.round((f.score/f.weight)*100)));
  const isProxy = isProxyFactor(f);
  const isResearched = !!f.research;
  return `
    <div class="fund-cell${isProxy ? ' fund-cell-proxy' : ''}">
      <div class="fund-cell-head">
        <div class="fund-cell-label">${f.name}${(() => { const missing = f.research ? [] : fundMissingMetrics(f); return missing.length ? `<span class="incomplete-tag" title="Missing from this run's data: ${missing.join(', ')} — scored on whichever metrics were available, see 'How is this calculated?'">Incomplete data</span>` : ''; })()}</div>
        ${f.excluded ? '<div class="fund-cell-score fs-pending">Not scored</div>' : `<div class="fund-cell-score ${band}">${f.score.toFixed(2)}<span class="fund-cell-max">/${f.weight}</span></div>`}
      </div>
      ${f.excluded ? '' : `<div class="fund-cell-bar"><i class="${band}" style="width:${pct}%"></i></div>`}
      ${f.excluded ? `<div class="fund-cell-note fund-cell-excluded">${PROXY_NOTE_KEYS.has(f.key) ? `Left out of the score: ${f.excluded}. Run Refresh Fundamental Info to add a sourced assessment.` : `Counted as an average score: ${f.excluded}.`}</div>` : (() => { const biz = fundBusinessSummary(f); return biz ? `<div class="fund-cell-business ${biz.band}">${biz.text}</div>` : ''; })()}
      ${(() => { const flags = govRedFlags(f); return flags.length ? `<div class="fund-cell-flags">${flags.map(fl => `<div class="fund-flag ${fl.sev}">⚠ ${fl.text}</div>`).join('')}</div>` : ''; })()}
      ${f.excluded ? '' : (() => { const extra = fundNoteExtra(f.note); return extra ? `<div class="fund-cell-note">${extra}</div>` : ''; })()}
      ${isResearched && hasSource(f) ? renderFactorResearchBlock(f) : ''}
      <div class="data-chips">
        ${f.metrics.map(([k,v])=>`<span class="data-chip${v === 'n/a' ? ' chip-na' : ''}"${PERCENTILE_METRIC_KEYS.has(k) ? ' title="A percentile, not a rank: 100th means the best of its industry peers, 50th is the middle, 1st is the weakest."' : ''}>${FUND_METRIC_LABEL[k] || k}: <b>${fundMetricDisplay(k, v)}</b></span>`).join('')}
      </div>
    </div>
  `;
}

// Findings of an on-demand Moat/Governance research run, stored on the factor as `research`:
// { asof, headline, summary, positives:[text], negatives:[text], sources:[string | {title,url}] }.
const RESEARCH_STALE_DAYS = 180;
function researchAgeDays(r){
  const t = r && r.asof ? Date.parse(r.asof) : NaN;
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}
function renderFactorResearchBlock(f){
  const r = f.research || {};
  const age = researchAgeDays(r);
  const stale = age !== null && age > RESEARCH_STALE_DAYS
    ? `<p class="fund-research-stale">&#9888; Research is ${age} days old &mdash; use "Refresh Fundamental Info" to update it.</p>` : '';
  const li = (x) => `<li>${escapeHtml(typeof x === 'string' ? x : (x && x.text) || '')}</li>`;
  const src = (x) => {
    if(typeof x === 'string') return escapeHtml(x);
    const title = escapeHtml((x && (x.title || x.url)) || '');
    return x && /^https?:\/\//.test(x.url || '') ? `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer">${title} ↗</a>` : title;
  };
  return `
    <div class="fund-cell-research">
      ${stale}
      ${r.points && r.points.length ? `<ul class="fund-research-list pts">${r.points.map(li).join('')}</ul>` : (r.summary ? `<p class="fund-research-summary">${escapeHtml(r.summary)}</p>` : '')}
      ${r.positives && r.positives.length ? `<ul class="fund-research-list pos">${r.positives.map(li).join('')}</ul>` : ''}
      ${r.negatives && r.negatives.length ? `<ul class="fund-research-list neg">${r.negatives.map(li).join('')}</ul>` : ''}
      ${r.sources && r.sources.length ? `<div class="fund-research-sources">Sources: ${r.sources.map(src).join(' · ')}</div>` : ''}
    </div>`;
}

export { renderFundFactorCell };
