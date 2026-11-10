// CSV text parser.

// One character inside a quoted field: "" is a quote, a single " ends the quotes, anything else is text.
function quotedChar(st, c, next){
  if(c === '"' && next === '"'){ st.field += '"'; st.i++; return; }
  if(c === '"'){ st.inQuotes = false; return; }
  st.field += c;
}

// One character outside quotes: " opens quotes, , ends the field, a line feed ends the row, a carriage return is skipped.
function plainChar(st, c){
  if(c === '"'){ st.inQuotes = true; return; }
  if(c === ','){ st.row.push(st.field); st.field = ''; return; }
  if(c === '\r') return;
  if(c === '\n'){ st.row.push(st.field); st.rows.push(st.row); st.row = []; st.field = ''; return; }
  st.field += c;
}

/**
 * Minimal RFC4180-ish parser: handles quoted fields containing commas/newlines. Blank rows are dropped.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCSV(text){
  /** @type {{ rows: string[][], row: string[], field: string, inQuotes: boolean, i: number }} */
  const st = { rows: [], row: [], field: '', inQuotes: false, i: 0 };
  for(; st.i < text.length; st.i++){
    if(st.inQuotes) quotedChar(st, text[st.i], text[st.i + 1]); else plainChar(st, text[st.i]);
  }
  if(st.field.length || st.row.length){ st.row.push(st.field); st.rows.push(st.row); }
  return st.rows.filter(r => r.some(v => v.trim() !== ''));
}

export { parseCSV };
