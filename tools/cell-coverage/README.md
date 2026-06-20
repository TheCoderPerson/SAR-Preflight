# Cell-coverage bundle (FCC mobile LTE)

The app shows per-carrier (AT&T / T-Mobile / Verizon) LTE coverage as toggleable map
layers and uses it to sharpen the cell-service readout (and to flag an operating area
with **no** mapped coverage). FCC mobile coverage has **no free live API or tile
service** — it is published only as bulk per-state / per-provider downloads — so this is
a **one-time build step** (re-run ~2×/year when the FCC refreshes the data, like
re-deploying the data proxy).

Until you run it, the cell-coverage layers simply don't appear and the app falls back to
its elevation-based cell estimate. **No coverage data ships in the repo** (a safety tool
should never show fake coverage).

## What you get

`data/cell/att.geojson`, `tmobile.geojson`, `verizon.geojson` — compact dissolved coverage
polygons (~40–150 KB gzipped each), clipped to your operating region, granularity ~1,000 ft
(FCC H3 resolution 9 — the same dataset CalTopo's cell layer uses).

## Combining 4G + 5G

The FCC publishes mobile coverage **per technology** (4G LTE and 5G-NR) as separate
downloads. The app shows one "cell service" layer per carrier where a point counts as
covered if **either** technology reaches it. You get that union automatically: just drop
**both** files into `input/` named for the carrier — `att_4g.geojson` **and**
`att_5g.geojson` — and the builder merges every `att*.geojson` into `att.geojson`. (A
single `att.geojson` also works if you only want one technology, or pre-merged both.)

## Steps

1. **Download** FCC BDC mobile availability for your state and carriers:
   <https://broadbandmap.fcc.gov/data-download> → *Mobile* → **4G LTE** *and* **5G-NR** →
   each provider/state. You get a GeoPackage/Shapefile of H3 res-9 hexagons (and/or raw
   propagation polygons) per technology.

2. **Convert to GeoJSON** and drop into `tools/cell-coverage/input/`, one file per
   carrier+technology (mapshaper, no install needed via `npx`):

   ```bash
   npx mapshaper att_lte.gpkg     -dissolve2 -o tools/cell-coverage/input/att_4g.geojson
   npx mapshaper att_5g.gpkg      -dissolve2 -o tools/cell-coverage/input/att_5g.geojson
   npx mapshaper tmobile_lte.gpkg -dissolve2 -o tools/cell-coverage/input/tmobile_4g.geojson
   npx mapshaper tmobile_5g.gpkg  -dissolve2 -o tools/cell-coverage/input/tmobile_5g.geojson
   npx mapshaper verizon_lte.gpkg -dissolve2 -o tools/cell-coverage/input/verizon_4g.geojson
   npx mapshaper verizon_5g.gpkg  -dissolve2 -o tools/cell-coverage/input/verizon_5g.geojson
   ```

   `-dissolve2` unions the hexagons into coverage boundaries (the biggest size win). You can
   also merge a carrier's two technologies into one dissolved file yourself if you prefer:
   `npx mapshaper att_lte.gpkg att_5g.gpkg combine-files -merge-layers force -dissolve2 -o input/att.geojson`.
   (FCC *raw propagation modeled* polygons are already dissolved — just convert and drop in.)

3. **Finalize** — merge per carrier (4G + 5G), clip to your region, simplify, quantize,
   strip attributes:

   ```bash
   node tools/cell-coverage/build.mjs
   # custom region (south,west,north,east):
   node tools/cell-coverage/build.mjs --region=38.0,-121.7,39.7,-119.6
   ```

   The default region covers El Dorado / Placer + neighboring CA counties. Outputs land in
   `data/cell/{att,tmobile,verizon}.geojson`, which the app loads at startup. Each file's
   `metadata.inputs` records which technology files went into it.

4. **Commit** the three `data/cell/*.geojson` files (or deploy them alongside the app).

## Notes

- Granularity is ~1,000 ft hexagons — the FCC's native mobile resolution. It is *modeled*
  coverage; real-world signal varies with device, terrain, and congestion. Treat as advisory.
- `input/` is a scratch directory for the dissolved-but-unprocessed GeoJSON; it is not loaded
  by the app and need not be committed.
