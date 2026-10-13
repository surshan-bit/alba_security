// Entry point of the page (built into app.js): starts the boot sequence and reports a failure on the cover.
import { boot } from './boot.js';
import { showBootFailure } from './status.js';

boot().catch(e => { console.error(e); showBootFailure(e); });
