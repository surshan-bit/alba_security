// The Strengths / Watch-outs box at the top of the Fundamental Score panel.
import { escapeHtml } from '../core/util.js';
import { fundBusinessSummary, isProxyFactor } from './fundtext.js';

const MAX_POINTS = 4;
const PROXY_MARK = '<sup class="fund-proxy-mark" title="Mechanical proxy — not individually researched for this company">†</sup>';
const PROXY_FOOTNOTE = '<div class="fund-pc-footnote">† Moat and/or Governance — mechanical proxies estimated from industry-relative data, not yet individually researched for this company.</div>';
// The Strengths and Watch-outs columns around two ready lists of <li> items; `footnote` goes under both.
const prosConsHtml = (prosHtml, consHtml, footnote) => `
    <div class="fund-overall-summary">
      <div class="fund-pros-cons">
        <div class="fund-pros">
          <div class="fund-pc-title fund-pc-title-pros">Strengths</div>
          <ul>${prosHtml}</ul>
        </div>
        <div class="fund-cons">
          <div class="fund-pc-title fund-pc-title-cons">Watch-outs</div>
          <ul>${consHtml}</ul>
        </div>${footnote}
      </div>
    </div>
  `;
const pointHtml = (x, mark) => `<li><span class="fund-pc-dot ${x.band}"></span>${escapeHtml(x.text)}${mark}</li>`;

// Strengths / Watch-outs written by Claude during Refresh Fundamental Info (stored as `summary` on the stock's research
// document, see src/livedata/fundamental.js). When present it replaces the mechanical list below, which stays as the fallback.
function renderFundSummaryFromResearch(s) {
  const sm = s.__fundSummary;
  if (!sm || typeof sm !== 'object') return '';
  const take = (a, tones, dflt) => (Array.isArray(a) ? a : [])
    .filter(x => x && typeof x.text === 'string' && x.text.trim()).slice(0, MAX_POINTS)
    .map(x => ({ text: x.text.trim(), band: tones[x.tone] || dflt }));
  const pros = take(sm.strengths, { strong: 'fs-buy', good: 'fs-mbuy' }, 'fs-mbuy');
  const cons = take(sm.watchouts, { caution: 'fs-hold', concern: 'fs-avoid' }, 'fs-hold');
  if (!pros.length && !cons.length) return '';
  const prosHtml = pros.length ? pros.map(x => pointHtml(x, '')).join('') : '<li class="fund-pc-empty">No standout strengths.</li>';
  const consHtml = cons.length ? cons.map(x => pointHtml(x, '')).join('') : '<li class="fund-pc-empty">No major red flags.</li>';
  return prosConsHtml(prosHtml, consHtml, '');
}

// Reuse the exact same per-factor business headline shown on each factor card below
// (fundBusinessSummary) rather than inventing separate text here — keeps the Pros/Cons
// list and the factor cards saying the same thing in the same words. The panel head right
// above already shows the score and verdict badge, so this section never repeats either.
function scoredPoints(m) {
  return m.factors.filter(f => !f.excluded).map(f => {
    const normalized = f.weight ? (f.score / f.weight) * 10 : null;
    const biz = fundBusinessSummary(f);
    return { key: f.key, isProxy: isProxyFactor(f), normalized, band: biz ? biz.band : null, text: biz ? biz.text : null };
  }).filter(x => x.normalized != null && x.text);
}

function renderFundOverallSummary(s) {
  const m = s.fundamentals;
  if (!m || !Array.isArray(m.factors) || !m.factors.length) return '';
  const reviewed = renderFundSummaryFromResearch(s);
  if (reviewed) return reviewed;
  const scored = scoredPoints(m);
  if (!scored.length) return '';
  const pros = scored.filter(x => x.band === 'fs-buy' || x.band === 'fs-mbuy')
    .sort((a, b) => b.normalized - a.normalized).slice(0, MAX_POINTS);
  const cons = scored.filter(x => x.band === 'fs-avoid')
    .sort((a, b) => a.normalized - b.normalized).slice(0, MAX_POINTS);
  // Moat & Governance are mechanical proxies, not individually researched (see the "Data
  // proxy" badge on their factor cards) — flag any bullet drawn from one so the quick-read
  // Strengths/Watch-outs box discloses that too, not just the card further down the page.
  const li = (x) => pointHtml(x, x.isProxy ? PROXY_MARK : '');
  const prosHtml = pros.length ? pros.map(li).join('') : '<li class="fund-pc-empty">No standout strengths this run.</li>';
  const consHtml = cons.length ? cons.map(li).join('') : '<li class="fund-pc-empty">No major red flags this run.</li>';
  const anyProxy = pros.concat(cons).some(x => x.isProxy);
  return prosConsHtml(prosHtml, consHtml, anyProxy ? '\n        ' + PROXY_FOOTNOTE : '');
}

export { renderFundOverallSummary };
