// CSV text parser.

function parseCSV(text){
  // Minimal RFC4180-ish parser: handles quoted fields containing commas/newlines.
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i], next = text[i+1];
    if(inQuotes){
      if(c === '"' && next === '"'){ field += '"'; i++; }
      else if(c === '"'){ inQuotes = false; }
      else { field += c; }
    } else {
      if(c === '"'){ inQuotes = true; }
      else if(c === ','){ row.push(field); field = ''; }
      else if(c === '\r'){ /* skip */ }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

export { parseCSV };
