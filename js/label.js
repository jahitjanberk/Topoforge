/* Raised text label for the model's base. Text is drawn on a canvas, traced into polygons (with
   holes for letters like O or A), simplified, and extruded. Works in the model worker
   (OffscreenCanvas) and on the page; traceMask is pure so it can be unit-tested in Node. */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { simplifyDP, signedArea, inRing } = Mapcast;

// mask: Uint8Array (1 = ink), w×h pixels, row-major with y pointing down.
// Returns closed loops of pixel-corner points in a y-up frame (x = column, y = -row):
// outlines counter-clockwise, holes clockwise. Diagonally touching pixels stay separate loops.
function traceMask(mask, w, h) {
  const ink = (i, j) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
  const W1 = w + 1, key = (x, y) => y * W1 + x;
  const out = new Map(); // corner → outgoing edges [{to, dx, dy}] (dx, dy in y-up frame)
  const edge = (x0, y0, x1, y1) => {
    const k = key(x0, y0);
    (out.get(k) || out.set(k, []).get(k)).push({ from: k, to: key(x1, y1), x1, y1, dx: x1 - x0, dy: -(y1 - y0), used: false });
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!ink(i, j)) continue;
    // Counter-clockwise in y-up around the pixel, only where the neighbour is empty.
    if (!ink(i, j + 1)) edge(i, j + 1, i + 1, j + 1);   // bottom: left → right
    if (!ink(i + 1, j)) edge(i + 1, j + 1, i + 1, j);   // right: up
    if (!ink(i, j - 1)) edge(i + 1, j, i, j);           // top: right → left
    if (!ink(i - 1, j)) edge(i, j, i, j + 1);           // left: down
  }
  const loops = [];
  for (const list of out.values()) for (const start of list) {
    if (start.used) continue;
    const pts = []; let e = start, guard = 0;
    while (e && !e.used && guard++ < 4 * w * h + 8) {
      e.used = true;
      pts.push({ x: e.x1, y: -e.y1, dx: e.dx, dy: e.dy });
      // At a corner shared by two diagonal pixels, take the left-most turn: hugs the same pixel.
      const cands = (out.get(e.to) || []).filter(c => !c.used);
      let best = null, bestTurn = -Infinity;
      for (const c of cands) { const turn = e.dx * c.dy - e.dy * c.dx; if (turn > bestTurn) { bestTurn = turn; best = c; } }
      e = best;
    }
    // Keep only the corners where direction changes.
    const n = pts.length, poly = [];
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; if (a.dx !== b.dx || a.dy !== b.dy) poly.push({ x: a.x, y: a.y }); }
    if (poly.length >= 3) loops.push(poly);
  }
  return loops;
}

// Groups loops into polygons: each outline with the holes directly inside it.
function loopsToPolygons(loops) {
  const outers = loops.filter(l => signedArea(l) > 0).map(l => ({ outer: l, holes: [], a: signedArea(l) }));
  for (const hole of loops.filter(l => signedArea(l) < 0)) {
    const p = hole[0], host = outers.filter(o => inRing(p.x + 0.25, p.y - 0.25, o.outer) || inRing(p.x, p.y, o.outer)).sort((a, b) => a.a - b.a)[0];
    if (host) host.holes.push(hole);
  }
  return outers;
}

// True if any two non-adjacent edges of the polygon's rings cross or touch. Simplifying a pixel
// outline can make thin strokes cross themselves or their hole; such polygons don't triangulate.
function hasCrossings(rings) {
  const segs = [];
  rings.forEach((r, ri) => r.forEach((a, i) => segs.push({ a, b: r[(i + 1) % r.length], ri, i, n: r.length })));
  const orient = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const onSeg = (p, q, r) => Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y);
  for (let s = 0; s < segs.length; s++) for (let t = s + 1; t < segs.length; t++) {
    const A = segs[s], B = segs[t];
    if (A.ri === B.ri && (Math.abs(A.i - B.i) === 1 || Math.abs(A.i - B.i) === A.n - 1)) continue; // neighbours share a vertex
    if (Math.max(A.a.x, A.b.x) < Math.min(B.a.x, B.b.x) || Math.max(B.a.x, B.b.x) < Math.min(A.a.x, A.b.x) ||
        Math.max(A.a.y, A.b.y) < Math.min(B.a.y, B.b.y) || Math.max(B.a.y, B.b.y) < Math.min(A.a.y, A.b.y)) continue;
    const o1 = orient(A.a, A.b, B.a), o2 = orient(A.a, A.b, B.b), o3 = orient(B.a, B.b, A.a), o4 = orient(B.a, B.b, A.b);
    if (o1 !== o2 && o3 !== o4) return true;
    if ((o1 === 0 && onSeg(A.a, B.a, A.b)) || (o2 === 0 && onSeg(A.a, B.b, A.b)) || (o3 === 0 && onSeg(B.a, A.a, B.b)) || (o4 === 0 && onSeg(B.a, A.b, B.b))) return true;
  }
  return false;
}

const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};
const FONT = '"Arial", "Helvetica Neue", "Helvetica", "Segoe UI", sans-serif';

// Text as polygons in mm, centred on (cx, cy), cap height ≈ heightMm, at most maxWidthMm wide.
// Returns [{outer, holes}] (outer CCW, holes CW) or [] when the text is empty.
function textPolygons(text, { cx, cy, heightMm, maxWidthMm, ppm = 16 }) {
  text = String(text || '').trim();
  if (!text) return [];
  let px = Math.round(heightMm * ppm * 1.35); // font size: cap height is ~0.72 of it
  const measure = makeCanvas(8, 8).getContext('2d');
  measure.font = `bold ${px}px ${FONT}`;
  let tw = measure.measureText(text).width;
  if (tw / ppm > maxWidthMm) { px = Math.floor(px * maxWidthMm * ppm / tw); measure.font = `bold ${px}px ${FONT}`; tw = measure.measureText(text).width; }
  const pad = 4, W = Math.ceil(tw) + 2 * pad, H = Math.ceil(px * 1.4) + 2 * pad;
  const ctx = makeCanvas(W, H).getContext('2d', { willReadFrequently: true });
  ctx.font = `bold ${px}px ${FONT}`; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
  ctx.fillText(text, pad, H / 2);
  const a = ctx.getImageData(0, 0, W, H).data, mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = a[i * 4 + 3] >= 128 ? 1 : 0;
  // Pixel loops → mm, centred. Group first (on the exact pixel outlines), then simplify away the
  // pixel staircase (~0.6 px) per glyph, keeping the exact outline where simplifying would make
  // the glyph cross itself.
  const toMm = p => ({ x: cx + (p.x - W / 2) / ppm, y: cy + (p.y + H / 2) / ppm });
  const raw = loopsToPolygons(traceMask(mask, W, H).map(l => l.map(toMm)));
  const out = [];
  for (const p of raw) {
    if (Math.abs(signedArea(p.outer)) < 0.02) continue; // specks
    const simp = { outer: simplifyDP(p.outer, 0.6 / ppm), holes: p.holes.map(h => simplifyDP(h, 0.6 / ppm)).filter(h => h.length >= 3) };
    const ok = simp.outer.length >= 3 && !hasCrossings([simp.outer, ...simp.holes]);
    out.push(ok ? simp : { outer: p.outer, holes: p.holes });
  }
  return out;
}

Object.assign(Mapcast, { traceMask, loopsToPolygons, hasCrossings, textPolygons });
})();
