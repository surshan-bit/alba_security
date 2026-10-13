// The hover card shown over a dot on the Analysis chart.
import { stocks, verdictLabel } from '../core/stocks.js';
import { isPinned } from '../core/pins.js';
import { escapeHtml } from '../core/util.js';
import { mosPct } from '../list/metrics.js';

const TOOLTIP_HTML = '<div class="analysis-tooltip" id="analysisTooltip"></div>';

function tooltipContent(s){
  const r = s.technical.raw;
  const mos = mosPct(s);
  const mosLabel = mos === -Infinity ? 'n/a' : `${mos >= 0 ? '+' : ''}${mos.toFixed(1)}%`;
  const v = s.valuation;
  const price = v && v.currentPrice != null ? `₹${v.currentPrice.toLocaleString('en-IN')}` : '—';
  return `
      <div class="analysis-tooltip-name">${escapeHtml(s.name)}${isPinned(s) ? ' <span style="color:var(--hold);">&#9733; Pinned</span>' : ''}</div>
      <div class="analysis-tooltip-ticker">${escapeHtml(s.ticker)}</div>
      <div class="analysis-tooltip-row"><span>Verdict</span><span class="badge b-${s.verdict}" style="padding:1px 8px;font-size:.68rem;">${verdictLabel[s.verdict]}</span></div>
      <div class="analysis-tooltip-row"><span>Score</span><span>${s.score != null ? s.score.toFixed(1) : '—'}</span></div>
      <div class="analysis-tooltip-row"><span>W RSI</span><span>${r.weekRsi.toFixed(1)}</span></div>
      <div class="analysis-tooltip-row"><span>M RSI</span><span>${r.monthRsi.toFixed(1)}</span></div>
      <div class="analysis-tooltip-row"><span>MoS</span><span>${mosLabel}</span></div>
      <div class="analysis-tooltip-row"><span>Price</span><span>${price}</span></div>
      <div class="analysis-tooltip-hint">Click to open this stock</div>
    `;
}

// Finds the tooltip element in the freshly drawn section and returns its controls.
function createAnalysisTooltip(){
  const tooltip = document.getElementById('analysisTooltip');
  function position(evt){
    const pad = 16;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    const rect = tooltip.getBoundingClientRect();
    if(x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if(y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  }
  function show(evt, s){
    tooltip.innerHTML = tooltipContent(s);
    tooltip.classList.add('show');
    position(evt);
  }
  function hide(){
    tooltip.classList.remove('show');
  }
  return { show, position, hide };
}

// Delegated once on the dots group, which persists across every redraw (only its innerHTML is replaced),
// instead of binding listeners on every circle on every slider tick.
function wireDotEvents(dotsGroupEl, tooltip, openStock){
  dotsGroupEl.addEventListener('mouseover', (evt) => {
    const dot = evt.target.closest('.analysis-dot');
    if(!dot) return;
    tooltip.show(evt, stocks[Number(dot.dataset.idx)]);
  });
  dotsGroupEl.addEventListener('mousemove', (evt) => {
    if(!evt.target.closest('.analysis-dot')) return;
    tooltip.position(evt);
  });
  dotsGroupEl.addEventListener('mouseout', (evt) => {
    if(!evt.target.closest('.analysis-dot')) return;
    tooltip.hide();
  });
  dotsGroupEl.addEventListener('click', (evt) => {
    const dot = evt.target.closest('.analysis-dot');
    if(!dot) return;
    tooltip.hide();
    openStock(Number(dot.dataset.idx));
  });
}

export { TOOLTIP_HTML, createAnalysisTooltip, wireDotEvents };
