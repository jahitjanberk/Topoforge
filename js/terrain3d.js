/* 3D terrain view (MapLibre GL), draped with OpenStreetMap and the print area.
   Elevation comes from the same AWS Terrarium tiles the STL export uses, so what you see
   here is the relief you will print. MapLibre is loaded lazily the first time 3D opens. */
(() => {
'use strict';
const Mapcast = window.Mapcast = window.Mapcast || {};

const { TERRARIUM_URL } = Mapcast;
const { OSM } = Mapcast;

const MAPLIBRE_VERSION = '4.7.1';
const MAPLIBRE_JS = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
const MAPLIBRE_CSS = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
const ACCENT = '#f25c2a';
const DEM_ATTR = 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / AWS Terrain Tiles</a>';
const EMPTY = { type: 'FeatureCollection', features: [] };

let libPromise = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (!libPromise) libPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = MAPLIBRE_CSS; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = MAPLIBRE_JS;
    js.onload = resolve;
    js.onerror = () => { libPromise = null; reject(new Error('Could not load the 3D map library. Check your connection.')); };
    document.head.appendChild(js);
  });
  return libPromise;
}

const demSource = () => ({ type: 'raster-dem', tiles: [TERRARIUM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: DEM_ATTR });
const osmSource = () => ({ type: 'raster', tiles: [OSM.url], tileSize: 256, maxzoom: OSM.maxNativeZoom, attribution: OSM.attribution });
const areaData = ring => !ring || ring.length < 3 ? EMPTY : {
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map(p => [p.lng, p.lat])] }
};

// Leaflet zoom is based on 256px tiles, MapLibre's on 512px, hence the ±1.
function createTerrainView(container) {
  let ml = null, creating = null;
  const want = { relief: true, exaggeration: 1.5, ring: null };

  function applyRelief() {
    if (ml && ml.isStyleLoaded()) ml.setLayoutProperty('hillshade', 'visibility', want.relief ? 'visible' : 'none');
  }

  async function create(center, zoom) {
    await loadMapLibre();
    ml = new maplibregl.Map({
      container,
      center: [center.lng, center.lat], zoom: Math.max(0, zoom - 1), pitch: 60, bearing: -15, maxPitch: 85,
      attributionControl: { compact: true },
      style: {
        version: 8,
        sources: { base: osmSource(), dem: demSource(), shade: demSource(), area: { type: 'geojson', data: areaData(want.ring) } },
        layers: [
          { id: 'sky', type: 'background', paint: { 'background-color': '#dfe7ee' } },
          { id: 'base', type: 'raster', source: 'base' },
          { id: 'hillshade', type: 'hillshade', source: 'shade', paint: { 'hillshade-exaggeration': 0.4, 'hillshade-shadow-color': '#3d3426' } },
          { id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': ACCENT, 'fill-opacity': 0.14 } },
          { id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': ACCENT, 'line-width': 3 } }
        ],
        terrain: { source: 'dem', exaggeration: want.exaggeration }
      }
    });
    ml.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    await new Promise(r => ml.once('load', r));
    applyRelief();
  }

  return {
    get active() { return !container.classList.contains('hidden'); },

    // Opens the 3D view at a Leaflet center/zoom.
    async show(center, zoom) {
      container.classList.remove('hidden');
      if (!ml || creating) {
        if (!creating) creating = create(center, zoom).finally(() => { creating = null; });
        await creating; return;
      }
      ml.resize();
      ml.jumpTo({ center: [center.lng, center.lat], zoom: Math.max(0, zoom - 1) });
    },

    // Hides the 3D view and returns the Leaflet center/zoom to go back to.
    hide() {
      container.classList.add('hidden');
      if (!ml) return null;
      const c = ml.getCenter();
      return { center: L.latLng(c.lat, c.lng), zoom: ml.getZoom() + 1 };
    },

    setRelief(on) { want.relief = on; applyRelief(); },

    setExaggeration(x) {
      want.exaggeration = x;
      if (ml && ml.isStyleLoaded()) ml.setTerrain({ source: 'dem', exaggeration: x });
    },

    // ring: [L.LatLng] outline of the print area, or null.
    setArea(ring) {
      want.ring = ring;
      const src = ml && ml.getSource('area');
      if (src) src.setData(areaData(ring));
    },

    fitArea(ring) {
      if (!ml || !ring || ring.length < 3) return;
      const b = L.latLngBounds(ring);
      ml.fitBounds([[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]], { padding: 80, pitch: ml.getPitch(), bearing: ml.getBearing(), duration: 800 });
    }
  };
}

Object.assign(Mapcast, { createTerrainView });
})();
