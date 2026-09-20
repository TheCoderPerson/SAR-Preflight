# NAIP-CHM lookup index builder

The app's optional **NAIP-CHM** canopy/structure height source ([Morford et al.
2026](https://doi.org/10.1038/s41597-026-07549-w), Univ. of Montana NTSG, MIT) is
one Cloud-Optimized GeoTIFF per NAIP quarter-quad, stored on
`https://rangeland.ntsg.umt.edu/data/naip-chm/` as

```
{year}/{utmZone}/m_{quad7}{qq}_{zone}_{res}_{date}[_{date2}]_chm.tif
```

The quarter-quad footprint follows from lat/lng (USGS 7.5′ quad numbering), but
the year, UTM zone, resolution code and acquisition date(s) in the filename do
not — only the dataset's **256 MB `index.csv`** knows them. `build.mjs` streams
that CSV once and writes small per-1°-block JSON files the app fetches lazily
(one to four per canopy load):

```
data/naipchm/38120.json   →  {"v":1,"e":{"01ne":"2022/10_060_20220721", "17sw":"2022/10_060_20220709", …}}
data/naipchm/manifest.json
```

* block = first five digits of `quad_id` (`38120` = lat [38, 39) × lon [−121, −120))
* key = two-digit quad index + quarter (`17sw`)
* value = `year/` + the filename tail after `m_{quad}{qq}_` (zone_res_date[_date2], verbatim);
  the app rebuilds `{year}/{zone}/m_{quad}{qq}_{tail}_chm.tif`

Full CONUS is about 942 files / 9 MB on disk (≈ 7.7 KB per block, gzipped over the
wire). ~850 Florida quarter-quads exist in two years (a 2021/22 60 cm and a 2023
30 cm run); the newer year wins.

## Rebuild

```bash
node tools/naip-chm-index/build.mjs                       # streams index.csv from the server (~30 s)
node tools/naip-chm-index/build.mjs --input index.csv     # from a local copy
node tools/naip-chm-index/build.mjs --bbox -125,32,-114,42  # subset (west,south,east,north)
```

Stdlib only (Node ≥ 18). Re-run only when the dataset publishes new or replaced
quads (see the server's `README` changelog); commit the regenerated
`data/naipchm/` files. Unit tests: `tests/unit/naipChmIndexTool.test.js`.
