/* 3D preview of the generated model (three.js). three.js ships only as an ES module, so it is
   loaded on first use with a dynamic import (resolved through the import map in index.html). */
(() => {
'use strict';
const Topoforge = globalThis.Topoforge = globalThis.Topoforge || {};

const { $, $$ } = Topoforge;
const { toSTL, download } = Topoforge;

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

/* ---------- pop-up (modal) ---------- */
// States: 'loading' (progress while the model builds), 'error', 'ready' (3D preview + downloads).
let returnFocus = null;
const modal = () => $('#preview');
function setState(state, title) {
  modal().dataset.state = state;
  $('#pvTitle').textContent = title;
}
function openModal() {
  const m = modal();
  if (m.classList.contains('hidden')) {
    returnFocus = document.activeElement;
    m.classList.remove('hidden');
  }
  setState('loading', 'Building your model…');
  modalProgress('Starting…', 0);
  $('#pvCancel').textContent = 'Cancel';
  $('#pvClose').focus();
}
function modalProgress(msg, frac) {
  $('#pvLoadMsg').textContent = msg;
  if (typeof frac === 'number') $('#pvProgress').firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}
function modalError(msg) {
  setState('error', 'Couldn’t build the model');
  $('#pvLoadMsg').textContent = msg;
  $('#pvCancel').textContent = 'Close';
  $('#pvCancel').focus();
}
// Keep keyboard focus inside the pop-up while it's open.
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || !isPreviewOpen()) return;
  const items = [...modal().querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!modal().contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

async function showPreview(model) {
  await loadThree();
  const wasHidden = modal().classList.contains('hidden');
  if (wasHidden) { returnFocus = document.activeElement; modal().classList.remove('hidden'); }
  setState('ready', 'Your model');
  if (!three) initThree();
  three.resize();
  const g = three.group;
  while (g.children.length) { const m = g.children.pop(); m.geometry.dispose(); m.material.dispose(); }
  const box = new THREE.Box3();
  for (const l of model.layers) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(l.arr, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: l.color, roughness: .85, metalness: 0, flatShading: true }));
    if (l.offset) mesh.position.set(l.offset[0], l.offset[1], 0); // tiles are spread apart for the preview only
    g.add(mesh); mesh.updateMatrixWorld(true); box.expandByObject(mesh);
  }
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3()), r = Math.max(size.x, size.y, size.z);
  three.controls.target.copy(c);
  three.camera.position.set(c.x - r * 0.15, c.y - r * 1.25, c.z + r * 0.95);
  three.camera.near = r / 100; three.camera.far = r * 20; three.camera.updateProjectionMatrix();
  three.start();
  // Notes (size warnings, layers left out, connector instructions) — the sidebar is behind the backdrop.
  const notesEl = $('#pvNotes');
  notesEl.replaceChildren(...(model.notes || []).map(n => { const p = document.createElement('p'); p.textContent = n; return p; }));
  notesEl.classList.toggle('hidden', !(model.notes || []).length);
  $('#pvStats').innerHTML = model.stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const parts = $('#dlParts'), mb = arrs => (arrs.reduce((s, a) => s + a.length, 0) / 9 * 50 / 1048576).toFixed(1);
  const partName = l => l.tile ? l.name.slice(l.tile.length + 3) : l.name; // "A1 · Water" → "Water"
  if (model.tiles) {
    // One row per tile: the tile button downloads all its parts in one file; chips download single parts.
    parts.innerHTML = model.tiles.map(t => {
      const ls = model.layers.map((l, i) => ({ l, i })).filter(x => x.l.tile === t.name);
      const chips = ls.length > 1 ? `<div class="tile-parts">${ls.map(({ l, i }) => `<button data-i="${i}" title="Download ${l.name}"><i style="background:${l.color}"></i>${partName(l)}</button>`).join('')}</div>` : '';
      return `<div class="tile-row"><button data-tile="${t.name}"><b>${t.name === 'Label' ? 'Label plate' : t.name === 'Keys' ? 'Connector keys' : 'Tile ' + t.name}</b><small>3MF</small></button>${chips}</div>`;
    }).join('');
    // A tile downloads as a 3MF (all its parts, coloured); the chips below give single-part STLs.
    $$('#dlParts [data-tile]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        const title = model.title || model.name;
        download(await Topoforge.to3MF(Topoforge.modelPieces(model, title, b.dataset.tile), { title }), `${model.name}-${b.dataset.tile.toLowerCase()}.3mf`);
      } finally { b.disabled = false; }
    });
  } else {
    parts.innerHTML = model.layers.map((l, i) => `<button data-i="${i}"><i style="background:${l.color}"></i>${l.name}<small>${mb([l.arr])} MB</small></button>`).join('');
  }
  $$('#dlParts [data-i]').forEach(b => b.onclick = () => { const l = model.layers[+b.dataset.i]; download(toSTL([l.arr]), `${model.name}-${l.id}.stl`); });
  const multi = model.layers.length > 1;
  parts.classList.toggle('hidden', !multi); $('#partsLabel').classList.toggle('hidden', !multi);
  $('#partsLabel').textContent = model.tiles ? 'Tiles (print each separately)' : 'Separate parts (multi-colour)';
  const hint = $('#partsLabel').nextElementSibling.nextElementSibling;
  hint.classList.toggle('hidden', !multi);
  hint.textContent = model.tiles
    ? 'Each tile downloads as a 3MF with its parts and colours; the chips give single-part STLs. “Download 3MF” above has every tile in one file, each as its own object.'
    : 'The 3MF above already holds these parts. Single-part STLs are here for slicers that need them: import them together as one object and give each part a filament.';
}

function isPreviewOpen() { return !$('#preview').classList.contains('hidden'); }
function closePreview() {
  $('#preview').classList.add('hidden');
  if (three) three.stop();
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  returnFocus = null;
}

Object.assign(Topoforge, { showPreview, isPreviewOpen, closePreview, openModal, modalProgress, modalError });
})();
