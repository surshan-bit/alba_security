// Analysis screen: which stocks the header Refresh button works on. The Refresh kit (src/refresh/kit.js) draws the button, the row ticks and the
// selection bar; this module tells it which stocks are shown, in leaderboard order. The older two-card panel is still used when no kit is installed.
import { stocks } from '../core/stocks.js';
import { analysisFilters, getAnalysisShownIdx } from './state.js';
import { createBatchRounds } from '../livedata/panel.js';
import { getRefreshKit } from '../refresh/hook.js';

// A batch place is kept per kind and starts over when the number of shown stocks, the sort column, its direction or the grouping changes (not when the order itself changes:
// a refresh moves prices and so the ranking, but the batch place must stay).
const rounds = createBatchRounds();
const shownStocks = () => getAnalysisShownIdx().map(i => stocks[i]).filter(Boolean);
const planKey = () => getAnalysisShownIdx().length + ':' + analysisFilters.sortCol + analysisFilters.sortDir + ':' + analysisFilters.groupBy;
// Called when a card's button is pressed: returns that batch and moves on to the following one.
const analysisTakeBatch = (kind) => rounds.take(kind, shownStocks(), planKey());

// Tells the kit what "all shown stocks" means for the header Refresh button.
function defineAnalysisScope(){
  const kit = getRefreshKit();
  if(kit) kit.defineScope('analysis', { label: 'shown stocks', source: 'analysis', selName: 'analysis', stocks: shownStocks });
}
// Called whenever the shown stocks change.
function updateAnalysisRefresh(){
  const kit = getRefreshKit();
  if(!kit) return;
  defineAnalysisScope();
  kit.repaint();
}

export { analysisTakeBatch, defineAnalysisScope, updateAnalysisRefresh };
