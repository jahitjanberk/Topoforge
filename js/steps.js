/* Stepped ("terraced") terrain. Heights are rounded down to whole steps, and mesh vertices are
   placed in pairs straddling every contour line, a hair apart, so each step edge becomes a
   near-vertical wall instead of a ramp across a triangle. The surface is still a heightfield, so
   the terrain solid stays watertight and everything else (water, buildings, roads) still fits.
   Pure geometry: runs in the worker, on the page and in Node tests. Units: model mm (x, y). */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { bbox, inRing } = Mapcast;

// Rounds elevations down to steps of stepM metres above base level m0.
function quantizer(m0, stepM) {
  return e => m0 + Math.max(0, Math.floor((e - m0) / stepM + 1e-9)) * stepM;
}

// ring: print outline (mm); h: mesh spacing (mm); elevAt(x, y): smooth elevation (m);
// m0, stepM: as in quantizer. Returns forced mesh points [{x, y, force: true}] in straddling pairs.
function contourPoints(ring, h, elevAt, m0, stepM, { gap = 0.04, maxPoints = 400000 } = {}) {
  const [x0, y0, x1, y1] = bbox(ring);
  const c = h * 0.5; // grid spacing: about two samples per mesh triangle
  const Gx = Math.ceil((x1 - x0) / c) + 1, Gy = Math.ceil((y1 - y0) / c) + 1;
  const V = new Float64Array(Gx * Gy);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < Gy; j++) for (let i = 0; i < Gx; i++) {
    const v = elevAt(x0 + i * c, y0 + j * c); V[j * Gx + i] = v;
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const out = [];
  const kMin = Math.max(1, Math.ceil((lo - m0) / stepM)), kMax = Math.floor((hi - m0) / stepM);
  for (let k = kMin; k <= kMax && out.length < maxPoints; k++) {
    const L = m0 + k * stepM;
    for (let j = 0; j < Gy - 1; j++) for (let i = 0; i < Gx - 1; i++) {
      const a = V[j * Gx + i], b = V[j * Gx + i + 1], d = V[(j + 1) * Gx + i], e = V[(j + 1) * Gx + i + 1];
      // Crossing points on the cell's four sides (marching squares, linear interpolation).
      const px = x0 + i * c, py = y0 + j * c, X = [];
      const cross = (va, vb, ax, ay, bx, by) => { if ((va >= L) !== (vb >= L)) { const t = (L - va) / (vb - va); X.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t }); } };
      cross(a, b, px, py, px + c, py); cross(b, e, px + c, py, px + c, py + c);
      cross(e, d, px + c, py + c, px, py + c); cross(d, a, px, py + c, px, py);
      for (let s = 0; s + 1 < X.length; s += 2) {
        const p = X[s], q = X[s + 1], len = Math.hypot(q.x - p.x, q.y - p.y);
        if (len < 1e-9) continue;
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        if (!inRing(mx, my, ring)) continue;
        // Find the exact contour crossing along the segment's normal (bisection on the smooth DEM).
        const nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
        const f = t => elevAt(mx + nx * t, my + ny * t) - L;
        let ta = -c, tb = c, fa = f(ta), fb = f(tb);
        if ((fa >= 0) === (fb >= 0)) continue;
        for (let it = 0; it < 16; it++) { const tm = (ta + tb) / 2, fm = f(tm); if ((fm >= 0) === (fa >= 0)) { ta = tm; fa = fm; } else { tb = tm; fb = fm; } }
        const t = (ta + tb) / 2, up = fb >= 0 ? 1 : -1; // which way is uphill along the normal
        out.push({ x: mx + nx * (t + up * gap), y: my + ny * (t + up * gap), force: true },
                 { x: mx + nx * (t - up * gap), y: my + ny * (t - up * gap), force: true });
      }
    }
  }
  return out;
}

Object.assign(Mapcast, { quantizer, contourPoints });
})();
