// Technical Score 2 (v1.202, all stocks from v1.203): saved by Refresh all stocks as a few records in the collection techScore2 (ids c001, c002 ...), 250 stocks
// each, because the score needs each stock's weekly bars and the page does not load those at start-up.
//   techScore2/<c001...> = { v: 1, asof: 'YYYY-MM-DD', at: ISO time, rows: [ { k, s, z, w }, ... ] }
//   k = the stock's record id (its ticker); s = the 0-10 score; z = the model's raw value; w = the last
//   completed week it rests on.
// The page lays each row on its stock as `technical2`; the grid column "Tech 2" and the Strategies field read it from there.
import { refreshAnalysisSoon } from '../analysis/section.js';
import { rerenderDetail } from '../detail/render.js';
import { stockByDocId } from './research.js';

let applied = [];
function applyTech2Overlay(chunkDocs){
  const index = stockByDocId();
  applied.forEach(s => { delete s.technical2; });
  applied = [];
  chunkDocs.forEach(d => {
    const c = d.data;
    if(!c || !Array.isArray(c.rows)) return;
    c.rows.forEach(row => {
      const s = row && typeof row.k === 'string' ? index.get(row.k) : null;
      if(!s) return;
      s.technical2 = { score: typeof row.s === 'number' ? row.s : null, z: typeof row.z === 'number' ? row.z : null, week: row.w || null, asof: c.asof || null };
      applied.push(s);
    });
  });
  rerenderDetail();
  const el = document.getElementById('section-analysis');
  if(el && el.classList.contains('active')) refreshAnalysisSoon();
}

export { applyTech2Overlay };
