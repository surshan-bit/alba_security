// Writes any pending preference / screen-state / strategy change when the page is hidden, closed or refreshed.
import { flushPrefs, flushUiState } from './prefs.js';
import { flushStrategies } from './strategies.js';

function flushAll(){ flushUiState(); flushPrefs(); flushStrategies(); }

function init_identity_flush(){
window.addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') flushAll(); });
}

export { init_identity_flush };
