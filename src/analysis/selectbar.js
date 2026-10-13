// Analysis screen: the two Live Data Refresh cards below the leaderboard (Fundamental, Technical), laid out like the Explorer's
// industry refresh. Nothing has to be ticked: a press refreshes the next batch of the shown stocks.
import { stocks } from '../core/stocks.js';
import { analysisFilters, getAnalysisShownIdx } from './state.js';
import { createBatchRounds, liveCardsHtml, paintBatchCards } from '../livedata/panel.js';

// Each press refreshes the next batch of the shown stocks, in leaderboard order, whether or not they were refreshed lately:
// the first press does ranks 1-50, the next 51-100 and so on, then it starts again from the top. The place is kept per card
// and starts over when the number of shown stocks or the sort changes.
const rounds = createBatchRounds();
const shownStocks = () => getAnalysisShownIdx().map(i => stocks[i]).filter(Boolean);
// Not the order itself: a refresh moves prices and so the ranking, but the batch place must stay.
const planKey = () => getAnalysisShownIdx().length + ':' + analysisFilters.sortBy;
// Called when a card's button is pressed: returns that batch and moves on to the following one.
const analysisTakeBatch = (kind) => rounds.take(kind, shownStocks(), planKey());

function renderAnalysisLivePanel(){
  return `<div class="analysis-refresh" id="analysisLiveRefresh">${liveCardsHtml('analysis', { fund: 'analysisSelFund', tech: 'analysisSelTech' })}</div>`;
}
// What each card says and allows while nothing is running; called whenever the shown stocks change.
function updateAnalysisRefresh(){
  paintBatchCards('analysis', rounds, shownStocks(), planKey(), 'shown stocks');
}

export { analysisTakeBatch, renderAnalysisLivePanel, updateAnalysisRefresh };
