// Made-up CSV data shared by the engine tests and the import tests: a screener.in style company table and a TradingView style
// technical table. Values come from a seeded pseudo-random sequence so every run sees the same numbers.
function createData(seedStart){
let seed = seedStart;
const setSeed = n => { seed = n; };
const TV_HEADER = ['Symbol', 'Description', 'Price', 'Price change % 1 week', 'Price change % 1 month',
  'Moving Average Convergence Divergence Level (12, 26) 1 month', 'Moving Average Convergence Divergence Signal (12, 26) 1 month',
  'Moving Average Convergence Divergence Level (12, 26) 1 week', 'Moving Average Convergence Divergence Signal (12, 26) 1 week',
  'Relative Strength Index (14) 1 month', 'Relative Strength Index (14) 1 week'];
const tvCsv = (rows, header) => [(header || TV_HEADER).map(h => /,/.test(h) ? '"' + h + '"' : h).join(','), ...rows.map(r => r.join(','))].join('\n');
const FUND_HEADER = ['Name', 'BSE Code', 'NSE Code', 'ISIN Code', 'Industry', 'Industry Group', 'Current Price', 'Intrinsic Value', 'Book Value', 'Profit growth',
  'Profit growth 3Years', 'Profit growth 5Years', 'Sales growth 3Years', 'Return on invested capital', 'Return on capital employed', 'Return on equity', 'OPM',
  'Price to Earning', 'Industry PE', 'PEG Ratio', 'Pledged percentage', 'Interest Coverage', 'Debt to equity', 'Change in promoter holding', 'Piotroski score',
  'Quick ratio', 'Altman Z Score', 'Current ratio', 'Contingent liabilities', 'Average return on equity 7Years', 'Average return on equity 10Years',
  'Median return on capital employed 10Years', 'Free cash flow 3years', 'Free cash flow 5years', 'Operating cash flow 3years', 'Operating cash flow 5years', 'CROIC',
  'Graham', 'Change in FII holding 3Years', 'Change in DII holding 3Years', 'Historical PE 5Years', 'Average Debtor days 3Years', 'NCAVPS', 'Number of Shareholders'];
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const rv = (lo, hi, d = 2) => (lo + rnd() * (hi - lo)).toFixed(d);
// one made-up company row; `over` replaces named columns
function fundRow(sym, group, industry, over){
  const price = +rv(50, 900, 1), row = {
    'Name': 'Company ' + sym, 'BSE Code': String(500000 + Math.floor(rnd() * 90000)), 'NSE Code': sym, 'ISIN Code': 'INE' + sym, 'Industry': industry, 'Industry Group': group,
    'Current Price': price, 'Intrinsic Value': (price * (0.6 + rnd())).toFixed(1), 'Book Value': rv(10, 300, 1), 'Profit growth': rv(-20, 80, 1), 'Profit growth 3Years': rv(-5, 40, 1),
    'Profit growth 5Years': rv(-5, 35, 1), 'Sales growth 3Years': rv(-5, 30, 1), 'Return on invested capital': rv(2, 35, 1), 'Return on capital employed': rv(3, 40, 1),
    'Return on equity': rv(2, 35, 1), 'OPM': rv(3, 40, 1), 'Price to Earning': rv(6, 60, 1), 'Industry PE': rv(12, 30, 1), 'PEG Ratio': rv(0.2, 3, 2),
    'Pledged percentage': rv(0, 40, 1), 'Interest Coverage': rv(0.5, 30, 1), 'Debt to equity': rv(0, 2, 2), 'Change in promoter holding': rv(-5, 3, 2),
    'Piotroski score': Math.floor(rnd() * 10), 'Quick ratio': rv(0.3, 3, 2), 'Altman Z Score': rv(0.5, 8, 2), 'Current ratio': rv(0.5, 3, 2), 'Contingent liabilities': rv(0, 500, 1),
    'Average return on equity 7Years': rv(2, 30, 1), 'Average return on equity 10Years': rv(2, 30, 1), 'Median return on capital employed 10Years': rv(3, 30, 1),
    'Free cash flow 3years': rv(-50, 300, 1), 'Free cash flow 5years': rv(-50, 300, 1), 'Operating cash flow 3years': rv(-20, 400, 1), 'Operating cash flow 5years': rv(-20, 400, 1),
    'CROIC': rv(-5, 30, 1), 'Graham': rv(20, 900, 1), 'Change in FII holding 3Years': rv(-4, 6, 2), 'Change in DII holding 3Years': rv(-4, 6, 2),
    'Historical PE 5Years': rv(8, 50, 1), 'Average Debtor days 3Years': rv(10, 150, 1), 'NCAVPS': rv(-100, 100, 1), 'Number of Shareholders': Math.floor(rnd() * 90000) };
  return Object.assign(row, over || {});
}
const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const fundCsv = (rows, header) => { const h = header || FUND_HEADER; return [h.map(esc).join(','), ...rows.map(r => h.map(c => esc(r[c])).join(','))].join('\n'); };

return { TV_HEADER, FUND_HEADER, tvCsv, fundCsv, fundRow, rnd, rv, setSeed, esc };
}
module.exports = { createData };
