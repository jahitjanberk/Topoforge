# Mapcast

Find a place, draw a print area, and export its terrain (plus optional buildings and roads) as an STL for 3D printing. Everything runs in the browser, with no build step and no API keys.

## Run it

Double-click `start.bat`, or run `npm start` (needs [Node.js](https://nodejs.org)). It serves the folder at http://localhost:8080 and opens your browser. Set `PORT` to use another port.

Opening `index.html` directly (`file://`) won't show the street map. OpenStreetMap's tile servers require a `Referer` header and replace tiles with an "Access blocked" image for pages that have none, which is always true for files opened from disk. The page detects this and explains it. Once deployed to any web host, the app works as is.

An internet connection is needed for map tiles, elevation data and the CDN libraries.

The scripts in `js/` are plain (non-module) scripts. Each file wraps its code in a function and shares what other files need on `window.Mapcast`, so load order in `index.html` matters.

## Tests

```sh
npm install          # once: dev copies of the geometry libraries the page loads from the CDN
npm test             # unit tests (Node, no network): every mesh part must be a watertight solid
npm run test:e2e     # browser tests in headless Edge/Chrome (needs internet; BROWSER=… to pick one)
```

`test/solid.mjs` holds the watertightness check: every edge is used exactly twice, in opposite directions, with positive volume. The unit tests and the browser tests share it. Screenshots from the browser tests are saved to `test/output/`.

## Structure

```
index.html        page markup
css/style.css     all styles
img/              logo + favicon
js/
  app.js          entry point: map, drawing tools, search, settings, persistence
  basemaps.js     OpenStreetMap layer + relief shading computed from elevation tiles
  terrain3d.js    3D terrain view (MapLibre GL, lazy-loaded)
  generator.js    runs model generation in a Web Worker (progress, cancel)
  worker.js       the Web Worker: loads geo/data/mesh/model and builds the model
  model.js        print area + settings → mesh layers (no DOM; runs in the worker)
  water.js        rasterised water mask: lake levels, rivers, shoreline points
  gpx.js          GPX parser (tracks + routes) and route simplification
  label.js        text → traced outlines for the raised label
  steps.js        stepped terrain: height rounding + contour point pairs
  threemf.js      3MF export (zip + model XML, coloured parts)
  mesh.js         terrain / water / building / road mesh builders
  data.js         elevation tiles + OpenStreetMap (Overpass) download
  geo.js          projection and 2D geometry helpers
  preview.js      three.js preview of the finished model
  stl.js          binary STL writer + download
  dom.js          $ / $$ shortcuts
```

## Data sources

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding). The same tiles drive the relief shading, the 3D view and the STL, so the relief you see is the relief you print.
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright) standard tiles, subject to the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Switch to a hosted provider before heavy use.
- Buildings, roads and water: OpenStreetMap through the Overpass API.

## Mesh size

The terrain mesh is adaptive. Cells start large and are split, worst first, where a flat surface would miss the real height by more than ~7% of the mesh spacing (about 0.05 mm at Standard). Splitting stops once the vertex count reaches what an even grid would use, so a model is never bigger than before. Flat ground (plains, lakes, terrace tops) gets a few large triangles, and the saved vertices go to the most detailed ground. Measured with `npm run test:e2e measure`:

| Area | Even grid | Adaptive |
|---|---|---|
| Netherlands polders (flat) | 93,728 triangles | 12,210 (13%) |
| Lake Thun, water on | 139,484 | 115,990 (83%) |
| Lake Thun, stepped | 207,890 | 148,052 (71%, with sparser contour pairs) |
| Bernese Alps (steep) | 93,728 | 92,500 (99%) |

Roads and buildings are simplified to what the model can show (0.05 mm). Road pieces are split only where the ground under them bends. Central Zurich at 3 km went from 38.2 MB to 20.4 MB this way (roads 391k → 173k triangles, buildings 360k → 206k). Models over 50 MB as STL get a warning with ways to shrink them, because some slicers freeze on very large files.

On a synthetic test landscape the adaptive mesh uses 44% fewer triangles with the same height error as the even grid (max 0.33 mm, average 0.034 mm; see `test/mesh.test.mjs`).

## Detail by scale

The map scale decides how much OpenStreetMap detail a model can show. A printed road is at least ~0.8 mm wide: at 1:500,000 that's a 400 m wide band.

| Scale | Roads | Buildings | Water |
|---|---|---|---|
| up to 1:50,000 | all | yes | all |
| to 1:75,000 | main + residential | yes | all |
| to 1:150,000 | main + residential | no | all |
| to 1:300,000 | motorway → secondary | no | lakes with an outline ≥ ~10 mm on the model |
| to 1:500,000 | motorway → secondary | no | same, without riverbank outlines (river lines stay) |
| beyond | motorways + trunk roads | no | same |

Left-out layers aren't downloaded, which keeps country-sized requests within what the free servers will answer. The area panel and the model notes say what was left out.

## GPX routes

**Import a GPX route…** in step 2, or drop a `.gpx` file on the map. Track segments and routes are read; waypoints are ignored. The route is drawn on the 2D map and in the 3D view, and the print area is fitted around it unless it's already inside one. In the model it becomes a raised strip that follows the terrain, as its own `*-route.stl` part. Width and height are under Advanced.

## Downloads

- **Download 3MF** (main button): one file with every part named and coloured, as one object (or one object per tile). Verified in PrusaSlicer 2.9.7: it opens as one object with each part as a named volume, kept in place and ready to give each a filament. Bambu Studio and OrcaSlicer descend from PrusaSlicer but haven't been tested. Cura reads only the standard 3MF layout, where each piece is a single mesh; use the single-part STLs there.
- **Download STL**: the whole model as one single-colour STL.
- **Parts / tiles list**: single-part STLs, and with tiles, one 3MF per tile.

The 3MF writer (`js/threemf.js`) needs no library: it builds the XML with shared vertices and writes the zip itself, compressing with the browser's `CompressionStream`. Each piece is one mesh with its parts stored back to back. `Metadata/Slic3r_PE_model.config` names each part's triangle range, the way PrusaSlicer stores multi-part objects. With plain 3MF components instead, PrusaSlicer splits the parts into separate objects and drops each onto the bed, so buildings and roads lose their place on the terrain.

## Tiles

**Split into tiles** (columns × rows, up to 6 × 6) cuts a model that is bigger than your print bed into pieces that fit together. The panel shows each tile's size as you change it. Each tile is built as its own set of watertight parts, from the print outline clipped to the tile. Tiles share one height scale and base, so they line up exactly. Buildings and road/route pieces that cross a seam are cut at it. The preview spreads the tiles slightly apart; downloaded files keep their real positions. Each tile downloads as one file, or part by part for multi-colour. With a label, the label plate is its own piece.

**Connector keys** (on by default when tiled) join neighbouring tiles. Each seam gets a bowtie key about every 50 mm. Both tiles have a half-dovetail pocket cut into their underside at the seam, wider inside than at the edge, so a key locks the tiles together and holds them in line. Print the *Connector keys* piece (keys are 0.15 mm smaller than the pockets and 0.2 mm thinner than they are deep), push one into each pair of pockets from below, and add a drop of glue. Pockets are only cut where at least 0.8 mm of model remains above them; a position under a lake moves along the seam, or is skipped with a note.

Freeform areas whose outline crosses a tile edge more than once can get an uneven edge on that tile (the app notes it). Concave buildings that a seam would break apart are left out of that tile.

## Label

Type a **Label on the base** (or click *Use place name*) to add a plate along the front edge of the model, with the text raised on it as its own `*-label.stl` part. The plate is part of the base. Text height scales with the model width, and long text is shrunk to fit. The text is drawn in a bold system font, traced into outlines (letter holes kept), and extruded, so any font or script the browser can draw works.

## Stepped terrain

Set **Terrain surface** to *Stepped* for flat terraces like stacked contour layers, with **Step height** in model millimetres. Heights are rounded down to whole steps, and mesh points are placed in pairs straddling each contour line, so every step edge is a near-vertical wall. The surface is still a single heightfield, so water, buildings, roads, routes and labels all work as usual. Expect about twice the triangles of the smooth surface.

## Water

With **Water** on, lakes, reservoirs, rivers and canals from OpenStreetMap become a separate part (`*-water.stl`) for multi-colour printing. Sea is included as well when "Flatten sea floor" is on.

- Lakes are flattened to one level (the median elevation over the lake). Rivers follow the terrain.
- The terrain under water is recessed by the **Water depth** setting, and the water part fills that recess exactly. The two parts meet with no gap or overlap, and each is watertight.
- Water features smaller than about 2 × 2 mm on the model are skipped. River lines are widened to stay printable.
- Sea is detected by elevation (at or below 0 m), so land below sea level, such as Dutch polders, also shows up as water.
