/* Model Web Worker: downloads data and builds the meshes off the main thread so the page stays
   responsive. Protocol (all messages carry the job id):
     in : { id, ring: [{lat,lng}], settings }
     out: { id, type: 'status', msg, frac } | { id, type: 'done', result } | { id, type: 'error', message }
   The mesh buffers in `result` are transferred, not copied. Cancelling = terminating the worker. */
importScripts(
  'https://cdn.jsdelivr.net/npm/delaunator@5.1.0/delaunator.min.js',
  'https://cdn.jsdelivr.net/npm/earcut@3.2.4/dist/earcut.min.js',
  'geo.js', 'data.js', 'mesh.js', 'model.js'
);

self.onmessage = async e => {
  const { id, ring, settings } = e.data;
  try {
    const result = await Mapcast.buildModel(ring, settings, (msg, frac) => self.postMessage({ id, type: 'status', msg, frac }));
    self.postMessage({ id, type: 'done', result }, result.layers.map(l => l.arr.buffer));
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
