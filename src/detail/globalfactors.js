// Global & Macro panel.
import { panelIcon } from './icons.js';
import { escapeHtml, safeText, safeUrl } from '../core/util.js';

const EVENT_IMPACTS = ['positive', 'negative', 'mixed'];
const EVENT_TAGS = { positive: 'Helps', negative: 'Hurts' };
// A source with a web address (f.url, http/https only) is a link that opens in a new tab; one without stays plain text.
function srcHtml(f){
  const label = escapeHtml(f.source);
  return safeUrl(f.url)
    ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : label;
}
const itemHtml = (f) => `<li class="global-item">${safeText(f.text)}${f.source ? `<span class="global-item-source">Source: ${srcHtml(f)}</span>` : ''}</li>`;
const listHtml = (list) => (list?.length ? list.map(itemHtml).join('') : '<li class="global-item">None identified.</li>');
const eventHtml = (e) => `<li class="global-item global-event ev-${EVENT_IMPACTS.indexOf(e.impact) >= 0 ? e.impact : 'mixed'}"><span class="ev-tag">${EVENT_TAGS[e.impact] || 'Mixed'}</span> <strong>${safeText(e.headline)}</strong>${e.why ? `<div>${safeText(e.why)}</div>` : ''}${e.source ? `<span class="global-item-source">Source: ${srcHtml(e)}</span>` : ''}</li>`;
const eventsHtml = (events) => (events && events.length ? `
      <div class="global-events">
        <div class="global-col-title">&#9888; Critical news &amp; world events</div>
        <ul class="global-list">${events.map(eventHtml).join('')}</ul>
      </div>` : '');
const panelHead = () => `
      <div class="global-panel-head">
        <div class="global-panel-title">${panelIcon('global')}Global &amp; Macro Information</div>
      </div>`;

function renderGlobalFactorsPanel(s){
  const g = s.globalFactors;
  if(!(g && (g.positive?.length || g.negative?.length))){
    return `
      <div class="global-panel jump-target" id="jump-global">${panelHead()}
        <p class="global-panel-sub">Not yet researched for this stock. Use the Refresh button at the top of this page and choose Fundamental to research it now; this works for any stock, whatever its rating.</p>
      </div>
    `;
  }
  return `
    <div class="global-panel jump-target" id="jump-global">${panelHead()}
      <div class="global-cols" data-css="--n:${Math.max(1, g.positive?.length || 0, g.negative?.length || 0)}">
        <div class="global-col">
          <div class="global-col-title pos">&#9650; Positive / tailwind</div>
          <ul class="global-list">${listHtml(g.positive)}</ul>
        </div>
        <div class="global-col">
          <div class="global-col-title neg">&#9660; Negative / risk</div>
          <ul class="global-list">${listHtml(g.negative)}</ul>
        </div>
      </div>
      ${eventsHtml(g.events)}
    </div>
  `;
}

export { renderGlobalFactorsPanel };
