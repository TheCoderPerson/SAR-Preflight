# Changelog

All notable changes to the SAR UAS Pre-Flight Intelligence Tool, newest first.

> Generated from `CHANGELOG_ENTRIES` in `sar-preflight-core.js` by `build.js` — edit there, not here.

## v2026.07.17-b — 2026-07-17

- Streets/Labels overlay: road lines now stay visible when zoomed in close. The Esri street tiles stop drawing road geometry past zoom 15 (labels only), so the app now upscales the zoom-15 tiles at closer zooms — lines and names get slightly softer the further you zoom, but the road vector no longer disappears.

## v2026.07.17 — 2026-07-17

- New "Streets / Labels" map overlay: transparent street lines with road names plus town/place labels (Esri hybrid reference tiles), designed to drape over the Satellite base layer — but it works over any base. Toggle it in the layer list right under the base layers; it can also be pre-downloaded for offline use in Config → Offline Tiles.
- New "Named Trails (OSM)" layer: named hiking trails, footpaths, 4WD tracks, bridleways and cycleways from OpenStreetMap for the drawn operational area, shown as pink dashed lines. Tap a trail for its name, type, surface and difficulty (SAC scale). Unlike the NFS/MVUM layers this covers all land ownership, is cached for offline use, and IS included in the CalTopo/KML export (as a "Named Trail (OSM)" folder).
- A "Named Trails (OSM)" section on the Terrain tab shows the trail count with the standard freshness row and UPDATE button.

## v2026.06.20-j — 2026-06-20

- The 24-hour timeline now drives the entire data panel, not just the sun & wind arrows: drag it and the weather, wind-by-altitude profile, ops/battery estimates, GNSS outlook and the overall GO/CAUTION/NO-GO all update to the selected forecast hour, so you can scrub to find the best launch window. A "FORECAST +Xh" banner makes clear when you are viewing a future hour, and notes that airspace, TFRs, fire and live traffic remain current-time.
- Weather radar now uses the traditional NWS color scale (green → yellow → orange → red → magenta, with blue for snow) instead of the previous blue-heavy palette, so heavy rain no longer shows as blue.
- CalTopo export now includes the LAANC ceiling grid (even when it is hidden on the map) and disclaimer-flagged emergency-LZ terrain estimates.
- CalTopo export no longer includes layers CalTopo already provides natively and that would be stale by the time the file is imported: ADS-B aircraft, MVUM roads & trails, USFS trails, cell coverage & towers, land ownership, dams and parcels. These layers still appear and remain clickable on the map.

## v2026.06.20-i — 2026-06-20

- Aircraft profiles are now built in: pick your drone (DJI Matrice 300/350 RTK, 30T, 4T, 4TD, Mavic 3T, Skydio X10, Neo, Avata/Avata 2, Mini 3/4/5 Pro and more) in Config → Aircraft & SOP Profile and every threshold — max wind, flight time, service ceiling, and operating-temperature limits — is set from that airframe's published specs. Wind NO-GO uses the rated max wind resistance with a CAUTION at ~65% of it.
- The old separate "Aircraft Profile" section is merged into the profile picker, so loading a profile sets the aircraft AND all risk thresholds at once. Editing any value recalculates the GO/CAUTION/NO-GO assessment live; "Save Profile" stores your own custom set.
- Many more Part 107 / safety thresholds are now editable: gust margin, hot & cold temperature limits, density altitude (caution & NO-GO), the Part 107 400 ft AGL ceiling, service-ceiling proximity, Kp geomagnetic index, air-quality (AQI) caution & NO-GO, and active-fire caution/NO-GO distances.
- New automatic flags: out-of-spec heat or cold for the selected aircraft, high density altitude, launching near/above the aircraft's service ceiling, elevated Kp (GNSS degradation), and hazardous air quality / wildfire smoke.

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
