/* Map layers: OpenStreetMap tiles, plus relief shading computed in the browser from the same
   AWS Terrarium elevation tiles the STL export uses. Shared by the 2D and 3D views. */
(() => {
'use strict';
const Topoforge = globalThis.Topoforge = globalThis.Topoforge || {};

const { TERRARIUM_URL } = Topoforge;

const OSM = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  maxNativeZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
};
const DEM_ATTR = 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / AWS Terrain Tiles</a>';

// OSM's tile policy requires a Referer; send the page origin explicitly.
const osmLayer = () => L.tileLayer(OSM.url, { maxNativeZoom: OSM.maxNativeZoom, maxZoom: 20, attribution: OSM.attribution, referrerPolicy: 'strict-origin-when-cross-origin' });

/* ---------- relief (hillshade) ---------- */
// Sun from the north-west, 45° up. Azimuth is converted to the math-angle convention used below.
const SUN_AZIMUTH = (360 - 315 + 90) * Math.PI / 180, SUN_ALTITUDE = 45 * Math.PI / 180;
const Z_FACTOR = 1.6; // slight vertical boost so gentle slopes still read

const SHADOW = 0.6; // darkest shadow = 60% (lighter shading keeps the map and its labels readable)

// Decoded elevation tiles (Float32Array, metres), shared between neighbouring relief tiles so
// each is downloaded and decoded once. Failed downloads are retried; a tile that still fails
// resolves to null. Kept to the most recent 300 tiles.
const dem = new Map();
const decodeCanvas = document.createElement('canvas'); decodeCanvas.width = decodeCanvas.height = 256;
const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });
function demTile(z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return Promise.resolve(null);
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  if (dem.has(key)) { const p = dem.get(key); dem.delete(key); dem.set(key, p); return p; }
  const url = TERRARIUM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const p = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { mode: 'cors' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const bmp = await createImageBitmap(await r.blob());
        decodeCtx.clearRect(0, 0, 256, 256); decodeCtx.drawImage(bmp, 0, 0); bmp.close();
        const px = decodeCtx.getImageData(0, 0, 256, 256).data, E = new Float32Array(256 * 256);
        for (let i = 0; i < E.length; i++) E[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
        return E;
      } catch { await new Promise(res => setTimeout(res, 400 * 3 ** attempt)); }
    }
    dem.delete(key); // let a later view try again
    return null;
  })();
  dem.set(key, p);
  if (dem.size > 300) dem.delete(dem.keys().next().value);
  return p;
}

// Shades one tile into a greyscale image (white = flat, darker = shadowed). Slopes at the tile's
// edges use its neighbours' pixels, so there are no seams between tiles.
// grid: the 3×3 block of decoded tiles around (x, y), centre at index 4; missing neighbours are
// null (edges then reuse the tile's own pixels).
function shadeGrid(ctx, grid, z, y) {
  const C = grid[4];
  if (!C) return false;
  const at = (r, c) => { // elevation at row r, column c; may reach one pixel into a neighbour
    const ty = r < 0 ? 0 : r > 255 ? 2 : 1, tx = c < 0 ? 0 : c > 255 ? 2 : 1, T = grid[ty * 3 + tx];
    if (!T) return C[Math.min(255, Math.max(0, r)) * 256 + Math.min(255, Math.max(0, c))];
    return T[((r + 256) % 256) * 256 + ((c + 256) % 256)];
  };
  const n = 2 ** z, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
  const cell = 40075016.686 * Math.cos(lat) / n / 256; // metres per pixel
  const zen = Math.PI / 2 - SUN_ALTITUDE, cz = Math.cos(zen), sz = Math.sin(zen);
  const id = ctx.createImageData(256, 256), px = id.data;
  for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) {
    const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * cell) * Z_FACTOR;
    const dy = (at(r + 1, c) - at(r - 1, c)) / (2 * cell) * Z_FACTOR;
    const slope = Math.atan(Math.hypot(dx, dy)), aspect = Math.atan2(dy, -dx);
    let hs = cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(SUN_AZIMUTH - aspect);
    hs = Math.max(0, Math.min(1, hs / cz)); // flat ground → 1 (no tint under multiply)
    const v = Math.round(255 * (1 - SHADOW * (1 - hs))), o = (r * 256 + c) * 4;
    px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return true;
}

const ReliefLayer = L.GridLayer.extend({
  // Progressive: shade as soon as the tile's own data arrives (so the map isn't kept waiting), then
  // redraw seamlessly once its eight neighbours are in.
  createTile(coords, done) {
    const tile = document.createElement('canvas'); tile.width = tile.height = 256;
    const ctx = tile.getContext('2d'), { x, y, z } = coords;
    const around = [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => demTile(z, x + dx, y + dy)));
    around[4].then(C => {
      const first = Array(9).fill(null); first[4] = C;
      shadeGrid(ctx, first, z, y);
      done(null, tile);
      if (C) Promise.all(around).then(grid => { if (grid.some((g, i) => g && i !== 4)) shadeGrid(ctx, grid, z, y); });
    }, () => done(null, tile)); // missing data: leave unshaded
    return tile;
  }
});
const reliefLayer = () => new ReliefLayer({ maxNativeZoom: 15, maxZoom: 20, opacity: 0.5, className: 'hillshade-layer', attribution: DEM_ATTR });

Object.assign(Topoforge, { OSM, osmLayer, reliefLayer });
})();
