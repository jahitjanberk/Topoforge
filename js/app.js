/* Topoforge — find a place, draw a print area, export the terrain as STL.
   This module wires up the UI: map, drawing tools, search, settings and persistence. */
(() => {
'use strict';
const Topoforge = globalThis.Topoforge = globalThis.Topoforge || {};

const { $, $$ } = Topoforge;
const { D2R, toLocal, fromLocal, rot, fmtLen, fmtArea, signedArea, bbox, cleanRing, simplifyDP, tileXY } = Topoforge;
const { osmLayer, reliefLayer } = Topoforge;
const { createTerrainView } = Topoforge;
const { createGenerator } = Topoforge;
const { showPreview, closePreview, isPreviewOpen } = Topoforge;
const { toSTL, download } = Topoforge;

const ACCENT = '#4f46e5';
const STORE = 'topoforge-v1';

const state = { tool: 'select', shape: null, place: '', relief: true, view3d: false, route: null };
const keys = { shift: false, alt: false, space: false };
const history = [];
let busy = false;
const generator = createGenerator(); // builds models in a Web Worker

const mpp = lat => 40075016.686 * Math.cos(lat * D2R) / 2 ** (map.getZoom() + 8);

/* =====================================================================
   Map — 2D (Leaflet, where you draw) and 3D terrain (MapLibre, to inspect)
   ===================================================================== */
const map = L.map('map', { zoomControl: false, boxZoom: false, worldCopyJump: true }).setView([46.5586, 7.8357], 12);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const cont = map.getContainer();
const terrain3d = createTerrainView($('#map3d'));

// OpenStreetMap blocks tile requests without a Referer, which file:// pages never send.
const fromFile = location.protocol === 'file:';
if (fromFile) $('#fileNotice').classList.remove('hidden');
else osmLayer().addTo(map);
const relief = reliefLayer();
function setRelief(on) {
  state.relief = on;
  if (on) relief.addTo(map); else relief.remove();
  terrain3d.setRelief(on);
  $('#relief').classList.toggle('active', on);
  $('#relief').setAttribute('aria-pressed', on);
}
$('#relief').onclick = () => { setRelief(!state.relief); save(); };

async function set3D(on) {
  if (on === state.view3d) return;
  state.view3d = on;
  $('#mapwrap').classList.toggle('is3d', on);
  $('#view3d').classList.toggle('active', on);
  $('#view3d').setAttribute('aria-pressed', on);
  if (on) {
    if (pen) penCancel();
    if (state.tool !== 'select') setTool('select');
    hideLabel();
    terrain3d.setArea(state.shape ? shapeRing(state.shape, 128) : null);
    terrain3d.setExaggeration(readSettings().exag);
    setHint();
    try { await terrain3d.show(map.getCenter(), map.getZoom()); }
    catch (err) { flash(err.message); set3D(false); }
  } else {
    const v = terrain3d.hide();
    if (v) map.setView(v.center, Math.round(v.zoom * 4) / 4, { animate: false });
    map.invalidateSize();
    setHint();
  }
  save();
}
$('#view3d').onclick = () => set3D(!state.view3d);

/* =====================================================================
   Shapes
   rect   {type,c,hw,hh,rot}    square {type,c,hw,rot}
   circle {type,c,r}            poly   {type,pts:[LatLng]}
   ===================================================================== */
const TYPE_NAMES = { rect: 'Rectangle', square: 'Square', circle: 'Circle', poly: 'Freeform' };
const halfH = s => s.type === 'square' ? s.hw : s.hh;
function shapeRing(s, n = 128) {
  if (!s) return [];
  if (s.type === 'rect' || s.type === 'square') {
    const hh = halfH(s);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => fromLocal(rot({ x: a * s.hw, y: b * hh }, s.rot || 0), s.c));
  }
  if (s.type === 'circle') {
    const out = [];
    for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; out.push(fromLocal({ x: s.r * Math.cos(t), y: s.r * Math.sin(t) }, s.c)); }
    return out;
  }
  return s.pts.slice();
}
function cloneShape(s) {
  if (!s) return null;
  const o = { ...s };
  if (s.c) o.c = L.latLng(s.c.lat, s.c.lng);
  if (s.pts) o.pts = s.pts.map(p => L.latLng(p.lat, p.lng));
  return o;
}
function shapeMetrics(s) {
  const ring = shapeRing(s, 96);
  const o = L.latLngBounds(ring).getCenter();
  const loc = ring.map(p => toLocal(p, o));
  const [a, b, c, d] = bbox(loc);
  return { w: c - a, h: d - b, area: Math.abs(signedArea(loc)) };
}
function dimsText(s) {
  if (!s) return '';
  if (s.type === 'rect') return `${fmtLen(2 * s.hw)} × ${fmtLen(2 * s.hh)}`;
  if (s.type === 'square') return `${fmtLen(2 * s.hw)} × ${fmtLen(2 * s.hw)}`;
  if (s.type === 'circle') return `⌀ ${fmtLen(2 * s.r)}`;
  const m = shapeMetrics(s); return `${fmtLen(m.w)} × ${fmtLen(m.h)}`;
}

let shapeLayer = null;
const shapeStyle = { color: ACCENT, weight: 2.5, fillColor: ACCENT, fillOpacity: 0.12, className: 'shape-path' };
function drawShapeLayer() {
  if (!state.shape) { if (shapeLayer) { shapeLayer.remove(); shapeLayer = null; } return; }
  const ring = shapeRing(state.shape);
  if (!shapeLayer) shapeLayer = L.polygon(ring, shapeStyle).addTo(map);
  else shapeLayer.setLatLngs(ring);
}

/* ---------- edit handles ---------- */
let handles = [];
let draggingKey = null;
const ROT_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"><path d="M20 12a8 8 0 11-3-6.2"/><path d="M20 4v5h-5"/></svg>';
function handleDefs() {
  const s = state.shape;
  if (!s || state.tool !== 'select') return [];
  const out = [];
  if (s.type === 'rect' || s.type === 'square') {
    const hh = halfH(s), r = s.rot || 0;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) out.push({ key: `c:${sx}:${sy}`, cls: 'corner', ll: fromLocal(rot({ x: sx * s.hw, y: sy * hh }, r), s.c) });
    if (s.type === 'rect') for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push({ key: `e:${sx}:${sy}`, cls: 'edge', ll: fromLocal(rot({ x: sx * s.hw, y: sy * hh }, r), s.c) });
    out.push({ key: 'rot', cls: 'rot', ll: fromLocal(rot({ x: 0, y: hh + 30 * mpp(s.c.lat) }, r), s.c) });
  } else if (s.type === 'circle') {
    out.push({ key: 'r', cls: 'radius', ll: fromLocal({ x: s.r, y: 0 }, s.c) });
  } else {
    s.pts.forEach((p, i) => out.push({ key: 'v:' + i, cls: 'vertex', ll: p }));
    s.pts.forEach((p, i) => { const q = s.pts[(i + 1) % s.pts.length]; out.push({ key: 'm:' + i, cls: 'mid', ll: L.latLng((p.lat + q.lat) / 2, (p.lng + q.lng) / 2) }); });
  }
  return out;
}
function makeIcon(cls) {
  const size = cls === 'mid' ? 10 : cls === 'rot' ? 18 : cls === 'edge' ? 11 : 13;
  return L.divIcon({ className: 'mh mh-' + cls, iconSize: [size, size], html: cls === 'rot' ? ROT_ICON : '' });
}
function rebuildHandles(defs, keep) {
  handles.forEach(h => { if (!keep || h !== keep) h.m.remove(); });
  handles = defs.map(d => {
    if (keep && d.key === keep.key) return keep;
    const m = L.marker(d.ll, { draggable: true, icon: makeIcon(d.cls), keyboard: false, zIndexOffset: d.cls === 'mid' ? 0 : 1000, autoPan: false });
    const h = { key: d.key, m };
    bindHandle(h);
    m.addTo(map);
    return h;
  });
}
function syncHandles(force) {
  const defs = handleDefs();
  const same = !force && defs.length === handles.length && defs.every((d, i) => d.key === handles[i].key);
  if (!same) return rebuildHandles(defs, draggingKey ? handles.find(h => h.key === draggingKey) : null);
  defs.forEach((d, i) => { if (handles[i].key !== draggingKey) handles[i].m.setLatLng(d.ll); });
}
function bindHandle(h) {
  h.m.on('dragstart', () => {
    pushHistory();
    draggingKey = h.key;
    if (h.key.startsWith('m:')) {
      const i = +h.key.slice(2);
      state.shape.pts.splice(i + 1, 0, h.m.getLatLng());
      h.key = 'v:' + (i + 1); draggingKey = h.key;
      rebuildHandles(handleDefs(), h);
    }
  });
  h.m.on('drag', e => {
    applyHandle(h.key, e.latlng);
    drawShapeLayer(); syncHandles(); updateAreaPanel();
    const p = map.latLngToContainerPoint(e.latlng);
    showLabel(p, h.key === 'rot' ? `${Math.round(((state.shape.rot || 0) / D2R % 360 + 360) % 360)}°` : dimsText(state.shape));
  });
  h.m.on('dragend', () => { draggingKey = null; hideLabel(); render(true); save(); });
  if (h.key.startsWith('v:')) {
    const del = e => { L.DomEvent.stop(e); deleteVertex(h); };
    h.m.on('dblclick', del); h.m.on('contextmenu', del);
  }
}
function deleteVertex(h) {
  const s = state.shape;
  if (!s || s.type !== 'poly' || !h.key.startsWith('v:')) return;
  if (s.pts.length <= 3) return flash('A shape needs at least 3 points');
  pushHistory();
  s.pts.splice(+h.key.slice(2), 1);
  render(true); save();
}
const MIN = 10; // metres
function applyHandle(key, ll) {
  const s = state.shape;
  if (key === 'rot') {
    const P = toLocal(ll, s.c);
    let a = Math.atan2(P.y, P.x) - Math.PI / 2;
    if (keys.shift) a = Math.round(a / (15 * D2R)) * 15 * D2R;
    s.rot = a; return;
  }
  if (key === 'r') { const P = toLocal(ll, s.c); s.r = Math.max(MIN, Math.hypot(P.x, P.y)); return; }
  if (key.startsWith('v:')) { s.pts[+key.slice(2)] = ll; return; }
  const [kind, sxs, sys] = key.split(':'); const sx = +sxs, sy = +sys;
  const r = s.rot || 0, hh = halfH(s);
  const P = toLocal(ll, s.c);
  if (keys.alt) { // resize symmetrically around the centre
    const d = rot(P, -r);
    if (kind === 'c') {
      let w = Math.max(MIN / 2, Math.abs(d.x)), h = Math.max(MIN / 2, Math.abs(d.y));
      if (s.type === 'square') w = h = Math.max(w, h);
      s.hw = w; if (s.type === 'rect') s.hh = h;
    } else if (sx) s.hw = Math.max(MIN / 2, Math.abs(d.x)); else s.hh = Math.max(MIN / 2, Math.abs(d.y));
    return;
  }
  if (kind === 'c') {
    const O = rot({ x: -sx * s.hw, y: -sy * hh }, r);       // opposite corner stays put
    const d = rot({ x: P.x - O.x, y: P.y - O.y }, -r);       // in shape frame
    let w = Math.max(MIN, sx * d.x), h = Math.max(MIN, sy * d.y);
    if (s.type === 'square') w = h = Math.max(w, h);
    const half = rot({ x: sx * w / 2, y: sy * h / 2 }, r);
    s.c = fromLocal({ x: O.x + half.x, y: O.y + half.y }, s.c);
    s.hw = w / 2; if (s.type === 'rect') s.hh = h / 2;
  } else {
    const O = rot({ x: -sx * s.hw, y: -sy * hh }, r);       // opposite edge midpoint
    const d = rot({ x: P.x - O.x, y: P.y - O.y }, -r);
    if (sx) {
      const w = Math.max(MIN, sx * d.x), half = rot({ x: sx * w / 2, y: 0 }, r);
      s.c = fromLocal({ x: O.x + half.x, y: O.y + half.y }, s.c); s.hw = w / 2;
    } else {
      const h = Math.max(MIN, sy * d.y), half = rot({ x: 0, y: sy * h / 2 }, r);
      s.c = fromLocal({ x: O.x + half.x, y: O.y + half.y }, s.c); s.hh = h / 2;
    }
  }
}
map.on('zoomend', () => syncHandles());

/* ---------- cursor label + hints ---------- */
const label = $('#cursorLabel');
function showLabel(pt, text) { label.textContent = text; label.style.left = pt.x + 'px'; label.style.top = pt.y + 'px'; label.classList.remove('hidden'); }
function hideLabel() { label.classList.add('hidden'); }
const HINTS = {
  select: s => !s ? 'Pick a tool above to draw your print area — <b>S</b> square · <b>R</b> rectangle · <b>C</b> circle · <b>P</b> pen'
    : s.type === 'poly' ? 'Drag the shape to <b>move</b> · drag points to reshape · drag a <b>small dot</b> to add a point · double-click a point to remove it'
    : s.type === 'circle' ? 'Drag the shape to <b>move</b> · drag the handle to change the size'
    : 'Drag the shape to <b>move</b> · drag handles to resize · top handle <b>rotates</b> (Shift snaps 15°) · Alt resizes from the centre',
  square: () => 'Drag to draw a square · hold <b>Alt</b> to draw from the centre · or just <b>click</b> to drop one',
  rect: () => 'Drag to draw a rectangle · <b>Shift</b> for a square · <b>Alt</b> from the centre · or just <b>click</b> to drop one',
  circle: () => 'Drag out from the centre · <b>Alt</b> to drag across the diameter · or just <b>click</b> to drop one',
  pen: () => '<b>Click</b> to place points, or <b>drag</b> to draw freehand · click the first point or press <b>Enter</b> to finish · <b>Backspace</b> undoes a point · hold <b>Space</b> to pan'
};
const HINT_3D = () => `3D terrain · relief at <b>${readSettings().exag.toFixed(1)}×</b> (your exaggeration setting) · drag to pan · ${matchMedia('(pointer: coarse)').matches ? '<b>two-finger drag</b> to tilt &amp; rotate · tap <b>3D</b> to go back and edit' : '<b>right-drag</b> to tilt &amp; rotate · press <b>3</b> to go back and edit'}`;
function setHint() { $('#hint').innerHTML = state.view3d ? HINT_3D() : HINTS[state.tool](state.shape); }
let flashTimer;
function flash(msg) { const h = $('#hint'); h.innerHTML = msg; clearTimeout(flashTimer); flashTimer = setTimeout(setHint, 2200); }

/* ---------- tools ---------- */
function setTool(t) {
  if (t !== 'select' && state.view3d) set3D(false); // drawing happens on the 2D map
  if (pen && t !== 'pen') penCancel();
  if (t !== 'select') setSheet('peek'); // phones: tuck the settings away while drawing
  state.tool = t;
  $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  const drawing = t !== 'select';
  cont.classList.toggle('drawing', drawing);
  if (drawing && !keys.space) { map.dragging.disable(); map.doubleClickZoom.disable(); }
  else { map.dragging.enable(); map.doubleClickZoom.enable(); }
  render(true); setHint();
}
$$('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(state.tool === b.dataset.tool && b.dataset.tool !== 'select' ? 'select' : b.dataset.tool)));

function pushHistory() { history.push(cloneShape(state.shape)); if (history.length > 50) history.shift(); }
function undo() {
  if (pen && pen.pts.length) { penBack(); return; }
  if (!history.length) return flash('Nothing to undo');
  state.shape = history.pop(); render(true); save(); setHint();
}
function deleteShape() { if (!state.shape) return; pushHistory(); state.shape = null; render(true); save(); setHint(); }
$('#tbUndo').onclick = undo;
$('#tbDelete').onclick = deleteShape;

function commitShape() { setTool('select'); save(); }
function defaultShape(tool, c) {
  const sz = cont.clientWidth && cont.clientHeight ? 0.32 * Math.min(cont.clientWidth, cont.clientHeight) * mpp(c.lat) : 1000;
  if (tool === 'circle') return { type: 'circle', c, r: sz / 2 };
  if (tool === 'square') return { type: 'square', c, hw: sz / 2, rot: 0 };
  return { type: 'rect', c, hw: sz * 0.65, hh: sz * 0.45, rot: 0 };
}
function shapeFromDrag(tool, a, b) {
  const d = toLocal(b, a);
  if (tool === 'circle') {
    if (keys.alt) { const r = Math.max(MIN, Math.hypot(d.x, d.y) / 2); return { type: 'circle', c: fromLocal({ x: d.x / 2, y: d.y / 2 }, a), r }; }
    return { type: 'circle', c: a, r: Math.max(MIN, Math.hypot(d.x, d.y)) };
  }
  const t = tool === 'rect' && keys.shift ? 'square' : tool;
  let w = Math.max(MIN, Math.abs(d.x)), h = Math.max(MIN, Math.abs(d.y));
  if (t === 'square') w = h = Math.max(w, h);
  if (keys.alt) return t === 'square' ? { type: 'square', c: a, hw: w, rot: 0 } : { type: 'rect', c: a, hw: w, hh: h, rot: 0 };
  const c = fromLocal({ x: (d.x < 0 ? -1 : 1) * w / 2, y: (d.y < 0 ? -1 : 1) * h / 2 }, a);
  return t === 'square' ? { type: 'square', c, hw: w / 2, rot: 0 } : { type: 'rect', c, hw: w / 2, hh: h / 2, rot: 0 };
}

/* ---------- pointer handling on the map ---------- */
function isUi(t) { return t.closest('.leaflet-control, .mh, .maptools, .basemap'); }
cont.addEventListener('pointerdown', e => {
  if (isUi(e.target) || keys.space) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (state.tool === 'select') {
    if (shapeLayer && e.target === shapeLayer.getElement()) startMove(e);
    return;
  }
  if (state.tool === 'pen') return penDown(e);
  shapeDown(e);
}, true);

function track(move, up) {
  const u = ev => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', u); window.removeEventListener('pointercancel', u); up(ev); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', u); window.addEventListener('pointercancel', u);
}
function startMove(e) {
  e.preventDefault(); e.stopPropagation();
  map.dragging.disable();
  const start = map.mouseEventToLatLng(e), orig = cloneShape(state.shape);
  let moved = false;
  track(ev => {
    const ll = map.mouseEventToLatLng(ev), dLat = ll.lat - start.lat, dLng = ll.lng - start.lng;
    if (!moved) { pushHistory(); moved = true; }
    const s = state.shape;
    if (s.c) s.c = L.latLng(orig.c.lat + dLat, orig.c.lng + dLng);
    else s.pts = orig.pts.map(p => L.latLng(p.lat + dLat, p.lng + dLng));
    drawShapeLayer(); syncHandles(); updateAreaPanel();
  }, () => { map.dragging.enable(); if (moved) save(); });
}
function shapeDown(e) {
  e.preventDefault();
  const startLL = map.mouseEventToLatLng(e), startPt = map.mouseEventToContainerPoint(e), tool = state.tool;
  let moved = false;
  const before = cloneShape(state.shape);
  track(ev => {
    const pt = map.mouseEventToContainerPoint(ev);
    if (!moved && pt.distanceTo(startPt) < 5) return;
    moved = true;
    state.shape = shapeFromDrag(tool, startLL, map.mouseEventToLatLng(ev));
    drawShapeLayer(); updateAreaPanel();
    showLabel(pt, dimsText(state.shape));
  }, () => {
    hideLabel();
    history.push(before);
    if (!moved) state.shape = defaultShape(tool, startLL);
    commitShape();
  });
}

/* ---------- pen ---------- */
let pen = null;
function penStart() {
  pen = {
    pts: [], lastT: 0,
    line: L.polyline([], { color: ACCENT, weight: 2.5, interactive: false }).addTo(map),
    fill: L.polygon([], { stroke: false, fillColor: ACCENT, fillOpacity: 0.08, interactive: false }).addTo(map),
    rubber: L.polyline([], { color: ACCENT, weight: 1.5, dashArray: '5 5', interactive: false }).addTo(map),
    first: null
  };
}
function penRedraw(cursor) {
  if (!pen) return;
  pen.line.setLatLngs(pen.pts);
  pen.fill.setLatLngs(pen.pts.length > 2 ? pen.pts : []);
  const last = pen.pts[pen.pts.length - 1];
  if (cursor && last) {
    const nearFirst = pen.pts.length >= 3 && map.latLngToContainerPoint(pen.pts[0]).distanceTo(map.latLngToContainerPoint(cursor)) < 12;
    pen.rubber.setLatLngs(pen.pts.length > 1 && !nearFirst ? [last, cursor, pen.pts[0]] : [last, cursor]);
    if (pen.first) pen.first.setStyle({ fillColor: nearFirst ? ACCENT : '#fff', radius: nearFirst ? 8 : 6 });
  } else pen.rubber.setLatLngs([]);
}
function penDown(e) {
  e.preventDefault();
  if (!pen) penStart();
  const ll = map.mouseEventToLatLng(e), pt = map.mouseEventToContainerPoint(e), P = pen.pts;
  if (P.length >= 3 && map.latLngToContainerPoint(P[0]).distanceTo(pt) < 12) return penFinish(false);
  const now = performance.now();
  if (P.length >= 3 && now - pen.lastT < 400 && map.latLngToContainerPoint(P[P.length - 1]).distanceTo(pt) < 8) return penFinish(false);
  pen.lastT = now;
  P.push(ll);
  if (P.length === 1) pen.first = L.circleMarker(ll, { radius: 6, color: ACCENT, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
  penRedraw(ll);
  let added = 0;
  track(ev => {
    const p2 = map.mouseEventToContainerPoint(ev);
    if (p2.distanceTo(map.latLngToContainerPoint(P[P.length - 1])) > 5) { P.push(map.mouseEventToLatLng(ev)); added++; penRedraw(); }
  }, () => { if (added >= 4 && pen && pen.pts.length >= 3) penFinish(true); });
}
cont.addEventListener('pointermove', e => {
  if (state.tool !== 'pen' || !pen || !pen.pts.length) { if (state.tool === 'pen' && !pen) showLabel(map.mouseEventToContainerPoint(e), 'Click or drag to start'); return; }
  const ll = map.mouseEventToLatLng(e);
  penRedraw(ll);
  const n = pen.pts.length;
  showLabel(map.mouseEventToContainerPoint(e), n < 3 ? `${n} point${n === 1 ? '' : 's'}` : `${n} points · Enter to finish`);
});
cont.addEventListener('pointerleave', () => { if (!draggingKey) hideLabel(); });
function penFinish(freehand) {
  if (!pen) return;
  let px = pen.pts.map(p => map.latLngToContainerPoint(p));
  px = cleanRing(px.map(p => ({ x: p.x, y: p.y })), 1.5);
  if (freehand) px = simplifyDP(px, 1.5);
  if (px.length < 3 || Math.abs(signedArea(px)) < 50) { flash('That shape is too small — try again'); penCancel(); return; }
  const before = cloneShape(state.shape);
  state.shape = { type: 'poly', pts: px.map(p => map.containerPointToLatLng(L.point(p.x, p.y))) };
  history.push(before);
  penCancel(); hideLabel(); commitShape();
}
function penBack() { if (!pen) return; pen.pts.pop(); if (!pen.pts.length) return penCancel(); penRedraw(); }
function penCancel() {
  if (!pen) return;
  ['line', 'fill', 'rubber', 'first'].forEach(k => pen[k] && pen[k].remove());
  pen = null; hideLabel();
}

/* ---------- keyboard ---------- */
const inField = e => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
window.addEventListener('keydown', e => {
  keys.shift = e.shiftKey; keys.alt = e.altKey;
  if (inField(e) || isPreviewOpen()) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (!keys.space) { keys.space = true; cont.classList.add('panning'); map.dragging.enable(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { if (pen) penCancel(); else if (state.tool !== 'select') setTool('select'); return; }
  if (k === 'enter' && pen) { if (pen.pts.length >= 3) penFinish(false); return; }
  if (k === 'backspace' && pen) { e.preventDefault(); penBack(); return; }
  if ((k === 'delete' || k === 'backspace') && state.tool === 'select') { e.preventDefault(); deleteShape(); return; }
  const map_ = { v: 'select', s: 'square', r: 'rect', c: 'circle', p: 'pen' };
  if (k === '3' || k === 't') { set3D(!state.view3d); return; }
  if (map_[k]) setTool(map_[k]);
});
window.addEventListener('keyup', e => {
  keys.shift = e.shiftKey; keys.alt = e.altKey;
  if (e.key === ' ' && keys.space) {
    keys.space = false; cont.classList.remove('panning');
    if (state.tool !== 'select') map.dragging.disable();
  }
});
window.addEventListener('blur', () => { keys.shift = keys.alt = false; if (keys.space) { keys.space = false; cont.classList.remove('panning'); if (state.tool !== 'select') map.dragging.disable(); } });

$('#useView').onclick = () => {
  const b = map.getBounds(), c = map.getCenter();
  const w = map.distance([c.lat, b.getWest()], [c.lat, b.getEast()]), h = map.distance([b.getSouth(), c.lng], [b.getNorth(), c.lng]);
  history.push(cloneShape(state.shape));
  state.shape = { type: 'rect', c, hw: w * 0.36, hh: h * 0.36, rot: 0 };
  commitShape();
};

/* =====================================================================
   GPX route
   ===================================================================== */
const ROUTE_STORE = 'topoforge-route-v1';
const ROUTE_COLOR = '#e11d48';
let routeLine = null;
function setRoute(route, { fit = false, persist = true } = {}) {
  state.route = route;
  if (routeLine) { routeLine.remove(); routeLine = null; }
  if (route) routeLine = L.polyline(route.segs, { color: ROUTE_COLOR, weight: 3.5, opacity: .9, interactive: false }).addTo(map);
  terrain3d.setRoute(route ? route.segs : null);
  const info = $('#routeInfo');
  info.classList.toggle('hidden', !route);
  if (route) {
    info.innerHTML = `<i class="route-dot"></i><span class="route-name" title="${escapeHtml(route.name)}">${escapeHtml(route.name)}</span><span class="route-km">${route.km.toFixed(1)} km</span>
      <button class="iconbtn" id="routeFit" title="Fit the print area to the route"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
      <button class="iconbtn" id="routeDel" title="Remove route"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    $('#routeFit').onclick = fitAreaToRoute;
    $('#routeDel').onclick = () => setRoute(null);
  }
  $('#routeImport').textContent = route ? 'Replace GPX route…' : 'Import a GPX route…';
  syncLayerUi(); updateAreaPanel();
  if (persist) { try { route ? localStorage.setItem(ROUTE_STORE, JSON.stringify(route)) : localStorage.removeItem(ROUTE_STORE); } catch (e) { /* storage full/unavailable */ } }
  if (fit && route) fitAreaToRoute();
}
function fitAreaToRoute() {
  if (!state.route) return;
  const b = L.latLngBounds(state.route.segs.flat()), c = b.getCenter();
  const w = map.distance([c.lat, b.getWest()], [c.lat, b.getEast()]), h = map.distance([b.getSouth(), c.lng], [b.getNorth(), c.lng]);
  history.push(cloneShape(state.shape));
  state.shape = { type: 'rect', c, hw: Math.max(MIN, w * 0.56), hh: Math.max(MIN, h * 0.56), rot: 0 }; // ~12% margin
  commitShape();
  map.fitBounds(L.latLngBounds(shapeRing(state.shape, 16)), { padding: [60, 60], animate: !state.view3d });
  if (state.view3d) terrain3d.fitArea(shapeRing(state.shape, 64));
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function importRouteFile(file) {
  if (!file) return;
  try {
    const r = Topoforge.parseGPX(await file.text(), file.name.replace(/\.gpx$/i, ''));
    // A brand-new route usually means "print this": frame it unless an area is already drawn around it.
    const inside = state.shape && L.latLngBounds(shapeRing(state.shape, 64)).contains(L.latLngBounds(r.segs.flat()));
    setRoute(r, { fit: !inside });
    $('#lRoute').checked = true; syncLayerUi(); save();
    flash(`Route loaded: <b>${escapeHtml(r.name)}</b> · ${r.km.toFixed(1)} km`);
  } catch (err) { flash(escapeHtml(err.message || 'Could not read that file.')); }
}
$('#routeImport').onclick = () => $('#routeFile').click();
$('#routeFile').onchange = e => { importRouteFile(e.target.files[0]); e.target.value = ''; };
// Drop a .gpx file anywhere on the map.
$('#mapwrap').addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); $('#mapwrap').classList.add('dropping'); } });
$('#mapwrap').addEventListener('dragleave', e => { if (e.target === $('#mapwrap') || !$('#mapwrap').contains(e.relatedTarget)) $('#mapwrap').classList.remove('dropping'); });
$('#mapwrap').addEventListener('drop', e => { e.preventDefault(); $('#mapwrap').classList.remove('dropping'); importRouteFile(e.dataTransfer.files[0]); });

/* =====================================================================
   Area panel
   ===================================================================== */
let areaPanelType = null;
function numInput(id, label, unit) { return `<label>${label}<div class="unit"><input id="${id}" type="number" step="any" min="0" inputmode="decimal"><i>${unit}</i></div></label>`; }
function updateAreaPanel() {
  const el = $('#areaInfo'), s = state.shape;
  $('#generate').disabled = busy ? !generator.cancellable : !s;
  // Say why Generate is disabled, and point at the drawing tools until an area exists.
  if (!busy && $('#genText')) $('#genText').textContent = s ? 'Generate 3D model' : 'Draw an area to generate';
  $('#mapwrap').classList.toggle('no-area', !s);
  if (!s) {
    if (areaPanelType !== 'none') { el.innerHTML = '<p class="empty"><b>Draw it on the map</b> with the tools at the top of the map: drag to draw, or click once to drop a ready-sized area you can move and resize.</p>'; areaPanelType = 'none'; }
    $('#estimate').classList.add('hidden'); $('#scaleNote').classList.add('hidden');
    $$('.chip.dropped').forEach(c => c.classList.remove('dropped'));
    return;
  }
  if (areaPanelType !== s.type) {
    areaPanelType = s.type;
    let fields = '';
    if (s.type === 'rect') fields = numInput('iW', 'Width', 'km') + numInput('iH', 'Height', 'km') + numInput('iRot', 'Rotation', '°');
    if (s.type === 'square') fields = numInput('iW', 'Side', 'km') + numInput('iRot', 'Rotation', '°');
    if (s.type === 'circle') fields = numInput('iW', 'Diameter', 'km');
    el.innerHTML = `
      <div class="area-head"><span class="badge">${TYPE_NAMES[s.type]}</span><span class="sp"></span>
        <button class="iconbtn" id="aZoom" title="Zoom to area"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
        <button class="iconbtn" id="aDel" title="Delete area"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
      </div>
      ${fields ? `<div class="dims">${fields}</div>` : ''}
      <div class="meta" id="aMeta"></div><div id="aWarn"></div>`;
    $('#aZoom').onclick = () => {
      const ring = shapeRing(state.shape, 64);
      map.fitBounds(L.latLngBounds(ring), { padding: [60, 60], animate: !state.view3d });
      if (state.view3d) terrain3d.fitArea(ring);
    };
    $('#aDel').onclick = deleteShape;
    const onNum = (id, fn) => { const i = $('#' + id); if (i) i.addEventListener('change', () => { const v = parseFloat(i.value); if (!isFinite(v) || v < 0) return; pushHistory(); fn(v); render(true); save(); }); };
    onNum('iW', v => { const m = Math.max(MIN, v * 1000); if (state.shape.type === 'circle') state.shape.r = m / 2; else state.shape.hw = m / 2; });
    onNum('iH', v => { state.shape.hh = Math.max(MIN, v * 1000) / 2; });
    onNum('iRot', v => { state.shape.rot = v * D2R; });
  }
  const setv = (id, v) => { const i = $('#' + id); if (i && document.activeElement !== i) i.value = v; };
  if (s.type === 'rect') { setv('iW', (2 * s.hw / 1000).toFixed(3)); setv('iH', (2 * s.hh / 1000).toFixed(3)); }
  if (s.type === 'square') setv('iW', (2 * s.hw / 1000).toFixed(3));
  if (s.type === 'circle') setv('iW', (2 * s.r / 1000).toFixed(3));
  if (s.rot !== undefined) setv('iRot', Math.round(((s.rot / D2R) % 360 + 360) % 360));
  const m = shapeMetrics(s), S = readSettings();
  const k = S.size / Math.max(m.w, m.h);
  const ratio = 1000 / k, r3 = Number(ratio.toPrecision(3));
  const tiled = S.tilesX * S.tilesY > 1;
  $('#oTiles').textContent = tiled ? `${Math.round(m.w * k / S.tilesX)} × ${Math.round(m.h * k / S.tilesY)} mm each` : 'Off';
  $('#aMeta').innerHTML = `${s.type === 'poly' ? `<b>${dimsText(s)}</b> · ${s.pts.length} points<br>` : ''}Area <b>${fmtArea(m.area)}</b><br>Model <b>${Math.round(m.w * k)} × ${Math.round(m.h * k)} mm</b> · scale 1:${r3.toLocaleString()}${tiled ? `<br>${S.tilesX * S.tilesY} tiles of up to <b>${Math.round(m.w * k / S.tilesX)} × ${Math.round(m.h * k / S.tilesY)} mm</b>` : ''}`;
  const km2 = m.area / 1e6;
  // What the map scale will leave out (the model builder applies the same rule), shown right
  // under the layer chips it affects.
  const detail = Topoforge.detailForScale(ratio, S.paths), dropped = [];
  const noBuildings = S.buildings && !detail.buildings;
  if (noBuildings) dropped.push('buildings are left out (too small to print)');
  if (S.roads && detail.level) dropped.push(`roads: only ${detail.level}`);
  $('#lBuildings').parentElement.classList.toggle('dropped', noBuildings);
  $('#scaleNote').classList.toggle('hidden', !dropped.length);
  $('#scaleNote').textContent = dropped.length ? `At 1:${r3.toLocaleString()}: ${dropped.join('; ')}.` : '';
  let warn = '';
  if (S.buildings && !noBuildings && km2 > 25) warn = `Large area for buildings (${km2.toFixed(0)} km²). Downloading may be slow or time out — consider a smaller area or terrain only.`;
  else if (S.terrain && !S.buildings && !S.roads && km2 < 0.5) warn = 'Small area with terrain only — it may print almost flat. Increase exaggeration or add buildings.';
  $('#aWarn').innerHTML = warn ? `<div class="warn">${warn}</div>` : '';
  updateEstimate(s, S, m, k, detail);
}

// Rough file size before generating. The terrain is predictable (the mesh keeps to a vertex budget
// set by the detail and the elevation data's resolution, and is often smaller); buildings and
// roads depend on how dense the area is, so they're only mentioned.
function updateEstimate(s, S, m, k, detail) {
  const el = $('#estimate');
  let tris = 0;
  const areaMm = m.area * k * k, perimMm = 2 * (m.w + m.h) * k;
  if (S.terrain) {
    const b = L.latLngBounds(shapeRing(s, 32)).pad(0.05);
    let z;
    for (z = 15; z >= 1; z--) {
      const a = tileXY(b.getNorth(), b.getWest(), z), c = tileXY(b.getSouth(), b.getEast(), z);
      if ((Math.floor(c.x) - Math.floor(a.x) + 1) * (Math.floor(c.y) - Math.floor(a.y) + 1) <= 36) break;
    }
    const resM = 156543.03392 * Math.cos(b.getCenter().lat * D2R) / 2 ** z;
    const h = Math.max(S.detail, resM * k * 0.7, Math.sqrt(areaMm / 220000));
    tris = 2 * areaMm / (0.866 * h * h) + 4 * perimMm / h;
    if (S.stepped) tris *= 1.6;
    if (S.water) tris *= 1.15;
  } else tris = 4 * perimMm / 4 + 200;
  const mb = tris * 50 / 1048576, fmt = v => v < 10 ? v.toFixed(1) : Math.round(v).toString();
  const extra = (S.buildings && detail.buildings) || S.roads ? ', plus buildings and roads (more in cities)' : '';
  el.classList.remove('hidden');
  el.classList.toggle('big', mb > 50);
  el.innerHTML = `Estimated size: up to <b>${fmt(mb)} MB</b> STL (≈ ${fmt(mb / 4)} MB as 3MF)${extra}.${mb > 50 ? ' Large for some slicers: try Draft detail or a smaller model.' : ''}`;
}
function render(force) {
  drawShapeLayer(); syncHandles(force); updateAreaPanel();
  if (state.view3d) terrain3d.setArea(state.shape ? shapeRing(state.shape, 128) : null);
}

/* =====================================================================
   Search (Nominatim)
   ===================================================================== */
let searchTimer, searchSeq = 0, results = [];
const q = $('#q'), list = $('#results');
q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 450); });
q.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); if (results.length) pick(results[0]); else search(true); }
  if (e.key === 'Escape') { list.innerHTML = ''; q.blur(); }
});
async function search(pickFirst) {
  const text = q.value.trim(); list.innerHTML = '';
  if (!text) return;
  const m = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { results = [{ display_name: `${m[1]}, ${m[2]}`, lat: +m[1], lon: +m[2], coord: true }]; renderResults(); if (pickFirst) pick(results[0]); return; }
  const seq = ++searchSeq;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(text)}`, { headers: { 'Accept-Language': navigator.language || 'en' } });
    const js = await r.json(); if (seq !== searchSeq) return;
    results = js; renderResults();
    if (pickFirst && results.length) pick(results[0]);
    if (!results.length) list.innerHTML = '<li><small>No places found</small></li>';
  } catch (err) { list.innerHTML = '<li><small>Search is unavailable right now</small></li>'; }
}
function renderResults() {
  list.innerHTML = results.map((r, i) => { const [head, ...rest] = r.display_name.split(', '); return `<li data-i="${i}">${head}<small>${rest.join(', ') || (r.coord ? 'Coordinates' : '')}</small></li>`; }).join('');
  $$('#results li[data-i]').forEach(li => li.onclick = () => pick(results[+li.dataset.i]));
}
function pick(r) {
  list.innerHTML = '';
  state.place = r.coord ? '' : r.display_name.split(',')[0];
  q.value = r.display_name.split(', ').slice(0, 2).join(', ');
  if (r.boundingbox) {
    const [s, n, w, e] = r.boundingbox.map(Number);
    map.fitBounds([[s, w], [n, e]], { maxZoom: 16, animate: !state.view3d });
  } else map.setView([+r.lat, +r.lon], 15, { animate: !state.view3d });
  if (state.view3d) terrain3d.show(map.getCenter(), map.getZoom());
  save();
}

/* =====================================================================
   Settings
   ===================================================================== */
const sliders = [['sSize', 'oSize', v => `${v} mm`], ['sBase', 'oBase', v => `${v} mm`], ['sExag', 'oExag', v => `${(+v).toFixed(1)}×`], ['sBH', 'oBH', v => `${(+v).toFixed(1)}×`], ['sBMin', 'oBMin', v => `${(+v).toFixed(1)} mm`], ['sRW', 'oRW', v => `${(+v).toFixed(1)} mm`], ['sRH', 'oRH', v => `${(+v).toFixed(1)} mm`], ['sWD', 'oWD', v => `${(+v).toFixed(1)} mm`], ['sRtW', 'oRtW', v => `${(+v).toFixed(1)} mm`], ['sRtH', 'oRtH', v => `${(+v).toFixed(1)} mm`], ['sLblH', 'oLblH', v => `${(+v).toFixed(1)} mm`], ['sStep', 'oStep', v => `${(+v).toFixed(1)} mm`]];
sliders.forEach(([s, o, f]) => { const el = $('#' + s); const upd = () => { $('#' + o).textContent = f(el.value); }; el.addEventListener('input', () => { upd(); updateAreaPanel(); }); el.addEventListener('change', save); upd(); });
$('#sExag').addEventListener('input', () => { terrain3d.setExaggeration(+$('#sExag').value); if (state.view3d) setHint(); });
$$('#detail button').forEach(b => b.onclick = () => { $$('#detail button').forEach(x => x.classList.toggle('active', x === b)); save(); });
const setSurface = v => { $$('#surface button').forEach(x => x.classList.toggle('active', x.dataset.v === v)); syncLayerUi(); };
$$('#surface button').forEach(b => b.onclick = () => { setSurface(b.dataset.v); save(); });
['lTerrain', 'lWater', 'lBuildings', 'lRoads', 'lPaths', 'lRoute', 'cSea'].forEach(id => $('#' + id).addEventListener('change', () => { syncLayerUi(); updateAreaPanel(); save(); }));
$('#tLabel').addEventListener('change', save);
$('#tLabel').addEventListener('input', syncLayerUi); // the label height setting appears with text
['selTX', 'selTY'].forEach(id => $('#' + id).addEventListener('change', () => { syncLayerUi(); updateAreaPanel(); save(); }));
$('#cKeys').addEventListener('change', save);
$('#labelPlace').onclick = () => {
  const c = state.shape ? L.latLngBounds(shapeRing(state.shape, 16)).getCenter() : map.getCenter();
  $('#tLabel').value = state.place || `${c.lat.toFixed(4)}°, ${c.lng.toFixed(4)}°`;
  save();
};
function syncLayerUi() {
  // Show only the settings that apply to the current choices.
  const on = id => $('#' + id).checked, show = (id, yes) => $('#' + id).classList.toggle('hidden', !yes);
  const terrain = on('lTerrain'), water = terrain && on('lWater');
  show('gTerrain', terrain);
  show('fKeys', (+$('#selTX').value || 1) * (+$('#selTY').value || 1) > 1);
  show('fStep', terrain && $('#surface button.active')?.dataset.v === 'stepped');
  // Water is cut into the terrain surface, so it needs terrain; footpaths are a kind of road.
  $('#lWater').disabled = !terrain;
  $('#lPaths').disabled = !on('lRoads');
  // The Route chip only shows once a GPX route is loaded.
  $('#lRoute').parentElement.classList.toggle('hidden', !state.route);
  // Fine-tuning: each setting only when its layer is in the model.
  const fine = { fBuild: on('lBuildings'), fRoads: on('lRoads'), fRoute: !!state.route && on('lRoute'), fLabelH: !!$('#tLabel').value.trim(), fWater: water, fSea: terrain };
  for (const [id, yes] of Object.entries(fine)) show(id, yes);
  show('advEmpty', !Object.values(fine).some(Boolean));
}
function readSettings() {
  return {
    size: +$('#sSize').value, base: +$('#sBase').value, exag: +$('#sExag').value,
    detail: +($('#detail button.active') || { dataset: { v: 0.7 } }).dataset.v,
    bMult: +$('#sBH').value, bMin: +$('#sBMin').value, roadMin: +$('#sRW').value, roadH: +$('#sRH').value,
    terrain: $('#lTerrain').checked, buildings: $('#lBuildings').checked, roads: $('#lRoads').checked,
    paths: $('#lRoads').checked && $('#lPaths').checked, sea: $('#cSea').checked,
    water: $('#lTerrain').checked && $('#lWater').checked, waterDepth: +$('#sWD').value,
    route: state.route && $('#lRoute').checked ? state.route.segs : null, routeW: +$('#sRtW').value, routeH: +$('#sRtH').value,
    label: $('#tLabel').value.trim(), labelH: +$('#sLblH').value,
    stepped: $('#lTerrain').checked && ($('#surface button.active') || {}).dataset?.v === 'stepped', stepMm: +$('#sStep').value,
    tilesX: +$('#selTX').value || 1, tilesY: +$('#selTY').value || 1, connectors: $('#cKeys').checked
  };
}

/* ---------- persistence ---------- */
function save() {
  try {
    const s = state.shape, ser = s ? { ...s, c: s.c ? [s.c.lat, s.c.lng] : undefined, pts: s.pts ? s.pts.map(p => [p.lat, p.lng]) : undefined } : null;
    const settings = {}; $$('#panel input, #panel select').forEach(i => { if (i.id && i.id !== 'q' && i.type !== 'file' && !i.id.startsWith('i')) settings[i.id] = i.type === 'checkbox' ? i.checked : i.value; });
    settings.detail = ($('#detail button.active') || {}).dataset?.v;
    settings.surface = ($('#surface button.active') || {}).dataset?.v;
    localStorage.setItem(STORE, JSON.stringify({ shape: ser, settings, view: [map.getCenter().lat, map.getCenter().lng, map.getZoom()], place: state.place, relief: state.relief, view3d: state.view3d }));
  } catch (e) { /* storage unavailable */ }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE) || 'null'); if (!d) return null;
    if (typeof d.relief === 'boolean') state.relief = d.relief;
    if (d.view) map.setView([d.view[0], d.view[1]], d.view[2]);
    if (d.settings) {
      for (const [k, v] of Object.entries(d.settings)) { const i = $('#' + k); if (!i) continue; if (i.type === 'checkbox') i.checked = v; else i.value = v; i.dispatchEvent(new Event('input')); }
      if (d.settings.detail) $$('#detail button').forEach(b => b.classList.toggle('active', b.dataset.v === d.settings.detail));
      if (d.settings.surface) $$('#surface button').forEach(b => b.classList.toggle('active', b.dataset.v === d.settings.surface));
    }
    if (d.shape) { const s = d.shape; if (s.c) s.c = L.latLng(s.c[0], s.c[1]); if (s.pts) s.pts = s.pts.map(p => L.latLng(p[0], p[1])); state.shape = s; }
    state.place = d.place || '';
    return d;
  } catch (e) { return null; }
}
map.on('moveend', save);

/* =====================================================================
   Generate
   ===================================================================== */
let statusShown = '';
// frac: 0–1 fills the progress bar; omit it to hide the bar.
function setStatus(msg, kind, frac) {
  const el = $('#status');
  if (kind === 'busy' && msg === statusShown && el.querySelector('.spin')) { /* same text: only move the bar */ }
  else {
    el.className = kind === 'err' ? 'err' : '';
    el.innerHTML = msg ? (kind === 'busy' ? '<div class="spin"></div>' : '') + `<span>${msg}</span>` : '';
    statusShown = kind === 'busy' ? msg : '';
  }
  const bar = $('#progress'), show = kind === 'busy' && typeof frac === 'number';
  bar.classList.toggle('hidden', !show);
  if (show) bar.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}
const GEN_LABEL = $('#generate').innerHTML;
const CANCEL_LABEL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>Cancel';
function setBusy(on) {
  busy = on;
  const btn = $('#generate');
  btn.innerHTML = on && generator.cancellable ? CANCEL_LABEL : GEN_LABEL;
  btn.classList.toggle('cancel', on);
  updateAreaPanel();
}
let lastModel = null;
$('#generate').onclick = () => busy ? generator.cancel() : generate();
async function generate() {
  if (!state.shape || busy) return;
  setBusy(true);
  Topoforge.openModal(); // the pop-up shows progress, then the model
  try {
    const result = await generator.run(shapeRing(state.shape, 256), readSettings(), (msg, frac) => { setStatus(msg, 'busy', frac); Topoforge.modalProgress(msg, frac); });
    lastModel = { ...result, name: slug(), title: modelTitle() };
    await showPreview(lastModel);
    setStatus(['Model ready.', ...result.notes].join(' '));
  } catch (err) {
    if (err && err.cancelled) { setStatus('Cancelled.'); closePreview(); }
    else { console.error(err); setStatus(err.message || String(err), 'err'); Topoforge.modalError(err.message || String(err)); }
  } finally { setBusy(false); }
}
// Closing the pop-up (✕, Esc, Back, the darkened background) while a model is building cancels it.
function requestClosePreview() {
  if (busy) { if (generator.cancellable) generator.cancel(); return; }
  closePreview();
}
$('#dlAll').onclick = () => lastModel && download(toSTL(lastModel.layers.map(l => l.arr)), lastModel.name + '.stl');
$('#dl3mf').onclick = async () => {
  if (!lastModel) return;
  const btn = $('#dl3mf'); btn.disabled = true;
  try { download(await Topoforge.to3MF(Topoforge.modelPieces(lastModel, modelTitle()), { title: modelTitle() }), lastModel.name + '.3mf'); }
  catch (err) { console.error(err); setStatus('Could not create the 3MF file: ' + (err.message || err), 'err'); }
  finally { btn.disabled = false; }
};
// Human-readable model name for 3MF objects: the place, else "Topoforge model".
function modelTitle() { return state.place || ($('#tLabel').value.trim()) || 'Topoforge model'; }
for (const id of ['pvClose', 'pvBack', 'pvCancel', 'pvBackdrop']) $('#' + id).onclick = requestClosePreview;
window.addEventListener('keydown', e => { if (e.key === 'Escape' && isPreviewOpen()) { e.preventDefault(); requestClosePreview(); } });

function slug() {
  const base = state.place || (state.shape ? (() => { const c = L.latLngBounds(shapeRing(state.shape, 16)).getCenter(); return `${c.lat.toFixed(4)}_${c.lng.toFixed(4)}`; })() : 'model');
  return 'topoforge-' + base.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-|-$/g, '');
}
/* ---------- theme ---------- */
// Follows the system unless chosen here; the choice is remembered (applied early by index.html).
const THEME_KEY = 'topoforge-theme';
const effectiveTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('#themeBtn').onclick = () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage unavailable */ }
};

/* ---------- welcome ---------- */
const WELCOME_KEY = 'topoforge-welcome-v1';
function openWelcome() { $('#welcome').classList.remove('hidden'); $('#welcomeGo').focus(); }
function closeWelcome() {
  $('#welcome').classList.add('hidden');
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) { /* storage unavailable */ }
  $('#q').focus();
}
$('#helpBtn').onclick = openWelcome;
$('#welcomeGo').onclick = closeWelcome;
$('#welcome').addEventListener('click', e => { if (e.target === $('#welcome')) closeWelcome(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#welcome').classList.contains('hidden')) { e.stopImmediatePropagation(); closeWelcome(); } }, true);

/* ---------- phones: settings in a bottom sheet ---------- */
// Three heights: peek (search + Generate), half, full. Drag the handle or tap it to cycle.
const phone = matchMedia('(max-width: 820px)');
const SHEET = { peek: () => 292, half: () => Math.round(innerHeight * 0.55), full: () => Math.round(innerHeight * 0.92) };
let sheetState = 'peek';
function setSheet(stateName, px) {
  if (!phone.matches) { document.documentElement.style.removeProperty('--sheet-h'); return; }
  sheetState = stateName || sheetState;
  document.documentElement.style.setProperty('--sheet-h', (px ?? SHEET[sheetState]()) + 'px');
  $('#sheetHandle').setAttribute('aria-label', sheetState === 'full' ? 'Show less' : 'Show more settings');
}
$('#sheetHandle').onclick = () => setSheet({ peek: 'half', half: 'full', full: 'peek' }[sheetState]);
$('#sheetHandle').addEventListener('pointerdown', e => {
  if (!phone.matches) return;
  const startY = e.clientY, startH = $('#panel').getBoundingClientRect().height;
  let moved = false;
  $('#panel').classList.add('dragging');
  const move = ev => {
    if (Math.abs(ev.clientY - startY) > 4) moved = true;
    setSheet(null, Math.max(120, Math.min(innerHeight * 0.94, startH + startY - ev.clientY)));
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    $('#panel').classList.remove('dragging');
    if (!moved) return; // a tap: the click handler cycles
    const h = $('#panel').getBoundingClientRect().height;
    const nearest = Object.keys(SHEET).reduce((a, b) => Math.abs(SHEET[a]() - h) < Math.abs(SHEET[b]() - h) ? a : b);
    setSheet(nearest);
    $('#sheetHandle').addEventListener('click', ev => ev.stopImmediatePropagation(), { once: true, capture: true });
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
phone.addEventListener('change', () => setSheet('peek'));
addEventListener('resize', () => setSheet());
$('#q').addEventListener('focus', () => { if (phone.matches) setSheet('full'); });
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && phone.matches) setTimeout(() => setSheet('peek'), 50); });

/* ---------- boot ---------- */
// One-time move of data saved under the app's old name (Mapcast), so returning users keep it.
try {
  for (const [from, to] of [['mapcast-v1', STORE], ['mapcast-route-v1', ROUTE_STORE]]) {
    const old = localStorage.getItem(from);
    if (old != null && localStorage.getItem(to) == null) localStorage.setItem(to, old);
    if (old != null) localStorage.removeItem(from);
  }
} catch (e) { /* storage unavailable */ }
const saved = load();
setRelief(state.relief);
try { const r = JSON.parse(localStorage.getItem(ROUTE_STORE) || 'null'); if (r && r.segs) setRoute(r, { persist: false }); } catch (e) { /* ignore */ }
syncLayerUi();
setTool('select');
if (saved && saved.view3d) set3D(true);
setSheet('peek');
try { if (!localStorage.getItem(WELCOME_KEY)) openWelcome(); } catch (e) { /* storage unavailable */ }
window.__topoforge = { state, map, generate, setTool, readSettings, get lastModel() { return lastModel; } };
})();
