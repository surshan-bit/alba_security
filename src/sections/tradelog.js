// The Trade Log page: positions bought and sold, and the form to add them. Loads the first time the page is opened (see core/lazy.js).
import { renderTradeLogPanel } from '../tradelog/panel.js';
import { init_tradelog_form } from '../tradelog/form.js';
import { init_ideas, renderIdeas } from '../tradelog/ideas.js';

function init(){ init_tradelog_form(); init_ideas(); }
function render(){ renderTradeLogPanel(); renderIdeas(); }

export { init, render };
