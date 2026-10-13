// Global & Macro panel.
import { panelIcon } from './icons.js';
import { escapeHtml } from '../core/util.js';

function renderGlobalFactorsPanel(s){
  const g = s.globalFactors;
  const hasContent = g && (g.positive?.length || g.negative?.length);
  // A source with a web address (f.url, http/https only) is a link that opens in a new tab; one without stays plain text.
  const srcHtml = (f) => {
    const label = escapeHtml(f.source);
    return typeof f.url === 'string' && /^https?:\/\//i.test(f.url)
      ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : label;
  };
  const item = (f) => `<li class="global-item">${f.text}${f.source ? `<span class="global-item-source">Source: ${srcHtml(f)}</span>` : ''}</li>`;
  if(!hasContent){
    return `
      <div class="global-panel" id="jump-global">
        <div class="global-panel-head">
          <div class="global-panel-title">${panelIcon('global')}Global &amp; Macro Information</div>
        </div>
        <p class="global-panel-sub">Not yet researched for this stock &mdash; the regular refresh only covers Strong/Good-rated stocks (see Knowledge Base §6). If you need this to decide on this stock right now, use the Refresh button at the top of this page and choose Fundamental.</p>
      </div>
    `;
  }
  return `
    <div class="global-panel" id="jump-global">
      <div class="global-panel-head">
        <div class="global-panel-title">${panelIcon('global')}Global &amp; Macro Information</div>
      </div>
      <div class="global-cols" style="--n:${Math.max(1, g.positive?.length || 0, g.negative?.length || 0)}">
        <div class="global-col">
          <div class="global-col-title pos">&#9650; Positive / tailwind</div>
          <ul class="global-list">${g.positive?.length ? g.positive.map(item).join('') : '<li class="global-item">None identified.</li>'}</ul>
        </div>
        <div class="global-col">
          <div class="global-col-title neg">&#9660; Negative / risk</div>
          <ul class="global-list">${g.negative?.length ? g.negative.map(item).join('') : '<li class="global-item">None identified.</li>'}</ul>
        </div>
      </div>
      ${g.events && g.events.length ? `
      <div class="global-events">
        <div class="global-col-title">&#9888; Critical news &amp; world events</div>
        <ul class="global-list">${g.events.map(e => `<li class="global-item global-event ev-${['positive','negative','mixed'].indexOf(e.impact) >= 0 ? e.impact : 'mixed'}"><span class="ev-tag">${e.impact === 'positive' ? 'Helps' : e.impact === 'negative' ? 'Hurts' : 'Mixed'}</span> <strong>${e.headline}</strong>${e.why ? `<div>${e.why}</div>` : ''}${e.source ? `<span class="global-item-source">Source: ${srcHtml(e)}</span>` : ''}</li>`).join('')}</ul>
      </div>` : ''}
    </div>
  `;
}

export { renderGlobalFactorsPanel };
