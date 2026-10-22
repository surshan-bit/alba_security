// Industry heat map: one tile per industry, sized by the size of its average change (the default) or by how many stocks it has
// (market-cap weights are not available), coloured by the average change over the chosen period. Pure functions that return HTML.
import { escapeHtml } from '../core/util.js';

// The % move that gives the strongest colour, per period (a month moves more than a week).
const SCALE = { '1W': 5, '1M': 10, '3M': 18, '6M': 28, '1Y': 45 };

// Squarified treemap: items [{ v, ... }] sorted by v (largest first) laid into the w x h box. Returns items with x, y, w, h.
function layout(items, w, h){
  const total = items.reduce((a, i) => a + i.v, 0), out = [];
  if(!total || !items.length) return out;
  const k = (w * h) / total, nodes = items.map(i => ({ i, a: i.v * k }));
  let x = 0, y = 0, bw = w, bh = h, start = 0;
  const worst = (row, side) => {
    const s = row.reduce((a, n) => a + n.a, 0), mx = Math.max(...row.map(n => n.a)), mn = Math.min(...row.map(n => n.a));
    return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn));
  };
  while(start < nodes.length){
    const side = Math.min(bw, bh);
    let end = start + 1;
    while(end < nodes.length && worst(nodes.slice(start, end + 1), side) <= worst(nodes.slice(start, end), side)) end++;
    const row = nodes.slice(start, end), s = row.reduce((a, n) => a + n.a, 0);
    if(bw >= bh){   // lay the row as a column on the left
      const cw = s / bh; let cy = y;
      row.forEach(n => { const ch = n.a / cw; out.push(Object.assign({}, n.i, { x, y: cy, w: cw, h: ch })); cy += ch; });
      x += cw; bw -= cw;
    } else {        // lay the row along the top
      const rh = s / bw; let cx = x;
      row.forEach(n => { const cw = n.a / rh; out.push(Object.assign({}, n.i, { x: cx, y, w: cw, h: rh })); cx += cw; });
      y += rh; bh -= rh;
    }
    start = end;
  }
  return out;
}

function tileColor(mean, period){
  if(mean === null) return 'var(--panel2)';
  const t = Math.min(Math.abs(mean) / (SCALE[period] || 10), 1), pct = Math.round(18 + t * 72);
  return 'color-mix(in srgb, var(' + (mean >= 0 ? '--buy' : '--avoid') + ') ' + pct + '%, var(--bg))';
}

// rows: the industry rows (name, count, mean). width: the pixel width the map will be drawn at (decides which tiles have room for text).
function heatmapHtml(rows, period, width, size){
  const W = 1000, H = 780, pxScale = (width || 1000) / W;
  const live = rows.filter(r => r.count > 0), bySize = size !== 'count';
  // Size by % change: the area follows how far the average moved (up or down); a floor keeps flat or missing industries visible.
  const maxMove = Math.max(0.0001, ...live.map(r => r.mean === null ? 0 : Math.abs(r.mean))), floor = maxMove * .08;
  const weight = r => bySize ? Math.max(r.mean === null ? 0 : Math.abs(r.mean), floor) : Math.sqrt(r.count);
  // Sized by % change: the risers are laid out together in one block on the left and the fallers (and flat / missing ones) in a block
  // on the right, each block sorted by size, the blocks sharing the width in proportion to their total change.
  const blocks = bySize ? [live.filter(r => r.mean !== null && r.mean > 0), live.filter(r => !(r.mean !== null && r.mean > 0))] : [live];
  const sumW = blocks.map(b => b.reduce((a, r) => a + weight(r), 0)), allW = sumW.reduce((a, v) => a + v, 0);
  let x0 = 0;
  const tiles = [];
  blocks.forEach((b, k) => {
    if(!b.length) return;
    const bw = bySize ? W * sumW[k] / allW : W;
    layout(b.map(r => ({ v: weight(r), r })).sort((a, c) => c.v - a.v), bw, H).forEach(t => tiles.push(Object.assign(t, { x: t.x + x0 })));
    x0 += bw;
  });
  const tile = (t) => {
    const r = t.r, pw = t.w * pxScale, ph = t.h * pxScale;
    // Text is sized to the tile: big tiles get a full label, small ones a smaller one that wraps, tiny ones only the tooltip.
    const fs = Math.max(9, Math.min(13, Math.min(pw / 9, ph / 3.2)));   // px
    const lineH = fs * 1.2, room = ph - 8;
    const showChg = pw > 62 && room >= lineH * 2, showN = pw > 80 && room >= lineH * 3.4;
    const nameLines = Math.floor((room - (showChg ? lineH : 0) - (showN ? lineH * .9 : 0)) / lineH);
    const showName = pw > 30 && nameLines >= 1;
    const chg = r.mean === null ? 'n/a' : (r.mean > 0 ? '+' : '') + r.mean.toFixed(2) + '%';
    const tip = r.name + ': ' + chg + ' average ' + period + ', ' + r.count + ' stock' + (r.count === 1 ? '' : 's');
    return '<button type="button" class="hm-tile" data-biz-heat="' + escapeHtml(r.name) + '" title="' + escapeHtml(tip) + '" style="left:' + (t.x / W * 100).toFixed(3) + '%;top:' + (t.y / H * 100).toFixed(3) + '%;width:' + (t.w / W * 100).toFixed(3) + '%;height:' + (t.h / H * 100).toFixed(3) + '%;background:' + tileColor(r.mean, period) + ';font-size:' + fs.toFixed(1) + 'px;padding:' + (pw < 60 || ph < 40 ? 2 : 5) + 'px ' + (pw < 60 ? 3 : 6) + 'px">'
      + (showName ? '<span class="hm-name" style="-webkit-line-clamp:' + Math.min(nameLines, 4) + '">' + escapeHtml(r.name) + '</span>' : '') + (showChg ? '<span class="hm-chg">' + chg + '</span>' : '') + (showN ? '<span class="hm-n">' + r.count + ' stock' + (r.count === 1 ? '' : 's') + '</span>' : '') + '</button>';
  };
  const s = SCALE[period] || 10;
  const legend = '<div class="hm-legend"><span>−' + s + '%</span><i class="hm-bar"></i><span>+' + s + '%</span><span class="hm-note">' + (bySize ? 'Tile size grows with the size of the average change; risers are grouped on the left, fallers on the right.' : 'Tile size grows with the number of stocks (scaled so small industries stay readable).') + ' Colour = average ' + period + ' change. Tap a tile to open the industry.</span></div>';
  return '<div class="hm-wrap" style="aspect-ratio:' + W + '/' + H + '">' + tiles.map(tile).join('') + '</div>' + legend;
}

export { heatmapHtml };
