// Unit tests for stepped terrain (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTopoforge } from './load.mjs';
import { checkSolid, isWatertight } from './solid.mjs';

const { buildTerrain, terrainSolid, quantizer, contourPoints } = loadTopoforge();

// A smooth hill: 0 m at the edges to ~300 m in the middle; model scale 0.05 mm/m, 3 mm base.
const hill = (x, y) => 300 * Math.exp(-(x * x + y * y) / 900);
const ring = [{ x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -40, y: 40 }];
const SCALE = 0.05, BASE = 3, STEP_MM = 1.5, h = 1.0;

function stepped(withPairs) {
  const stepM = STEP_MM / SCALE, q = quantizer(0, stepM);
  const pts = withPairs ? contourPoints(ring, h, hill, 0, stepM) : [];
  const T = buildTerrain(ring, h, (x, y) => q(hill(x, y)), pts);
  const zOf = e => BASE + e * SCALE;
  return { T, solid: terrainSolid(T, zOf), zOf };
}

// Share of the top surface (by plan area) on sloped triangles = ramps between steps.
function rampShare({ T, zOf }) {
  let ramp = 0, all = 0;
  for (let i = 0; i < T.keep.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map(j => T.keep[i + j]);
    const A = T.P[a], B = T.P[b], C = T.P[c];
    const area = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
    all += area;
    const za = zOf(T.E[a]), zb = zOf(T.E[b]), zc = zOf(T.E[c]);
    if (Math.max(za, zb, zc) - Math.min(za, zb, zc) > 1e-6) ramp += area;
  }
  return ramp / all;
}

test('stepped terrain is watertight and only has whole-step heights', () => {
  const s = stepped(true);
  const r = checkSolid(s.solid);
  assert.ok(isWatertight(r), JSON.stringify(r));
  const levels = new Set();
  for (let i = 0; i < s.T.N; i++) levels.add(Math.round(s.zOf(s.T.E[i]) * 1000));
  const expected = Math.floor(300 * SCALE / STEP_MM) + 1;
  assert.ok(levels.size <= expected, `${levels.size} distinct heights, expected at most ${expected}`);
  for (const z of levels) assert.ok(Math.abs(((z / 1000 - BASE) / STEP_MM) % 1) < 1e-6 || Math.abs(((z / 1000 - BASE) / STEP_MM) % 1 - 1) < 1e-6, `height ${z / 1000} is not on a step`);
});

test('contour point pairs make the step walls crisp', () => {
  const crisp = rampShare(stepped(true)), naive = rampShare(stepped(false));
  assert.ok(crisp < 0.03, `with contour pairs, ${(crisp * 100).toFixed(1)}% of the top is ramps`);
  assert.ok(naive > crisp * 4, `naive rounding should be much worse (${(naive * 100).toFixed(1)}% vs ${(crisp * 100).toFixed(1)}%)`);
});
