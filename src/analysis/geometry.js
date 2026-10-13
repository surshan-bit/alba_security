// The Analysis scatter chart's geometry: size, scales, dot radius, and the static SVG
// (gridlines, quadrant lines and labels, axis titles). The dots themselves are drawn by chart.js.
import { mosPct } from '../list/metrics.js';
import { analysisFilters } from './state.js';

// Dot radius scales with Margin of Safety: a bigger circle is a bigger cushion between price and
// intrinsic value. It is fixed to the full plottable set's MoS range (not the currently filtered range)
// so a dot's size means the same thing wherever the RSI sliders are set. Radius scales by sqrt(MoS)
// rather than MoS directly, since a viewer reads the circle's AREA as "how big" and area grows with r².
const DOT_R_MIN = 4, DOT_R_MAX = 13;

// Which raw field feeds which axis is a user choice (the X-axis / Y-axis toggles), defaulting to
// X = Weekly, Y = Monthly. The RSI range sliders and the MoS bucket still filter on the underlying
// Weekly / Monthly values whichever axis shows them.
function valueFor(s, axis){
  const r = s.technical.raw;
  return axis === 'month' ? r.monthRsi : r.weekRsi;
}
const axisTitle = (axis) => axis === 'month' ? 'M RSI (14)' : 'W RSI (14)';
const axisShort = (axis) => axis === 'month' ? 'Monthly' : 'Weekly';

// `host` is the element the chart fills; `plottable` the stocks that have both RSI readings.
function chartGeometry(host, plottable){
  const mosValues = plottable.map(s => mosPct(s)).filter(v => v !== -Infinity);
  const mosMin = mosValues.length ? Math.min(...mosValues) : 0;
  const mosMax = mosValues.length ? Math.max(...mosValues) : 0;
  function radiusForMos(mos){
    if(mos === -Infinity || mosMax === mosMin) return DOT_R_MIN;
    const t = Math.max(0, Math.min(1, (mos - mosMin) / (mosMax - mosMin)));
    return DOT_R_MIN + (DOT_R_MAX - DOT_R_MIN) * Math.sqrt(t);
  }

  // Chart size follows the space available, so on a wide desktop the plot fills the panel instead of
  // sitting centred with blank bands either side. One SVG unit = one pixel, so text stays a fixed size.
  const hostW = host.clientWidth || 0;
  const W = hostW > 0 ? Math.max(640, Math.min(1700, Math.round(hostW))) : 780;
  const H = Math.round(Math.max(420, Math.min(620, W * 0.42)));
  const marginLeft = 56, marginRight = 24, marginTop = 24, marginBottom = 54;
  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;
  const clamp = (n) => Math.min(100, Math.max(0, n));
  const xFor = (rsi) => marginLeft + (clamp(rsi) / 100) * plotW;
  const yFor = (rsi) => marginTop + plotH - (clamp(rsi) / 100) * plotH;
  const xAxis = analysisFilters.xAxis, yAxis = analysisFilters.yAxis;

  let gridSvg = '';
  [0, 20, 40, 60, 80, 100].forEach(t => {
    gridSvg += `<line class="analysis-grid-line" x1="${xFor(t)}" y1="${marginTop}" x2="${xFor(t)}" y2="${marginTop + plotH}"></line>`;
    gridSvg += `<line class="analysis-grid-line" x1="${marginLeft}" y1="${yFor(t)}" x2="${marginLeft + plotW}" y2="${yFor(t)}"></line>`;
    gridSvg += `<text class="analysis-tick-label" x="${xFor(t)}" y="${marginTop + plotH + 16}" text-anchor="middle">${t}</text>`;
    gridSvg += `<text class="analysis-tick-label" x="${marginLeft - 8}" y="${(yFor(t) + 3).toFixed(1)}" text-anchor="end">${t}</text>`;
  });

  const quadrantLines = `
    <line class="analysis-quadrant-line" x1="${xFor(50)}" y1="${marginTop}" x2="${xFor(50)}" y2="${marginTop + plotH}"></line>
    <line class="analysis-quadrant-line" x1="${marginLeft}" y1="${yFor(50)}" x2="${marginLeft + plotW}" y2="${yFor(50)}"></line>
  `;
  const quadrantLabels = `
    <text class="analysis-quadrant-label" x="${marginLeft + plotW - 8}" y="${marginTop + 16}" text-anchor="end">Bullish both timeframes</text>
    <text class="analysis-quadrant-label" x="${marginLeft + 8}" y="${marginTop + 16}" text-anchor="start">${axisShort(yAxis)} strong, ${axisShort(xAxis)} pullback</text>
    <text class="analysis-quadrant-label" x="${marginLeft + plotW - 8}" y="${marginTop + plotH - 8}" text-anchor="end">${axisShort(xAxis)} bounce, ${axisShort(yAxis)} weak</text>
    <text class="analysis-quadrant-label" x="${marginLeft + 8}" y="${marginTop + plotH - 8}" text-anchor="start">Weak both timeframes</text>
  `;
  const axisLabels = `
    <text class="analysis-axis-label" x="${marginLeft + plotW / 2}" y="${H - 10}" text-anchor="middle">${axisTitle(xAxis)}</text>
    <text class="analysis-axis-label" x="16" y="${marginTop + plotH / 2}" text-anchor="middle" transform="rotate(-90 16 ${marginTop + plotH / 2})">${axisTitle(yAxis)}</text>
  `;
  const axisBox = `<rect class="analysis-axis-line" x="${marginLeft}" y="${marginTop}" width="${plotW}" height="${plotH}" fill="none"></rect>`;

  // MoS range slider bounds follow the data, so the full range always means "no MoS filter".
  const mosBoundLo = Math.floor(mosMin), mosBoundHi = Math.max(Math.ceil(mosMax), Math.floor(mosMin) + 1);

  return { W, H, xFor, yFor, radiusForMos, mosBoundLo, mosBoundHi, gridSvg, axisBox, quadrantLines, quadrantLabels, axisLabels };
}

export { chartGeometry, valueFor };
