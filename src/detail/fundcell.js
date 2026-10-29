// One factor card of the Fundamental Score panel: score bar, business line, governance flags, note,
// researched findings and the metric chips.
import { escapeHtml } from '../core/util.js';
import { hasSource } from '../core/fundscore.js';
import { scoreBand } from '../list/metrics.js';
import { fundMissingMetrics } from './completeness.js';
import { FUND_METRIC_LABEL, PERCENTILE_METRIC_KEYS, fundMetricDisplay, fundMetricNum, fundNoteExtra } from './fundmetrics.js';
import { fundBusinessSummary, isProxyFactor } from './fundtext.js';
import { metricDotHtml, toneDotHtml } from './metricdot.js';
import { dropRepeats } from '../core/sourcetags.js';
import { pointsView } from './pointview.js';

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
// v1.310: no source icons and no number pills; the one mark left is the warning on a point whose figure could not be verified.
const WARN_ICON = '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3.2M8 11.6v.1"/>';
const warnIcon = label => `<span class="srcico st-warn" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WARN_ICON}</svg></span>`;
// Long decimals from TradingView (13.9496814684338) are shown to two places.
const tidyValue = v => String(v).replace(/-?\d+\.\d{3,}/g, m => parseFloat(m).toFixed(2));
// One metric row: [dot] label ........ value (right-aligned, one column for the whole card). `ns` (the metric's links to the written points) is kept as data-n so a point and its rows light up together on hover.
function rowHtml(cls, ns, dot, label, value, extra, attrs){
  return `<span class="data-chip ${cls}"${ns.length ? ` data-n="${ns.join(' ')}"` : ''}${attrs || ''}>${dot}<span class="chip-label">${label}</span><b class="chip-val">${value}</b>${extra || ''}</span>`;
}
function chipHtml(f, view, k, v){
  const ns = view.nums.get(k) || [], pct = PERCENTILE_METRIC_KEYS.has(k);
  return rowHtml((v === 'n/a' ? 'chip-na' : '') + (pct ? ' chip-long' : ''), ns, metricDotHtml(f, k, v), `${FUND_METRIC_LABEL[k] || k}:`, fundMetricDisplay(k, v), '',
    pct ? ' title="A percentile, not a rank: 100th means the best of its industry peers, 50th is the middle, 1st is the weakest."' : '');
}
// Figures Claude found in the TradingView data that no metric row shows (kept only when the figure is in that data).
function factHtml(x){
  const label = escapeHtml(String(x.label).replace(/\s*\(TradingView\)\s*$/i, '')) + ':';
  return rowHtml('chip-new', x.n || [], toneDotHtml(['pos', 'neg'].includes(x.tone) ? x.tone : 'neu'), label, escapeHtml(tidyValue(x.value)), x.note ? `<span class="chip-note">${escapeHtml(x.note)}</span>` : '');
}
// v1.309: a card is "wide" (the whole row) when it has written points, so its metrics and its points sit side by side.
// Cards without points are shown two to a row (src/detail/fundamentals.js decides; a lone one is wide too).
function fundCellHasPoints(f){
  return !!f.research && (hasSource(f) || pointsView(f).pts.length > 0);
}
function renderFundFactorCell(f, wide){
  const normalized = (f.score/f.weight)*10;
  const band = scoreBand(normalized);
  const pct = Math.max(0, Math.min(100, Math.round((f.score/f.weight)*100)));
  const isProxy = isProxyFactor(f);
  const isResearched = !!f.research;
  const view = pointsView(f);
  // v1.303: the written bullets show whenever there are any (before, only when the research also listed sources, so a card could show link numbers on its rows with no bullets to match).
  const showResearch = isResearched && (hasSource(f) || view.pts.length > 0);
  return `
    <div class="fund-cell${isProxy ? ' fund-cell-proxy' : ''}${wide ? ' fund-cell-wide' : ''}">
      <div class="fund-cell-head">
        <div class="fund-cell-label">${f.name}${(() => { const missing = f.research ? [] : fundMissingMetrics(f); return missing.length ? `<span class="incomplete-tag" title="Missing from this run's data: ${missing.join(', ')} — scored on whichever metrics were available, see 'How is this calculated?'">Incomplete data</span>` : ''; })()}</div>
        ${f.excluded ? '<div class="fund-cell-score fs-pending">Not scored</div>' : `<div class="fund-cell-score ${band}">${f.score.toFixed(2)}<span class="fund-cell-max">/${f.weight}</span></div>`}
      </div>
      ${f.excluded ? '' : `<div class="fund-cell-bar"><i class="${band}" style="width:${pct}%"></i></div>`}
      <div class="fund-cell-cols">
      <div class="data-chips">
        ${f.metrics.map(([k,v])=>chipHtml(f, view, k, v)).join('')}${view.facts.map(factHtml).join('')}
      </div>
      <div class="fund-cell-exp">
      ${f.excluded ? `<div class="fund-cell-note fund-cell-excluded">${PROXY_NOTE_KEYS.has(f.key) ? `Left out of the score: ${f.excluded}. Run Refresh Fundamental Info to add a sourced assessment.` : `Counted as an average score: ${f.excluded}.`}</div>` : (() => { const biz = fundBusinessSummary(f); return biz ? `<div class="fund-cell-business ${biz.band}">${biz.text}</div>` : ''; })()}
      ${(() => { const flags = govRedFlags(f); return flags.length ? `<div class="fund-cell-flags">${flags.map(fl => `<div class="fund-flag ${fl.sev}">⚠ ${fl.text}</div>`).join('')}</div>` : ''; })()}
      ${f.excluded ? '' : (() => { const extra = fundNoteExtra(f.note); return extra ? `<div class="fund-cell-note">${extra}</div>` : ''; })()}
      ${showResearch ? renderFactorResearchBlock(f, view) : ''}
      </div>
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
function renderFactorResearchBlock(f, view){
  const r = f.research || {};
  const age = researchAgeDays(r);
  const stale = age !== null && age > RESEARCH_STALE_DAYS
    ? `<p class="fund-research-stale">&#9888; Research is ${age} days old &mdash; use "Refresh Fundamental Info" to update it.</p>` : '';
  const li = (x) => `<li>${escapeHtml(typeof x === 'string' ? x : (x && x.text) || '')}</li>`;
  // v1.309: with numbered points present, the Strengths and Watch-outs lines join the same list: same dot column, same right-hand slot.
  const plainLi = (cls) => (x) => `<li class="fr-pt fr-plain ${cls}"><span class="fr-gut"><span class="fr-bul"></span></span><span class="fr-body"><span class="fr-text">${escapeHtml(typeof x === 'string' ? x : (x && x.text) || '')}</span></span></li>`;
  const pointLi = (p) => `<li class="fr-pt"${p.n ? ` data-n="${p.n}"` : ''}><span class="fr-gut"><span class="fr-bul"></span></span><span class="fr-body"><span class="fr-text">${escapeHtml(p.text)}</span>${p.url ? `<span class="fr-meta"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.src || 'Source')} ↗</a></span>` : ''}</span>${p.ok ? '' : `<span class="fr-src">${warnIcon('Not verified: a figure in this sentence could not be found in the metric rows or the TradingView data.')}</span>`}</li>`;
  const src = (x) => {
    if(typeof x === 'string') return escapeHtml(x);
    const title = escapeHtml((x && (x.title || x.url)) || '');
    return x && /^https?:\/\//.test(x.url || '') ? `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer">${title} ↗</a>` : title;
  };
  // A news source already linked on a bullet is not listed again.
  // v1.301: a Strengths / Watch-outs line that repeats a numbered point (or each other) is shown once.
  const pts = dropRepeats(view.pts, []);
  const pos = dropRepeats(r.positives, pts);
  const neg = dropRepeats(r.negatives, pts.concat(pos));
  const linked = new Set(pts.map(p => p.url).filter(Boolean));
  const rest = (Array.isArray(r.sources) ? r.sources : []).filter(x => !(x && typeof x === 'object' && linked.has(x.url)));
  return `
    <div class="fund-cell-research">
      ${stale}
      ${pts.length ? `<ul class="fund-research-list pts fr-tagged">${pts.map(pointLi).join('')}${pos.map(plainLi('fr-pos')).join('')}${neg.map(plainLi('fr-neg')).join('')}</ul>` : (r.summary ? `<p class="fund-research-summary">${escapeHtml(r.summary)}</p>` : '')}
      ${!pts.length && pos.length ? `<ul class="fund-research-list pos">${pos.map(li).join('')}</ul>` : ''}
      ${!pts.length && neg.length ? `<ul class="fund-research-list neg">${neg.map(li).join('')}</ul>` : ''}
      ${rest.length ? `<div class="fund-research-sources">Sources: ${rest.map(src).join(' · ')}</div>` : ''}
    </div>`;
}

export { fundCellHasPoints, renderFundFactorCell };
