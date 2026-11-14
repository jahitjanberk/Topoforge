// Unit tests for the label outline tracer (no canvas needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadMapcast } from './load.mjs';
import { checkSolid, isWatertight } from './solid.mjs';

const { traceMask, loopsToPolygons, signedArea, addPrism } = loadMapcast();

const maskFrom = rows => {
  const h = rows.length, w = rows[0].length, m = new Uint8Array(w * h);
  rows.forEach((r, j) => [...r].forEach((c, i) => { m[j * w + i] = c === '#' ? 1 : 0; }));
  return { m, w, h };
};

test('an "O" traces to one outline with one hole', () => {
  const { m, w, h } = maskFrom([
    '........',
    '.######.',
    '.######.',
    '.##..##.',
    '.##..##.',
    '.######.',
    '.######.',
    '........'
  ]);
  const polys = loopsToPolygons(traceMask(m, w, h));
  assert.equal(polys.length, 1);
  assert.equal(polys[0].holes.length, 1);
  assert.equal(signedArea(polys[0].outer), 36);
  assert.equal(signedArea(polys[0].holes[0]), -4);
  assert.equal(polys[0].outer.length, 4, 'straight runs collapse to corners');
});

test('pixels touching only at a corner stay separate loops', () => {
  const { m, w, h } = maskFrom(['#.', '.#']);
  const loops = traceMask(m, w, h);
  assert.equal(loops.length, 2);
  assert.deepEqual(loops.map(l => signedArea(l)), [1, 1]);
});

test('regression: a real traced glyph whose hole bridge ran along a pixel row stays watertight', () => {
  // Captured from the label "Interlaken 46.69°N": earcut's hole bridge passed exactly through two
  // outline vertices, leaving 8 open edges until addPrism triangulated in a rotated frame.
  const p = JSON.parse(fs.readFileSync(new URL('./fixtures/glyph-hole-bridge.json', import.meta.url)));
  const out = [];
  assert.ok(addPrism(out, p.outer, p.holes, 0, 1));
  const r = checkSolid(out);
  assert.ok(isWatertight(r), JSON.stringify(r));
  assert.ok(Math.abs(r.volume - (signedArea(p.outer) + p.holes.reduce((s, h) => s + signedArea(h), 0))) < 1e-6);
});

test('traced text-like shapes extrude to watertight solids', () => {
  const { m, w, h } = maskFrom([
    '#####...###..#...#',
    '#...#..#...#.##..#',
    '#####..#####.#.#.#',
    '#...#..#...#.#..##',
    '#...#..#...#.#...#'
  ]);
  const out = [];
  for (const p of loopsToPolygons(traceMask(m, w, h))) assert.ok(addPrism(out, p.outer, p.holes, 0, 1));
  const r = checkSolid(out);
  assert.ok(isWatertight(r, { allowShared: true }), JSON.stringify(r));
  const inkPixels = m.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(r.volume - inkPixels) < 1e-9, `volume ${r.volume} should equal the ink area ${inkPixels}`);
});
