// Data integrity check run at load.
import { stocks } from '../core/stocks.js';
import { escapeHtml, tickerSymbol } from '../core/util.js';
import { albaFiHasValuation } from '../import/fund-check.js';
import { expectedScore } from '../core/fundscore.js';

// One-time data-integrity sanity check, run once at load. The offline refresh/merge pipeline
// (scripts/lib/scoring.js, run outside the browser before publishing) already enforces these
// invariants, but a bad manual edit to the stocks array could still slip through and silently
// mis-score the Technical valuation blend or show a verdict that doesn't match its own factors.
// This surfaces a visible banner — not just a console warning — so a broken publish doesn't sit
// unnoticed until someone happens to check the numbers by hand.
function runDataIntegrityCheck(){
  const banner = document.getElementById('dataIntegrityBanner');
  if(!banner) return;
  const problems = [];
  stocks.forEach(s => {
    let sym = '(unknown)';
    try { sym = tickerSymbol(s); } catch(e) { /* malformed ticker field — fall through with placeholder */ }
    // A stock with no Intrinsic Value has no valuation anchor by design (the import allows it, the technical import leaves it frozen).
    if(s.pillars && (typeof s.pillars.val !== 'number' || Number.isNaN(s.pillars.val)) && albaFiHasValuation(s)){
      problems.push(`${sym}: pillars.val is missing/non-numeric (Technical's valuation blend depends on it)`);
    }
    if(s.fundamentals && Array.isArray(s.fundamentals.factors)){
      // The score covers the factors that count, a factor with no data as neutral (see core/fundscore.js).
      const factors = s.fundamentals.factors;
      const invalid = factors.some(f => typeof f.weight !== 'number' || (!f.excluded && typeof f.score !== 'number'));
      const expected = expectedScore(factors);
      if(invalid || (expected != null && Math.abs(expected - s.score) > 0.05)){
        problems.push(`${sym}: fundamentals factor scores (${invalid ? 'invalid' : expected.toFixed(2)} over the factors that count) don't match stock.score (${s.score})`);
      }
    }
  });
  if(problems.length === 0) return; // clean — leave the banner hidden, don't clutter the UI
  console.warn('[data-integrity] ' + problems.length + ' issue(s) found:', problems);
  const shown = problems.slice(0, 5);
  banner.innerHTML = `⚠ Data integrity check found ${problems.length} issue${problems.length === 1 ? '' : 's'} in the published stock data (full list in the browser console): ${shown.map(escapeHtml).join(' · ')}${problems.length > shown.length ? ` · +${problems.length - shown.length} more` : ''}`;
  banner.style.display = '';
}

function init_joblogs_integrity(){
runDataIntegrityCheck();
}

export { init_joblogs_integrity };
