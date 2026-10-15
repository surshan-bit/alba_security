// Small shared helpers: ids, escaping, date and size formatting.

function sanitizeDocId(id){
  return String(id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_') || 'x';
}

function tickerSymbol(s){
  return s.ticker.split('·')[0].trim();
}

// Industry portion of the ticker field (format "<SYMBOL> · <Industry>"). Used by the Analysis
// section's leaderboard Industry column — added 2026-10-06.
function tickerIndustry(s){
  const parts = s.ticker.split('·');
  return parts.length > 1 ? parts[1].trim() : '—';
}

function formatDeepRefreshTimestamp(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {day:'numeric', month:'short', hour:'numeric', minute:'2-digit', timeZone:'Asia/Kolkata'}) + ' IST';
}

function formatRequestedAt(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {day:'numeric', month:'short', hour:'numeric', minute:'2-digit'});
}
function daysSinceDate(str){
  if(!str) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str));
  const d = dateOnly ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]) : new Date(String(str));
  if(isNaN(d.getTime())) return null;
  const now = new Date();
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
}

function formatDate(iso){
  if(!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if(isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'});
}
// ---- Weekly CSV upload / diff ----
function escapeHtml(str){
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function formatUploadTimestamp(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit', timeZone:'Asia/Kolkata'}) + ' IST';
}

function formatBytes(n){
  if(n == null) return '';
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/(1024*1024)).toFixed(1) + ' MB';
}

function pctChangeSpan(pct){
  if(pct == null) return '–';
  const cls = pct > 0 ? 'chg-up' : (pct < 0 ? 'chg-down' : '');
  return `<span class="${cls}">${pct>0?'+':''}${(pct).toFixed(2)}%</span>`;
}

// The stock's page on screener.in. The consolidated page is the default (the plain page shows standalone figures, which
// under-report any company with subsidiaries); s.screenerConsolidated === false marks a company whose consolidated page
// was checked and is blank (single-entity companies), which links to the plain page instead.
function screenerUrl(s){
  const sym = s.ticker.split('·')[0].trim().toUpperCase();
  const suffix = s.screenerConsolidated === false ? '' : 'consolidated/';
  return `https://www.screener.in/company/${encodeURIComponent(sym)}/${suffix}`;
}

export { daysSinceDate, escapeHtml, formatBytes, formatDate, formatDeepRefreshTimestamp, formatRequestedAt, formatUploadTimestamp, pctChangeSpan, sanitizeDocId, screenerUrl, tickerIndustry, tickerSymbol };
