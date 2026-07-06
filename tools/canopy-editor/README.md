# Canopy Update Tool

The SAR-Preflight canopy layer comes from the [Meta/WRI Global Canopy Height (1 m)](https://registry.opendata.aws/dataforgood-fb-forests/)
dataset — a ~2020 snapshot. Logging and wildfire make it wrong exactly where SAR
crews care most: an area the app treats as 30 m timber may now be bare burn scar,
which corrupts vegetation-aware viewsheds.

This standalone tool fixes that. You compare the canopy raster against **recent
Sentinel-2 imagery** (10 m, ~5-day revisit) and **near-real-time GOES** fire
layers, draw polygons over logged/burned areas, clear or adjust the canopy there,
and export a corrected canopy that SAR-Preflight can consume.

It is deliberately separate from the PWA: raster editing wants Python
(rasterio/GDAL), and this is a pre-mission desk task, not a field task.

## Setup

```bash
cd tools/canopy-editor
python3 -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
python server.py                 # → http://127.0.0.1:8765/
```

Flags: `--port`, `--host`, `--max-aoi-km` (default 12 — memory guard),
`--upstream-proxy <cloudflare-worker-url>` (see Serve mode).

## Workflow

1. **AOI** — draw a rectangle (or paste `west,south,east,north`). The tool
   fetches the Meta canopy tiles covering it (windowed HTTP reads, no proxy
   needed outside a browser) and builds a mosaic at the native ~1 m resolution,
   grid-aligned to the source tiles. Cached in `cache/` — reopening the same
   area resumes the session, edits included.
2. **Scenes** — search Sentinel-2 L2A scenes (Element84 Earth Search, free, no
   account) by date range and cloud cover. Pick a post-event scene and flicker
   it against the canopy overlay: burn scars and clear-cuts are obvious where
   brown imagery sits under green canopy.
3. **Edits** — draw polygons in one of three modes:
   - **clear** — zero all canopy inside the polygon;
   - **clear non-vegetated (NDVI)** — zero only pixels whose *current* NDVI
     (from the selected scene) is below the threshold, so surviving green
     islands inside a rough burn polygon keep their heights. Tune the threshold
     with the NDVI mask overlay (default 0.4; sparse dry conifer can sit near
     0.3 — char, shadow, and water all read low);
   - **set height** — paint a constant height (regrowth, or a shadow estimate).
   Everything is a non-destructive op list: undo, delete any op, re-applied
   over the pristine original each time.
4. **Shadow height** — pick a scene, then draw a line from a tree's base along
   its shadow to the tip. Height = length × tan(sun elevation), using the
   scene's own sun geometry. The result reports its quantization uncertainty
   (±~10·tan(el) m at Sentinel-2's 10 m pixels — a sanity-check instrument, not
   a survey), warns when your line isn't anti-sun, and can pre-fill set-height
   mode. Without a scene, enter the image's UTC capture time and a built-in
   NOAA solar-position routine supplies the sun geometry (lower confidence).
   Automatic shadow detection was deliberately left out: at 10 m pixels it
   quantizes to ~6 m of height per pixel and confuses shadow with char, water,
   and terrain shading.
5. **Export** — writes `output/canopy_edited_<aoi>_<date>.tif`
   (EPSG:3857, Float32 metres, ~1 m, tiled+DEFLATE, NaN-free). Opens in
   QGIS/CalTopo, and is the file a future SAR-Preflight "load local canopy
   file" feature would read. Optionally also writes **per-quadkey tiles**
   in the exact Meta layout (`output/chm/<quadkey>.tif`).

## Serve mode — feed the PWA today, zero app changes

SAR-Preflight fetches canopy as `{data proxy URL}/chm/{quadkey}.tif`. This
server answers that exact route (CORS + Range): a patched tile from
`output/chm/` when you exported one, otherwise pass-through from Meta S3.

So after a per-quadkey export, paste `http://127.0.0.1:8765` into the PWA's
**Config → Data proxy URL** and reload the vegetation layer — your edits appear
in the app's canopy overlay and viewsheds immediately.

The PWA uses that same base URL for its other worker routes (`/tfr`, `/notam`,
`/adsb`, `/usfs`, `/blm`). Start with
`--upstream-proxy https://your-worker.example.workers.dev` to forward those to
your deployed `tools/canopy-proxy` worker; without it they 404 and the PWA
degrades gracefully.

**Heads-up:** per-quadkey export downloads each touched source tile once
(~0.3–1 GB per tile, cached in `cache/tiles/`) and rewrites it with your edits —
expect several minutes per tile. The single-mosaic export is instant and is the
right choice unless you specifically want the PWA serve-mode path.

## Data sources

| Layer | Source | Notes |
|---|---|---|
| Canopy height | Meta/WRI 1 m COGs on public S3 | quadkey z9 tiles, EPSG:3857; transient 5xx on cold reads are retried like the PWA does |
| Recent optical | Sentinel-2 L2A via [Earth Search](https://earth-search.aws.element84.com/v1) STAC + COGs on AWS | free, no auth; scene-level cloud % is tile-wide, so try several scenes |
| Live fire context | NOAA GOES East/West via [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) WMTS | GeoColor + fire-temperature, ~10 min cadence. 0.5–2 km resolution: shows *that* a fire burns, never *where* to edit — use a post-event Sentinel-2 pass for that |
| Basemap | Esri World_Imagery | same as the main app |

## Accuracy caveats

- NDVI thresholding is a blunt instrument; if it proves noisy on burn scars,
  dNBR from `swir22` (20 m) is the better severity metric — a candidate v2.
- Fresh burns may lack a cloud-free Sentinel-2 pass for weeks.
- Shadow heights assume flat terrain and quantize with the 10 m pixel grid.
- Meta canopy itself is model output (±3–5 m typical) — clearing stale trees
  matters more than centimetre precision.

## Development

```bash
python -m pytest test_quadkeys.py   # parity with sar-preflight-raster.js fixtures
```

`quadkeys.py` is a straight port of the quadkey/mercator math in
`../../sar-preflight-raster.js` — keep them in sync.
