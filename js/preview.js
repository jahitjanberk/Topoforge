/* 3D preview of the generated model (three.js). three.js ships only as an ES module, so it is
   loaded on first use with a dynamic import (resolved through the import map in index.html). */
(() => {
'use strict';
const Mapcast = globalThis.Mapcast = globalThis.Mapcast || {};

const { $, $$ } = Mapcast;
const { toSTL, download } = Mapcast;

let THREE = null, OrbitControls = null;
async function loadThree() {
  if (THREE) return;
  try {
    const [core, addons] = await Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]);
    THREE = core; OrbitControls = addons.OrbitControls;
  } catch (err) {
    throw new Error('Could not load the 3D preview library. Check your connection.');
  }
}

let three = null;
function initThree() {
  const host = $('#pvCanvas');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8178, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-1, -1.5, 2.2); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(1.5, 1, 1); scene.add(fill);
  const group = new THREE.Group(); scene.add(group);
  const resize = () => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(host);
  let running = false;
  const loop = () => { if (!running) return; controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); };
  three = { renderer, scene, camera, controls, group, resize, start: () => { if (!running) { running = true; loop(); } }, stop: () => { running = false; } };
}

async function showPreview(model) {
  await loadThree();
  $('#preview').classList.remove('hidden');
  if (!three) initThree();
  three.resize();
  const g = three.group;
  while (g.children.length) { const m = g.children.pop(); m.geometry.dispose(); m.material.dispose(); }
  const box = new THREE.Box3();
  for (const l of model.layers) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(l.arr, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: l.color, roughness: .85, metalness: 0, flatShading: true }));
    g.add(mesh); geo.computeBoundingBox(); box.union(geo.boundingBox);
  }
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3()), r = Math.max(size.x, size.y, size.z);
  three.controls.target.copy(c);
  three.camera.position.set(c.x - r * 0.15, c.y - r * 1.25, c.z + r * 0.95);
  three.camera.near = r / 100; three.camera.far = r * 20; three.camera.updateProjectionMatrix();
  three.start();
  $('#pvStats').innerHTML = model.stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const parts = $('#dlParts');
  parts.innerHTML = model.layers.map((l, i) => `<button data-i="${i}"><i style="background:${l.color}"></i>${l.name}<small>${(l.arr.length / 9 * 50 / 1048576).toFixed(1)} MB</small></button>`).join('');
  $$('#dlParts button').forEach(b => b.onclick = () => { const l = model.layers[+b.dataset.i]; download(toSTL([l.arr]), `${model.name}-${l.id}.stl`); });
  const multi = model.layers.length > 1;
  parts.classList.toggle('hidden', !multi); $('#partsLabel').classList.toggle('hidden', !multi);
  $('#partsLabel').nextElementSibling.nextElementSibling.classList.toggle('hidden', !multi);
}

function isPreviewOpen() { return !$('#preview').classList.contains('hidden'); }
function closePreview() { $('#preview').classList.add('hidden'); if (three) three.stop(); }

Object.assign(Mapcast, { showPreview, isPreviewOpen, closePreview });
})();
