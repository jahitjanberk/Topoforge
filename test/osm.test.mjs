// Unit tests for OpenStreetMap parsing (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTopoforge } from './load.mjs';

const { parseOSM, assembleRings, areaFilter, Bounds } = loadTopoforge();

test('Overpass area filter: bounding box for rectangles, short polygon for circles', () => {
  const rect = [{ lat: 46, lng: 7 }, { lat: 46, lng: 8 }, { lat: 47, lng: 8 }, { lat: 47, lng: 7 }];
  assert.equal(areaFilter(Bounds.of(rect), rect), '46.000000,7.000000,47.000000,8.000000');
  const circle = Array.from({ length: 256 }, (_, i) => ({ lat: 46.5 + 0.5 * Math.sin(i / 256 * 2 * Math.PI), lng: 7.5 + 0.5 * Math.cos(i / 256 * 2 * Math.PI) }));
  const f = areaFilter(Bounds.of(circle), circle);
  assert.match(f, /^poly:"/);
  const nums = f.slice(6, -1).split(' ');
  assert.ok(nums.length / 2 <= 64, `polygon too long: ${nums.length / 2} points`);
});
const P = (lat, lon) => ({ lat, lon });

test('assembleRings joins split and reversed ways into one closed ring', () => {
  const a = [P(0, 0), P(0, 1), P(0, 2)];
  const b = [P(1, 2), P(0, 2)]; // runs backwards: must be reversed to continue from a's end
  const c = [P(1, 2), P(1, 0), P(0, 0)];
  const rings = assembleRings([a, b, c]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5); // 0,0 0,1 0,2 1,2 1,0 (closing point dropped)
});

test('assembleRings drops pieces that cannot close', () => {
  assert.equal(assembleRings([[P(0, 0), P(0, 1)], [P(5, 5), P(6, 6)]]).length, 0);
});

test('parseOSM: lake relation from split ways, with an island; river line; buildings; roads', () => {
  const js = {
    elements: [
      { type: 'relation', tags: { type: 'multipolygon', natural: 'water', water: 'lake' }, members: [
        { type: 'way', role: 'outer', geometry: [P(0, 0), P(0, 10), P(10, 10)] },
        { type: 'way', role: 'outer', geometry: [P(10, 10), P(10, 0), P(0, 0)] },
        { type: 'way', role: 'inner', geometry: [P(4, 4), P(4, 6), P(6, 6), P(6, 4), P(4, 4)] }
      ] },
      { type: 'way', tags: { natural: 'water', water: 'river' }, geometry: [P(20, 0), P(20, 1), P(21, 1), P(20, 0)] },
      { type: 'way', tags: { waterway: 'river', width: '35' }, geometry: [P(30, 0), P(31, 1)] },
      { type: 'way', tags: { waterway: 'canal' }, geometry: [P(32, 0), P(33, 1)] },
      { type: 'way', tags: { building: 'yes' }, geometry: [P(1, 1), P(1, 2), P(2, 2), P(1, 1)] },
      { type: 'way', tags: { highway: 'primary' }, geometry: [P(0, 0), P(5, 5)] }
    ]
  };
  const o = parseOSM(js);
  const lake = o.water.find(w => w.kind === 'lake');
  assert.ok(lake, 'lake parsed');
  assert.equal(lake.outer.length, 4);
  assert.equal(lake.holes.length, 1, 'island kept as a hole');
  assert.equal(o.water.find(w => w.kind === 'flow').outer.length, 3, 'river area is flowing water');
  assert.deepEqual(o.rivers.map(r => r.width), [35, 12], 'width tag, then canal default');
  assert.equal(o.buildings.length, 1);
  assert.equal(o.roads.length, 1);
});

test('small map scales ask Overpass only for printable water', () => {
  const { detailForScale } = loadTopoforge();
  const city = detailForScale(20000, false), country = detailForScale(2e6, false);
  assert.equal(city.waterMinLength, 0);
  assert.equal(city.riverAreas, true);
  assert.equal(country.waterMinLength, 20000, '10 mm of outline at 1:2,000,000 = 20 km');
  assert.equal(country.riverAreas, false);
});
