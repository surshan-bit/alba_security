// The Refresh kit (src/refresh/kit.js) draws the Refresh buttons, freshness dots and the saved queue. The screens and the Live Data Refresh
// engine reach it through this hook, so that they work (with the older in-panel cards) until the kit is installed at start-up.
let kit = null;
export function setRefreshKit(k){ kit = k; }
export function getRefreshKit(){ return kit; }
