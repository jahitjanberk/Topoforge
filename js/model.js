/* Turns a print area + settings into printable mesh layers. No DOM or Leaflet access, so it
   runs inside the model Web Worker (js/worker.js) as well as on the page. Progress is reported
   through onStatus(message, fraction 0–1). */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { Bounds, toLocal, fromLocal, simplifyDP, haversineKm, bbox, cleanRing, signedArea, inRing, distToRing } = Mapcast;
const { loadElevation, fetchOverpass, parseOSM, buildingHeight, ROADS, PATHS } = Mapcast;
const { buildTerrain, terrainSolid, refineWater, splitWater, addPrism, addRoadBox } = Mapcast;
const { buildWaterMask, WATER } = Mapcast;
const { textPolygons } = Mapcast;

const tick = () => new Promise(r => setTimeout(r, 16));

// Share of the progress bar each stage covers.
const P = { download: [0, 0.4], terrain: 0.45, buildings: [0.7, 0.85], roads: [0.85, 0.97], done: 0.98 };
const lerp = ([a, b], f) => a + (b - a) * f;

// ringLL: [{lat,lng}] outline of the print area. S: settings from readSettings().
// Returns { layers: [{id,name,color,arr}], stats: [[label,value]], notes: [string] }.
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
  const elevAt = !elev ? () => 0 : mask ? (x, y) => { const l = mask.levelAt(x, y); return l != null ? l : rawElevAt(x, y); } : rawElevAt;

  onStatus('Building terrain…', P.terrain); await tick();
  const T = buildTerrain(ring, h, elevAt, mask ? mask.shorePts : []);
  const zOf = e => S.base + (e - T.minE) * scale * S.exag;
  const zAt = (x, y) => zOf(elevAt(x, y));

  // Classify triangles as water: OSM water at the centroid, or sea (all corners at/below 0 m).
  let water = [], waterShare = 0, terrain;
  if (wantWater && elev) {
    const { P: V, keep } = T, isWater = new Uint8Array(keep.length / 3);
    const sea = S.sea ? V.map(p => seaLevelAt(p.x, p.y) <= 0) : null;
    let wetArea = 0, allArea = 0;
    for (let t = 0, i = 0; i < keep.length; i += 3, t++) {
      const a = V[keep[i]], b = V[keep[i + 1]], c = V[keep[i + 2]];
      const ar = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
      allArea += ar;
      if ((mask && mask.kindAt((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3) !== WATER.NONE) || (sea && sea[keep[i]] && sea[keep[i + 1]] && sea[keep[i + 2]])) { isWater[t] = 1; wetArea += ar; }
    }
    waterShare = allArea ? wetArea / allArea : 0;
    if (wetArea > 0) {
      const depth = Math.min(S.waterDepth, S.base * 0.6); // never cut through the base
      const R = refineWater(T, isWater); // remove zero-thickness pinches in the water solid
      const split = splitWater(R.T, zOf, R.isWater, depth);
      water = split.water;
      terrain = terrainSolid(R.T, zOf, split.zs);
    }
  }
  if (!terrain) terrain = terrainSolid(T, zOf);

  let buildings = [], nB = 0;
  if (S.buildings && osm.buildings.length) {
    const bMsg = `Raising ${osm.buildings.length.toLocaleString()} buildings…`;
    onStatus(bMsg, P.buildings[0]); await tick();
    for (const [i, bd] of osm.buildings.entries()) {
      if (i % 500 === 0) onStatus(bMsg, lerp(P.buildings, i / osm.buildings.length));
      let outer = cleanRing(bd.outer.map(p => ll2m(p.lat, p.lon)), 0.02);
      if (outer.length < 3 || Math.abs(signedArea(outer)) < 0.15) continue;
      if (!outer.every(p => inRing(p.x, p.y, ring))) continue;
      const holes = bd.holes.map(hr => cleanRing(hr.map(p => ll2m(p.lat, p.lon)), 0.02)).filter(hr => hr.length >= 3);
      const zs = outer.map(p => zAt(p.x, p.y)), zmin = Math.min(...zs), zmax = Math.max(...zs);
      const hm = Math.max(S.bMin, buildingHeight(bd.tags) * scale * S.bMult);
      if (addPrism(buildings, outer, holes, Math.max(0.05, zmin - 0.4), Math.max(zmin + hm, zmax + 0.3))) nB++;
    }
  }
  // Lays a polyline (model mm) onto the terrain as short boxes `w` wide, `height` above the
  // surface, skipping pieces that would overhang the print edge. Returns true if anything was laid.
  const piece = elev ? Math.max(1.2, (h || 1) * 1.5) : 4;
  const layLine = (out, pts, w, height) => {
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
        addRoadBox(out, p0, p1, w, zAt, height); any = true;
      }
    }
    return any;
  };

  let roads = [], nR = 0;
  if (S.roads && osm.roads.length) {
    onStatus('Laying roads…', P.roads[0]); await tick();
    for (const [ri, rd] of osm.roads.entries()) {
      if (ri % 500 === 0) onStatus('Laying roads…', lerp(P.roads, ri / osm.roads.length));
      const t = rd.tags; if (t.tunnel && t.tunnel !== 'no') continue;
      const spec = ROADS[t.highway] || (S.paths ? PATHS[t.highway] : null); if (!spec) continue;
      const w = Math.max(spec[0] * scale, S.roadMin * spec[1]);
      if (layLine(roads, rd.pts.map(p => ll2m(p.lat, p.lon)), w, S.roadH)) nR++;
    }
  }

  // GPX route: one raised strip per track segment, simplified to what the printer can resolve.
  let route = [], routeKm = 0;
  if (S.route && S.route.length) {
    onStatus('Laying your route…', P.roads[1]); await tick();
    for (const seg of S.route) {
      const pts = simplifyDP(seg.map(p => ll2m(p.lat, p.lng)), 0.05);
      layLine(route, pts, S.routeW, S.routeH);
      for (let i = 1; i < seg.length; i++) routeKm += haversineKm(seg[i - 1], seg[i]);
    }
  }

  // Label: a plate along the front (south) edge, as tall as the base, with raised text on it.
  // The plate joins the base part (it overlaps the model by 0.5 mm so it's attached); the text is
  // its own part for a contrasting colour.
  let label = [];
  const labelText = String(S.label || '').trim();
  if (labelText) {
    onStatus('Adding the label…', P.done); await tick();
    const [lx0, ly0, lx1] = bbox(ring), width = lx1 - lx0;
    const th = Math.min(14, Math.max(5, width * 0.07)), depth = th * 1.9;
    const plate = [{ x: lx0, y: ly0 - depth }, { x: lx1, y: ly0 - depth }, { x: lx1, y: ly0 + 0.5 }, { x: lx0, y: ly0 + 0.5 }];
    addPrism(terrain, plate, [], 0, S.base);
    for (const p of textPolygons(labelText, { cx: (lx0 + lx1) / 2, cy: ly0 - depth / 2, heightMm: th, maxWidthMm: width - th })) {
      addPrism(label, p.outer, p.holes, S.base - 0.3, S.base + S.labelH);
    }
  }

  onStatus('Preparing preview…', P.done); await tick();
  const layers = [
    { id: 'terrain', name: S.terrain ? 'Terrain & base' : 'Base', color: '#e3d3b0', arr: new Float32Array(terrain) },
    { id: 'water', name: 'Water', color: '#4a90d9', arr: new Float32Array(water) },
    { id: 'buildings', name: 'Buildings', color: '#fbfaf8', arr: new Float32Array(buildings) },
    { id: 'roads', name: 'Roads', color: '#52525b', arr: new Float32Array(roads) },
    { id: 'route', name: 'Route', color: '#e11d48', arr: new Float32Array(route) },
    { id: 'label', name: 'Label', color: '#27272a', arr: new Float32Array(label) }
  ].filter(l => l.arr.length);
  let maxZ = 0, fx0 = Infinity, fy0 = Infinity, fx1 = -Infinity, fy1 = -Infinity;
  for (const l of layers) for (let i = 0; i < l.arr.length; i += 3) {
    const x = l.arr[i], y = l.arr[i + 1], z = l.arr[i + 2];
    if (z > maxZ) maxZ = z; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
  }
  const tris = layers.reduce((s, l) => s + l.arr.length / 9, 0);
  const stats = [
    ['Footprint', `${(fx1 - fx0).toFixed(0)} × ${(fy1 - fy0).toFixed(0)} mm`], ['Height', `${maxZ.toFixed(1)} mm`],
    ['Scale', `1:${Number((1000 / scale).toPrecision(3)).toLocaleString()}`],
    ...(elev ? [['Elevation range', `${Math.round(T.minE)}–${Math.round(T.maxE)} m`]] : []),
    ...(wantWater ? [['Water', `${(waterShare * 100).toFixed(waterShare < 0.1 ? 1 : 0)}% of area`]] : []),
    ...(S.route && S.route.length ? [['Route', `${routeKm.toFixed(1)} km`]] : []),
    ...(S.buildings ? [['Buildings', nB.toLocaleString()]] : []), ...(S.roads ? [['Roads', nR.toLocaleString()]] : []),
    ['Triangles', tris.toLocaleString()], ['File size', `${(tris * 50 / 1048576).toFixed(1)} MB`]
  ];
  const notes = [];
  if (elev && elev.failed) notes.push(`${elev.failed} elevation tile(s) failed to load — those parts are flat.`);
  if (S.buildings && osmJs && !nB) notes.push('No buildings were found inside the area.');
  if (wantWater && elev && !water.length) notes.push('No lakes, rivers or sea were found inside the area.');
  if (S.route && S.route.length && !route.length) notes.push('The route is outside the print area.');
  return { layers, stats, notes };
}

Object.assign(Mapcast, { buildModel });
})();
