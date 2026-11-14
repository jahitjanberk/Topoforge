// 3MF export: the file is read back with an independent unzipper (Node's zlib) and checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { loadOfflineModel, RING, SETTINGS } from './offline-model.mjs';

const M = loadOfflineModel();
const { to3MF, crc32, buildModel, addPrism } = M;
const Mapcast = M;

// Minimal zip reader (central directory → entries), verifying every CRC.
function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = {};
  let eocd = buf.length - 22; while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let p = dv.getUint32(eocd + 16, true);
  for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'central directory entry');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true);
    const body = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.equal(data.length, size, `${name}: size`);
    assert.equal(crc32(data), crc, `${name}: CRC`);
    out[name] = data.toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// Parses objects from the model XML (meshes as index arrays; triangle p1 = material override) and
// the PrusaSlicer volume config (each part = a named triangle range of its object).
function parseModel(xml, config = '') {
  const objects = new Map();
  for (const m of xml.matchAll(/<object id="(\d+)"([^>]*)>([\s\S]*?)<\/object>/g)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    const verts = [...m[3].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(v => [+v[1], +v[2], +v[3]]);
    const tris = [...m[3].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"(?: p1="(\d+)")?\/>/g)].map(t => [+t[1], +t[2], +t[3], t[4] == null ? null : +t[4]]);
    objects.set(+m[1], { ...attrs, verts, tris, volumes: [] });
  }
  for (const m of config.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const o = objects.get(+m[1]); assert.ok(o, `config refers to unknown object ${m[1]}`);
    for (const v of m[2].matchAll(/<volume firstid="(\d+)" lastid="(\d+)">([\s\S]*?)<\/volume>/g)) {
      o.volumes.push({ first: +v[1], last: +v[2], name: v[3].match(/key="name" value="([^"]*)"/)[1], type: v[3].match(/key="volume_type" value="([^"]*)"/)[1] });
    }
  }
  const items = [...xml.matchAll(/<item objectid="(\d+)"[^>]*\/>/g)].map(i => +i[1]);
  const bases = [...xml.matchAll(/<base name="([^"]*)" displaycolor="(#[0-9A-F]{8})"\/>/g)].map(b => ({ name: b[1], color: b[2] }));
  return { objects, items, bases };
}

// Checks one object: its volumes tile the triangle list exactly, each volume is watertight by
// vertex index, and each volume's triangles carry its own colour. Returns the volume names.
function checkObject(o, bases) {
  assert.ok(o.volumes.length > 0, `${o.name}: no volumes in the config`);
  let next = 0;
  for (const v of o.volumes) {
    assert.equal(v.first, next, `${o.name}: volumes must be contiguous`);
    assert.equal(v.type, 'ModelPart');
    const tris = o.tris.slice(v.first, v.last + 1);
    assert.equal(indexManifold({ verts: o.verts, tris }), 0, `${o.name} / ${v.name} has open edges by vertex index`);
    const mats = new Set(tris.map(t => t[3] == null ? +o.pindex : t[3]));
    assert.equal(mats.size, 1, `${o.name} / ${v.name}: mixed colours`);
    assert.equal(bases[[...mats][0]].name, v.name, `${o.name} / ${v.name}: wrong colour`);
    next = v.last + 1;
  }
  assert.equal(next, o.tris.length, `${o.name}: volumes must cover every triangle`);
  return o.volumes.map(v => v.name);
}

// Watertight by index: every directed edge used once, its reverse used once; no index out of range.
function indexManifold({ verts, tris }) {
  const dir = new Map(); let open = 0;
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    assert.ok(u < verts.length && v < verts.length, 'triangle index out of range');
    const k = u + '>' + v; dir.set(k, (dir.get(k) || 0) + 1);
  }
  for (const [k, n] of dir) { const [u, v] = k.split('>'); if ((dir.get(v + '>' + u) || 0) !== n) open++; }
  return open;
}

const read3MF = async blob => {
  const files = unzip(Buffer.from(await blob.arrayBuffer()));
  return { files, ...parseModel(files['3D/3dmodel.model'], files['Metadata/Slic3r_PE_model.config']) };
};

test('a two-part model exports as one object with two named, coloured parts', async () => {
  const box = (x, z0, z1) => { const o = []; addPrism(o, [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }], [], z0, z1); return new Float32Array(o); };
  const { files, objects, items, bases } = await read3MF(await to3MF([{ name: 'Model', parts: [{ name: 'Terrain & base', color: '#e3d3b0', arr: box(0, 0, 3) }, { name: 'Water', color: '#4a90d9', arr: box(10, 0, 2) }] }], { title: 'Test <&>' }));
  assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', 'Metadata/Slic3r_PE_model.config', '[Content_Types].xml', '_rels/.rels']);
  assert.match(files['_rels/.rels'], /Target="\/3D\/3dmodel.model"/);
  const xml = files['3D/3dmodel.model'];
  assert.match(xml, /unit="millimeter"/);
  assert.match(xml, /Test &lt;&amp;&gt;/, 'title escaped');
  assert.match(xml, /slic3rpe:Version3mf">1</);
  assert.deepEqual(bases, [{ name: 'Terrain &amp; base', color: '#E3D3B0FF' }, { name: 'Water', color: '#4A90D9FF' }]);
  assert.equal(items.length, 1, 'one build item: the parts are one object');
  const o = objects.get(items[0]);
  assert.equal(o.name, 'Model');
  assert.equal(o.verts.length, 16, 'each box keeps its own 8 corners');
  assert.equal(o.tris.length, 24);
  assert.deepEqual(checkObject(o, bases), ['Terrain &amp; base', 'Water']);
});

test('a real tiled model exports one object per tile, each with watertight coloured parts', async () => {
  const model = await buildModel(RING, { ...SETTINGS, tilesX: 2, tilesY: 1, label: '' });
  const { objects, items, bases } = await read3MF(await to3MF(Mapcast.modelPieces(model, 'Test')));
  assert.deepEqual(items.map(i => objects.get(i).name), ['Test — tile A1', 'Test — tile B1']);
  assert.deepEqual(bases.map(b => b.name).sort(), ['Buildings', 'Roads', 'Route', 'Terrain &amp; base'], 'one material per part type, shared by tiles');
  let parts = 0;
  for (const i of items) parts += checkObject(objects.get(i), bases).length;
  assert.equal(parts, model.layers.length);
});
