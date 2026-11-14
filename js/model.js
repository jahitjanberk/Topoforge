/* Turns a print area + settings into printable mesh layers. No DOM access: progress is
   reported through onStatus(message). */
(() => {
'use strict';
const Mapcast = window.Mapcast = window.Mapcast || {};

const { toLocal, fromLocal, bbox, cleanRing, signedArea, inRing, distToRing } = Mapcast;
const { loadElevation, fetchOverpass, parseOSM, buildingHeight, ROADS, PATHS } = Mapcast;
const { buildTerrain, terrainSolid, addPrism, addRoadBox } = Mapcast;

const tick = () => new Promise(r => setTimeout(r, 16));

// ringLL: [L.LatLng] outline of the print area. S: settings from readSettings().
// Returns { layers: [{id,name,color,arr}], stats: [[label,value]], notes: [string] }.
async function buildModel(ringLL, S, onStatus = () => {}) {
  const bounds = L.latLngBounds(ringLL), o = bounds.getCenter();
  const ringM = ringLL.map(ll => toLocal(ll, o));
  const [minx, miny, maxx, maxy] = bbox(ringM);
  const scale = S.size / Math.max(maxx - minx, maxy - miny); // mm per metre
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  let ring = cleanRing(ringM.map(p => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale })), 1e-3);
  if (signedArea(ring) < 0) ring.reverse();
  const m2ll = (x, y) => fromLocal({ x: x / scale + cx, y: y / scale + cy }, o);
  const ll2m = (lat, lng) => { const p = toLocal({ lat, lng }, o); return { x: (p.x - cx) * scale, y: (p.y - cy) * scale }; };

  onStatus(S.terrain && (S.buildings || S.roads) ? 'Downloading elevation and OpenStreetMap data…' : S.terrain ? 'Downloading elevation data…' : (S.buildings || S.roads) ? 'Downloading OpenStreetMap data…' : 'Building model…');
  const [elev, osmJs] = await Promise.all([
    S.terrain ? loadElevation(bounds.pad(0.05)) : null,
    S.buildings || S.roads ? fetchOverpass(bounds.pad(0.01), S) : null
  ]);
  const osm = osmJs ? parseOSM(osmJs) : { buildings: [], roads: [] };

  onStatus('Building terrain…'); await tick();
  const elevAt = elev ? (x, y) => { const ll = m2ll(x, y); const e = elev.sample(ll.lat, ll.lng); return S.sea ? Math.max(e, 0) : e; } : () => 0;
  let h = null;
  if (elev) {
    h = Math.max(S.detail, elev.resM * scale * 0.7);
    h = Math.max(h, Math.sqrt(Math.abs(signedArea(ring)) / 220000));
  }
  const T = buildTerrain(ring, h, elevAt);
  const zOf = e => S.base + (e - T.minE) * scale * S.exag;
  const zAt = (x, y) => zOf(elevAt(x, y));
  const terrain = terrainSolid(T, zOf);

  let buildings = [], nB = 0;
  if (S.buildings && osm.buildings.length) {
    onStatus(`Raising ${osm.buildings.length.toLocaleString()} buildings…`); await tick();
    for (const bd of osm.buildings) {
      let outer = cleanRing(bd.outer.map(p => ll2m(p.lat, p.lon)), 0.02);
      if (outer.length < 3 || Math.abs(signedArea(outer)) < 0.15) continue;
      if (!outer.every(p => inRing(p.x, p.y, ring))) continue;
      const holes = bd.holes.map(hr => cleanRing(hr.map(p => ll2m(p.lat, p.lon)), 0.02)).filter(hr => hr.length >= 3);
      const zs = outer.map(p => zAt(p.x, p.y)), zmin = Math.min(...zs), zmax = Math.max(...zs);
      const hm = Math.max(S.bMin, buildingHeight(bd.tags) * scale * S.bMult);
      if (addPrism(buildings, outer, holes, Math.max(0.05, zmin - 0.4), Math.max(zmin + hm, zmax + 0.3))) nB++;
    }
  }
  let roads = [], nR = 0;
  if (S.roads && osm.roads.length) {
    onStatus('Laying roads…'); await tick();
    const piece = elev ? Math.max(1.2, (h || 1) * 1.5) : 4;
    for (const rd of osm.roads) {
      const t = rd.tags; if (t.tunnel && t.tunnel !== 'no') continue;
      const spec = ROADS[t.highway] || (S.paths ? PATHS[t.highway] : null); if (!spec) continue;
      const w = Math.max(spec[0] * scale, S.roadMin * spec[1]);
      const pts = rd.pts.map(p => ll2m(p.lat, p.lon));
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
          addRoadBox(roads, p0, p1, w, zAt, S.roadH); any = true;
        }
      }
      if (any) nR++;
    }
  }

  onStatus('Preparing preview…'); await tick();
  const layers = [
    { id: 'terrain', name: S.terrain ? 'Terrain & base' : 'Base', color: '#e3d3b0', arr: new Float32Array(terrain) },
    { id: 'buildings', name: 'Buildings', color: '#fbfaf8', arr: new Float32Array(buildings) },
    { id: 'roads', name: 'Roads', color: '#52525b', arr: new Float32Array(roads) }
  ].filter(l => l.arr.length);
  let maxZ = 0; for (const l of layers) for (let i = 2; i < l.arr.length; i += 3) if (l.arr[i] > maxZ) maxZ = l.arr[i];
  const [bx0, by0, bx1, by1] = bbox(ring);
  const tris = layers.reduce((s, l) => s + l.arr.length / 9, 0);
  const stats = [
    ['Footprint', `${(bx1 - bx0).toFixed(0)} × ${(by1 - by0).toFixed(0)} mm`], ['Height', `${maxZ.toFixed(1)} mm`],
    ['Scale', `1:${Number((1000 / scale).toPrecision(3)).toLocaleString()}`],
    ...(elev ? [['Elevation range', `${Math.round(T.minE)}–${Math.round(T.maxE)} m`]] : []),
    ...(S.buildings ? [['Buildings', nB.toLocaleString()]] : []), ...(S.roads ? [['Roads', nR.toLocaleString()]] : []),
    ['Triangles', tris.toLocaleString()], ['File size', `${(tris * 50 / 1048576).toFixed(1)} MB`]
  ];
  const notes = [];
  if (elev && elev.failed) notes.push(`${elev.failed} elevation tile(s) failed to load — those parts are flat.`);
  if (S.buildings && osmJs && !nB) notes.push('No buildings were found inside the area.');
  return { layers, stats, notes };
}

Object.assign(Mapcast, { buildModel });
})();
