// Restores the saved Analysis panels at load.
import { setAnalysisColumnsPanelOpen } from '../analysis/state.js';
import { uiStateGet } from '../identity/prefs.js';

function init_ui_restore(){
const savedUi = uiStateGet();
setAnalysisColumnsPanelOpen(!!savedUi.aColsOpen);
}

export { init_ui_restore };
