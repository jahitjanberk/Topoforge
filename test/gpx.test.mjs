// Unit tests for the GPX parser (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTopoforge } from './load.mjs';

const { parseGPX, haversineKm } = loadTopoforge();

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Metadata name</name></metadata>
  <wpt lat="1" lon="1"><name>Ignored waypoint</name></wpt>
  <trk><name><![CDATA[Harder Kulm & back]]></name>
    <trkseg>
      <trkpt lat="46.6900" lon="7.8600"><ele>570</ele></trkpt>
      <trkpt lon='7.8650' lat='46.6950'/>
      <trkpt lat="46.7000" lon="7.8700"></trkpt>
    </trkseg>
    <trkseg><trkpt lat="46.7" lon="7.87"/></trkseg>
  </trk>
  <rte><rtept lat="46.71" lon="7.88"/><rtept lat="46.72" lon="7.89"/></rte>
</gpx>`;

test('parses track segments and routes, skips waypoints and 1-point segments', () => {
  const r = parseGPX(GPX);
  assert.equal(r.name, 'Harder Kulm & back', 'track name, CDATA and entities decoded');
  assert.equal(r.segs.length, 2, 'one track segment + one route; the single-point segment is dropped');
  assert.deepEqual(r.segs[0][0], { lat: 46.69, lng: 7.86 });
  assert.equal(r.segs[0].length, 2, 'collinear middle point simplified away');
  const expected = haversineKm({ lat: 46.69, lng: 7.86 }, { lat: 46.695, lng: 7.865 }) + haversineKm({ lat: 46.695, lng: 7.865 }, { lat: 46.70, lng: 7.87 }) + haversineKm({ lat: 46.71, lng: 7.88 }, { lat: 46.72, lng: 7.89 });
  assert.ok(Math.abs(r.km - expected) < 1e-9, 'length measured on the unsimplified track');
});

test('round trips (start = end) keep their shape when simplified', () => {
  const pts = Array.from({ length: 61 }, (_, i) => { const t = i / 60 * 2 * Math.PI; return `<trkpt lat="${46.697 + 0.006 * Math.sin(t)}" lon="${7.862 + 0.012 * Math.cos(t)}"/>`; });
  const r = parseGPX(`<gpx><trk><trkseg>${pts.join('')}</trkseg></trk></gpx>`);
  assert.ok(r.segs[0].length > 10, `loop collapsed to ${r.segs[0].length} points`);
});

test('model-space simplification keeps closed loops (simplifyDP)', () => {
  const { simplifyDP } = loadTopoforge();
  const loop = Array.from({ length: 41 }, (_, i) => ({ x: 10 * Math.cos(i / 40 * 2 * Math.PI), y: 10 * Math.sin(i / 40 * 2 * Math.PI) }));
  assert.ok(simplifyDP(loop, 0.05).length > 10);
});

test('haversine distance is right for a known pair', () => {
  // One degree of latitude ≈ 111.2 km.
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.05);
});

test('rejects non-GPX files and GPX without tracks', () => {
  assert.throws(() => parseGPX('{"type":"FeatureCollection"}'), /not a GPX/);
  assert.throws(() => parseGPX('<gpx><wpt lat="1" lon="2"/></gpx>'), /No track or route/);
});

test('falls back to the file name when the GPX has no name', () => {
  assert.equal(parseGPX('<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk></gpx>', 'morning-run').name, 'morning-run');
});
