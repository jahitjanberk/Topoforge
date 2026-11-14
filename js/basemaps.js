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

// Shades one 256×256 Terrarium tile into a greyscale image (white = flat, darker = shadowed).
// Edge pixels reuse their neighbours, so tile seams are barely visible.
function shadeTile(img, ctx, z, y) {
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, 256, 256), px = id.data, E = new Float32Array(256 * 256);
  for (let i = 0; i < E.length; i++) E[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  const n = 2 ** z, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n)));
  const cell = 40075016.686 * Math.cos(lat) / n / 256; // metres per pixel
  const zen = Math.PI / 2 - SUN_ALTITUDE, cz = Math.cos(zen), sz = Math.sin(zen);
  for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) {
    const at = (rr, cc) => E[Math.min(255, Math.max(0, rr)) * 256 + Math.min(255, Math.max(0, cc))];
    const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * cell) * Z_FACTOR;
    const dy = (at(r + 1, c) - at(r - 1, c)) / (2 * cell) * Z_FACTOR;
    const slope = Math.atan(Math.hypot(dx, dy)), aspect = Math.atan2(dy, -dx);
    let hs = cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(SUN_AZIMUTH - aspect);
    hs = Math.max(0, Math.min(1, hs / cz)); // flat ground → 1 (no tint under multiply)
    const v = Math.round(255 * Math.min(1, hs)), o = (r * 256 + c) * 4;
    px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
}

const ReliefLayer = L.GridLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('canvas'); tile.width = tile.height = 256;
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { shadeTile(img, tile.getContext('2d', { willReadFrequently: true }), coords.z, coords.y); done(null, tile); };
    img.onerror = () => done(null, tile); // leave blank (no shading) where data is missing
    img.src = TERRARIUM_URL.replace('{z}', coords.z).replace('{x}', coords.x).replace('{y}', coords.y);
    return tile;
  }
});
const reliefLayer = () => new ReliefLayer({ maxNativeZoom: 15, maxZoom: 20, opacity: 0.55, className: 'hillshade-layer', attribution: DEM_ATTR });

Object.assign(Topoforge, { OSM, osmLayer, reliefLayer });
})();
