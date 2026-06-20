# data/cell/

The app loads per-carrier FCC mobile LTE coverage from this directory:

- `att.geojson`
- `tmobile.geojson`
- `verizon.geojson`

These files are **generated** by `tools/cell-coverage/build.mjs` from FCC Broadband Data
Collection downloads — see `tools/cell-coverage/README.md`. They are intentionally **not**
checked in by default (a safety tool should not ship stale/placeholder coverage). When the
files are absent, the cell-coverage layers don't appear and the app uses its elevation-based
cell estimate. Regenerate ~2×/year when the FCC refreshes the data.
