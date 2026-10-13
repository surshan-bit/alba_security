// The controls above the Analysis chart: the three range sliders (Weekly RSI, Monthly RSI, MoS) and the
// X-axis / Y-axis / colour toggles. Their state lives in analysisFilters, outside the render, so it
// survives leaving the section and coming back.
import { analysisFilters, saveAnalysisFilters } from './state.js';

const mosClamper = (lo, hi) => (v) => Math.min(hi, Math.max(lo, v));

function toggleGroup(label, attr, current, ids){
  const btn = (value, text) => `<button type="button" class="analysis-color-btn${current === value ? ' active' : ''}" id="${ids[value]}" data-${attr}="${value}">${text}</button>`;
  return `<div class="analysis-color-toggle">
        <div class="analysis-color-toggle-label">${label}</div>
        <div class="analysis-color-toggle-btns">
          ${btn('week', 'W RSI')}
          ${btn('month', 'M RSI')}
        </div>
      </div>`;
}

function rangeSlider(label, labelId, labelText, idPrefix, min, max, lo, hi, minAria, maxAria){
  return `<div class="analysis-filter">
        <div class="analysis-filter-label">${label}: <span id="${labelId}">${labelText}</span></div>
        <div class="range-slider">
          <div class="range-track"></div>
          <input type="range" min="${min}" max="${max}" step="1" value="${lo}" id="${idPrefix}MinInput" class="range-min" aria-label="${minAria}">
          <input type="range" min="${min}" max="${max}" step="1" value="${hi}" id="${idPrefix}MaxInput" class="range-max" aria-label="${maxAria}">
        </div>
      </div>`;
}

function analysisControlsHtml(mosBoundLo, mosBoundHi){
  const f = analysisFilters;
  const mosClamp = mosClamper(mosBoundLo, mosBoundHi);
  const mosCurLo = f.mosLo === null ? mosBoundLo : mosClamp(f.mosLo);
  const mosCurHi = f.mosHi === null ? mosBoundHi : mosClamp(f.mosHi);
  return `<div class="analysis-filters">
      ${rangeSlider('W RSI range', 'weekRsiRangeLabel', `${f.weekMin}&ndash;${f.weekMax}`, 'weekRsi', 0, 100, f.weekMin, f.weekMax, 'W RSI minimum', 'W RSI maximum')}
      ${rangeSlider('M RSI range', 'monthRsiRangeLabel', `${f.monthMin}&ndash;${f.monthMax}`, 'monthRsi', 0, 100, f.monthMin, f.monthMax, 'M RSI minimum', 'M RSI maximum')}
      ${rangeSlider('MoS range', 'mosRangeLabel', '', 'mos', mosBoundLo, mosBoundHi, mosCurLo, mosCurHi, 'Margin of Safety minimum', 'Margin of Safety maximum')}
      <div class="analysis-toggles">
      ${toggleGroup('X-axis:', 'axis-value', f.xAxis, { week: 'xAxisWeekBtn', month: 'xAxisMonthBtn' })}
      ${toggleGroup('Y-axis:', 'axis-value', f.yAxis, { week: 'yAxisWeekBtn', month: 'yAxisMonthBtn' })}
      ${toggleGroup('Colour dots by:', 'color-by', f.colorBy, { week: 'colorByWeekBtn', month: 'colorByMonthBtn' })}
      </div>
    </div>`;
}

// Two overlapping single-thumb <input type=range> per axis, the standard trick for a dual-handle slider
// without a library: both inputs span the full track but only their thumb is pointer-events:auto (see
// CSS), so each can only be grabbed by its own handle. When the two handles meet, they lock together.
// While a slider is dragged only `schedule()` (a redraw of the dots and table) runs, never a full render,
// which would recreate the slider under the drag and kill it. Saving happens once, on 'change' (release).
function wireSliders(schedule){
  const f = analysisFilters;
  const el = (id) => document.getElementById(id);
  const weekMinInput = el('weekRsiMinInput'), weekMaxInput = el('weekRsiMaxInput');
  const monthMinInput = el('monthRsiMinInput'), monthMaxInput = el('monthRsiMaxInput');
  const weekLabel = el('weekRsiRangeLabel'), monthLabel = el('monthRsiRangeLabel');
  function syncSliderInputs(){
    weekMinInput.value = f.weekMin;
    weekMaxInput.value = f.weekMax;
    monthMinInput.value = f.monthMin;
    monthMaxInput.value = f.monthMax;
    weekLabel.textContent = `${f.weekMin}–${f.weekMax}`;
    monthLabel.textContent = `${f.monthMin}–${f.monthMax}`;
  }
  const onInput = (input, apply) => input.addEventListener('input', () => { apply(Number(input.value)); syncSliderInputs(); schedule(); });
  onInput(weekMinInput, v => { f.weekMin = Math.min(v, f.weekMax); });
  onInput(weekMaxInput, v => { f.weekMax = Math.max(v, f.weekMin); });
  onInput(monthMinInput, v => { f.monthMin = Math.min(v, f.monthMax); });
  onInput(monthMaxInput, v => { f.monthMax = Math.max(v, f.monthMin); });
  [weekMinInput, weekMaxInput, monthMinInput, monthMaxInput].forEach(input => {
    input.addEventListener('change', () => saveAnalysisFilters(analysisFilters));
  });
}

function wireMosSlider(mosBoundLo, mosBoundHi, schedule){
  const f = analysisFilters;
  const mosClamp = mosClamper(mosBoundLo, mosBoundHi);
  const mosMinInput = document.getElementById('mosMinInput');
  const mosMaxInput = document.getElementById('mosMaxInput');
  const mosLabel = document.getElementById('mosRangeLabel');
  function syncMosInputs(){
    const lo = f.mosLo === null ? mosBoundLo : mosClamp(f.mosLo);
    const hi = f.mosHi === null ? mosBoundHi : mosClamp(f.mosHi);
    mosMinInput.value = lo; mosMaxInput.value = hi;
    mosLabel.textContent = (f.mosLo === null && f.mosHi === null) ? 'All (' + mosBoundLo + '% to ' + mosBoundHi + '%)' : lo + '% to ' + hi + '%';
  }
  function setMosRange(lo, hi){
    f.mosLo = lo <= mosBoundLo ? null : lo;
    f.mosHi = hi >= mosBoundHi ? null : hi;
    syncMosInputs();
    schedule();
  }
  syncMosInputs();
  mosMinInput.addEventListener('input', () => setMosRange(Math.min(Number(mosMinInput.value), Number(mosMaxInput.value)), Number(mosMaxInput.value)));
  mosMaxInput.addEventListener('input', () => setMosRange(Number(mosMinInput.value), Math.max(Number(mosMaxInput.value), Number(mosMinInput.value))));
  [mosMinInput, mosMaxInput].forEach(input => input.addEventListener('change', () => saveAnalysisFilters(analysisFilters)));
}

// Colour only recolours the dots, so it needs just `update()`. The X / Y axis toggles also re-label the axis
// titles and two quadrant labels, so they redraw the whole section (`rerender`); that is safe because a
// click is not a drag in progress. Only two timeframes exist, so choosing the one already on the other
// axis swaps the other axis instead of leaving both showing the same thing.
function wireToggles(update, rerender){
  const f = analysisFilters;
  const colorByBtns = [document.getElementById('colorByWeekBtn'), document.getElementById('colorByMonthBtn')];
  colorByBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      f.colorBy = btn.dataset.colorBy;
      colorByBtns.forEach(b => b.classList.toggle('active', b === btn));
      saveAnalysisFilters(analysisFilters);
      update();
    });
  });
  const axisButtons = (prefix, own, other) => {
    [document.getElementById(prefix + 'AxisWeekBtn'), document.getElementById(prefix + 'AxisMonthBtn')].forEach(btn => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.axisValue;
        if(value === f[other]) f[other] = f[own];
        f[own] = value;
        saveAnalysisFilters(analysisFilters);
        rerender();
      });
    });
  };
  axisButtons('x', 'xAxis', 'yAxis');
  axisButtons('y', 'yAxis', 'xAxis');
}

function wireAnalysisControls({ mosBoundLo, mosBoundHi, update, schedule, rerender }){
  wireMosSlider(mosBoundLo, mosBoundHi, schedule);
  wireSliders(schedule);
  wireToggles(update, rerender);
}

export { analysisControlsHtml, wireAnalysisControls };
