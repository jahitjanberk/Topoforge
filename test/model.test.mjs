// Runs the real model builder offline: the two downloads (elevation, OpenStreetMap) are replaced
// with synthetic data, everything else is the code the app runs. Focus: splitting into tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSolid, isWatertight } from './solid.mjs';
import { loadOfflineModel, RING, SETTINGS } from './offline-model.mjs';

const { buildModel } = loadOfflineModel();
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
  assert.deepEqual(m.tiles.map(t => t.name), ['A1', 'B1', 'A2', 'B2', 'Keys'], 'four tiles plus the connector keys piece');
  assertAllWatertight(m);

  // Each tile's geometry stays within its quarter of the footprint (tiles must fit side by side).
  const all = whole.layers.find(l => l.part === 'terrain').arr;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < all.length; i += 3) { x0 = Math.min(x0, all[i]); x1 = Math.max(x1, all[i]); y0 = Math.min(y0, all[i + 1]); y1 = Math.max(y1, all[i + 1]); }
  const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2, eps = 1e-3;
  for (const l of m.layers.filter(l => l.tile !== 'Keys')) {
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
  assert.deepEqual(m.tiles.map(t => t.name).filter(n => n !== 'Keys'), ['A1', 'B1', 'C1', 'A2', 'B2', 'C2']);
  assertAllWatertight(m);
});

test('when OpenStreetMap is down, the terrain is still built and the note says what is missing', async () => {
  globalThis.__osmDown = true;
  try {
    const m = await buildModel(RING, { ...SETTINGS, water: true, route: null });
    assert.deepEqual(m.layers.map(l => l.part), ['terrain']);
    assertAllWatertight(m);
    assert.match(m.notes[0], /no buildings, roads, lakes and rivers/);
    assert.ok(!m.notes.some(n => /No lakes|No buildings/.test(n)), 'no misleading "nothing found" notes');
    // Without terrain there would be nothing to print: report the error instead.
    await assert.rejects(buildModel(RING, { ...SETTINGS, terrain: false, route: null }), /busy/);
  } finally { globalThis.__osmDown = false; }
});

test('connector keys: one per seam, pockets cut, keys fit, everything watertight', async () => {
  const m = await buildModel(RING, { ...SETTINGS, tilesX: 2, tilesY: 2, connectors: true });
  const keys = m.layers.find(l => l.part === 'keys');
  assert.ok(keys, 'a connector keys piece');
  const r = checkSolid(keys.arr);
  assert.ok(isWatertight(r), `keys not watertight: ${JSON.stringify(r)}`);
  const plain = await buildModel(RING, { ...SETTINGS, tilesX: 2, tilesY: 2, connectors: false });
  assert.ok(!plain.layers.some(l => l.part === 'keys'), 'no keys when switched off');
  assert.match(m.notes.join(' '), /4 connector keys/, 'one key per seam on a 2 × 2 grid');
  // Pockets: tiles lose material, roughly the keys' volume plus fit clearance.
  const tv = mm => mm.layers.filter(l => l.part === 'terrain').reduce((s, l) => s + checkSolid(l.arr).volume, 0);
  const removed = tv(plain) - tv(m);
  assert.ok(removed > r.volume && removed < r.volume * 1.6, `pockets removed ${removed.toFixed(0)} mm³ for keys of ${r.volume.toFixed(0)} mm³`);
  // Keys are thinner than the pockets are deep, so they sit flush or below the tiles' undersides.
  let zMax = 0; for (let i = 2; i < keys.arr.length; i += 3) zMax = Math.max(zMax, keys.arr[i]);
  assert.ok(zMax <= SETTINGS.base * 0.5 - 0.2 + 1e-6, `key thickness ${zMax}`);
  assertAllWatertight(m);
});

test('small map scales leave out unprintable detail (buildings, minor roads)', async () => {
  const { detailForScale } = globalThis.Mapcast;
  assert.equal(detailForScale(20000, false).level, '', 'city scale keeps everything');
  assert.ok(detailForScale(20000, true).roadClasses.includes('footway'));
  assert.equal(detailForScale(100000, false).buildings, false);
  assert.ok(!detailForScale(100000, false).roadClasses.includes('service'));
  assert.deepEqual(detailForScale(2e6, false).roadClasses.sort(), ['motorway', 'motorway_link', 'trunk', 'trunk_link']);
  // The offline test area (~2.3 km) printed 10 mm wide is about 1:230,000: no buildings, and only
  // the primary road survives (the residential street is dropped).
  const m = await buildModel(RING, { ...SETTINGS, size: 10, route: null });
  assert.ok(!m.layers.some(l => l.part === 'buildings'), 'no buildings');
  assert.ok(m.layers.some(l => l.part === 'roads'), 'major road kept');
  assert.match(m.notes.join(' '), /Buildings are left out/);
  assert.match(m.notes.join(' '), /only major roads/);
  assertAllWatertight(m);
});
