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
  ['roads', 'Roads', '#52525b'], ['route', 'Route', '#e11d48'], ['label', 'Label', '#27272a']
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
  const dlMsg = S.terrain && needOsm ? 'Downloading elevation and OpenStreetMap data…' : S.terrain ? 'Downloading elevation data…' : needOsm ? 'Downloading OpenStreetMap data…' : 'Building model…';
  // The OpenStreetMap servers can queue requests; show how long we've been waiting.
  let elevFrac = S.terrain ? 0 : 1, waited = 0;
  const dlStatus = () => onStatus(waited >= 3 ? `${dlMsg.replace('…', '')} — waiting for the OpenStreetMap server (${waited} s)…` : dlMsg, lerp(P.download, needOsm ? elevFrac * 0.5 : elevFrac));
  dlStatus();
  const [elev, osmJs] = await Promise.all([
    S.terrain ? loadElevation(bounds.pad(0.05), f => { elevFrac = f; dlStatus(); }) : null,
    needOsm ? fetchOverpass(bounds.pad(0.01), { ...S, water: wantWater }, ringLL, s => { waited = s; dlStatus(); }) : null
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
      name: String.fromCharCode(65 + i) + (j + 1), rect: tiled ? rect : [-Infinity, -Infinity, Infinity, Infinity], ring: tRing,
      offset: tiled ? [(i - (nx - 1) / 2) * TILE_GAP, ((ny - 1) / 2 - j) * TILE_GAP] : [0, 0],
      parts: Object.fromEntries(PARTS.map(([id]) => [id, []]))
    });
  }

  /* ---------- terrain (+ water) per tile ---------- */
  for (const [k, t] of tiles.entries()) {
    onStatus(tiled ? `Building terrain — tile ${t.name} (${k + 1} of ${tiles.length})…` : 'Building terrain…', lerp(P.terrain, k / tiles.length * 0.5)); await tick();
    t.T = buildTerrain(t.ring, h, elevAt, extraPts);
  }
  const minE = Math.min(...tiles.map(t => t.T.minE)), maxE = Math.max(...tiles.map(t => t.T.maxE));
  const zOf = e => S.base + (e - minE) * scale * S.exag;
  const zAt = (x, y) => zOf(elevAt(x, y));

  let wetArea = 0, allArea = 0;
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
        const depth = Math.min(S.waterDepth, S.base * 0.6); // never cut through the base
        const R = refineWater(T, isWater); // remove zero-thickness pinches in the water solid
        const split = splitWater(R.T, zOf, R.isWater, depth);
        t.parts.water = split.water;
        terrain = terrainSolid(R.T, zOf, split.zs);
      }
    }
    t.parts.terrain = terrain || terrainSolid(T, zOf);
    t.T = null; // free memory
  }
  const waterShare = allArea ? wetArea / allArea : 0;

  /* ---------- buildings (clipped at tile edges) ---------- */
  let nB = 0;
  if (S.buildings && osm.buildings.length) {
    const bMsg = `Raising ${osm.buildings.length.toLocaleString()} buildings…`;
    onStatus(bMsg, P.buildings[0]); await tick();
    for (const [i, bd] of osm.buildings.entries()) {
      if (i % 500 === 0) onStatus(bMsg, lerp(P.buildings, i / osm.buildings.length));
      const outer = cleanRing(bd.outer.map(p => ll2m(p.lat, p.lon)), 0.02);
      if (outer.length < 3 || Math.abs(signedArea(outer)) < 0.15) continue;
      if (!outer.every(p => inRing(p.x, p.y, ring))) continue;
      const holes = bd.holes.map(hr => cleanRing(hr.map(p => ll2m(p.lat, p.lon)), 0.02)).filter(hr => hr.length >= 3);
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
  const piece = elev ? Math.max(1.2, (h || 1) * 1.5) : 4;
  const layLine = (partId, pts, w, height) => {
    let any = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y); if (len < 1e-4) continue;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, n = Math.max(1, Math.ceil(len / piece));
      for (let k = 0; k < n; k++) {
        let p0 = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }, p1 = { x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n };
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
  if (elev && elev.failed) notes.push(`${elev.failed} elevation tile(s) failed to load — those parts are flat.`);
  if (S.buildings && osmJs && !nB) notes.push('No buildings were found inside the area.');
  if (wantWater && elev && !has('water')) notes.push('No lakes, rivers or sea were found inside the area.');
  if (S.route && S.route.length && !routeLaid) notes.push('The route is outside the print area.');
  if (tiled && labelText) notes.push('The label plate is a separate piece.');
  return { layers, tiles: tiled ? tiles.map(t => ({ name: t.name })) : null, stats, notes };
}

Object.assign(Mapcast, { buildModel });
})();
