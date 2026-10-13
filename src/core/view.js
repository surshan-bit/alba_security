// Whether page changes are remembered yet.
let uiStateTracking = false;    // becomes true once the saved screen has been restored (so loading itself doesn't overwrite it)

function getUiStateTracking(){ return uiStateTracking; }
function setUiStateTracking(v){ uiStateTracking = v; }

export { getUiStateTracking, setUiStateTracking };
