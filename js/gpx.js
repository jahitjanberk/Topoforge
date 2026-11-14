/* GPX route import. A small dependency-free parser (no DOMParser, so it also runs in Node tests):
   reads track segments (<trkseg>/<trkpt>) and routes (<rte>/<rtept>); waypoints are ignored. */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { D2R } = Mapcast;

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return m ? parseFloat(m[1]) : NaN;
};
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

function points(xml, tag) {
  const out = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    const lat = attr(m[0], 'lat'), lng = attr(m[0], 'lon');
    if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.push({ lat, lng });
  }
  return out;
}

const haversineKm = (a, b) => {
  const dLat = (b.lat - a.lat) * D2R, dLng = (b.lng - a.lng) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(s)));
};

// Douglas–Peucker in a local metric frame; tolM: tolerance in metres. Keeps stored routes small.
function simplifyLL(pts, tolM) {
  if (pts.length < 3) return pts.slice();
  const lat0 = pts[0].lat * D2R, k = 111320;
  const P = pts.map(p => ({ x: p.lng * k * Math.cos(lat0), y: p.lat * k }));
  const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1;
  const stack = [[0, P.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop(); let md = 0, mi = -1;
    const a = P[s], b = P[e], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    for (let i = s + 1; i < e; i++) {
      // Round trips start and end at the same spot: measure from it instead of from a zero-length line.
      const d = l > 1e-9 ? Math.abs(dy * P[i].x - dx * P[i].y + b.x * a.y - b.y * a.x) / l : Math.hypot(P[i].x - a.x, P[i].y - a.y);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tolM) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Returns { name, segs: [[{lat,lng}]], km } or throws with a readable message.
function parseGPX(text, fallbackName = 'Route') {
  if (!/<gpx\b/i.test(text)) throw new Error('That file is not a GPX file.');
  const segs = [];
  for (const m of text.matchAll(/<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/gi)) { const p = points(m[1], 'trkpt'); if (p.length >= 2) segs.push(p); }
  for (const m of text.matchAll(/<rte\b[^>]*>([\s\S]*?)<\/rte>/gi)) { const p = points(m[1], 'rtept'); if (p.length >= 2) segs.push(p); }
  if (!segs.length) throw new Error('No track or route found in that GPX file (waypoints alone can’t be drawn).');
  const nm = text.match(/<(?:trk|rte)\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i) || text.match(/<metadata>[\s\S]*?<name>([\s\S]*?)<\/name>/i);
  const simplified = segs.map(s => simplifyLL(s, 2)); // 2 m: far finer than any print can show
  let km = 0;
  for (const s of segs) for (let i = 1; i < s.length; i++) km += haversineKm(s[i - 1], s[i]);
  return { name: (nm && decode(nm[1])) || fallbackName, segs: simplified, km };
}

Object.assign(Mapcast, { parseGPX, haversineKm, simplifyLL });
})();
