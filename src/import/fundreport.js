// What the Fundamental import tells the person: the check of the uploaded file's columns, the warning for a thin file, the note saved with the job and
// the lines of the result card. Pure: numbers and lists in, text out.

// The 44 columns of the screener.in export the import needs.
const FI_COLUMNS = ['Name','BSE Code','NSE Code','ISIN Code','Industry Group','Industry','Current Price','Intrinsic Value','Book value','Profit growth','Profit growth 3Years','Profit growth 5Years','Sales growth 3Years','Return on invested capital','Return on capital employed','Return on equity','OPM','Price to Earning','Industry PE','PEG Ratio','Pledged percentage','Interest Coverage','Debt to equity','Change in promoter holding','Piotroski score','Quick ratio','Altman Z Score','Current ratio','Contingent liabilities','Average return on equity 7Years','Average return on equity 10Years','Median return on capital employed 10Years','Free cash flow 3years','Free cash flow 5years','Operating cash flow 3years','Operating cash flow 5years','CROIC','Graham','Change in FII holding 3Years','Change in DII holding 3Years','Historical PE 5Years','Average debtor days 3years','NCAVPS','Number of Shareholders'];

const IN = (n) => n.toLocaleString('en-IN');
// "a, b, c … +n" for a long list.
const listed = (items, max) => items.slice(0, max).join(', ') + (items.length > max ? ' … +' + (items.length - max) : '');
const VERDICTS = [['buy', 'Strong'], ['mbuy', 'Good'], ['hold', 'Hold'], ['avoid', 'Avoid']];
const mixText = (before, after, joiner, arrow) => VERDICTS.map(([k, label]) => label + ' ' + (before[k] || 0) + arrow + (after[k] || 0)).join(joiner) + '.';

/** The error text when the file's header lacks columns of the expected layout, or null when it matches. */
function fundColumnsError(csvText){
  const header = (csvText.split(/\r?\n/, 1)[0] || '').split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  const missing = FI_COLUMNS.filter((c) => !header.includes(c.toLowerCase()));
  if(!missing.length) return null;
  return 'the file does not match the expected 44-column screener.in layout. Missing: ' + missing.slice(0, 6).join(', ') + (missing.length > 6 ? ' … +' + (missing.length - 6) : '') + '.';
}

/** The warning for a file that covers few of the dashboard's stocks, or null. */
function thinFileWarning(rescored, total){
  if(rescored >= 1500) return null;
  return 'Only ' + IN(rescored) + ' of the ' + IN(total) + ' dashboard stocks are in this file (a full Screener.in export has about 2,100 or more), so every other stock keeps its old data and its old refresh date. That usually means a filtered or partial export.';
}

/** The note saved with the finished job. `res` is the engine's result; `before` / `after` count the stocks per verdict. */
function importNote(res, before, after){
  return 'Imported in the page: ' + res.rescored + ' rescored, ' + res.onboarded.length + ' new, ' + res.dropped.length + ' left unchanged, ' + res.inactive.length + ' marked inactive (not in the file). ' + mixText(before, after, ', ', '→');
}

/** The new stocks the file gave no Intrinsic Value for (symbols), so they have no valuation or technical score yet. */
function newWithoutValue(stocks, onboarded, symOf){
  return stocks.filter((s) => onboarded.includes(symOf(s)) && !(s.pillars && typeof s.pillars.val === 'number')).map(symOf);
}

const MUTED = 'fi-line fi-line-muted';
/** The lines of the result card. `info` = { res, before, chk, nothing, noVal, logErr }. */
function importResultLines(info){
  const { res, before, chk, nothing, noVal, logErr } = info, lines = [
    { text: nothing ? 'Import complete: the file produced no changes to the stored data.' : 'Import complete.', cls: 'fi-line fi-line-strong' },
    { text: IN(res.rescored) + ' stocks rescored · ' + res.onboarded.length + ' new · ' + res.inactive.length + ' not in the file (marked inactive: hidden and no longer refreshed).' },
    { text: mixText(before, res.verdictMix, ' · ', ' → ') },
    { text: chk.moved + ' stocks moved by 1.0 point or more (largest move ' + chk.maxMove.toFixed(2) + ').' }];
  if(res.duplicates && res.duplicates.length) lines.push({ text: 'The file lists ' + listed(res.duplicates, 10) + ' on more than one row; only the first row of each was used.' });
  if(res.onboarded.length) lines.push({ text: 'New: ' + listed(res.onboarded, 15) + '. They use the default Screener.in link and ' + (res.bseOnly.length ? 'have no TradingView chart mapping yet (BSE-only: ' + res.bseOnly.slice(0, 10).join(', ') + (res.bseOnly.length > 10 ? ' …' : '') + ').' : 'need no chart mapping.'), cls: MUTED });
  if(noVal.length) lines.push({ text: noVal.length + ' new stock' + (noVal.length === 1 ? ' has' : 's have') + ' no Intrinsic Value in the file, so no valuation or technical score yet: ' + listed(noVal, 10) + '.', cls: MUTED });
  if(logErr) lines.push({ text: 'The data is saved, but the upload record could not be marked as imported (' + logErr + '), so the Last file loaded card may still say "not imported".' });
  return lines;
}

export { fundColumnsError, importNote, importResultLines, newWithoutValue, thinFileWarning };
