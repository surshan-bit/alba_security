// Maps the column headings of Screener's peer-comparison table to the field names the Alba fundamental engine reads
// (src/import/fund-engine.js, extractRecords). Headings are matched after lower-casing and dropping everything that is not a letter or digit,
// so "Debt / Eq" and "debt/eq" are the same. The peer table's columns are the ones saved in the Screener account that logs in.

export const norm = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// engine field -> accepted normalised headings (the first is the heading seen on the account used for the PASUPTAC check)
export const FIELDS = {
  de: ['debteq', 'debttoequity'],
  interestCoverage: ['interestcoverage', 'intcov'],
  quickRatio: ['quickrat', 'quickratio'],
  currentRatio: ['currentratio'],
  altmanZ: ['altmanzscr', 'altmanz'],
  avgDebtorDays3: ['debtordays3yrs', 'debtordays3yr'],
  contingentLiabilities: ['contliabrscr', 'contingentliabilitiesrscr'],
  roce: ['roce'],
  roe: ['roe'],
  opm: ['opm'],
  medianRoce10: ['medroce10yr', 'medianroce10yr'],
  avgRoe7: ['roe7yr'],
  avgRoe10: ['roe10yr'],
  salesGrowth3: ['salesvar3yrs', 'salesvar3yr'],
  profitGrowth3: ['profitvar3yrs', 'profitvar3yr'],
  profitGrowth5: ['profitvar5yrs', 'profitvar5yr'],
  profitGrowthTTM: ['profitgrowth'],
  fcf3: ['freecashflow3yrsrscr', 'freecashflow3yrrscr'],
  fcf5: ['freecashflow5yrsrscr', 'freecashflow5yrrscr'],
  ocf3: ['cfopr3yrsrscr', 'cfopr3yrrscr'],
  ocf5: ['cfopr5yrsrscr', 'cfopr5yrrscr'],
  pe: ['pe'],
  industryPe: ['indpe', 'industrype'],
  peg: ['peg'],
  histPe5: ['5yrspe', '5yrpe'],
  intrinsicValue: ['ivrs', 'intrinsicvaluers'],
  graham: ['grahampricers', 'grahamnumberrs'],
  ncavps: ['ncavpsrs', 'ncavps'],
  piotroski: ['piotskiscr', 'piotroskiscr', 'piotroskiscore'],
  pledgePct: ['pledged'],
  promoterHoldingChange: ['changeinpromhold', 'chginpromhold'],
  fiiChange3: ['chginfiihold3yr', 'changeinfiihold3yr'],
  diiChange3: ['chgindiihold3yr', 'changeindiihold3yr'],
  croic: ['croic'],
  roic: ['roic'],
  currentPrice: ['cmprs', 'cmp', 'currentprice'],
  bookValue: ['bvrs', 'bookvaluers', 'bookvalue'],
  marketCap: ['marcaprscr', 'mcaprscr', 'marketcaprscr'],
};

const BY_HEADING = new Map();
for (const [field, names] of Object.entries(FIELDS)) for (const n of names) if (!BY_HEADING.has(n)) BY_HEADING.set(n, field);

// "1,234.5" -> 1234.5, "12.3%" -> 12.3, "-", "" and "NA" -> null
export function toNumber(text){
  const t = String(text == null ? '' : text).replace(/,/g, '').replace(/%/g, '').trim();
  if(t === '' || t === '-' || /^n\/?a$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// One peer-table row (cells in the order of `headers`) -> { record, unmatched: [headings nobody reads], missing: [engine fields with no column or no value] }
export function toRecord(headers, cells){
  const record = {}, unmatched = [];
  headers.forEach((h, i) => {
    const key = BY_HEADING.get(norm(h));
    if(key === undefined){ if(i > 1) unmatched.push(h); return; }
    if(!(key in record)) record[key] = toNumber(cells[i]);
  });
  const missing = Object.keys(FIELDS).filter(f => record[f] == null && f !== 'marketCap' && f !== 'bookValue');   // read by the CSV import but not used in any score
  for(const f of Object.keys(FIELDS)) if(!(f in record)) record[f] = null;
  return { record, unmatched, missing };
}
