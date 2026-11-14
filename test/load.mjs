// Loads the app's classic scripts into this Node process, the same way the page/worker does
// (each file adds its functions to globalThis.Mapcast). Libraries come from node_modules at the
// exact versions index.html loads from the CDN.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'node_modules/delaunator/delaunator.min.js',
  'node_modules/earcut/dist/earcut.min.js',
  'js/geo.js', 'js/data.js', 'js/mesh.js', 'js/stl.js'
];

let loaded = null;
export function loadMapcast() {
  if (loaded) return loaded;
  for (const f of FILES) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  return (loaded = globalThis.Mapcast);
}
