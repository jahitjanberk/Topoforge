/* Binary STL export + file download */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

function toSTL(arrs) {
  const n = arrs.reduce((s, a) => s + a.length / 9, 0);
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  const head = 'Mapcast STL — data © OpenStreetMap contributors; elevation: Mapzen/AWS Terrain Tiles';
  for (let i = 0; i < 80; i++) dv.setUint8(i, i < head.length ? head.charCodeAt(i) & 0x7f : 32);
  dv.setUint32(80, n, true);
  let off = 84;
  for (const a of arrs) for (let i = 0; i < a.length; i += 9) {
    const ux = a[i + 3] - a[i], uy = a[i + 4] - a[i + 1], uz = a[i + 5] - a[i + 2], vx = a[i + 6] - a[i], vy = a[i + 7] - a[i + 1], vz = a[i + 8] - a[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(off, nx / l, true); dv.setFloat32(off + 4, ny / l, true); dv.setFloat32(off + 8, nz / l, true); off += 12;
    for (let j = 0; j < 9; j++) { dv.setFloat32(off, a[i + j], true); off += 4; }
    dv.setUint16(off, 0, true); off += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

Object.assign(Mapcast, { toSTL, download });
})();
