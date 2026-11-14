// Unit tests for the mesh builders: every part must be a watertight, printable solid.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMapcast } from './load.mjs';
import { checkSolid, isWatertight } from './solid.mjs';

const M = loadMapcast();
const { buildTerrain, terrainSolid, refineWater, splitWater, addPrism, addRoadBox, toSTL, signedArea } = M;

// Synthetic landscape (metres) and the model mapping used by model.js (base 3 mm).
const hills = (x, y) => 40 * Math.sin(x / 9) * Math.cos(y / 13) + 15 * Math.sin((x + y) / 5) + 60;
const BASE = 3;
const zOfFor = T => e => BASE + (e - T.minE) * 0.2;
const square = s => [{ x: -s, y: -s }, { x: s, y: -s }, { x: s, y: s }, { x: -s, y: s }];
const circle = (r, n = 96) => Array.from({ length: n }, (_, i) => ({ x: r * Math.cos(i / n * 2 * Math.PI), y: r * Math.sin(i / n * 2 * Math.PI) }));
const lShape = [{ x: -30, y: -30 }, { x: 30, y: -30 }, { x: 30, y: -5 }, { x: -5, y: -5 }, { x: -5, y: 30 }, { x: -30, y: 30 }];

const assertSolid = (arr, label, opts) => {
  const r = checkSolid(arr);
  assert.ok(isWatertight(r, opts), `${label} is not watertight: ${JSON.stringify(r)}`);
  return r;
};

for (const [name, ring] of [['square', square(40)], ['circle', circle(35)], ['L-shape (concave)', lShape]]) {
  test(`terrain solid is watertight: ${name}`, () => {
    const T = buildTerrain(ring, 1.2, hills);
    const r = assertSolid(terrainSolid(T, zOfFor(T)), name);
    const area = Math.abs(signedArea(ring)), zMax = BASE + (T.maxE - T.minE) * 0.2;
    assert.ok(r.volume > BASE * area * 0.99 && r.volume < zMax * area, `implausible volume ${r.volume}`);
  });
}

test('flat slab (terrain off) is watertight', () => {
  const T = buildTerrain(square(40), null, () => 0);
  const r = assertSolid(terrainSolid(T, () => BASE), 'slab');
  assert.ok(Math.abs(r.volume - BASE * 80 * 80) < 1e-3 * BASE * 80 * 80);
});

test('water split: both parts watertight, volume conserved', () => {
  const ring = square(40), h = 1.0;
  // A lake (disc) plus a river strip narrower than two mesh spacings: the narrow strip produces
  // bank-to-bank edges, which must be refined away (they used to make the water non-manifold).
  const wet = (x, y) => Math.hypot(x - 10, y - 10) < 14 || (Math.abs(y + 22) < 0.9 && x < 25);
  const shore = [];
  for (let i = 0; i < 200; i++) { const a = i / 200 * 2 * Math.PI; shore.push({ x: 10 + 14 * Math.cos(a), y: 10 + 14 * Math.sin(a) }); }
  for (let x = -40; x < 25; x += 0.8) shore.push({ x, y: -22.9 }, { x, y: -21.1 }, { x, y: -22 });
  const T = buildTerrain(ring, h, hills, shore), zOf = zOfFor(T);
  const isWater = new Uint8Array(T.keep.length / 3);
  for (let t = 0; t < isWater.length; t++) {
    const [a, b, c] = [0, 1, 2].map(j => T.P[T.keep[t * 3 + j]]);
    isWater[t] = wet((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3) ? 1 : 0;
  }
  const before = checkSolid(terrainSolid(T, zOf)).volume;
  const R = refineWater(T, isWater);
  const split = splitWater(R.T, zOf, R.isWater, 0.8);
  const land = assertSolid(terrainSolid(R.T, zOf, split.zs), 'land');
  const water = assertSolid(split.water, 'water');
  assert.ok(water.volume > 50, `water volume too small: ${water.volume}`);
  assert.ok(Math.abs(land.volume + water.volume - before) < before * 1e-6, 'land + water should equal the original terrain');
});

test('building prism with a courtyard is watertight with exact volume', () => {
  const outer = square(10), hole = square(4).reverse(), out = [];
  assert.ok(addPrism(out, outer, [hole], 2, 7));
  const r = assertSolid(out, 'building');
  assert.ok(Math.abs(r.volume - (400 - 64) * 5) < 1e-6);
});

test('road box is watertight', () => {
  const out = [];
  addRoadBox(out, { x: 0, y: 0 }, { x: 10, y: 3 }, 1.2, (x, y) => 3 + 0.1 * x + 0.05 * y, 0.6);
  assertSolid(out, 'road');
});

test('binary STL has the right size and triangle count', async () => {
  const a = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), b = new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 2, 1, 0, 2, 0, 1, 2]);
  const buf = new DataView(await toSTL([a, b]).arrayBuffer());
  assert.equal(buf.byteLength, 84 + 3 * 50);
  assert.equal(buf.getUint32(80, true), 3);
  assert.equal(buf.getFloat32(84 + 8, true), 1, 'first normal should point +z');
});
