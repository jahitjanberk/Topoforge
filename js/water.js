/* Water mask: rasterises OSM water (lakes, river areas, river lines) onto a grid over the print
   area so terrain points can be classified in O(1). Lakes get one flat level each; flowing water
   follows the terrain. Runs in the model worker (OffscreenCanvas) or on the page.
   All coordinates here are model millimetres (x right, y up), as in model.js. */
(() => {
'use strict';
const Topoforge = globalThis.Topoforge = globalThis.Topoforge || {};

const NONE = 0, LAKE = 1, FLOW = 2;
const MAX_GRID = 2048; // cells per side

const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};

// osm: { water: [{outer, holes, kind}], rivers: [{pts, width}] } in lat/lon (from parseOSM).
// opts: { bbox: [minx,miny,maxx,maxy] mm, h: mesh spacing mm, ll2m(lat,lng) → {x,y} mm,
//         scale: mm per metre, rawElevAt(x,y) → metres, minRiver: mm }
// Returns { kindAt, levelAt, shorePts, lakes, rivers } or null when there is no water.
function buildWaterMask(osm, opts) {
  const { bbox, h, ll2m, scale, rawElevAt } = opts;
  const [x0, y0, x1, y1] = bbox;
  const cell = Math.max(h * 0.4, (x1 - x0) / MAX_GRID, (y1 - y0) / MAX_GRID);
  const W = Math.ceil((x1 - x0) / cell) + 1, H = Math.ceil((y1 - y0) / cell) + 1;
  const kind = new Uint8Array(W * H), lakeId = new Int32Array(W * H).fill(-1);
  const toPx = p => ({ x: (p.x - x0) / cell, y: (p.y - y0) / cell });
  const shorePts = [];
  const step = h * 0.8;

  // Points along shorelines become mesh vertices so triangle edges follow the shore.
  const addEdgePts = (a, b) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) {
      const x = a.x + (b.x - a.x) * k / n, y = a.y + (b.y - a.y) * k / n;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) shorePts.push({ x, y });
    }
  };
  const tracePolygon = (ctx, rings, ox, oy) => {
    ctx.beginPath();
    for (const r of rings) r.forEach((p, i) => { const q = toPx(p); i ? ctx.lineTo(q.x - ox, q.y - oy) : ctx.moveTo(q.x - ox, q.y - oy); });
    ctx.closePath();
  };

  // Ponds, fountains and pools smaller than this (mm²) would print as 1–2 triangle specks.
  const minArea = Math.max(3, 4 * h * h);
  const ringArea = r => { let s = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += p.x * q.y - q.x * p.y; } return Math.abs(s) / 2; };
  const polys = osm.water.map(w => {
    const rings = [w.outer, ...w.holes].map(r => r.map(p => ll2m(p.lat, p.lon)));
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of rings[0]) { if (p.x < a) a = p.x; if (p.y < b) b = p.y; if (p.x > c) c = p.x; if (p.y > d) d = p.y; }
    return { rings, kind: w.kind, bb: [a, b, c, d], area: ringArea(rings[0]) };
  }).filter(p => p.area >= minArea && p.bb[2] >= x0 && p.bb[0] <= x1 && p.bb[3] >= y0 && p.bb[1] <= y1);

  // Lakes: one small canvas per lake (cropped to the grid) so each keeps its own id and level.
  const levels = [];
  let lakes = 0;
  for (const p of polys.filter(p => p.kind === 'lake')) {
    const bx = Math.max(0, Math.floor((p.bb[0] - x0) / cell)), by = Math.max(0, Math.floor((p.bb[1] - y0) / cell));
    const bw = Math.min(W, Math.ceil((p.bb[2] - x0) / cell) + 1) - bx, bh = Math.min(H, Math.ceil((p.bb[3] - y0) / cell) + 1) - by;
    if (bw <= 0 || bh <= 0) continue;
    const cv = makeCanvas(bw, bh), ctx = cv.getContext('2d', { willReadFrequently: true });
    tracePolygon(ctx, p.rings, bx, by); ctx.fill('evenodd');
    const a = ctx.getImageData(0, 0, bw, bh).data, id = levels.length, cells = [];
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      if (a[(j * bw + i) * 4 + 3] < 128) continue;
      const g = (by + j) * W + bx + i; kind[g] = LAKE; lakeId[g] = id; cells.push(g);
    }
    if (!cells.length) { levels.push(0); continue; }
    // Level = median DEM height over the lake (robust to shoreline noise).
    const sample = [], stride = Math.max(1, Math.floor(cells.length / 400));
    for (let k = 0; k < cells.length; k += stride) { const g = cells[k]; sample.push(rawElevAt(x0 + (g % W) * cell, y0 + Math.floor(g / W) * cell)); }
    sample.sort((u, v) => u - v);
    levels.push(sample[sample.length >> 1]);
    p.rings.forEach(r => r.forEach((q, i) => addEdgePts(q, r[(i + 1) % r.length])));
    lakes++;
  }

  // Flowing water (river areas + river lines) shares one full-size canvas.
  const flowPolys = polys.filter(p => p.kind === 'flow');
  const minW = Math.max(opts.minRiver || 1.2, h * 1.5);
  const lines = osm.rivers.map(r => ({ pts: r.pts.map(p => ll2m(p.lat, p.lon)), w: Math.max(r.width * scale, minW) }))
    .filter(r => r.pts.some(p => p.x >= x0 - r.w && p.x <= x1 + r.w && p.y >= y0 - r.w && p.y <= y1 + r.w));
  if (flowPolys.length || lines.length) {
    const cv = makeCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
    for (const p of flowPolys) { tracePolygon(ctx, p.rings, 0, 0); ctx.fill('evenodd'); p.rings.forEach(r => r.forEach((q, i) => addEdgePts(q, r[(i + 1) % r.length]))); }
    ctx.lineCap = ctx.lineJoin = 'round'; ctx.strokeStyle = '#000';
    for (const r of lines) {
      ctx.lineWidth = r.w / cell;
      ctx.beginPath(); r.pts.forEach((p, i) => { const q = toPx(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke();
      // Banks and centre line as mesh vertices: the centre ones end up fully inside the river.
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 1e-6) continue;
        const nx = -(b.y - a.y) / len * r.w / 2, ny = (b.x - a.x) / len * r.w / 2;
        addEdgePts(a, b);
        addEdgePts({ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny });
        addEdgePts({ x: a.x - nx, y: a.y - ny }, { x: b.x - nx, y: b.y - ny });
      }
    }
    const a = ctx.getImageData(0, 0, W, H).data;
    for (let g = 0; g < W * H; g++) if (a[g * 4 + 3] >= 128 && kind[g] === NONE) kind[g] = FLOW;
  }

  if (!lakes && !flowPolys.length && !lines.length) return null;
  const cellOf = (x, y) => {
    const i = Math.round((x - x0) / cell), j = Math.round((y - y0) / cell);
    return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i;
  };
  return {
    kindAt(x, y) { const g = cellOf(x, y); return g < 0 ? NONE : kind[g]; },
    // Flat level (metres) for lake cells, otherwise null.
    levelAt(x, y) { const g = cellOf(x, y); return g >= 0 && kind[g] === LAKE ? levels[lakeId[g]] : null; },
    shorePts, lakes, rivers: lines.length + flowPolys.length
  };
}

Object.assign(Topoforge, { buildWaterMask, WATER: { NONE, LAKE, FLOW } });
})();
