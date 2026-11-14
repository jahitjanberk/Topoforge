/* Geo helpers — local equirectangular metres around an origin, plus 2D geometry utilities.
   Works without Leaflet (e.g. in the model Web Worker); returns L.LatLng objects when it is loaded. */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const R = 6378137, D2R = Math.PI / 180;
const toLocal = (ll, o) => ({ x: (ll.lng - o.lng) * D2R * R * Math.cos(o.lat * D2R), y: (ll.lat - o.lat) * D2R * R });
const latLng = (lat, lng) => typeof L !== 'undefined' ? L.latLng(lat, lng) : { lat, lng };
const fromLocal = (p, o) => latLng(o.lat + p.y / R / D2R, o.lng + p.x / (R * Math.cos(o.lat * D2R)) / D2R);

// Lat/lng bounding box with the subset of Leaflet's LatLngBounds API the model code uses.
class Bounds {
  constructor(s, w, n, e) { this.s = s; this.w = w; this.n = n; this.e = e; }
  static of(points) {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of points) { if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; if (p.lng < w) w = p.lng; if (p.lng > e) e = p.lng; }
    return new Bounds(s, w, n, e);
  }
  getSouth() { return this.s; } getWest() { return this.w; } getNorth() { return this.n; } getEast() { return this.e; }
  getCenter() { return { lat: (this.s + this.n) / 2, lng: (this.w + this.e) / 2 }; }
  pad(r) { const h = (this.n - this.s) * r, w = (this.e - this.w) * r; return new Bounds(this.s - h, this.w - w, this.n + h, this.e + w); }
}
const rot = (p, a) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const fmtLen = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
const fmtArea = a => a < 1e6 ? `${Math.round(a).toLocaleString()} m²` : `${(a / 1e6).toFixed(a < 1e8 ? 2 : 0)} km²`;

function signedArea(r) { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p.x * q.y - q.x * p.y; } return a / 2; }
function inRing(x, y, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function distToRing(x, y, r) {
  let best = Infinity;
  for (let i = 0, n = r.length; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a.x + t * dx - x, ey = a.y + t * dy - y, d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
function bbox(pts) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of pts) { if (p.x < a) a = p.x; if (p.y < b) b = p.y; if (p.x > c) c = p.x; if (p.y > d) d = p.y; } return [a, b, c, d]; }
function cleanRing(r, eps) {
  const out = [];
  for (const p of r) { const q = out[out.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > eps) out.push(p); }
  while (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) out.pop();
  return out;
}
function simplifyDP(pts, tol) {
  if (pts.length < 4) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop(); let md = 0, mi = -1;
    const a = pts[s], b = pts[e], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1e-9;
    for (let i = s + 1; i < e; i++) { const d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / l; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Fractional slippy-map tile coordinates
function tileXY(lat, lng, z) {
  const n = 2 ** z, lr = Math.max(-85.05, Math.min(85.05, lat)) * D2R;
  return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n };
}

Object.assign(Mapcast, { R, Bounds, toLocal, fromLocal, rot, fmtLen, fmtArea, signedArea, inRing, distToRing, bbox, cleanRing, simplifyDP, tileXY, D2R });
})();
