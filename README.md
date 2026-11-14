# Mapcast

Find a place, draw a print area, and export its terrain (plus optional buildings and roads) as an STL for 3D printing. Everything runs in the browser, with no build step and no API keys.

## Run it

Double-click `start.bat`, or run `npm start` (needs [Node.js](https://nodejs.org)). It serves the folder at http://localhost:8080 and opens your browser. Set `PORT` to use another port.

Opening `index.html` directly (`file://`) won't show the street map. OpenStreetMap's tile servers require a `Referer` header and replace tiles with an "Access blocked" image for pages that have none, which is always true for files opened from disk. The page detects this and explains it. Once deployed to any web host, the app works as is.

An internet connection is needed for map tiles, elevation data and the CDN libraries.

The scripts in `js/` are plain (non-module) scripts. Each file wraps its code in a function and shares what other files need on `window.Mapcast`, so load order in `index.html` matters.

## Structure

```
index.html        page markup
css/style.css     all styles
img/              logo + favicon
js/
  app.js          entry point: map, drawing tools, search, settings, persistence
  basemaps.js     OpenStreetMap layer + relief shading computed from elevation tiles
  terrain3d.js    3D terrain view (MapLibre GL, lazy-loaded)
  model.js        print area + settings → mesh layers
  mesh.js         terrain / building / road mesh builders
  data.js         elevation tiles + OpenStreetMap (Overpass) download
  geo.js          projection and 2D geometry helpers
  preview.js      three.js preview of the finished model
  stl.js          binary STL writer + download
  dom.js          $ / $$ shortcuts
```

## Data sources

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding). The same tiles drive the relief shading, the 3D view and the STL, so the relief you see is the relief you print.
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright) standard tiles, subject to the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Switch to a hosted provider before heavy use.
- Buildings and roads: OpenStreetMap through the Overpass API.
