/* 3MF export: one file holding every part, named and coloured, so a slicer (PrusaSlicer, Bambu
   Studio, OrcaSlicer, Cura) opens a multi-colour model as one object made of parts.
   Layout: each part is a mesh object with a colour from <basematerials>; the parts of one piece
   (the whole model, or one tile) are grouped as components of a parent object, which is the
   build item. A 3MF file is a zip; this has a small zip writer (deflate via CompressionStream,
   falling back to no compression). Works in browsers and in Node 18+. */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

/* ---------- zip ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; } // e.g. an engine without 'deflate-raw'
}

// files: [{ name, data: Uint8Array }] → Blob (application/zip).
async function zip(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    const packed = await deflateRaw(f.data), method = packed ? 8 : 0, body = packed || f.data;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); // UTF-8 names
    head.setUint16(8, method, true); head.setUint16(10, dosTime, true); head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true); head.setUint32(18, body.length, true); head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    chunks.push(new Uint8Array(head.buffer), name, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, body.length, true); cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ---------- model XML ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const num = v => { const s = v.toFixed(5); return s.includes('.') ? s.replace(/\.?0+$/, '') : s; };
const hexColor = c => (c.length === 4 ? '#' + [...c.slice(1)].map(x => x + x).join('') : c).toUpperCase() + 'FF';

// Triangle soup → indexed mesh XML. Vertices are shared by exact float value, so a watertight
// soup becomes a watertight indexed mesh.
function meshXml(arr) {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const bits = new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
  const index = new Map(), verts = [], tris = [];
  const vid = i => {
    const k = bits[i] + ',' + bits[i + 1] + ',' + bits[i + 2];
    let v = index.get(k);
    if (v === undefined) { v = index.size; index.set(k, v); verts.push(`<vertex x="${num(f32[i])}" y="${num(f32[i + 1])}" z="${num(f32[i + 2])}"/>`); }
    return v;
  };
  for (let i = 0; i < f32.length; i += 9) {
    const a = vid(i), b = vid(i + 3), c = vid(i + 6);
    if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  }
  return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

// pieces: [{ name, parts: [{ name, color, arr }] }] — one build item per piece (whole model or tile).
async function to3MF(pieces, { title = 'Mapcast model' } = {}) {
  const colors = [], colorIndex = new Map();
  for (const pc of pieces) for (const p of pc.parts) {
    const k = p.name + '|' + p.color;
    if (!colorIndex.has(k)) { colorIndex.set(k, colors.length); colors.push(p); }
  }
  const objects = [], items = [];
  let id = 2; // 1 = basematerials
  for (const pc of pieces) {
    const partIds = [];
    for (const p of pc.parts) {
      objects.push(`<object id="${id}" type="model" name="${esc(p.name)}" pid="1" pindex="${colorIndex.get(p.name + '|' + p.color)}">${meshXml(p.arr)}</object>`);
      partIds.push(id++);
    }
    objects.push(`<object id="${id}" type="model" name="${esc(pc.name)}"><components>${partIds.map(p => `<component objectid="${p}"/>`).join('')}</components></object>`);
    items.push(`<item objectid="${id++}"/>`);
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">Mapcast</metadata>
<metadata name="Copyright">Map data © OpenStreetMap contributors; elevation: Mapzen / AWS Terrain Tiles</metadata>
<resources>
<basematerials id="1">${colors.map(p => `<base name="${esc(p.name)}" displaycolor="${hexColor(p.color)}"/>`).join('')}</basematerials>
${objects.join('\n')}
</resources>
<build>${items.join('')}</build>
</model>`;
  const enc = new TextEncoder();
  return zip([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: '3D/3dmodel.model', data: enc.encode(model) }
  ]).then(b => new Blob([b], { type: 'model/3mf' }));
}

// A built model (from buildModel) → 3MF pieces: one object for the whole model, or one per tile
// (onlyTile: just that tile). Part names drop the tile prefix ("A1 · Water" → "Water").
function modelPieces(model, title, onlyTile = null) {
  const part = l => ({ name: l.tile ? l.name.slice(l.tile.length + 3) : l.name, color: l.color, arr: l.arr });
  if (!model.tiles) return [{ name: title, parts: model.layers.map(part) }];
  return model.tiles.filter(t => !onlyTile || t.name === onlyTile).map(t => ({
    name: t.name === 'Label' ? `${title} — label plate` : `${title} — tile ${t.name}`,
    parts: model.layers.filter(l => l.tile === t.name).map(part)
  }));
}

Object.assign(Mapcast, { to3MF, modelPieces, zip, crc32, meshXml });
})();
