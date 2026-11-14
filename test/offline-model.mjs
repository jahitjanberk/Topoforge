// The real model builder with its two downloads (elevation, OpenStreetMap) replaced by synthetic
// data, so model-level tests run offline. Shared by model.test.mjs and threemf.test.mjs.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { loadMapcast, ROOT } from './load.mjs';

const sq = (lat, lng, d) => [[lat, lng], [lat, lng + d], [lat + d, lng + d], [lat + d, lng], [lat, lng]].map(([la, lo]) => ({ lat: la, lon: lo }));

export const RING = [{ lat: 46.69, lng: 7.85 }, { lat: 46.69, lng: 7.88 }, { lat: 46.71, lng: 7.88 }, { lat: 46.71, lng: 7.85 }];
export const ROUTE = [[{ lat: 46.6915, lng: 7.8560 }, { lat: 46.7050, lng: 7.8600 }, { lat: 46.7060, lng: 7.8750 }, { lat: 46.6950, lng: 7.8740 }]];
export const SETTINGS = {
  size: 150, base: 3, exag: 1.5, detail: 0.7, bMult: 1.5, bMin: 0.8, roadMin: 0.8, roadH: 0.6,
  terrain: true, buildings: true, roads: true, paths: false, sea: true, water: false, waterDepth: 0.8,
  route: ROUTE, routeW: 1.4, routeH: 1, label: '', labelH: 0.8, stepped: false, stepMm: 1, tilesX: 1, tilesY: 1
};

let built = null;
export function loadOfflineModel() {
  if (built) return built;
  const M = loadMapcast();
  // Synthetic hills instead of AWS elevation tiles.
  M.loadElevation = async () => ({
    sample: (lat, lng) => 500 + 300 * Math.sin((lat - 46.69) * 300) * Math.cos((lng - 7.85) * 200),
    resM: 10, z: 14, failed: 0
  });
  // Synthetic OpenStreetMap: buildings (one straddling both tile seams, one with a courtyard),
  // a road and a residential street crossing the seams.
  M.fetchOverpass = async () => ({
    elements: [
      { type: 'way', tags: { building: 'yes' }, geometry: sq(46.6995, 7.8645, 0.001) },
      { type: 'way', tags: { building: 'house' }, geometry: sq(46.6930, 7.8550, 0.0006) },
      { type: 'relation', tags: { type: 'multipolygon', building: 'yes' }, members: [
        { type: 'way', role: 'outer', geometry: sq(46.7030, 7.8620, 0.002) },
        { type: 'way', role: 'inner', geometry: sq(46.7035, 7.8625, 0.001) } ] },
      { type: 'way', tags: { highway: 'primary' }, geometry: [{ lat: 46.6920, lon: 7.8530 }, { lat: 46.7080, lon: 7.8770 }] },
      { type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: 46.7000, lon: 7.8520 }, { lat: 46.7000, lon: 7.8780 }] }
    ]
  });
  for (const f of ['js/water.js', 'js/model.js', 'js/threemf.js']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  return (built = globalThis.Mapcast);
}
