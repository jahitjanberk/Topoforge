/* Mesh building (all units mm, z up). Uses the global Delaunator and earcut libraries. */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { bbox, inRing, distToRing, signedArea, cleanRing, clipPolygonRect, rectContains } = Mapcast;

const earcut = (globalThis.earcut && globalThis.earcut.default) || globalThis.earcut;

// earcut emits every triangle with the same winding; read it from the summed area so
// zero-area slivers along straight edges are never flipped on rounding noise.
function earcutWinding(tr, at) {
  let sum = 0;
  for (let i = 0; i < tr.length; i += 3) { const a = at(tr[i]), b = at(tr[i + 1]), c = at(tr[i + 2]); sum += (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
  return sum;
}
function pushTri(o, ax, ay, az, bx, by, bz, cx, cy, cz) { o.push(ax, ay, az, bx, by, bz, cx, cy, cz); }

// Adaptive vertex placement. Square cells start large and are split in four, worst cell first,
// while some cell's flat approximation misses the real elevation by more than tolM, and only
// while the vertex count stays within what the uniform grid would use (its budget). So the mesh
// is never larger than the uniform one: flat ground (plains, lakes, terrace tops) gets a few big
// triangles, and the vertices saved there go where the ground is most detailed. Cells touching
// the print outline are always refined fully, so the outline gets a fine band as before.
function adaptivePoints(ring, h, elevAt, tolM, emitPoint) {
  const [minx, miny, maxx, maxy] = bbox(ring);
  // Finest cells are 0.8h squares, a little denser than the uniform grid, so detailed spots can
  // be refined beyond it when the budget allows (accuracy measured in test/mesh.test.mjs).
  const hf = h * 0.8, S0 = hf * 8, q = hf / 4, memo = new Map(), emitted = new Set();
  const budget = Math.abs(signedArea(ring)) / (0.866 * h * h); // the uniform grid's interior vertex count
  const E = (x, y) => { // elevation, memoised on a lattice shared between cell levels
    const k = Math.round((x - minx) / q) * 1048576 + Math.round((y - miny) / q);
    let v = memo.get(k); if (v === undefined) { v = elevAt(x, y); memo.set(k, v); } return v;
  };
  // Largest miss of the cell's flat approximation, sampled every h/2. The mesh covers the cell
  // with two triangles along one diagonal or the other, so both are checked.
  const errorOf = (x, y, s) => {
    const z00 = E(x, y), z10 = E(x + s, y), z01 = E(x, y + s), z11 = E(x + s, y + s), n = Math.max(2, Math.round(2 * s / h));
    let worst = 0;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const u = i / n, v = j / n, z = E(x + u * s, y + v * s);
      const pA = u >= v ? z00 + (z10 - z00) * u + (z11 - z10) * v : z00 + (z11 - z01) * u + (z01 - z00) * v;   // diagonal 00–11
      const pB = u + v <= 1 ? z00 + (z10 - z00) * u + (z01 - z00) * v : z11 + (z01 - z11) * (1 - u) + (z10 - z11) * (1 - v); // diagonal 10–01
      worst = Math.max(worst, Math.abs(z - pA), Math.abs(z - pB));
    }
    return worst;
  };
  // Max-heap of cells by error.
  const heap = [];
  const push = c => { heap.push(c); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].e >= heap[i].e) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].e > heap[m].e) m = l; if (r < heap.length && heap[r].e > heap[m].e) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  // Exact vertex count: corners are shared between cells, so count how many cells use each one.
  const cornerKey = (x, y) => Math.round((x - minx) / hf) * 1048576 + Math.round((y - miny) / hf);
  const uses = new Map(); let vertices = 0;
  const corners = (c, d) => {
    for (const [x, y] of [[c.x, c.y], [c.x + c.s, c.y], [c.x, c.y + c.s], [c.x + c.s, c.y + c.s]]) {
      const k = cornerKey(x, y), n = (uses.get(k) || 0) + d;
      if (n === 0) { uses.delete(k); vertices--; } else { if (!uses.has(k)) vertices++; uses.set(k, n); }
    }
  };
  const add = (x, y, s) => {
    const cx = x + s / 2, cy = y + s / 2, dEdge = distToRing(cx, cy, ring);
    if (!inRing(cx, cy, ring) && dEdge > s * 0.75) return; // fully outside
    const e = s <= hf * 1.01 ? -1 : dEdge < s * 0.75 ? Infinity : errorOf(x, y, s); // -1: can't split
    const c = { x, y, s, e }; push(c); corners(c, 1);
  };
  for (let y = miny; y < maxy; y += S0) for (let x = minx; x < maxx; x += S0) add(x, y, S0);
  while (heap.length && heap[0].e > tolM) {
    // Splitting adds up to 5 vertices; stop once that would exceed the uniform grid's count.
    if (heap[0].e !== Infinity && vertices + 5 > budget) break;
    const c = pop(); corners(c, -1);
    const s2 = c.s / 2;
    add(c.x, c.y, s2); add(c.x + s2, c.y, s2); add(c.x, c.y + s2, s2); add(c.x + s2, c.y + s2, s2);
  }
  const emit = (x, y) => {
    const k = cornerKey(x, y);
    if (!emitted.has(k)) { emitted.add(k); emitPoint(x, y); }
  };
  for (const c of heap) { emit(c.x, c.y); emit(c.x + c.s, c.y); emit(c.x, c.y + c.s); emit(c.x + c.s, c.y + c.s); }
}

// Watertight terrain solid clipped to ring. h = sample spacing (null → flat slab).
// extraPts: additional vertices (e.g. shorelines) that the grid makes room for.
// opts.tolM: if set, place vertices adaptively (see adaptivePoints) with this height tolerance in
// elevation units; otherwise use a uniform grid.
function buildTerrain(ring, h, elevAt, extraPts = [], opts = {}) {
  const B = [];
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
    const k = h ? Math.max(1, Math.ceil(len / h)) : 1;
    for (let j = 0; j < k; j++) B.push({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k });
  }
  const nb = B.length, P = B.slice();
  if (h) {
    // Spatial hash so extra points and grid points don't crowd each other into slivers.
    const cs = h * 0.35, grid = new Map(), cellKey = (x, y) => Math.floor(x / cs) + ',' + Math.floor(y / cs);
    const near = (x, y, r) => {
      const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of grid.get((cx + i) + ',' + (cy + j)) || []) if ((p.x - x) ** 2 + (p.y - y) ** 2 < r * r) return true;
      return false;
    };
    const add = p => { const k = cellKey(p.x, p.y); (grid.get(k) || grid.set(k, []).get(k)).push(p); P.push(p); };
    // Forced points (contour pairs for stepped terrain) go in as-is: they are deliberately close.
    for (const p of extraPts) if (p.force && inRing(p.x, p.y, ring) && distToRing(p.x, p.y, ring) > h * 0.5) add({ x: p.x, y: p.y });
    for (const p of extraPts) if (!p.force && inRing(p.x, p.y, ring) && distToRing(p.x, p.y, ring) > h * 0.5 && !near(p.x, p.y, h * 0.3)) add({ x: p.x, y: p.y });
    const ok = (x, y) => inRing(x, y, ring) && distToRing(x, y, ring) > h * 0.5 && (!extraPts.length || !near(x, y, h * 0.35));
    if (opts.tolM > 0) adaptivePoints(ring, h, elevAt, opts.tolM, (x, y) => { if (ok(x, y)) add({ x, y }); });
    else {
      const [minx, miny, maxx, maxy] = bbox(ring);
      let row = 0;
      for (let y = miny + h * 0.5; y < maxy; y += h * 0.866, row++)
        for (let x = minx + (row % 2 ? h * 0.75 : h * 0.25); x < maxx; x += h)
          if (ok(x, y)) add({ x, y });
    }
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
// zs: optional per-vertex top heights overriding zOf(E[i]) (used to recess water areas).
function terrainSolid(T, zOf, zs = null) {
  const { P, keep, E, N } = T, out = [];
  const Z = zs || new Float64Array(N); if (!zs) for (let i = 0; i < N; i++) Z[i] = zOf(E[i]);
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
// A vertex is recessed under water only when all its triangles are water, so shore vertices keep
// zero water thickness. Two cases would then pinch the water solid to zero thickness inside it
// (non-manifold edges): an interior water edge with both ends on the shore (e.g. across a narrow
// river), and a water triangle with all three corners on the shore. Both are fixed by inserting a
// vertex (edge midpoint / centroid), which lies fully in water and gets recessed. Inserted points
// lie on the existing surface, so the terrain shape is unchanged. Returns a refined copy.
function refineWater(T, isWater) {
  const P = T.P.slice(), E = Array.from(T.E);
  let keep = T.keep.slice(), wet = Array.from(isWater);
  for (let pass = 0; pass < 6; pass++) {
    const N = P.length, total = new Uint16Array(N), wc = new Uint16Array(N);
    for (let t = 0, i = 0; i < keep.length; i += 3, t++) for (let j = 0; j < 3; j++) { total[keep[i + j]]++; if (wet[t]) wc[keep[i + j]]++; }
    const shore = i => !(wc[i] && wc[i] === total[i]);
    const key = (u, v) => u < v ? u * N + v : v * N + u;
    const edges = new Map();
    for (let t = 0, i = 0; i < keep.length; i += 3, t++) for (let j = 0; j < 3; j++) {
      const k = key(keep[i + j], keep[i + (j + 1) % 3]);
      (edges.get(k) || edges.set(k, []).get(k)).push(t);
    }
    const nk = [], nw = [], split = new Set();
    const addVertex = (idxs) => { const n = idxs.length; P.push({ x: idxs.reduce((s, i) => s + P[i].x, 0) / n, y: idxs.reduce((s, i) => s + P[i].y, 0) / n }); E.push(idxs.reduce((s, i) => s + E[i], 0) / n); return P.length - 1; };
    let changed = false;
    // Chords: interior edges between two water triangles with both ends on the shore.
    for (const [k, ts] of edges) {
      if (ts.length !== 2 || !wet[ts[0]] || !wet[ts[1]] || split.has(ts[0]) || split.has(ts[1])) continue;
      const u = Math.floor(k / N), v = k % N;
      if (!shore(u) || !shore(v)) continue;
      const m = addVertex([u, v]);
      for (const t of ts) {
        split.add(t);
        const tri = [keep[t * 3], keep[t * 3 + 1], keep[t * 3 + 2]];
        let r = 0; while (!((tri[r] === u && tri[(r + 1) % 3] === v) || (tri[r] === v && tri[(r + 1) % 3] === u))) r++;
        const x = tri[r], y = tri[(r + 1) % 3], z = tri[(r + 2) % 3];
        nk.push(x, m, z, m, y, z); nw.push(1, 1);
      }
      changed = true;
    }
    // Water triangles with all corners on the shore (not already split above).
    for (let t = 0; t < keep.length / 3; t++) {
      if (!wet[t] || split.has(t)) continue;
      const [a, b, c] = [keep[t * 3], keep[t * 3 + 1], keep[t * 3 + 2]];
      if (!shore(a) || !shore(b) || !shore(c)) continue;
      const m = addVertex([a, b, c]);
      split.add(t);
      nk.push(a, b, m, b, c, m, c, a, m); nw.push(1, 1, 1);
      changed = true;
    }
    if (!changed) break;
    const k2 = [], w2 = [];
    for (let t = 0; t < keep.length / 3; t++) if (!split.has(t)) { k2.push(keep[t * 3], keep[t * 3 + 1], keep[t * 3 + 2]); w2.push(wet[t]); }
    keep = k2.concat(nk); wet = w2.concat(nw);
  }
  return { T: { ...T, P, E: Float64Array.from(E), keep, N: P.length }, isWater: Uint8Array.from(wet) };
}

// Splits the terrain surface into land + water.
// isWater: Uint8Array, one flag per triangle of T.keep. depth: water thickness (mm).
// Vertices whose every triangle is water are lowered by `depth`; the water solid fills that recess
// up to the original surface. Its bottom is exactly the recessed terrain top, so the two parts meet
// with no gap and no overlap. At the shore the water thins to zero, which keeps the land untouched.
// Returns { zs: recessed terrain heights for terrainSolid, water: triangle array }.
function splitWater(T, zOf, isWater, depth) {
  const { P, keep, E, N } = T;
  const Z = new Float64Array(N), Zt = new Float64Array(N);
  for (let i = 0; i < N; i++) Z[i] = zOf(E[i]);
  const total = new Uint16Array(N), wet = new Uint16Array(N);
  for (let t = 0, i = 0; i < keep.length; i += 3, t++) for (let j = 0; j < 3; j++) { total[keep[i + j]]++; if (isWater[t]) wet[keep[i + j]]++; }
  for (let i = 0; i < N; i++) Zt[i] = wet[i] && wet[i] === total[i] ? Z[i] - depth : Z[i];

  const water = [], cnt = new Map(), key = (u, v) => u < v ? u * N + v : v * N + u;
  for (let t = 0, i = 0; i < keep.length; i += 3, t++) {
    if (!isWater[t]) continue;
    const a = keep[i], b = keep[i + 1], c = keep[i + 2];
    pushTri(water, P[a].x, P[a].y, Z[a], P[b].x, P[b].y, Z[b], P[c].x, P[c].y, Z[c]);    // top, up
    pushTri(water, P[a].x, P[a].y, Zt[a], P[c].x, P[c].y, Zt[c], P[b].x, P[b].y, Zt[b]); // bottom, down
    for (let j = 0; j < 3; j++) { const k = key(keep[i + j], keep[i + (j + 1) % 3]); cnt.set(k, (cnt.get(k) || 0) + 1); }
  }
  // Walls on the water region's outline wherever it has thickness (lake edges at the print border).
  const EPS = 1e-6;
  for (let t = 0, i = 0; i < keep.length; i += 3, t++) {
    if (!isWater[t]) continue;
    for (let j = 0; j < 3; j++) {
      const u = keep[i + j], v = keep[i + (j + 1) % 3];
      if (cnt.get(key(u, v)) !== 1) continue;
      const a = P[u], b = P[v], du = Z[u] - Zt[u] > EPS, dv = Z[v] - Zt[v] > EPS;
      if (dv) pushTri(water, a.x, a.y, Zt[u], b.x, b.y, Zt[v], b.x, b.y, Z[v]);
      if (du) pushTri(water, a.x, a.y, Zt[u], b.x, b.y, Z[v], a.x, a.y, Z[u]);
    }
  }
  return { zs: Zt, water };
}

function addPrism(o, outer, holes, zb, zt) {
  if (signedArea(outer) < 0) outer = outer.slice().reverse();
  holes = holes.map(h => signedArea(h) > 0 ? h.slice().reverse() : h);
  // earcut joins each hole to the outline with a bridge found by a horizontal ray. On axis-aligned
  // outlines (pixel-traced text, many buildings) that bridge can run exactly through other vertices,
  // leaving T-junctions (open edges). Triangulating in a slightly rotated frame avoids it; the
  // triangles still use the original points.
  const pts = outer.slice(), flat = [], hi = [], ca = Math.cos(0.1), sa = Math.sin(0.1);
  const put = p => flat.push(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  outer.forEach(put);
  for (const h of holes) { hi.push(flat.length / 2); h.forEach(p => { put(p); pts.push(p); }); }
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
// Solid over a convex, counter-clockwise outline: flat bottom at zb, top following zTop(p).
function addDrapedPrism(o, q, zTop, zb) {
  const zt = q.map(zTop), n = q.length;
  for (let i = 1; i < n - 1; i++) {
    pushTri(o, q[0].x, q[0].y, zt[0], q[i].x, q[i].y, zt[i], q[i + 1].x, q[i + 1].y, zt[i + 1]);   // top (fan)
    pushTri(o, q[0].x, q[0].y, zb, q[i + 1].x, q[i + 1].y, zb, q[i].x, q[i].y, zb);              // bottom
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, A = q[i], Bq = q[j];
    pushTri(o, A.x, A.y, zb, Bq.x, Bq.y, zb, Bq.x, Bq.y, zt[j]);
    pushTri(o, A.x, A.y, zb, Bq.x, Bq.y, zt[j], A.x, A.y, zt[i]);
  }
}

// A road/route piece from a to b, w wide, roadH above the terrain. clipRect (optional): keep only
// the part inside this rectangle (tiles) — the piece stays convex, so it stays a closed solid.
function addRoadBox(o, a, b, w, zAt, roadH, clipRect = null) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy); if (len < 1e-6) return false;
  const nx = -dy / len * w / 2, ny = dx / len * w / 2;
  let q = [{ x: a.x - nx, y: a.y - ny }, { x: b.x - nx, y: b.y - ny }, { x: b.x + nx, y: b.y + ny }, { x: a.x + nx, y: a.y + ny }];
  const zb = Math.max(0.05, Math.min(...q.map(p => zAt(p.x, p.y))) - 0.5);
  if (clipRect && !rectContains(clipRect, q)) {
    q = cleanRing(clipPolygonRect(q, clipRect), 1e-5);
    if (q.length < 3 || Math.abs(signedArea(q)) < 1e-4) return false;
  }
  addDrapedPrism(o, q, p => zAt(p.x, p.y) + roadH, zb);
  return true;
}

Object.assign(Mapcast, { earcutWinding, pushTri, buildTerrain, terrainSolid, refineWater, splitWater, addPrism, addDrapedPrism, addRoadBox });
})();
