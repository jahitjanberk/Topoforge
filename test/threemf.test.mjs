// 3MF export: the file is read back with an independent unzipper (Node's zlib) and checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { loadOfflineModel, RING, SETTINGS } from './offline-model.mjs';

const M = loadOfflineModel();
const { to3MF, crc32, buildModel, addPrism } = M;

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

// Parses objects from the model XML; meshes as index arrays.
function parseModel(xml) {
  const objects = new Map();
  for (const m of xml.matchAll(/<object id="(\d+)"([^>]*)>([\s\S]*?)<\/object>/g)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    const verts = [...m[3].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(v => [+v[1], +v[2], +v[3]]);
    const tris = [...m[3].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].map(t => [+t[1], +t[2], +t[3]]);
    const comps = [...m[3].matchAll(/<component objectid="(\d+)"\/>/g)].map(c => +c[1]);
    objects.set(+m[1], { ...attrs, verts, tris, comps });
  }
  const items = [...xml.matchAll(/<item objectid="(\d+)"\/>/g)].map(i => +i[1]);
  const bases = [...xml.matchAll(/<base name="([^"]*)" displaycolor="(#[0-9A-F]{8})"\/>/g)].map(b => ({ name: b[1], color: b[2] }));
  return { objects, items, bases };
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

test('a two-part model exports as one object with two coloured parts', async () => {
  const box = (x, z0, z1) => { const o = []; addPrism(o, [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }], [], z0, z1); return new Float32Array(o); };
  const blob = await to3MF([{ name: 'Model', parts: [{ name: 'Terrain & base', color: '#e3d3b0', arr: box(0, 0, 3) }, { name: 'Water', color: '#4a90d9', arr: box(10, 0, 2) }] }], { title: 'Test <&>' });
  const files = unzip(Buffer.from(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
  assert.match(files['_rels/.rels'], /Target="\/3D\/3dmodel.model"/);
  const xml = files['3D/3dmodel.model'];
  assert.match(xml, /unit="millimeter"/);
  assert.match(xml, /Test &lt;&amp;&gt;/, 'title escaped');
  const { objects, items, bases } = parseModel(xml);
  assert.deepEqual(bases, [{ name: 'Terrain &amp; base', color: '#E3D3B0FF' }, { name: 'Water', color: '#4A90D9FF' }]);
  assert.equal(items.length, 1);
  const parent = objects.get(items[0]);
  assert.equal(parent.name, 'Model');
  assert.equal(parent.comps.length, 2);
  for (const id of parent.comps) {
    const o = objects.get(id);
    assert.equal(o.pid, '1');
    assert.equal(o.verts.length, 8, 'box corners shared, not duplicated');
    assert.equal(o.tris.length, 12);
    assert.equal(indexManifold(o), 0);
  }
});

test('a real tiled model exports one watertight, coloured object per tile', async () => {
  const model = await buildModel(RING, { ...SETTINGS, tilesX: 2, tilesY: 1, label: '' });
  const pieces = model.tiles.map(t => ({ name: `Tile ${t.name}`, parts: model.layers.filter(l => l.tile === t.name).map(l => ({ name: l.name.split(' · ')[1], color: l.color, arr: l.arr })) }));
  const blob = await to3MF(pieces);
  const { objects, items, bases } = parseModel(unzip(Buffer.from(await blob.arrayBuffer()))['3D/3dmodel.model']);
  assert.deepEqual(items.map(i => objects.get(i).name), ['Tile A1', 'Tile B1']);
  assert.deepEqual(bases.map(b => b.name).sort(), ['Buildings', 'Roads', 'Route', 'Terrain &amp; base'], 'one material per part type, shared by tiles');
  let parts = 0;
  for (const i of items) for (const id of objects.get(i).comps) {
    const o = objects.get(id); parts++;
    assert.equal(indexManifold(o), 0, `${objects.get(i).name} / ${o.name} has open edges by vertex index`);
  }
  assert.equal(parts, model.layers.length);
});
