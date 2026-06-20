# Changelog

All notable changes to the SAR UAS Pre-Flight Intelligence Tool, newest first.

> Generated from `CHANGELOG_ENTRIES` in `sar-preflight-core.js` by `build.js` — edit there, not here.

## v2026.06.20-h — 2026-06-20

- Added privacy-first anonymous usage analytics (Cloudflare Web Analytics) so the team can gauge how often the tool is used. It is cookieless and country-level only: nothing from your map (GPS, drawn operational area, observer/viewshed coordinates) is ever sent, no precise location or IP is stored, and analytics never run offline or in the single-file field build. Browser Do-Not-Track / Global Privacy Control is honored, and you can opt out anytime in Config → Privacy.

## v2026.06.20-g — 2026-06-20

- Each new data source (Ground Access, Land Ownership, Water, Hospitals & LZs) now has its own section in the Terrain tab showing when it was last updated and an UPDATE button to refresh just that source — matching the other data items.

## v2026.06.20-f — 2026-06-20

- New map overlays for mission planning: forest roads, trails & Motor Vehicle Use Map (MVUM) routes, BLM routes, public-land ownership, water (streams & lakes), hospitals & helicopter landing zones, terrain hillshade, parcel boundaries, and per-carrier cell coverage.
- New CAUTION when part of your operating area is on private / non-public land (verify landowner permission) — based on the BLM Surface Management Agency layer.
- Per-carrier (AT&T / T-Mobile / Verizon) FCC LTE/5G cell coverage now drives the cell-service readout and a "no coverage" caution. Requires a one-time data build (see tools/cell-coverage) and ships with no data by default.
- Added "Cache Data for Current View" to pre-download all data layers (plus optional terrain DEM & vegetation) for offline use; cache status now shows storage used vs. quota, and Hillshade/Parcels were added to the map-tile download.
- Removed the unused "Optional API keys" field from Config (live NOTAMs/TFRs use the data proxy).
- Forest-service & BLM layers load through the data proxy — redeploy your Cloudflare Worker (tools/canopy-proxy) to enable them.

## v2026.06.20-e — 2026-06-20

- Added a "setup guide" link in Config → Data Sources → Data proxy URL that opens step-by-step instructions and code on GitHub for deploying your own free Cloudflare Worker data proxy.

## v2026.06.20-d — 2026-06-20

- Added an in-app changelog: a "What's New" dialog now appears the first time you open the app after an update, with a link to the full changelog on GitHub.
- Fixed "Check for Updates" so it accurately detects a newer version and prompts you to reload, instead of always reporting "up to date".

## v2026.06.20-c — 2026-06-20

- Moved the diagnostics report from an automatic popup to a "View Diagnostics Report" button in Config → App Version.

## v2026.06.20-b — 2026-06-20

- Removed the Flight Plan Suggestion and Other Aircraft sections from the Ops tab.
- Removed the Training Mode and Audit Trail sections from the Config tab.
