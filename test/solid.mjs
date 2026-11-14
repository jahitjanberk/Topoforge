// Mesh checks shared by the unit tests (Node) and the browser tests (injected into the page).
// Keep checkSolid self-contained: e2e.mjs sends its source text to the browser.

// arr: flat triangle soup [x,y,z, x,y,z, x,y,z, ...] (as in the model layers / STL).
// A printable solid has every edge used exactly twice, once in each direction. Bodies inside one
// part may overlap (buildings, roads); each must still be closed, which this checks per edge.
export function checkSolid(arr) {
  const q = v => Math.round(v * 1e4);
  const vk = i => q(arr[i]) + ',' + q(arr[i + 1]) + ',' + q(arr[i + 2]);
  const dir = new Map();
  let degenerate = 0, volume = 0;
  for (let i = 0; i < arr.length; i += 9) {
    const k = [vk(i), vk(i + 3), vk(i + 6)];
    const ax = arr[i], ay = arr[i + 1], az = arr[i + 2], bx = arr[i + 3], by = arr[i + 4], bz = arr[i + 5], cx = arr[i + 6], cy = arr[i + 7], cz = arr[i + 8];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) { degenerate++; continue; }
    for (let j = 0; j < 3; j++) { const e = k[j] + '>' + k[(j + 1) % 3]; dir.set(e, (dir.get(e) || 0) + 1); }
  }
  // open: an edge whose two directions don't pair up (a hole or a flipped face).
  // shared: paired, but used by more than two faces (bodies touching along an edge).
  let openEdges = 0, nonManifoldEdges = 0;
  for (const [e, n] of dir) {
    const [a, b] = e.split('>');
    const back = dir.get(b + '>' + a) || 0;
    if (n !== back) openEdges++;
    else if (n > 1) nonManifoldEdges++;
  }
  return { triangles: arr.length / 9, openEdges, nonManifoldEdges, degenerate, volume };
}

// True when a part is a closed, consistently oriented solid with positive volume.
// allowShared: parts made of many small bodies (roads, routes) may touch along edges.
export const isWatertight = (r, { allowShared = false } = {}) =>
  r.openEdges === 0 && (allowShared || r.nonManifoldEdges === 0) && r.degenerate === 0 && r.volume > 0;
