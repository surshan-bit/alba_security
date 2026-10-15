// CSV upload handlers on the Data Refresh page (Fundamental and Technical).
import { stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';
import { parseCSV } from './csvparse.js';
import { recordFundamentalCsvUpload, recordTechnicalCsvUpload } from './upload-history.js';
import { targetEl } from '../core/evt.js';

function tickerFromString(t){
  return t.split('·')[0].trim().toUpperCase();
}

const existingTickers = new Set(stocks.map(s => tickerFromString(s.ticker)));

// TradingView's export column order/set isn't stable week to week (confirmed against several
// real Growth List exports — some weeks include only a same-day MACD pair, others include
// separate weekly/monthly MACD columns), so columns are matched by header text, not position.
// A column is found only if every phrase in `must` appears in its (lowercased) header.
function findCol(header, must){
  return header.findIndex(h => must.every(phrase => h.includes(phrase)));
}

function parsePctCell(v){
  if(v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[%,]/g, ''));
  return isNaN(n) ? null : n;
}

// CHANGED (2026-09-29): Technical Score CSV upload never creates new stock entries — onboarding a
// brand-new ticker happens only via the Fundamental Score screener.in CSV (see
// renderFundamentalDiffResults below). So "unmatchedTickers" here (symbols in this Growth List file
// with no existing dashboard ticker) are reported as skipped, not as candidates to research/onboard.
function renderDiffResults(resultEl, fileTickers, unmatchedTickers, droppedTickers, moveByTicker, hasMoveData){
  const matchedTickers = fileTickers.filter(t => existingTickers.has(t));
  // Kept deliberately short (2026-10-09): counts only. The long ticker lists and explanatory text were removed.
  resultEl.innerHTML = `
    <div class="diff-summary">
      <div class="diff-stat"><b>${fileTickers.length}</b>In file</div>
      <div class="diff-stat"><b>${matchedTickers.length}</b>Will update</div>
      <div class="diff-stat"><b>${unmatchedTickers.length}</b>Not tracked (skipped)</div>
      <div class="diff-stat"><b>${droppedTickers.length}</b>Not in file</div>
    </div>
  `;
}

// Fundamental Score's diff preview is simpler than Technical's: there's no weekly price-move data
// in a screener.in export, and (per "current logic always") every matched ticker gets its
// Fundamental Score fully recomputed unconditionally — there's no trigger/flagging concept here.
function renderFundamentalDiffResults(resultEl, fileTickers, newTickers, droppedTickers){
  const alreadyScored = fileTickers.length - newTickers.length;
  const newLine = newTickers.length
    ? `<div class="upload-hint">New: ${newTickers.slice(0, 12).map(escapeHtml).join(', ')}${newTickers.length > 12 ? ' … +' + (newTickers.length - 12) : ''}</div>` : '';
  resultEl.innerHTML = `
    <div class="diff-summary">
      <div class="diff-stat"><b>${fileTickers.length}</b>In file</div>
      <div class="diff-stat"><b>${alreadyScored}</b>Already scored</div>
      <div class="diff-stat"><b>${newTickers.length}</b>New</div>
      <div class="diff-stat"><b>${droppedTickers.length}</b>Not in file</div>
    </div>
    ${newLine}
  `;
}

// ---- Technical Score CSV (TradingView Growth List export) — backup source ----
function processTechnicalCsvText(text){
  const resultEl = document.getElementById('technicalUploadResult');
  try {
    const rows = parseCSV(text);
    if(rows.length < 2){ throw new Error('No data rows found — check that the header row and at least one data row were included.'); }
    const header = rows[0].map(h => h.trim().toLowerCase());
    let symCol = header.findIndex(h => h === 'symbol');
    if(symCol === -1) symCol = header.findIndex(h => h.includes('symbol'));
    if(symCol === -1) throw new Error('Could not find a "Symbol" column.');

    // Best-effort — matched by header text since TradingView's own column order/set varies
    // week to week. Absence just means the "flagged for review" count can't be estimated here.
    const weekPctCol = findCol(header, ['price change', '1 week']);
    const monthPctCol = findCol(header, ['price change', '1 month']);
    const hasMoveData = weekPctCol !== -1 && monthPctCol !== -1;

    // Single pass over the CSV rows builds the ticker list, its membership set, and the
    // unmatched-ticker list together — avoids the extra full-array .filter() pass a previous
    // version ran afterward (over fileTickers again) just to split out unmatchedTickers.
    const fileTickers = [];
    const fileSet = new Set();
    const moveByTicker = new Map();
    // "unmatched" here means not yet tracked on the dashboard — a Technical Score CSV never
    // onboards these as new stocks (see renderDiffResults); onboarding is Fundamental-CSV-only.
    const unmatchedTickers = [];
    for(let i=1, n=rows.length; i<n; i++){
      const v = (rows[i][symCol] || '').trim().toUpperCase();
      if(!v) continue;
      fileTickers.push(v);
      fileSet.add(v);
      if(!existingTickers.has(v)) unmatchedTickers.push(v);
      if(hasMoveData){
        moveByTicker.set(v, {
          week: parsePctCell(rows[i][weekPctCol]),
          month: parsePctCell(rows[i][monthPctCol])
        });
      }
    }
    // One pass over the (fixed-size) existing-ticker set rather than spreading it into a new
    // array first (`[...existingTickers]`) purely to .filter() it.
    const droppedTickers = [];
    for(const t of existingTickers){
      if(!fileSet.has(t)) droppedTickers.push(t);
    }

    renderDiffResults(resultEl, fileTickers, unmatchedTickers, droppedTickers, moveByTicker, hasMoveData);
    return { rowCount: fileTickers.length, newCount: unmatchedTickers.length, droppedCount: droppedTickers.length };
  } catch(err){
    resultEl.innerHTML = `<div class="upload-error">Couldn't process this CSV: ${escapeHtml(err.message)}</div>`;
    return null;
  }
}

// ---- Fundamental Score CSV (screener.in export) — primary, always-on source ----
// screener.in exports use ISIN/NSE/BSE code columns, not TradingView's "Symbol" column, and carry
// no weekly/monthly price-change data (that's a Technical/Growth-List-only concept) — so this gets
// its own column detection and its own (simpler) diff preview rather than reusing processTechnicalCsvText.
function processFundamentalCsvText(text){
  const resultEl = document.getElementById('fundamentalUploadResult');
  try {
    const rows = parseCSV(text);
    if(rows.length < 2){ throw new Error('No data rows found — check that the header row and at least one data row were included.'); }
    const header = rows[0].map(h => h.trim().toLowerCase());
    const nseCol = header.findIndex(h => h.includes('nse') && h.includes('code'));
    const bseCol = header.findIndex(h => h.includes('bse') && h.includes('code'));
    const isinCol = header.findIndex(h => h.includes('isin'));
    if(nseCol === -1 && bseCol === -1 && isinCol === -1){
      throw new Error('Could not find an "NSE Code", "BSE Code" or "ISIN Code" column — this doesn\'t look like a screener.in export.');
    }

    // Single pass over the CSV rows builds the ticker list, its membership set, and the
    // new-ticker list together — avoids the extra full-array .filter() pass the previous
    // version ran afterward (over fileTickers again) just to split out newTickers.
    const fileTickers = [];
    const fileSet = new Set();
    const newTickers = [];
    for(let i=1, n=rows.length; i<n; i++){
      const r = rows[i];
      const nse = nseCol !== -1 ? (r[nseCol] || '').trim() : '';
      let sym = nse;
      if(!sym && bseCol !== -1){
        const bseRaw = (r[bseCol] || '').trim();
        if(bseRaw){
          const bseNum = parseInt(bseRaw, 10);
          sym = isNaN(bseNum) ? bseRaw : String(bseNum);
        }
      }
      sym = sym.trim().toUpperCase();
      if(!sym) continue;
      fileTickers.push(sym);
      fileSet.add(sym);
      if(!existingTickers.has(sym)) newTickers.push(sym);
    }
    if(fileTickers.length === 0){ throw new Error('Found the identifying column(s) but no rows had an NSE or BSE code to match against.'); }

    // One pass over the (fixed-size) existing-ticker set rather than spreading it into a new
    // array first (`[...existingTickers]`) purely to .filter() it — avoids allocating and
    // copying a ~2000+ element array on every single CSV preview.
    const droppedTickers = [];
    for(const t of existingTickers){
      if(!fileSet.has(t)) droppedTickers.push(t);
    }

    renderFundamentalDiffResults(resultEl, fileTickers, newTickers, droppedTickers);
    return { rowCount: fileTickers.length, newCount: newTickers.length, droppedCount: droppedTickers.length };
  } catch(err){
    resultEl.innerHTML = `<div class="upload-error">Couldn't process this CSV: ${escapeHtml(err.message)}</div>`;
    return null;
  }
}

function handleTechnicalCsvFile(file){
  const resultEl = document.getElementById('technicalUploadResult');
  resultEl.innerHTML = `<div class="upload-hint">Reading ${escapeHtml(file.name)}…</div>`;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    const stats = processTechnicalCsvText(text);
    recordTechnicalCsvUpload(file, text, stats);
  };
  reader.onerror = () => {
    resultEl.innerHTML = `<div class="upload-error">Couldn't read this file. Please try again.</div>`;
  };
  reader.readAsText(file);
}

function handleFundamentalCsvFile(file){
  const resultEl = document.getElementById('fundamentalUploadResult');
  resultEl.innerHTML = `<div class="upload-hint">Reading ${escapeHtml(file.name)}…</div>`;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    const stats = processFundamentalCsvText(text);
    recordFundamentalCsvUpload(file, text, stats);
  };
  reader.onerror = () => {
    resultEl.innerHTML = `<div class="upload-error">Couldn't read this file. Please try again.</div>`;
  };
  reader.readAsText(file);
}

const technicalCsvInputEl = document.getElementById('technicalCsvInput');

const fundamentalCsvInputEl = document.getElementById('fundamentalCsvInput');

function init_import_csv_upload(){
if(technicalCsvInputEl){
  technicalCsvInputEl.addEventListener('change', e => {
    const file = targetEl(e).files && targetEl(e).files[0];
    if(file) handleTechnicalCsvFile(file);
  });
}
if(fundamentalCsvInputEl){
  fundamentalCsvInputEl.addEventListener('change', e => {
    const file = targetEl(e).files && targetEl(e).files[0];
    if(file) handleFundamentalCsvFile(file);
  });
}

}

export { init_import_csv_upload };
