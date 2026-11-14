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

// Height of the mesh's top surface at (x, y), by barycentric interpolation in the containing triangle.
function meshHeightAt(T, zOf, x, y, cells) {
  for (const t of cells.get(Math.floor(x / 4) + ',' + Math.floor(y / 4)) || []) {
    const [a, b, c] = [T.keep[t], T.keep[t + 1], T.keep[t + 2]], A = T.P[a], B = T.P[b], C = T.P[c];
    const d = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    const u = ((B.y - C.y) * (x - C.x) + (C.x - B.x) * (y - C.y)) / d, v = ((C.y - A.y) * (x - C.x) + (A.x - C.x) * (y - C.y)) / d, w = 1 - u - v;
    if (u >= -1e-9 && v >= -1e-9 && w >= -1e-9) return u * zOf(T.E[a]) + v * zOf(T.E[b]) + w * zOf(T.E[c]);
  }
  return null;
}
function surfaceError(T, zOf, truth) {
  const cells = new Map(); // 4 mm buckets of triangles by bounding box
  for (let t = 0; t < T.keep.length; t += 3) {
    const ps = [0, 1, 2].map(j => T.P[T.keep[t + j]]);
    for (let i = Math.floor(Math.min(...ps.map(p => p.x)) / 4); i <= Math.floor(Math.max(...ps.map(p => p.x)) / 4); i++)
      for (let j = Math.floor(Math.min(...ps.map(p => p.y)) / 4); j <= Math.floor(Math.max(...ps.map(p => p.y)) / 4); j++)
        (cells.get(i + ',' + j) || cells.set(i + ',' + j, []).get(i + ',' + j)).push(t);
  }
  let max = 0, sq = 0, n = 0, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 3000; k++) {
    const x = -38 + 76 * rnd(), y = -38 + 76 * rnd(), z = meshHeightAt(T, zOf, x, y, cells);
    if (z == null) continue;
    const e = Math.abs(z - zOf(truth(x, y))); max = Math.max(max, e); sq += e * e; n++;
  }
  return { max, rms: Math.sqrt(sq / n), n };
}

test('adaptive mesh: far fewer triangles on flat ground, same accuracy', () => {
  // Plains and a high plateau (flat), a detailed hill, and a ridge between them.
  const land = (x, y) => {
    const hill = 120 * Math.exp(-((x + 15) ** 2 + (y - 10) ** 2) / 120) * (1 + 0.15 * Math.sin(x * 1.3) * Math.cos(y * 1.1));
    const plateau = 80 / (1 + Math.exp(-(x - 15) / 0.8)); // steep (~2 mm wide) but continuous, like real DEM data
    return 20 + hill + plateau + 10 * Math.sin(y / 6) * Math.exp(-((x - 5) ** 2) / 40);
  };
  const ring = square(40), h = 0.7, scale = 0.2, tolMm = h * 0.07;
  const zOf = e => BASE + e * scale;
  const uniform = buildTerrain(ring, h, land), adaptive = buildTerrain(ring, h, land, [], { tolM: tolMm / scale });
  assertSolid(terrainSolid(adaptive, zOf), 'adaptive terrain');
  const nU = uniform.keep.length / 3, nA = adaptive.keep.length / 3;
  const eU = surfaceError(uniform, zOf, land), eA = surfaceError(adaptive, zOf, land);
  console.log(`    uniform ${nU} triangles, max error ${eU.max.toFixed(3)} mm, rms ${eU.rms.toFixed(4)} mm`);
  console.log(`    adaptive ${nA} triangles (${(100 * nA / nU).toFixed(0)}%), max error ${eA.max.toFixed(3)} mm, rms ${eA.rms.toFixed(4)} mm`);
  assert.ok(nA < nU * 0.6, `expected at least 40% fewer triangles: ${nA} vs ${nU}`);
  assert.ok(eA.max < eU.max + tolMm, `adaptive max error ${eA.max.toFixed(3)} mm vs uniform ${eU.max.toFixed(3)} mm`);
  assert.ok(eA.rms < eU.rms * 1.25, `adaptive rms error ${eA.rms.toFixed(4)} mm vs uniform ${eU.rms.toFixed(4)} mm`);
});
