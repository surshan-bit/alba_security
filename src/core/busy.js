// Which long-running work is in progress (imports, refreshes). The auto-reload waits until none of it is running.
const checks = [];
const registerBusy = (fn) => { checks.push(fn); };
const anyBusy = () => checks.some((fn) => { try { return !!fn(); } catch(e){ return false; } });
export { anyBusy, registerBusy };
