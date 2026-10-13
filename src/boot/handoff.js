// What the boot sequence hands to the app: the stock list, and the one debug/test handle on `window`.
//
// The app never reads anything from `window` that boot put there. The stock list travels through getBootStocks(); the
// handle below (window.__alba) exists for headless tests and debugging only (the browser tests read loadInfo and stocks from it).

let bootStocks = null;

function setBootStocks(list){ bootStocks = list; }
function getBootStocks(){
  if(!bootStocks) throw new Error('the stock list was not loaded before the app started');
  return bootStocks;
}
function debugHandle(){
  if(!window.__alba) window.__alba = {};
  return window.__alba;
}

export { debugHandle, getBootStocks, setBootStocks };
