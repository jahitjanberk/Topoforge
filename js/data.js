/* Data sources: elevation (AWS Terrarium tiles) + OpenStreetMap (Overpass) */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { D2R, tileXY, inRing } = Mapcast;

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Decodes one tile without the DOM, so this also runs inside a Web Worker.
async function fetchBitmap(url) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return createImageBitmap(await r.blob());
}
const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};

// b: Bounds (see geo.js). onProgress(fraction 0–1) as tiles arrive.
async function loadElevation(b, onProgress = () => {}) {
  let z, x0, x1, y0, y1;
  for (z = 15; z >= 1; z--) {
    const a = tileXY(b.getNorth(), b.getWest(), z), c = tileXY(b.getSouth(), b.getEast(), z);
    x0 = Math.floor(a.x); x1 = Math.floor(c.x); y0 = Math.floor(a.y); y1 = Math.floor(c.y);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 36) break;
  }
  const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
  const cv = makeCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(128,0,0)'; ctx.fillRect(0, 0, W, H); // = 0 m
  let failed = 0, done = 0;
  const jobs = [], n = 2 ** z;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const url = TERRARIUM_URL.replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
    jobs.push(fetchBitmap(url)
      .then(bmp => { ctx.drawImage(bmp, (x - x0) * 256, (y - y0) * 256); bmp.close(); })
      .catch(() => { failed++; })
      .finally(() => onProgress(++done / jobs.length)));
  }
  await Promise.all(jobs);
  if (failed === jobs.length) throw new Error('Could not download elevation data. Check your connection, or untick Terrain.');
  const px = ctx.getImageData(0, 0, W, H).data, E = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) E[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  const sample = (lat, lng) => {
    const t = tileXY(lat, lng, z);
    let fx = (t.x - x0) * 256 - 0.5, fy = (t.y - y0) * 256 - 0.5;
    fx = Math.max(0, Math.min(W - 1.001, fx)); fy = Math.max(0, Math.min(H - 1.001, fy));
    const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy, i = iy * W + ix;
    return E[i] * (1 - dx) * (1 - dy) + E[i + 1] * dx * (1 - dy) + E[i + W] * (1 - dx) * dy + E[i + W + 1] * dx * dy;
  };
  return { sample, resM: 156543.03392 * Math.cos(b.getCenter().lat * D2R) / 2 ** z, z, failed };
}
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
async function fetchOverpass(b, S) {
  const bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(v => v.toFixed(6)).join(',');
  const parts = [];
  if (S.buildings) parts.push(`way["building"](${bb});`, `relation["building"]["type"="multipolygon"](${bb});`);
  if (S.roads) parts.push(`way["highway"](${bb});`);
  if (S.water) parts.push(
    `way["natural"="water"](${bb});`, `relation["natural"="water"](${bb});`,
    `way["landuse"="reservoir"](${bb});`, `relation["landuse"="reservoir"](${bb});`,
    `way["waterway"="riverbank"](${bb});`, `relation["waterway"="riverbank"](${bb});`,
    `way["waterway"~"^(river|canal)$"](${bb});`
  );
  const query = `[out:json][timeout:120];(${parts.join('')});out geom qt;`;
  let lastErr;
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (err) { lastErr = err; }
  }
  throw new Error(`The OpenStreetMap server is busy (${lastErr && lastErr.message}). Try again in a minute, use a smaller area, or untick Buildings/Roads/Water.`);
}
const ROADS = {
  motorway: [16, 1.6], trunk: [13, 1.5], primary: [11, 1.4], secondary: [10, 1.25], tertiary: [8, 1.15],
  motorway_link: [7, 1.1], trunk_link: [7, 1.1], primary_link: [7, 1.1], secondary_link: [7, 1.05], tertiary_link: [6, 1],
  unclassified: [6, 1], residential: [6, 1], living_street: [5, 1], road: [6, 1], pedestrian: [5, .9], service: [4, .8], busway: [6, 1]
};
const PATHS = { footway: [2, .6], path: [2, .6], cycleway: [2, .6], steps: [2, .6], bridleway: [2, .6], track: [3, .7] };
const BH = { house: 7, detached: 7, semidetached_house: 7, bungalow: 4, terrace: 8, garage: 3, garages: 3, shed: 3, hut: 3, roof: 4, carport: 3, apartments: 15, residential: 10, commercial: 12, office: 18, retail: 8, industrial: 9, warehouse: 9, church: 15, cathedral: 35, hospital: 18, school: 9, university: 14, hotel: 18 };
function buildingHeight(t) {
  const p = v => { if (v == null) return null; const f = parseFloat(String(v).replace(',', '.')); return isFinite(f) ? f : null; };
  let h = p(t.height);
  if (h == null && t['building:levels'] != null) { const l = p(t['building:levels']); if (l != null) h = l * 3.2 + (p(t['roof:levels']) || 0) * 1.6; }
  if (h == null) h = BH[t.building] || 9;
  return Math.min(Math.max(h, 2), 900);
}
/* ---------- water ---------- */
const FLOWING = new Set(['river', 'canal', 'stream', 'ditch', 'drain', 'lock', 'rapids', 'wastewater', 'stream_pool']);
const isWaterArea = t => t.natural === 'water' || t.landuse === 'reservoir' || t.waterway === 'riverbank';
// Lakes, ponds and reservoirs are flat ('lake'); river areas follow the terrain ('flow').
const waterKind = t => t.waterway === 'riverbank' || FLOWING.has(t.water) ? 'flow' : 'lake';
const RIVER_WIDTH = { river: 20, canal: 12 }; // metres, when the way has no width tag

// Joins open way geometries end-to-end into closed rings (large lakes are split over many ways).
// Pieces that can't be closed (cut off by the download area) are dropped.
function assembleRings(ways) {
  const key = p => p.lat + ',' + p.lon;
  const rings = [], pool = ways.filter(w => w && w.length >= 2).map(w => w.slice());
  while (pool.length) {
    let ring = pool.pop();
    for (let guard = 0; key(ring[0]) !== key(ring[ring.length - 1]) && guard < 10000; guard++) {
      const end = key(ring[ring.length - 1]);
      const i = pool.findIndex(w => key(w[0]) === end || key(w[w.length - 1]) === end);
      if (i < 0) break;
      const w = pool.splice(i, 1)[0];
      ring = ring.concat((key(w[0]) === end ? w : w.reverse()).slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring.slice(0, -1));
  }
  return rings;
}
// Groups inner rings under the outer ring that contains them.
function ringsToPolygons(outers, inners, extra) {
  const polys = outers.map(o => ({ outer: o, holes: [], ...extra }));
  for (const h of inners) {
    const p = polys.find(b => inRing(h[0].lon, h[0].lat, b.outer.map(q => ({ x: q.lon, y: q.lat }))));
    if (p) p.holes.push(h);
  }
  return polys;
}

function parseOSM(js) {
  const buildings = [], roads = [], water = [], rivers = [];
  const closed = g => g && g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
  for (const el of js.elements || []) {
    const t = el.tags || {};
    if (isWaterArea(t)) {
      if (el.type === 'way' && closed(el.geometry)) water.push({ outer: el.geometry.slice(0, -1), holes: [], kind: waterKind(t) });
      else if (el.type === 'relation') {
        const ways = role => (el.members || []).filter(m => m.type === 'way' && m.geometry && (role === 'inner') === (m.role === 'inner')).map(m => m.geometry);
        water.push(...ringsToPolygons(assembleRings(ways('outer')), assembleRings(ways('inner')), { kind: waterKind(t) }));
      }
      continue;
    }
    if (el.type === 'way' && (t.waterway === 'river' || t.waterway === 'canal') && el.geometry && !(t.tunnel && t.tunnel !== 'no')) {
      const w = parseFloat(String(t.width || '').replace(',', '.'));
      rivers.push({ pts: el.geometry, width: isFinite(w) && w > 0 ? w : RIVER_WIDTH[t.waterway] });
      continue;
    }
    if (el.type === 'way' && t.building && closed(el.geometry)) buildings.push({ outer: el.geometry.slice(0, -1), holes: [], tags: t });
    else if (el.type === 'way' && t.highway && el.geometry && t.area !== 'yes') roads.push({ pts: el.geometry, tags: t });
    else if (el.type === 'relation' && t.building) {
      const outers = [], inners = [];
      for (const m of el.members || []) if (m.type === 'way' && closed(m.geometry)) (m.role === 'inner' ? inners : outers).push(m.geometry.slice(0, -1));
      const bs = outers.map(o => ({ outer: o, holes: [], tags: t }));
      for (const h of inners) { const ring = bs.find(b => inRing(h[0].lon, h[0].lat, b.outer.map(p => ({ x: p.lon, y: p.lat })))); if (ring) ring.holes.push(h); }
      buildings.push(...bs);
    }
  }
  return { buildings, roads, water, rivers };
}

Object.assign(Mapcast, { TERRARIUM_URL, loadElevation, OVERPASS, fetchOverpass, ROADS, PATHS, BH, buildingHeight, parseOSM, assembleRings });
})();
