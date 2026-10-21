// The Data Refresh page: the Fundamental and Technical CSV imports, the TradingView watchlist sync, and the data-age bars.
// Only the owner uses it, so it loads the first time the page is opened (see core/lazy.js).
import '../import/csvparse.js';
import { init_import_csv_upload } from '../import/csv-upload.js';
import '../import/upload-history.js';
import '../import/fund-engine.js';
import { init_import_fund_import } from '../import/fund-import.js';
import '../import/tech-engine.js';
import '../import/tech-import.js';
import { renderWlPicker } from '../import/wlsync.js';
import { refreshLastFiles, renderAllLastFiles } from '../import/last-file.js';
import { init_joblogs_freshness } from '../joblogs/freshness.js';
import { init_refresh_tvrefresh } from '../refresh/tvrefresh.js';
import { renderWatchlistSyncLogPanel } from '../joblogs/panels.js';

function init(){
  init_joblogs_freshness();
  init_import_csv_upload();
  init_import_fund_import();
  refreshLastFiles();
  init_refresh_tvrefresh();
}
function render(){ renderWlPicker(); renderWatchlistSyncLogPanel(); renderAllLastFiles(); }

export { init, render };
