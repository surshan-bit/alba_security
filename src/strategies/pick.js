// The stocks that qualify for one strategy today (used by the optional Strategy filters in Analysis).
import { stocks } from '../core/stocks.js';
import { publishedStrategies } from './state.js';
import { qualifyingStocks } from './rules.js';

// -> Set of stocks, or null when no strategy is chosen (or the chosen one no longer exists or is not published).
function strategyStockSet(id){
  const st = id ? publishedStrategies().find(x => x.id === id) : null;
  return st ? new Set(qualifyingStocks(stocks, st.rules)) : null;
}
// -> id, or '' when it is empty or the strategy was deleted
function validStrategyId(id){ return id && publishedStrategies().some(x => x.id === id) ? id : ''; }

export { strategyStockSet, validStrategyId };
