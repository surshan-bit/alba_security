// Debug handle and page-change tracking.
import { stocks } from '../core/stocks.js';
import { setUiStateTracking } from '../core/view.js';
import { sanitizeDocId, tickerSymbol } from '../core/util.js';
import { stockResearchAgeDays } from '../research/status.js';
import { renderDetail } from '../detail/render.js';
import { applyResearchOverlay } from '../overlays/research.js';
import { applySnapshotOverlay, applyUpdatesOverlay } from '../overlays/updates.js';
import { debugHandle } from '../boot/handoff.js';

function init_app_actions(){

// Handles for headless tests / debugging only.
Object.assign(debugHandle(), { stocks, applyUpdatesOverlay, applySnapshotOverlay, applyResearchOverlay, sanitizeDocId, tickerSymbol, stockResearchAgeDays, renderDetail });

// The last page is reopened in ui/historyrestore.js; from here on page changes are remembered.
setUiStateTracking(true);
}

export { init_app_actions };
