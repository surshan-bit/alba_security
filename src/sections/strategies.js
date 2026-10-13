// The Strategies page: the rule editor, results, goal search and saved lists.
// (The saved strategies themselves, and the rules that the Analysis filters use, stay in the main part:
// strategies/state.js, rules.js, pick.js, fields.js, news.js.) Loads the first time the page is opened (see core/lazy.js).
import { init_strategies_section, renderStrategiesSection } from '../strategies/section.js';

function init(){ init_strategies_section(); }
function render(){ renderStrategiesSection(); }

export { init, render };
