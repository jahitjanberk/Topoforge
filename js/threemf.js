/* 3MF export: one file holding every part, named and coloured, so a slicer opens a multi-colour
   model as one object made of parts (layout notes at to3MF). A 3MF file is a zip; this has a
   small zip writer (deflate via CompressionStream, falling back to no compression).
   Works in browsers and in Node 18+. */
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
  const m = { verts: [], tris: [] };
  appendPart(m, arr, null);
  return `<mesh><vertices>${m.verts.join('')}</vertices><triangles>${m.tris.join('')}</triangles></mesh>`;
}

// Appends one part to a merged mesh {verts, tris} (XML strings). Each part keeps its own vertices,
// so it stays a closed solid on its own. p1: material index for these triangles (null = default).
// Returns the part's triangle range [first, last] within the mesh.
function appendPart(m, arr, p1) {
  const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const bits = new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
  const index = new Map(), base = m.verts.length, first = m.tris.length;
  const mat = p1 == null ? '' : ` p1="${p1}"`;
  const vid = i => {
    const k = bits[i] + ',' + bits[i + 1] + ',' + bits[i + 2];
    let v = index.get(k);
    if (v === undefined) { v = base + index.size; index.set(k, v); m.verts.push(`<vertex x="${num(f32[i])}" y="${num(f32[i + 1])}" z="${num(f32[i + 2])}"/>`); }
    return v;
  };
  for (let i = 0; i < f32.length; i += 9) {
    const a = vid(i), b = vid(i + 3), c = vid(i + 6);
    if (a !== b && b !== c && a !== c) m.tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${mat}/>`);
  }
  return [first, m.tris.length - 1];
}

// pieces: [{ name, parts: [{ name, color, arr }] }] — one object per piece (whole model or tile).
//
// Layout: each piece is ONE object whose mesh holds all its parts back to back, with each part's
// triangles tagged with its colour (core-spec basematerials). Metadata/Slic3r_PE_model.config names
// each part's triangle range as a volume — that is how PrusaSlicer (and slicers derived from it)
// store multi-part objects. With plain 3MF components instead, PrusaSlicer splits the parts into
// separate objects and drops each onto the bed, losing their relative heights.
async function to3MF(pieces, { title = 'Mapcast model' } = {}) {
  const colors = [], colorIndex = new Map();
  for (const pc of pieces) for (const p of pc.parts) {
    const k = p.name + '|' + p.color;
    if (!colorIndex.has(k)) { colorIndex.set(k, colors.length); colors.push(p); }
  }
  const objects = [], items = [], configs = [];
  let id = 2; // 1 = basematerials
  for (const pc of pieces) {
    const m = { verts: [], tris: [] }, volumes = [];
    const parts = pc.parts.filter(p => p.arr.length);
    const def = parts.length ? colorIndex.get(parts[0].name + '|' + parts[0].color) : 0; // object default: first part
    for (const p of parts) {
      const ci = colorIndex.get(p.name + '|' + p.color);
      const [first, last] = appendPart(m, p.arr, ci === def ? null : ci);
      if (last >= first) volumes.push({ name: p.name, first, last });
    }
    objects.push(`<object id="${id}" type="model" name="${esc(pc.name)}" pid="1" pindex="${def}"><mesh><vertices>${m.verts.join('')}</vertices><triangles>${m.tris.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}" printable="1"/>`);
    configs.push(` <object id="${id}" instances_count="1">\n  <metadata type="object" key="name" value="${esc(pc.name)}"/>\n` +
      volumes.map(v => `  <volume firstid="${v.first}" lastid="${v.last}">\n   <metadata type="volume" key="name" value="${esc(v.name)}"/>\n   <metadata type="volume" key="volume_type" value="ModelPart"/>\n   <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n  </volume>\n`).join('') +
      ' </object>');
    id++;
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
<metadata name="slic3rpe:Version3mf">1</metadata>
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
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') },
    { name: '3D/3dmodel.model', data: enc.encode(model) },
    { name: 'Metadata/Slic3r_PE_model.config', data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${configs.join('\n')}\n</config>\n`) }
  ]).then(b => new Blob([b], { type: 'model/3mf' }));
}

// A built model (from buildModel) → 3MF pieces: one object for the whole model, or one per tile
// (onlyTile: just that tile). Part names drop the tile prefix ("A1 · Water" → "Water").
function modelPieces(model, title, onlyTile = null) {
  const part = l => ({ name: l.tile ? l.name.slice(l.tile.length + 3) : l.name, color: l.color, arr: l.arr });
  if (!model.tiles) return [{ name: title, parts: model.layers.map(part) }];
  return model.tiles.filter(t => !onlyTile || t.name === onlyTile).map(t => ({
    name: t.name === 'Label' ? `${title} — label plate` : t.name === 'Keys' ? `${title} — connector keys` : `${title} — tile ${t.name}`,
    parts: model.layers.filter(l => l.tile === t.name).map(part)
  }));
}

Object.assign(Mapcast, { to3MF, modelPieces, zip, crc32, meshXml });
})();
