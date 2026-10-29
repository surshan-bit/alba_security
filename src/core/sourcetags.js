// Where each statement in a factor card's written analysis comes from, and whether its figures can be found in the data.
// Pure helpers (no imports): used when a Fundamental refresh saves the research and when the stock page draws it.
//   CSV            the imported screener.in data (the metric rows)
//   TradingView    financials, analyst forecasts, news headlines and filings handed to Claude during the refresh
//   Claude's view  a judgement rather than a figure
// A figure in a bullet counts as "found" when the same number appears in the metric rows or in the TradingView text Claude was given;
// anything else is shown as "not verified" instead of being trusted.

const BASIS_LABEL = {
  csv: 'CSV',
  tv: 'TradingView',
  'tv-financials': 'TradingView financials',
  'tv-forecasts': 'TradingView forecasts',
  'tv-news': 'TradingView news',
  'tv-filings': 'TradingView filings',
  claude: "Claude's view"
};
const BASIS_ORDER = ['csv', 'tv-financials', 'tv-forecasts', 'tv-news', 'tv-filings', 'claude'];
// The prompt sections of a Fundamental refresh, and the source each one is shown as.
const SECTION_BASIS = { fin: 'tv-financials', finLite: 'tv-financials', fc: 'tv-forecasts', fcLite: 'tv-forecasts', news: 'tv-news', newsLite: 'tv-news', stories: 'tv-news', docs: 'tv-filings' };
const SCALE = { crore: 1e7, cr: 1e7, lakh: 1e5, million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9 };

const hayNumbers = text => (String(text).match(/-?\d[\d,]*(?:\.\d+)?/g) || []).map(x => Math.abs(parseFloat(x.replace(/,/g, '')))).filter(Number.isFinite);

// The figures in a sentence that can be checked: skips years, dates, "3-year", ordinals, "FY23" and bare numbers under 10.
function numbersIn(text) {
  const out = [], re = /(?<![A-Za-z\d.])(?<!\d-)(\d[\d,]*(?:\.\d+)?)(\s*(?:crore|cr\b|lakh|million|billion|bn\b|mn\b|%|x\b|times))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1], unit = (m[2] || '').trim().toLowerCase(), after = text.slice(m.index + m[0].length, m.index + m[0].length + 9);
    const v = parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    if (/^-\d/.test(after) || /^-?\s?(year|yr|day|month|quarter|week|th\b|st\b|nd\b|rd\b)/i.test(after)) continue;
    if (!unit && Number.isInteger(v) && ((v >= 1900 && v <= 2100) || v < 10)) continue;
    out.push({ v, dec: (raw.split('.')[1] || '').length, unit });
  }
  return out;
}
function matches(h, n) {
  const f = Math.pow(10, n.dec), same = x => Math.abs(Math.round(x * f) / f - n.v) < 1e-9 || Math.abs(Math.floor(x * f) / f - n.v) < 1e-9 || Math.abs(x - n.v) <= n.v * 0.005;
  if (same(h)) return true;
  if (SCALE[n.unit] && same(h / SCALE[n.unit])) return true;
  return n.unit === '%' && h <= 5 && same(h * 100);
}

// Lists of known figures, in the order they are credited: the metric rows first, then each TradingView section.
function haystacks(ctx) {
  if (ctx.__hay) return ctx.__hay;
  /** @type {Record<string, number[]>} */
  const by = { csv: [] };
  (ctx.chips || []).forEach(([, v]) => by.csv.push(...hayNumbers(v)));
  Object.keys(ctx.tv || {}).forEach(b => { by[b] = (by[b] || []).concat(hayNumbers(ctx.tv[b])); });
  (ctx.facts || []).forEach(f => { by[f.basis] = (by[f.basis] || []).concat(hayNumbers(f.value)); });
  ctx.__hay = BASIS_ORDER.filter(b => by[b]).map(b => ({ basis: b, nums: by[b] }));
  return ctx.__hay;
}
// Every number in a short value such as "5 buy · 1 hold · 0 sell" (nothing skipped: each one must be found).
function allNumbers(text) {
  const out = [], re = /(\d[\d,]*(?:\.(\d+))?)(\s*(crore|cr\b|lakh|million|billion|bn\b|mn\b|%))?/gi;
  let m;
  while ((m = re.exec(text))) out.push({ v: parseFloat(m[1].replace(/,/g, '')), dec: (m[2] || '').length, unit: (m[4] || '').toLowerCase() });
  return out;
}
const clip = (x, n) => String(x == null ? '' : x).trim().slice(0, n);

// Figures Claude offers as extra rows: only a figure found in the TradingView text is kept, with the section it was found in.
function cleanFacts(raw, ctx) {
  const taken = new Set((ctx.chips || []).map(x => x[0])), out = [];
  const tvOnly = { tv: ctx.tv, chips: [] };
  (Array.isArray(raw) ? raw : []).forEach(x => {
    if (out.length >= 4 || !x || typeof x !== 'object') return;
    const label = clip(x.label, 60), value = clip(x.value, 40);
    if (!label || !value || taken.has(label) || !/\d/.test(value)) return;
    const nums = allNumbers(value);
    let basis = null;
    const hays = haystacks(tvOnly);
    for (const n of nums) {
      const hit = hays.find(h => h.nums.some(k => matches(k, n)));
      if (!hit) return;
      basis = basis || hit.basis;
    }
    taken.add(label);
    out.push({ label, value, basis, tone: ['pos', 'neg', 'neu'].includes(x.tone) ? x.tone : 'neu', note: clip(x.note, 120) });
  });
  return out;
}

// One bullet from Claude (a string, or { text, view, refs, url, basis }): its source tags, the metric rows it relies on and whether
// its figures were found. ctx: { chips, facts, tv, allowedUrls, titles, labels }.
function tagPoint(raw, ctx) {
  const text = clip(typeof raw === 'string' ? raw : raw && raw.text, 300);
  if (!text) return null;
  const r = raw && typeof raw === 'object' ? raw : {}, basis = new Set(), hays = haystacks(ctx);
  let ok = true;
  const nums = numbersIn(text);
  nums.forEach(n => { const hit = hays.find(h => h.nums.some(k => matches(k, n))); if (hit) basis.add(hit.basis); else ok = false; });
  if (!nums.length) (Array.isArray(r.basis) ? r.basis : []).forEach(b => { if (BASIS_LABEL[b]) basis.add(b); });
  const url = typeof r.url === 'string' && ctx.allowedUrls && ctx.allowedUrls.has(r.url) ? r.url : '';
  if (url) basis.add('tv-news');
  if (r.view === true || !basis.size) basis.add('claude');
  const refs = [...new Set((Array.isArray(r.refs) ? r.refs : []).filter(l => typeof l === 'string' && ctx.labels && ctx.labels.has(l)))].slice(0, 4);
  const out = { text, basis: BASIS_ORDER.filter(b => basis.has(b)), refs, ok };
  if (url) { out.url = url; const t = ctx.titles && ctx.titles.get(url); if (t) out.src = clip(t, 140); }
  return out;
}

export { BASIS_LABEL, SECTION_BASIS, cleanFacts, tagPoint };
