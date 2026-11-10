// CSV upload handler on the Data Refresh page (the Fundamental Score file).
import { stocks } from '../core/stocks.js';
import { escapeHtml } from '../core/util.js';
import { parseCSV } from './csvparse.js';
import { recordFundamentalCsvUpload } from './upload-history.js';
import { targetEl } from '../core/evt.js';
import { setHtml } from '../core/safehtml.js';

function tickerFromString(t){
  return t.split('·')[0].trim().toUpperCase();
}

const existingTickers = new Set(stocks.map(s => tickerFromString(s.ticker)));

// Fundamental Score's diff preview is simpler than Technical's: there's no weekly price-move data
// in a screener.in export, and (per "current logic always") every matched ticker gets its
// Fundamental Score fully recomputed unconditionally — there's no trigger/flagging concept here.
function renderFundamentalDiffResults(resultEl, fileTickers, newTickers, droppedTickers){
  const alreadyScored = fileTickers.length - newTickers.length;
  const newLine = newTickers.length
    ? `<div class="upload-hint">New: ${newTickers.slice(0, 12).map(escapeHtml).join(', ')}${newTickers.length > 12 ? ' … +' + (newTickers.length - 12) : ''}</div>` : '';
  setHtml(resultEl, `
    <div class="diff-summary">
      <div class="diff-stat"><b>${fileTickers.length}</b>In file</div>
      <div class="diff-stat"><b>${alreadyScored}</b>Already scored</div>
      <div class="diff-stat"><b>${newTickers.length}</b>New</div>
      <div class="diff-stat"><b>${droppedTickers.length}</b>Not in file</div>
    </div>
    ${newLine}
  `);
}

// ---- Fundamental Score CSV (screener.in export) — primary, always-on source ----
// screener.in exports use ISIN/NSE/BSE code columns, not TradingView's "Symbol" column, and carry
// no weekly/monthly price-change data (that's a Technical/Growth-List-only concept) — so this gets
// its own column detection and its own (simpler) diff preview rather than reusing processTechnicalCsvText.
// Which columns hold the NSE, BSE and ISIN codes (-1 when a column is missing). Throws when there is none of them.
function identityColumns(headerRow){
  const header = headerRow.map(h => h.trim().toLowerCase());
  const nseCol = header.findIndex(h => h.includes('nse') && h.includes('code'));
  const bseCol = header.findIndex(h => h.includes('bse') && h.includes('code'));
  const isinCol = header.findIndex(h => h.includes('isin'));
  if(nseCol === -1 && bseCol === -1 && isinCol === -1){
    throw new Error('Could not find an "NSE Code", "BSE Code" or "ISIN Code" column — this doesn\'t look like a screener.in export.');
  }
  return { nseCol, bseCol };
}

// A row's symbol: its NSE code, else its BSE code (a number is written without leading zeros), upper case; '' when it has neither.
function rowSymbol(r, { nseCol, bseCol }){
  let sym = nseCol !== -1 ? (r[nseCol] || '').trim() : '';
  const bseRaw = !sym && bseCol !== -1 ? (r[bseCol] || '').trim() : '';
  if(bseRaw){
    const bseNum = parseInt(bseRaw, 10);
    sym = isNaN(bseNum) ? bseRaw : String(bseNum);
  }
  return sym.trim().toUpperCase();
}

// Single pass over the CSV rows builds the ticker list, its membership set, and the
// new-ticker list together — avoids the extra full-array .filter() pass the previous
// version ran afterward (over fileTickers again) just to split out newTickers.
function readFileTickers(rows, cols){
  const fileTickers = [], fileSet = new Set(), newTickers = [];
  for(let i=1, n=rows.length; i<n; i++){
    const sym = rowSymbol(rows[i], cols);
    if(!sym) continue;
    fileTickers.push(sym);
    fileSet.add(sym);
    if(!existingTickers.has(sym)) newTickers.push(sym);
  }
  return { fileTickers, fileSet, newTickers };
}

function processFundamentalCsvText(text){
  const resultEl = document.getElementById('fundamentalUploadResult');
  try {
    const rows = parseCSV(text);
    if(rows.length < 2){ throw new Error('No data rows found — check that the header row and at least one data row were included.'); }
    const { fileTickers, fileSet, newTickers } = readFileTickers(rows, identityColumns(rows[0]));
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
    setHtml(resultEl, `<div class="upload-error">Couldn't process this CSV: ${escapeHtml(err.message)}</div>`);
    return null;
  }
}

function handleFundamentalCsvFile(file){
  const resultEl = document.getElementById('fundamentalUploadResult');
  setHtml(resultEl, `<div class="upload-hint">Reading ${escapeHtml(file.name)}…</div>`);
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    const stats = processFundamentalCsvText(text);
    recordFundamentalCsvUpload(file, text, stats);
  };
  reader.onerror = () => {
    setHtml(resultEl, `<div class="upload-error">Couldn't read this file. Please try again.</div>`);
  };
  reader.readAsText(file);
}

const fundamentalCsvInputEl = document.getElementById('fundamentalCsvInput');

function init_import_csv_upload(){
if(fundamentalCsvInputEl){
  fundamentalCsvInputEl.addEventListener('change', e => {
    const file = targetEl(e).files && /** @type {FileList} */ (targetEl(e).files)[0];
    if(file) handleFundamentalCsvFile(file);
  });
}

}

export { init_import_csv_upload };
