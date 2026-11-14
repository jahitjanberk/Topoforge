/* Turns a print area + settings into printable mesh layers. No DOM or Leaflet access, so it
   runs inside the model Web Worker (js/worker.js) as well as on the page. Progress is reported
   through onStatus(message, fraction 0–1).

   Tiles: the model can be split into a grid of tiles (for prints larger than the bed). Each tile
   is built as its own set of watertight parts from the print outline clipped to the tile, with a
   shared height scale and base level, so tiles meet exactly. A single model is one tile. */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { Bounds, toLocal, fromLocal, simplifyDP, haversineKm, bbox, cleanRing, signedArea, inRing, distToRing } = Mapcast;
const { clipPolygonRect, rectContains, rectsOverlap } = Mapcast;
const { loadElevation, fetchOverpass, parseOSM, buildingHeight, ROADS, PATHS } = Mapcast;
const { buildTerrain, terrainSolid, refineWater, splitWater, addPrism, addRoadBox } = Mapcast;
const { buildWaterMask, WATER } = Mapcast;
const { textPolygons, hasCrossings } = Mapcast;
const { quantizer, contourPoints } = Mapcast;

const tick = () => new Promise(r => setTimeout(r, 16));

// Share of the progress bar each stage covers.
const P = { download: [0, 0.4], terrain: [0.45, 0.7], buildings: [0.7, 0.85], roads: [0.85, 0.97], done: 0.98 };
const lerp = ([a, b], f) => a + (b - a) * f;

const PARTS = [
  ['terrain', 'Terrain & base', '#e3d3b0'], ['water', 'Water', '#4a90d9'], ['buildings', 'Buildings', '#fbfaf8'],
  ['roads', 'Roads', '#52525b'], ['route', 'Route', '#e11d48'], ['label', 'Label', '#27272a'],
  ['keys', 'Connector keys', '#a8a29e']
];
const TILE_GAP = 6; // mm between tiles in the preview (downloads keep the real positions)

// ringLL: [{lat,lng}] outline of the print area. S: settings from readSettings().
// Returns { layers: [{id,name,color,arr,tile?,offset?}], tiles: [{name}]|null, stats, notes }.
async function buildModel(ringLL, S, onStatus = () => {}) {
  const bounds = Bounds.of(ringLL), o = bounds.getCenter();
  const ringM = ringLL.map(ll => toLocal(ll, o));
  const [minx, miny, maxx, maxy] = bbox(ringM);
  const scale = S.size / Math.max(maxx - minx, maxy - miny); // mm per metre
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  let ring = cleanRing(ringM.map(p => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale })), 1e-3);
  if (signedArea(ring) < 0) ring.reverse();
  const m2ll = (x, y) => fromLocal({ x: x / scale + cx, y: y / scale + cy }, o);
  const ll2m = (lat, lng) => { const p = toLocal({ lat, lng }, o); return { x: (p.x - cx) * scale, y: (p.y - cy) * scale }; };
  const notes = [];

  /* ---------- downloads ---------- */
  const wantWater = S.water && S.terrain; // water is cut into the terrain, so it needs terrain
  const needOsm = S.buildings || S.roads || wantWater;
  let osmError = null;
  const dlMsg = S.terrain && needOsm ? 'Downloading elevation and OpenStreetMap data…' : S.terrain ? 'Downloading elevation data…' : needOsm ? 'Downloading OpenStreetMap data…' : 'Building model…';
  // The OpenStreetMap servers can queue requests; show how long we've been waiting.
  let elevFrac = S.terrain ? 0 : 1, waited = 0;
  const dlStatus = () => onStatus(waited >= 3 ? `${dlMsg.replace('…', '')} — waiting for the OpenStreetMap server (${waited} s)…` : dlMsg, lerp(P.download, needOsm ? elevFrac * 0.5 : elevFrac));
  dlStatus();
  const [elev, osmJs] = await Promise.all([
    S.terrain ? loadElevation(bounds.pad(0.05), f => { elevFrac = f; dlStatus(); }) : null,
    // If the OpenStreetMap servers all fail, still build the terrain (unless that's all there'd be).
    needOsm ? fetchOverpass(bounds.pad(0.01), { ...S, water: wantWater }, ringLL, s => { waited = s; dlStatus(); })
      .catch(err => { if (!S.terrain) throw err; osmError = err; return null; }) : null
  ]);
  const osm = osmJs ? parseOSM(osmJs) : { buildings: [], roads: [], water: [], rivers: [] };

  /* ---------- elevation model (shared by all tiles) ---------- */
  const seaLevelAt = (x, y) => { const ll = m2ll(x, y); return elev.sample(ll.lat, ll.lng); }; // unclamped DEM
  const rawElevAt = (x, y) => { const e = seaLevelAt(x, y); return S.sea ? Math.max(e, 0) : e; };
  let h = null;
  if (elev) {
    h = Math.max(S.detail, elev.resM * scale * 0.7);
    h = Math.max(h, Math.sqrt(Math.abs(signedArea(ring)) / 220000));
  }

  let mask = null;
  if (wantWater && elev && (osm.water.length || osm.rivers.length)) {
    onStatus('Mapping lakes and rivers…', P.download[1]); await tick();
    mask = buildWaterMask(osm, { bbox: bbox(ring), h, ll2m, scale, rawElevAt, minRiver: 1.2 });
  }
  // Lakes are flattened to their level; everything else follows the DEM.
  const smoothElevAt = !elev ? () => 0 : mask ? (x, y) => { const l = mask.levelAt(x, y); return l != null ? l : rawElevAt(x, y); } : rawElevAt;
  let elevAt = smoothElevAt, extraPts = mask ? mask.shorePts : [], steps = 0;

  // Stepped terrain: round heights down to whole steps, with contour point pairs for crisp walls.
  if (S.stepped && elev && h) {
    onStatus('Cutting terrain steps…', P.terrain[0]); await tick();
    const [x0, y0, x1, y1] = bbox(ring);
    let m0 = Infinity, m1 = -Infinity;
    const sample = (x, y) => { const e = smoothElevAt(x, y); if (e < m0) m0 = e; if (e > m1) m1 = e; };
    for (let j = 0; j <= 150; j++) for (let i = 0; i <= 150; i++) { const x = x0 + (x1 - x0) * i / 150, y = y0 + (y1 - y0) * j / 150; if (inRing(x, y, ring)) sample(x, y); }
    ring.forEach(p => sample(p.x, p.y));
    const stepM = S.stepMm / (scale * S.exag); // one step in metres of real elevation
    const q = quantizer(m0, stepM);
    extraPts = extraPts.concat(contourPoints(ring, h, smoothElevAt, m0, stepM));
    elevAt = (x, y) => q(smoothElevAt(x, y));
    steps = Math.floor((m1 - m0) / stepM) + 1;
  }

  /* ---------- tiles ---------- */
  const nx = Math.min(6, Math.max(1, Math.round(S.tilesX || 1))), ny = Math.min(6, Math.max(1, Math.round(S.tilesY || 1)));
  const tiled = nx * ny > 1;
  const [rx0, ry0, rx1, ry1] = bbox(ring);
  const tiles = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    // Columns A, B, C… west→east; rows 1, 2, 3… north→south.
    const rect = [rx0 + (rx1 - rx0) * i / nx, ry1 - (ry1 - ry0) * (j + 1) / ny, rx0 + (rx1 - rx0) * (i + 1) / nx, ry1 - (ry1 - ry0) * j / ny];
    let tRing = tiled ? cleanRing(clipPolygonRect(ring, rect), 1e-6) : ring;
    if (tRing.length < 3 || Math.abs(signedArea(tRing)) < 1) continue; // e.g. corners of a circle
    if (signedArea(tRing) < 0) tRing = tRing.slice().reverse();
    if (tiled && hasCrossings([tRing])) notes.push(`Tile ${String.fromCharCode(65 + i)}${j + 1}: the area's outline crosses this tile's edge several times, so its edge may be uneven.`);
    tiles.push({
      name: String.fromCharCode(65 + i) + (j + 1), i, j, rect: tiled ? rect : [-Infinity, -Infinity, Infinity, Infinity], ring: tRing,
      offset: tiled ? [(i - (nx - 1) / 2) * TILE_GAP, ((ny - 1) / 2 - j) * TILE_GAP] : [0, 0],
      parts: Object.fromEntries(PARTS.map(([id]) => [id, []]))
    });
  }

  /* ---------- connector keys (tiles only) ---------- */
  // Bowtie keys join neighbouring tiles: each tile gets a half-dovetail pocket cut up into its
  // underside at the seam (wider inside than at the seam, so a key can't pull out sideways), and
  // the keys are printed separately and pushed in from below. Pocket mouths are inserted into the
  // tile outlines now, so they become mesh vertices; keys are confirmed once heights are known.
  let keys = [];
  const pocketD = Math.min(2.5, Math.max(0.8, S.base * 0.5)); // pocket depth = key thickness + 0.2
  if (tiled && h && S.connectors !== false) {
    const tw = Math.min((rx1 - rx0) / nx, (ry1 - ry0) / ny);
    const a = Math.min(8, Math.max(4, tw * 0.1)), w0 = a * 0.85, w1 = a * 1.45; // depth, mouth, inner width
    const at = (i, j) => tiles.find(t => t.i === i && t.j === j);
    const onLine = (ringT, coord, val) => ringT.filter(p => Math.abs(p[coord] - val) < 1e-9).map(p => p[coord === 'x' ? 'y' : 'x']);
    const seams = [];
    for (const A of tiles) {
      const E = at(A.i + 1, A.j), Sb = at(A.i, A.j + 1); // east and south neighbours
      if (E) seams.push({ A, B: E, coord: 'x', val: A.rect[2], u: { x: 0, y: 1 }, nA: { x: -1, y: 0 } });
      if (Sb) seams.push({ A, B: Sb, coord: 'y', val: A.rect[1], u: { x: 1, y: 0 }, nA: { x: 0, y: 1 } });
    }
    for (const sm of seams) {
      const ea = onLine(sm.A.ring, sm.coord, sm.val), eb = onLine(sm.B.ring, sm.coord, sm.val);
      if (ea.length < 2 || eb.length < 2) continue;
      const lo = Math.max(Math.min(...ea), Math.min(...eb)) + w1 / 2 + 1, hi = Math.min(Math.max(...ea), Math.max(...eb)) - w1 / 2 - 1;
      if (hi <= lo) continue;
      const count = Math.max(1, Math.round((hi - lo) / 50)), spacing = count === 1 ? hi - lo : (hi - lo) / (count - 1);
      // Each key slot has fallback positions along the seam, tried in order if the preferred one
      // turns out to be too thin (e.g. under a lake); the first that fits is used.
      for (let k = 0; k < count; k++) for (const [pref, f] of [0, -0.2, 0.2, -0.35, 0.35].entries()) {
        const s = (count === 1 ? (lo + hi) / 2 : lo + spacing * k) + f * spacing;
        if (s < lo || s > hi) continue;
        const c = sm.coord === 'x' ? { x: sm.val, y: s } : { x: s, y: sm.val };
        const P0 = (du, dn, n) => ({ x: c.x + sm.u.x * du + n.x * dn, y: c.y + sm.u.y * du + n.y * dn });
        const nB = { x: -sm.nA.x, y: -sm.nA.y };
        const key = {
          slot: `${sm.A.name}|${sm.B.name}|${k}`, pref, c, u: sm.u, nA: sm.nA, a, w0, w1, tiles: [sm.A, sm.B],
          S: P0(-w0 / 2, 0, sm.nA), T: P0(w0 / 2, 0, sm.nA),
          inner: [[P0(-w1 / 2, a, sm.nA), P0(w1 / 2, a, sm.nA)], [P0(-w1 / 2, a, nB), P0(w1 / 2, a, nB)]]
        };
        // The pocket must sit well inside both tiles (not near another edge of the outline).
        if (key.inner.every((pts, n) => pts.every(p => inRing(p.x, p.y, key.tiles[n].ring) && distToRing(p.x, p.y, key.tiles[n].ring) > 1))) keys.push(key);
      }
    }
    // Insert pocket mouths into both tile outlines so they become boundary vertices.
    for (const t of tiles) {
      const pts = keys.filter(kk => kk.tiles.includes(t)).flatMap(kk => [kk.S, kk.T]);
      if (!pts.length) continue;
      const out = [];
      for (let i = 0; i < t.ring.length; i++) {
        const p = t.ring[i], q = t.ring[(i + 1) % t.ring.length], dx = q.x - p.x, dy = q.y - p.y, l2 = dx * dx + dy * dy;
        out.push(p);
        const on = pts.filter(m => Math.abs(dx * (m.y - p.y) - dy * (m.x - p.x)) < 1e-9 * Math.sqrt(l2))
          .map(m => ({ m, t: ((m.x - p.x) * dx + (m.y - p.y) * dy) / l2 })).filter(o => o.t > 1e-9 && o.t < 1 - 1e-9).sort((A, B) => A.t - B.t);
        out.push(...on.map(o => o.m));
      }
      t.ring = out;
    }
  }

  /* ---------- terrain (+ water) per tile ---------- */
  // Adaptive mesh: flat ground gets large triangles as long as the surface stays within ~7% of the
  // mesh spacing of the true height (about 0.05 mm at Standard) — finer than a printer can show.
  // S.adaptive === false keeps the old uniform grid (used to measure the saving).
  const tolM = elev && h && S.adaptive !== false ? (h * 0.07) / (scale * S.exag) : 0;
  for (const [k, t] of tiles.entries()) {
    onStatus(tiled ? `Building terrain — tile ${t.name} (${k + 1} of ${tiles.length})…` : 'Building terrain…', lerp(P.terrain, k / tiles.length * 0.5)); await tick();
    t.T = buildTerrain(t.ring, h, elevAt, extraPts, { tolM });
  }
  const minE = Math.min(...tiles.map(t => t.T.minE)), maxE = Math.max(...tiles.map(t => t.T.maxE));
  const zOf = e => S.base + (e - minE) * scale * S.exag;
  const zAt = (x, y) => zOf(elevAt(x, y));

  let wetArea = 0, allArea = 0;
  const waterDepth = Math.min(S.waterDepth, S.base * 0.6); // never cut through the base
  for (const [k, t] of tiles.entries()) {
    if (tiled) { onStatus(`Building terrain — tile ${t.name} (${k + 1} of ${tiles.length})…`, lerp(P.terrain, 0.5 + k / tiles.length * 0.5)); await tick(); }
    const T = t.T;
    let terrain = null;
    if (wantWater && elev) {
      // Water: OSM water at the triangle centroid, or sea (all corners at/below 0 m).
      const { P: V, keep } = T, isWater = new Uint8Array(keep.length / 3);
      const sea = S.sea ? V.map(p => seaLevelAt(p.x, p.y) <= 0) : null;
      let wet = 0;
      for (let tri = 0, i = 0; i < keep.length; i += 3, tri++) {
        const a = V[keep[i]], b = V[keep[i + 1]], c = V[keep[i + 2]];
        const ar = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
        allArea += ar;
        if ((mask && mask.kindAt((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3) !== WATER.NONE) || (sea && sea[keep[i]] && sea[keep[i + 1]] && sea[keep[i + 2]])) { isWater[tri] = 1; wet += ar; }
      }
      wetArea += wet;
      if (wet > 0) {
        const R = refineWater(T, isWater); // remove zero-thickness pinches in the water solid
        const split = splitWater(R.T, zOf, R.isWater, waterDepth);
        t.parts.water = split.water;
        terrain = { T: R.T, zs: split.zs };
      }
    }
    t.solid = terrain || { T, zs: null }; // built below, once the connector pockets are settled
    t.T = null;
  }
  const waterShare = allArea ? wetArea / allArea : 0;

  // Keep only keys with enough material above both pockets (≥ 0.8 mm), e.g. not under lakes.
  const keysPlanned = new Set(keys.map(kk => kk.slot)).size; // slots, not fallback positions
  if (keys.length) {
    const wetAt = (x, y) => (mask && mask.kindAt(x, y) !== WATER.NONE) || (wantWater && S.sea && elev && seaLevelAt(x, y) <= 0);
    const topAt = (x, y) => zAt(x, y) - (wantWater && wetAt(x, y) ? waterDepth : 0) - (h || 1) * 0.07;
    keys = keys.filter(kk => kk.inner.every(([p, q]) => {
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
        const mouth = { x: kk.S.x + (kk.T.x - kk.S.x) * i / 4, y: kk.S.y + (kk.T.y - kk.S.y) * i / 4 }, in_ = { x: p.x + (q.x - p.x) * i / 4, y: p.y + (q.y - p.y) * i / 4 };
        const x = mouth.x + (in_.x - mouth.x) * j / 4, y = mouth.y + (in_.y - mouth.y) * j / 4;
        if (topAt(x, y) < pocketD + 0.8) return false;
      }
      return true;
    }));
    // One key per slot: the most preferred position that passed.
    const best = new Map();
    for (const kk of keys) if (!best.has(kk.slot) || kk.pref < best.get(kk.slot).pref) best.set(kk.slot, kk);
    keys = [...best.values()];
  }
  // Build each tile's solid with its pockets. A tile that can't take them drops those keys (and its
  // neighbours are rebuilt without them).
  const pocketsOf = t => keys.filter(kk => kk.tiles.includes(t)).map(kk => ({ S: kk.S, T: kk.T, inner: kk.inner[kk.tiles.indexOf(t)], d: pocketD }));
  for (let pass = 0, todo = tiles.slice(); todo.length && pass < 4; pass++) {
    const failed = [];
    for (const t of todo) {
      const res = terrainSolid(t.solid.T, zOf, t.solid.zs, pocketsOf(t));
      if (res) t.parts.terrain = res; else failed.push(t);
    }
    const dropped = keys.filter(kk => kk.tiles.some(t => failed.includes(t)));
    keys = keys.filter(kk => !dropped.includes(kk));
    todo = [...new Set(failed.concat(dropped.flatMap(kk => kk.tiles)))];
  }
  for (const t of tiles) { if (!t.parts.terrain.length) t.parts.terrain = terrainSolid(t.solid.T, zOf, t.solid.zs); t.solid = null; }

  /* ---------- buildings (clipped at tile edges) ---------- */
  let nB = 0;
  if (S.buildings && osm.buildings.length) {
    const bMsg = `Raising ${osm.buildings.length.toLocaleString()} buildings…`;
    onStatus(bMsg, P.buildings[0]); await tick();
    for (const [i, bd] of osm.buildings.entries()) {
      if (i % 500 === 0) onStatus(bMsg, lerp(P.buildings, i / osm.buildings.length));
      let outer = cleanRing(bd.outer.map(p => ll2m(p.lat, p.lon)), 0.02);
      if (outer.length < 3 || Math.abs(signedArea(outer)) < 0.15) continue;
      if (!outer.every(p => inRing(p.x, p.y, ring))) continue;
      let holes = bd.holes.map(hr => cleanRing(hr.map(p => ll2m(p.lat, p.lon)), 0.02)).filter(hr => hr.length >= 3);
      // Footprint detail below 0.05 mm can't be printed: simplify, unless that makes it cross itself.
      const so = simplifyDP(outer, 0.05), sh = holes.map(hr => simplifyDP(hr, 0.05)).filter(hr => hr.length >= 3 && Math.abs(signedArea(hr)) > 0.01);
      if (so.length >= 3 && Math.abs(signedArea(so)) >= 0.15 && !hasCrossings([so, ...sh])) { outer = so; holes = sh; }
      const zs = outer.map(p => zAt(p.x, p.y)), zmin = Math.min(...zs), zmax = Math.max(...zs);
      const hm = Math.max(S.bMin, buildingHeight(bd.tags) * scale * S.bMult);
      const zb = Math.max(0.05, zmin - 0.4), zt = Math.max(zmin + hm, zmax + 0.3), bb = bbox(outer);
      let placed = false;
      for (const t of tiles) {
        if (!rectsOverlap(t.rect, bb)) continue;
        if (rectContains(t.rect, outer)) { placed = addPrism(t.parts.buildings, outer, holes, zb, zt) || placed; continue; }
        const o2 = cleanRing(clipPolygonRect(outer, t.rect), 1e-4);
        if (o2.length < 3 || Math.abs(signedArea(o2)) < 0.05) continue;
        const h2 = holes.map(hr => cleanRing(clipPolygonRect(hr, t.rect), 1e-4)).filter(hr => hr.length >= 3 && Math.abs(signedArea(hr)) > 1e-3);
        if (hasCrossings([o2, ...h2])) continue; // a concave footprint that the cut would break
        placed = addPrism(t.parts.buildings, o2, h2, zb, zt) || placed;
      }
      if (placed) nB++;
    }
  }

  /* ---------- roads and route (pieces clipped at tile edges) ---------- */
  // Lays a polyline (model mm) onto the terrain as short boxes `w` wide, `height` above the
  // surface, skipping pieces that would overhang the print edge. Returns true if anything was laid.
  // Pieces are split only where the ground under them bends (by more than 0.05 mm), and kept
  // short near the print outline (so the overhang rule below stays fine-grained). On flat ground a
  // straight stretch is one piece; the old fixed 1.2 mm pieces made city models huge.
  const ROAD_TOL = 0.05, MAX_PIECE = 15;
  const pieceCuts = (a, b, len) => {
    const at = t => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }), ts = [0, 1];
    const zt = t => { const p = at(t); return zAt(p.x, p.y); };
    const rec = (t0, z0, t1, z1) => {
      const segLen = (t1 - t0) * len;
      if (segLen <= 0.6) return;
      const mid = at((t0 + t1) / 2);
      let need = segLen > MAX_PIECE || distToRing(mid.x, mid.y, ring) < segLen;
      if (!need && elev) for (const f of [0.25, 0.5, 0.75]) if (Math.abs(zt(t0 + (t1 - t0) * f) - (z0 + (z1 - z0) * f)) > ROAD_TOL) { need = true; break; }
      if (!need) return;
      const tm = (t0 + t1) / 2, zm = zt(tm);
      rec(t0, z0, tm, zm); ts.push(tm); rec(tm, zm, t1, z1);
    };
    rec(0, zt(0), 1, zt(1));
    return ts.sort((x, y) => x - y);
  };
  const layLine = (partId, ptsIn, w, height) => {
    let any = false;
    const pts = simplifyDP(ptsIn, ROAD_TOL); // OSM curve detail far below what the model can show
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 1e-4) continue;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, cuts = pieceCuts(a, b, len), n = cuts.length - 1;
      for (let k = 0; k < n; k++) {
        let p0 = { x: a.x + (b.x - a.x) * cuts[k], y: a.y + (b.y - a.y) * cuts[k] }, p1 = { x: a.x + (b.x - a.x) * cuts[k + 1], y: a.y + (b.y - a.y) * cuts[k + 1] };
        if (k === 0) p0 = { x: p0.x - ux * w / 2, y: p0.y - uy * w / 2 };
        if (k === n - 1) p1 = { x: p1.x + ux * w / 2, y: p1.y + uy * w / 2 };
        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2, m = w / 2;
        if (!inRing(mx, my, ring) || !inRing(p0.x, p0.y, ring) || !inRing(p1.x, p1.y, ring)) continue;
        if (distToRing(mx, my, ring) < m || distToRing(p0.x, p0.y, ring) < m * 0.9 || distToRing(p1.x, p1.y, ring) < m * 0.9) continue;
        const pb = [Math.min(p0.x, p1.x) - m, Math.min(p0.y, p1.y) - m, Math.max(p0.x, p1.x) + m, Math.max(p0.y, p1.y) + m];
        for (const t of tiles) if (rectsOverlap(t.rect, pb) && addRoadBox(t.parts[partId], p0, p1, w, zAt, height, tiled ? t.rect : null)) any = true;
      }
    }
    return any;
  };

  let nR = 0;
  if (S.roads && osm.roads.length) {
    onStatus('Laying roads…', P.roads[0]); await tick();
    for (const [ri, rd] of osm.roads.entries()) {
      if (ri % 500 === 0) onStatus('Laying roads…', lerp(P.roads, ri / osm.roads.length));
      const t = rd.tags; if (t.tunnel && t.tunnel !== 'no') continue;
      const spec = ROADS[t.highway] || (S.paths ? PATHS[t.highway] : null); if (!spec) continue;
      const w = Math.max(spec[0] * scale, S.roadMin * spec[1]);
      if (layLine('roads', rd.pts.map(p => ll2m(p.lat, p.lon)), w, S.roadH)) nR++;
    }
  }

  // GPX route: one raised strip per track segment, simplified to what the printer can resolve.
  let routeKm = 0, routeLaid = false;
  if (S.route && S.route.length) {
    onStatus('Laying your route…', P.roads[1]); await tick();
    for (const seg of S.route) {
      if (layLine('route', simplifyDP(seg.map(p => ll2m(p.lat, p.lng)), 0.05), S.routeW, S.routeH)) routeLaid = true;
      for (let i = 1; i < seg.length; i++) routeKm += haversineKm(seg[i - 1], seg[i]);
    }
  }

  /* ---------- label ---------- */
  // A plate along the front (south) edge, as tall as the base, with raised text on it. Untiled, the
  // plate joins the base (overlapping the model by 0.5 mm); tiled, it is a separate piece.
  const labelText = String(S.label || '').trim();
  if (labelText) {
    onStatus('Adding the label…', P.done); await tick();
    const width = rx1 - rx0, th = Math.min(14, Math.max(5, width * 0.07)), depth = th * 1.9;
    const plate = [{ x: rx0, y: ry0 - depth }, { x: rx1, y: ry0 - depth }, { x: rx1, y: ry0 + (tiled ? 0 : 0.5) }, { x: rx0, y: ry0 + (tiled ? 0 : 0.5) }];
    let host = tiles[0];
    if (tiled) {
      host = { name: 'Label', rect: null, offset: [0, -((ny - 1) / 2 + 1) * TILE_GAP], parts: Object.fromEntries(PARTS.map(([id]) => [id, []])) };
      tiles.push(host);
    }
    addPrism(host.parts.terrain, plate, [], 0, S.base);
    for (const p of textPolygons(labelText, { cx: (rx0 + rx1) / 2, cy: ry0 - depth / 2, heightMm: th, maxWidthMm: width - th })) {
      addPrism(host.parts.label, p.outer, p.holes, S.base - 0.3, S.base + S.labelH);
    }
  }

  /* ---------- connector keys piece ---------- */
  // The keys, laid out in a compact grid (so the piece fits a bed), 0.15 mm smaller than the
  // pockets all round and 0.2 mm thinner than they are deep.
  if (keys.length) {
    const host = { name: 'Keys', rect: null, offset: [0, -((ny - 1) / 2 + (labelText ? 2.2 : 1)) * TILE_GAP], parts: Object.fromEntries(PARTS.map(([id]) => [id, []])) };
    const cl = 0.15, kk0 = keys[0], gapK = 3, perRow = Math.max(1, Math.floor((rx1 - rx0) / (kk0.w1 + gapK)));
    const yBase = ry0 - (labelText ? Math.min(14, Math.max(5, (rx1 - rx0) * 0.07)) * 1.9 : 0) - 10 - kk0.a;
    keys.forEach((kk, n) => {
      const cx = rx0 + kk.w1 / 2 + (n % perRow) * (kk.w1 + gapK), cy = yBase - Math.floor(n / perRow) * (2 * kk.a + gapK);
      const A = kk.a - cl, W0 = kk.w0 / 2 - cl, W1 = kk.w1 / 2 - cl;
      const bowtie = [{ x: cx - W1, y: cy - A }, { x: cx + W1, y: cy - A }, { x: cx + W0, y: cy }, { x: cx + W1, y: cy + A }, { x: cx - W1, y: cy + A }, { x: cx - W0, y: cy }];
      addPrism(host.parts.keys, bowtie, [], 0, pocketD - 0.2);
    });
    tiles.push(host);
    notes.push(`${keys.length} connector key${keys.length === 1 ? '' : 's'}: print the “Connector keys” piece and push one key into each pair of matching pockets on the tiles’ undersides (a drop of glue holds them).`);
  }
  if (keysPlanned > keys.length) notes.push(`${keysPlanned - keys.length} connector key position${keysPlanned - keys.length === 1 ? ' was' : 's were'} skipped where the model is too thin above the pocket (e.g. under lakes).`);

  /* ---------- output ---------- */
  onStatus('Preparing preview…', P.done); await tick();
  const layers = [];
  for (const t of tiles) for (const [id, name, color] of PARTS) {
    const arr = t.parts[id];
    if (!arr.length) continue;
    const partName = id === 'terrain' ? (t.name === 'Label' ? 'Plate' : S.terrain ? 'Terrain & base' : 'Base') : name;
    layers.push(tiled
      ? { id: `${t.name.toLowerCase()}-${id}`, name: `${t.name} · ${partName}`, part: id, color, arr: new Float32Array(arr), tile: t.name, offset: t.offset }
      : { id, name: partName, part: id, color, arr: new Float32Array(arr) });
  }
  let maxZ = 0, fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  for (const l of layers) for (let i = 0; i < l.arr.length; i += 3) {
    const x = l.arr[i], y = l.arr[i + 1], z = l.arr[i + 2];
    if (z > maxZ) maxZ = z; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
  }
  const tris = layers.reduce((s, l) => s + l.arr.length / 9, 0);
  const has = id => layers.some(l => l.part === id);
  const stats = [
    ['Footprint', `${(fx1 - fx0).toFixed(0)} × ${(fy1 - fy0).toFixed(0)} mm`], ['Height', `${maxZ.toFixed(1)} mm`],
    ...(tiled ? [['Tiles', `${nx} × ${ny}, each ≤ ${((rx1 - rx0) / nx).toFixed(0)} × ${((ry1 - ry0) / ny).toFixed(0)} mm`]] : []),
    ['Scale', `1:${Number((1000 / scale).toPrecision(3)).toLocaleString()}`],
    ...(elev ? [['Elevation range', `${Math.round(minE)}–${Math.round(maxE)} m`]] : []),
    ...(steps ? [['Steps', `${steps} × ${S.stepMm} mm`]] : []),
    ...(wantWater ? [['Water', `${(waterShare * 100).toFixed(waterShare < 0.1 ? 1 : 0)}% of area`]] : []),
    ...(S.route && S.route.length ? [['Route', `${routeKm.toFixed(1)} km`]] : []),
    ...(S.buildings ? [['Buildings', nB.toLocaleString()]] : []), ...(S.roads ? [['Roads', nR.toLocaleString()]] : []),
    ['Triangles', tris.toLocaleString()], ['File size', `${(tris * 50 / 1048576).toFixed(1)} MB`]
  ];
  // Very large files freeze or crash some slicers: say so, and how to shrink the model.
  const stlMB = tris * 50 / 1048576;
  if (stlMB > 50) {
    const big = layers.filter(l => ['buildings', 'roads'].includes(l.part)).reduce((s, l) => s + l.arr.length / 9, 0) > tris * 0.5;
    notes.unshift(`This model is large (${stlMB.toFixed(0)} MB as STL, ${Math.round(tris).toLocaleString()} triangles); some slicers struggle with files this big. Prefer the 3MF download (much smaller), ${big ? 'untick Buildings or Roads, or ' : ''}use a smaller area${tiled ? '' : ', or split into tiles'}.`);
  }
  if (osmError) {
    const skipped = [S.buildings && 'buildings', S.roads && 'roads', wantWater && 'lakes and rivers'].filter(Boolean).join(', ');
    notes.unshift(`The OpenStreetMap servers didn't respond, so this model has no ${skipped}${wantWater && S.sea ? ' (the sea is still included)' : ''}. Try Generate again in a few minutes to add them.`);
  }
  if (elev && elev.failed) notes.push(`${elev.failed} elevation tile(s) failed to load — those parts are flat.`);
  if (S.buildings && osmJs && !nB) notes.push('No buildings were found inside the area.');
  if (wantWater && elev && !osmError && !has('water')) notes.push('No lakes, rivers or sea were found inside the area.');
  if (S.route && S.route.length && !routeLaid) notes.push('The route is outside the print area.');
  if (tiled && labelText) notes.push('The label plate is a separate piece.');
  return { layers, tiles: tiled ? tiles.map(t => ({ name: t.name })) : null, stats, notes };
}

Object.assign(Mapcast, { buildModel });
})();
