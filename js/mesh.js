/* Mesh building (all units mm, z up). Uses the global Delaunator and earcut libraries. */
(() => {
'use strict';
const Mapcast = window.Mapcast = window.Mapcast || {};

const { bbox, inRing, distToRing, signedArea } = Mapcast;

const earcut = (window.earcut && window.earcut.default) || window.earcut;

// earcut emits every triangle with the same winding; read it from the summed area so
// zero-area slivers along straight edges are never flipped on rounding noise.
function earcutWinding(tr, at) {
  let sum = 0;
  for (let i = 0; i < tr.length; i += 3) { const a = at(tr[i]), b = at(tr[i + 1]), c = at(tr[i + 2]); sum += (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
  return sum;
}
function pushTri(o, ax, ay, az, bx, by, bz, cx, cy, cz) { o.push(ax, ay, az, bx, by, bz, cx, cy, cz); }

// Watertight terrain solid clipped to ring. h = sample spacing (null → flat slab).
function buildTerrain(ring, h, elevAt) {
  const B = [];
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
    const k = h ? Math.max(1, Math.ceil(len / h)) : 1;
    for (let j = 0; j < k; j++) B.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  const nb = B.length, P = B.slice();
  if (h) {
    const [minx, miny, maxx, maxy] = bbox(ring);
    let row = 0;
    for (let y = miny + h * 0.5; y < maxy; y += h * 0.866, row++)
      for (let x = minx + (row % 2 ? h * 0.75 : h * 0.25); x < maxx; x += h)
        if (inRing(x, y, ring) && distToRing(x, y, ring) > h * 0.5) P.push({ x, y });
  }
  const N = P.length, coords = new Float64Array(N * 2);
  P.forEach((p, i) => { coords[i * 2] = p.x; coords[i * 2 + 1] = p.y; });
  const t = new Delaunator(coords).triangles, keep = [];
  const lim = h ? (2.2 * h) ** 2 : 0;
  for (let i = 0; i < t.length; i += 3) {
    let a = t[i], b = t[i + 1], c = t[i + 2];
    const A = P[a], Bp = P[b], C = P[c];
    const ar = (Bp.x - A.x) * (C.y - A.y) - (Bp.y - A.y) * (C.x - A.x);
    if (Math.abs(ar) < 1e-9) continue;
    let inside;
    if (h && a >= nb && b >= nb && c >= nb && (Bp.x - A.x) ** 2 + (Bp.y - A.y) ** 2 < lim && (C.x - A.x) ** 2 + (C.y - A.y) ** 2 < lim && (C.x - Bp.x) ** 2 + (C.y - Bp.y) ** 2 < lim) inside = true;
    else inside = inRing((A.x + Bp.x + C.x) / 3, (A.y + Bp.y + C.y) / 3, ring);
    if (!inside) continue;
    if (ar < 0) { const tmp = b; b = c; c = tmp; }
    keep.push(a, b, c);
  }
  const E = new Float64Array(N);
  let minE = Infinity, maxE = -Infinity;
  for (let i = 0; i < N; i++) { E[i] = elevAt(P[i].x, P[i].y); if (E[i] < minE) minE = E[i]; if (E[i] > maxE) maxE = E[i]; }
  return { P, keep, E, minE, maxE, N };
}
function terrainSolid(T, zOf) {
  const { P, keep, E, N } = T, out = [];
  const Z = new Float64Array(N); for (let i = 0; i < N; i++) Z[i] = zOf(E[i]);
  for (let i = 0; i < keep.length; i += 3) { const a = keep[i], b = keep[i + 1], c = keep[i + 2]; pushTri(out, P[a].x, P[a].y, Z[a], P[b].x, P[b].y, Z[b], P[c].x, P[c].y, Z[c]); }
  // boundary edges (used once)
  const cnt = new Map(), key = (u, v) => u < v ? u * N + v : v * N + u;
  for (let i = 0; i < keep.length; i += 3) for (let j = 0; j < 3; j++) { const k = key(keep[i + j], keep[i + (j + 1) % 3]); cnt.set(k, (cnt.get(k) || 0) + 1); }
  const next = new Map(); let pinch = false;
  for (let i = 0; i < keep.length; i += 3) for (let j = 0; j < 3; j++) {
    const u = keep[i + j], v = keep[i + (j + 1) % 3];
    if (cnt.get(key(u, v)) !== 1) continue;
    const a = P[u], b = P[v];
    pushTri(out, a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, Z[v]);
    pushTri(out, a.x, a.y, 0, b.x, b.y, Z[v], a.x, a.y, Z[u]);
    if (next.has(u)) pinch = true; next.set(u, v);
  }
  // bottom: earcut the boundary loops; fall back to mirroring the top
  let bottomOk = false;
  if (!pinch) {
    const loops = [], seen = new Set();
    for (const s of next.keys()) {
      if (seen.has(s)) continue;
      const loop = []; let u = s, guard = 0;
      while (!seen.has(u) && guard++ < 1e7) { seen.add(u); loop.push(u); u = next.get(u); if (u === undefined) break; }
      if (u === s && loop.length >= 3) loops.push(loop);
    }
    const area = l => signedArea(l.map(i => P[i]));
    const outers = loops.filter(l => area(l) > 0).map(l => ({ l, holes: [], a: area(l) })), holes = loops.filter(l => area(l) < 0);
    for (const hl of holes) {
      const p = P[hl[0]];
      const cands = outers.filter(o => inRing(p.x, p.y, o.l.map(i => P[i]))).sort((x, y) => x.a - y.a);
      if (cands[0]) cands[0].holes.push(hl);
    }
    const bot = []; let covered = 0, expected = 0;
    for (const o of outers) {
      const idx = [...o.l], hi = [];
      for (const hl of o.holes) { hi.push(idx.length); idx.push(...hl); }
      const flat = []; idx.forEach(i => flat.push(P[i].x, P[i].y));
      const tr = earcut(flat, hi.length ? hi : null);
      expected += o.a + o.holes.reduce((s, hl) => s + area(hl), 0);
      const flip = earcutWinding(tr, i => P[idx[i]]) > 0; // bottom faces must point down
      for (let i = 0; i < tr.length; i += 3) {
        let a = P[idx[tr[i]]], b = P[idx[tr[i + 1]]], c = P[idx[tr[i + 2]]];
        covered += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
        if (flip) { const tmp = b; b = c; c = tmp; }
        pushTri(bot, a.x, a.y, 0, b.x, b.y, 0, c.x, c.y, 0);
      }
    }
    if (expected > 0 && Math.abs(covered - expected) / expected < 0.005) { for (const v of bot) out.push(v); bottomOk = true; }
  }
  if (!bottomOk) for (let i = 0; i < keep.length; i += 3) { const a = P[keep[i]], b = P[keep[i + 1]], c = P[keep[i + 2]]; pushTri(out, a.x, a.y, 0, c.x, c.y, 0, b.x, b.y, 0); }
  return out;
}
function addPrism(o, outer, holes, zb, zt) {
  if (signedArea(outer) < 0) outer = outer.slice().reverse();
  holes = holes.map(h => signedArea(h) > 0 ? h.slice().reverse() : h);
  const pts = outer.slice(), flat = [], hi = [];
  outer.forEach(p => flat.push(p.x, p.y));
  for (const h of holes) { hi.push(flat.length / 2); h.forEach(p => { flat.push(p.x, p.y); pts.push(p); }); }
  const tr = earcut(flat, hi.length ? hi : null);
  if (!tr.length) return false;
  const flip = earcutWinding(tr, i => pts[i]) < 0; // top faces must be CCW
  for (let i = 0; i < tr.length; i += 3) {
    let a = pts[tr[i]], b = pts[tr[i + 1]], c = pts[tr[i + 2]];
    if (flip) { const t = b; b = c; c = t; }
    pushTri(o, a.x, a.y, zt, b.x, b.y, zt, c.x, c.y, zt);
    pushTri(o, a.x, a.y, zb, c.x, c.y, zb, b.x, b.y, zb);
  }
  for (const r of [outer, ...holes]) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    pushTri(o, a.x, a.y, zb, b.x, b.y, zb, b.x, b.y, zt);
    pushTri(o, a.x, a.y, zb, b.x, b.y, zt, a.x, a.y, zt);
  }
  return true;
}
function addRoadBox(o, a, b, w, zAt, roadH) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy); if (len < 1e-6) return;
  const nx = -dy / len * w / 2, ny = dx / len * w / 2;
  const q = [{ x: a.x - nx, y: a.y - ny }, { x: b.x - nx, y: b.y - ny }, { x: b.x + nx, y: b.y + ny }, { x: a.x + nx, y: a.y + ny }];
  const zg = q.map(p => zAt(p.x, p.y)), zt = zg.map(z => z + roadH), zb = Math.max(0.05, Math.min(...zg) - 0.5);
  pushTri(o, q[0].x, q[0].y, zt[0], q[1].x, q[1].y, zt[1], q[2].x, q[2].y, zt[2]);
  pushTri(o, q[0].x, q[0].y, zt[0], q[2].x, q[2].y, zt[2], q[3].x, q[3].y, zt[3]);
  pushTri(o, q[0].x, q[0].y, zb, q[2].x, q[2].y, zb, q[1].x, q[1].y, zb);
  pushTri(o, q[0].x, q[0].y, zb, q[3].x, q[3].y, zb, q[2].x, q[2].y, zb);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, A = q[i], Bq = q[j];
    pushTri(o, A.x, A.y, zb, Bq.x, Bq.y, zb, Bq.x, Bq.y, zt[j]);
    pushTri(o, A.x, A.y, zb, Bq.x, Bq.y, zt[j], A.x, A.y, zt[i]);
  }
}

Object.assign(Mapcast, { earcutWinding, pushTri, buildTerrain, terrainSolid, addPrism, addRoadBox });
})();
