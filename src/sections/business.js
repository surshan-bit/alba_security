// The Business page: industries ranked by price change over a period, with their news. Loads the first time the page is opened (see core/lazy.js).
import { init as initPanel, show } from '../business/panel.js';

function init(){ initPanel(); }
function render(){ show(); }

export { init, render };
