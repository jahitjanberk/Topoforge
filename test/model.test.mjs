// Runs the real model builder offline: the two downloads (elevation, OpenStreetMap) are replaced
// with synthetic data, everything else is the code the app runs. Focus: splitting into tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { loadMapcast, ROOT } from './load.mjs';
import { checkSolid, isWatertight } from './solid.mjs';

const M = loadMapcast();
// Synthetic hills instead of AWS elevation tiles.
M.loadElevation = async () => ({
  sample: (lat, lng) => 500 + 300 * Math.sin((lat - 46.69) * 300) * Math.cos((lng - 7.85) * 200),
  resM: 10, z: 14, failed: 0
});
// Synthetic OpenStreetMap: buildings (one straddling both seams, one with a courtyard), a road and a
// footpath crossing the seams diagonally.
const sq = (lat, lng, d) => [[lat, lng], [lat, lng + d], [lat + d, lng + d], [lat + d, lng], [lat, lng]].map(([la, lo]) => ({ lat: la, lon: lo }));
M.fetchOverpass = async () => ({
  elements: [
    { type: 'way', tags: { building: 'yes' }, geometry: sq(46.6995, 7.8645, 0.001) },          // across both seams
    { type: 'way', tags: { building: 'house' }, geometry: sq(46.6930, 7.8550, 0.0006) },       // inside tile A2
    { type: 'relation', tags: { type: 'multipolygon', building: 'yes' }, members: [
      { type: 'way', role: 'outer', geometry: sq(46.7030, 7.8620, 0.002) },                     // across the vertical seam
      { type: 'way', role: 'inner', geometry: sq(46.7035, 7.8625, 0.001) } ] },
    { type: 'way', tags: { highway: 'primary' }, geometry: [{ lat: 46.6920, lon: 7.8530 }, { lat: 46.7080, lon: 7.8770 }] },
    { type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: 46.7000, lon: 7.8520 }, { lat: 46.7000, lon: 7.8780 }] } // along the horizontal seam
  ]
});
for (const f of ['js/water.js', 'js/model.js']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
const { buildModel } = globalThis.Mapcast;

const RING = [{ lat: 46.69, lng: 7.85 }, { lat: 46.69, lng: 7.88 }, { lat: 46.71, lng: 7.88 }, { lat: 46.71, lng: 7.85 }];
const ROUTE = [[{ lat: 46.6915, lng: 7.8560 }, { lat: 46.7050, lng: 7.8600 }, { lat: 46.7060, lng: 7.8750 }, { lat: 46.6950, lng: 7.8740 }]];
const SETTINGS = {
  size: 150, base: 3, exag: 1.5, detail: 0.7, bMult: 1.5, bMin: 0.8, roadMin: 0.8, roadH: 0.6,
  terrain: true, buildings: true, roads: true, paths: false, sea: true, water: false, waterDepth: 0.8,
  route: ROUTE, routeW: 1.4, routeH: 1, label: '', labelH: 0.8, stepped: false, stepMm: 1, tilesX: 1, tilesY: 1
};
const SHARED = ['buildings', 'roads', 'route', 'label']; // many small bodies: may touch along edges

function assertAllWatertight(model) {
  for (const l of model.layers) {
    const r = checkSolid(l.arr);
    assert.ok(isWatertight(r, { allowShared: SHARED.includes(l.part) }), `${l.name} is not watertight: ${JSON.stringify(r)}`);
  }
}
const volume = (model, part) => model.layers.filter(l => l.part === part).reduce((s, l) => s + checkSolid(l.arr).volume, 0);

test('untiled model: every part watertight', async () => {
  const m = await buildModel(RING, SETTINGS);
  assert.equal(m.tiles, null);
  assert.deepEqual(m.layers.map(l => l.part).sort(), ['buildings', 'roads', 'route', 'terrain']);
  assertAllWatertight(m);
});

test('2 × 2 tiles: watertight, inside their tiles, and adding up to the whole', async () => {
  const whole = await buildModel(RING, SETTINGS);
  const m = await buildModel(RING, { ...SETTINGS, tilesX: 2, tilesY: 2 });
  assert.deepEqual(m.tiles.map(t => t.name), ['A1', 'B1', 'A2', 'B2']);
  assertAllWatertight(m);

  // Each tile's geometry stays within its quarter of the footprint (tiles must fit side by side).
  const all = whole.layers.find(l => l.part === 'terrain').arr;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < all.length; i += 3) { x0 = Math.min(x0, all[i]); x1 = Math.max(x1, all[i]); y0 = Math.min(y0, all[i + 1]); y1 = Math.max(y1, all[i + 1]); }
  const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2, eps = 1e-3;
  for (const l of m.layers) {
    const east = l.tile[0] === 'B', south = l.tile[1] === '2';
    for (let i = 0; i < l.arr.length; i += 3) {
      const x = l.arr[i], y = l.arr[i + 1];
      assert.ok(east ? x >= xm - eps : x <= xm + eps, `${l.name} crosses the vertical seam (x=${x})`);
      assert.ok(south ? y <= ym + eps : y >= ym - eps, `${l.name} crosses the horizontal seam (y=${y})`);
    }
  }
  // Same terrain, just cut: volumes agree (small differences come from re-meshing near the seams).
  const vt = volume(m, 'terrain'), vw = volume(whole, 'terrain');
  assert.ok(Math.abs(vt - vw) / vw < 0.01, `tiled terrain ${vt.toFixed(0)} vs whole ${vw.toFixed(0)} mm³`);
  // The straddling building is split, not dropped: total building volume is preserved.
  const bt = volume(m, 'buildings'), bw = volume(whole, 'buildings');
  assert.ok(Math.abs(bt - bw) / bw < 0.01, `tiled buildings ${bt.toFixed(1)} vs whole ${bw.toFixed(1)} mm³`);
  assert.ok(m.stats.some(([k, v]) => k === 'Tiles' && v.startsWith('2 × 2')));
});

test('tiles with stepped terrain and a non-rectangular (circle) area', async () => {
  const c = { lat: 46.70, lng: 7.865 }, circle = Array.from({ length: 96 }, (_, i) => ({ lat: c.lat + 0.009 * Math.sin(i / 96 * 2 * Math.PI), lng: c.lng + 0.013 * Math.cos(i / 96 * 2 * Math.PI) }));
  const m = await buildModel(circle, { ...SETTINGS, tilesX: 3, tilesY: 2, stepped: true, stepMm: 1.5 });
  assert.equal(m.tiles.length, 6);
  assertAllWatertight(m);
});
