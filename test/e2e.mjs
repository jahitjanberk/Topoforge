// End-to-end tests in a real headless browser (Edge or Chrome) over the DevTools protocol.
// Needs internet access (map tiles, elevation, OpenStreetMap). Run: npm run test:e2e [scenario…]
// Set BROWSER=/path/to/chrome-or-edge if it isn't found automatically.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './load.mjs';
import { checkSolid } from './solid.mjs';

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'
].filter(Boolean);
const BROWSER = CANDIDATES.find(p => fs.existsSync(p));
if (!BROWSER) { console.error('No Chrome/Edge found. Set BROWSER=/path/to/browser.'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// ---------- static server + browser ----------
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(p, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); res.end(data); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mapcast-e2e-'));
const browser = spawn(BROWSER, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run', 'about:blank']);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  browser.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('browser did not start')), 20000);
});
const port = new URL(wsUrl).port;
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

let msgId = 0; const pending = new Map(); const errors = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise(r => { const i = ++msgId; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluation failed');
  return r.result?.result?.value;
};
const screenshot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const dir = path.join(ROOT, 'test', 'output'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.from(r.result.data, 'base64'));
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP });
for (let i = 0; i < 60 && !(await evaluate('!!window.__mapcast').catch(() => false)); i++) await sleep(250);
await evaluate(`window.__checkSolid = ${checkSolid.toString()}; true`);

// ---------- page helpers ----------
const setArea = (lat, lng, zoom, layers) => evaluate(`(() => {
  const mc = window.__mapcast;
  if (!document.querySelector('#preview').classList.contains('hidden')) document.querySelector('#pvClose').click();
  mc.map.setView([${lat}, ${lng}], ${zoom}, { animate: false });
  const want = ${JSON.stringify(layers)};
  for (const id of ['lTerrain', 'lWater', 'lBuildings', 'lRoads', 'lPaths']) { const c = document.getElementById(id); if (!c.disabled && c.checked !== !!want[id]) c.click(); }
  document.querySelector('#useView').click(); return true; })()`);
const generate = () => evaluate(`(async () => {
  const t0 = performance.now(); await window.__mapcast.generate();
  const m = window.__mapcast.lastModel, status = document.querySelector('#status').textContent;
  return { ms: Math.round(performance.now() - t0), status, failed: document.querySelector('#status').classList.contains('err'),
    parts: m ? Object.fromEntries(m.layers.map(l => [l.id, window.__checkSolid(l.arr)])) : {} };
})()`);

// ---------- scenarios ----------
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✔' : '✖'} ${name}${detail ? '  ' + detail : ''}`); };
const watertight = (p, allowShared) => p && p.openEdges === 0 && (allowShared || p.nonManifoldEdges === 0) && p.degenerate === 0 && p.volume > 0;
const partsOk = (parts, shared = ['buildings', 'roads', 'route', 'label']) =>
  Object.entries(parts).every(([id, p]) => watertight(p, shared.includes(id)));

const SCENARIOS = {
  async boot() {
    await sleep(3000);
    const s = await evaluate(`({ tiles: document.querySelectorAll('.leaflet-tile-loaded').length, relief: document.querySelectorAll('.hillshade-layer canvas').length })`);
    check('map and relief tiles load', s.tiles > 0 && s.relief > 0, JSON.stringify(s));
    await evaluate(`document.querySelector('#view3d').click(), true`); await sleep(6000);
    const d = await evaluate(`({ on: document.querySelector('#mapwrap').classList.contains('is3d'), canvas: !!document.querySelector('#map3d canvas') })`);
    await evaluate(`document.querySelector('#view3d').click(), true`); await sleep(500);
    check('3D terrain view opens', d.on && d.canvas);
  },
  async water() {
    await setArea(46.6930, 7.7300, 12, { lTerrain: 1, lWater: 1 });
    const r = await generate();
    check('terrain + water (Lake Thun) generates', !r.failed && !!r.parts.water, `${r.ms} ms · ${r.status}`);
    check('terrain + water parts are watertight', partsOk(r.parts), JSON.stringify(r.parts));
    await screenshot('water.png');
  },
  async town() {
    await setArea(46.6863, 7.8632, 16, { lTerrain: 1, lWater: 1, lBuildings: 1, lRoads: 1 });
    const r = await generate();
    check('buildings + roads generate', !r.failed && !!r.parts.buildings && !!r.parts.roads, `${r.ms} ms · ${r.status}`);
    check('all town parts are closed solids', partsOk(r.parts), JSON.stringify(r.parts));
    const again = await generate();
    check('regenerating the same area reuses downloaded data', !again.failed && again.ms < 15000, `${again.ms} ms`);
    await screenshot('town.png');
  },
  async route() {
    // A loop up to Harder Kulm above Interlaken, imported through the real file input.
    const pts = []; for (let i = 0; i <= 60; i++) { const t = i / 60 * 2 * Math.PI; pts.push([46.697 + 0.006 * Math.sin(t), 7.862 + 0.012 * Math.cos(t)]); }
    const gpx = `<gpx><trk><name>E2E loop</name><trkseg>${pts.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('')}</trkseg></trk></gpx>`;
    await evaluate(`(() => { if (!document.querySelector('#preview').classList.contains('hidden')) document.querySelector('#pvClose').click();
      for (const id of ['lWater', 'lBuildings', 'lRoads']) { const c = document.getElementById(id); if (c.checked) c.click(); }
      const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(gpx)}], 'loop.gpx', { type: 'application/gpx+xml' }));
      const input = document.querySelector('#routeFile'); input.files = dt.files; input.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(800);
    const ui = await evaluate(`({ info: document.querySelector('#routeInfo').textContent.replace(/\\s+/g, ' ').trim(), chip: !document.getElementById('lRoute').parentElement.classList.contains('hidden'), shape: !!window.__mapcast.state.shape })`);
    check('GPX import shows the route and frames the area', ui.info.includes('E2E loop') && ui.chip && ui.shape, JSON.stringify(ui));
    const r = await generate();
    check('route generates as its own part', !r.failed && !!r.parts.route, `${r.ms} ms · ${r.status}`);
    check('route part is closed', !!r.parts.route && partsOk(r.parts), JSON.stringify(r.parts.route));
    await screenshot('route.png');
    await evaluate(`document.querySelector('#pvClose').click(), document.querySelector('#routeDel').click(), true`);
  },
  async cancel() {
    await setArea(46.5586, 7.8357, 11, { lTerrain: 1 });
    await evaluate(`document.querySelector('#detail button[data-v="0.4"]').click(), true`);
    const r = await evaluate(`(async () => {
      const p = window.__mapcast.generate(); await new Promise(r => setTimeout(r, 800));
      const label = document.querySelector('#generate').textContent.trim(); document.querySelector('#generate').click(); await p;
      return { label, status: document.querySelector('#status').textContent, after: document.querySelector('#generate').textContent.trim() };
    })()`);
    await evaluate(`document.querySelector('#detail button[data-v="0.7"]').click(), true`);
    check('cancel stops generation', r.label === 'Cancel' && r.status === 'Cancelled.' && r.after.includes('Generate'), JSON.stringify(r));
  }
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
try {
  for (const name of wanted) {
    if (!SCENARIOS[name]) { check(`unknown scenario "${name}"`, false); continue; }
    try { await SCENARIOS[name](); } catch (e) { check(`${name} threw`, false, e.message); }
  }
  check('no errors in the page console', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  ws.close(); browser.kill(); server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
