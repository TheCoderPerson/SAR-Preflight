# Changelog

All notable changes to the SAR UAS Pre-Flight Intelligence Tool, newest first.

> Generated from `CHANGELOG_ENTRIES` in `sar-preflight-core.js` by `build.js` — edit there, not here.

## v2026.07.17-i — 2026-07-17

- Wording cleanup: the built-in data proxy and the PDF briefing header are now described generically (no team-specific naming).

## v2026.07.17-h — 2026-07-17

- Works out of the box — no proxy setup needed: the app now ships with a built-in default data proxy, so the vegetation overlay, viewshed canopy, live TFRs/NOTAMs, ADS-B proxy route, and USFS/BLM layers work immediately without deploying your own Cloudflare Worker. Entering your own Worker URL in Config still overrides the default (needed for forks hosted on other origins); clearing the field returns to the built-in proxy.
- If the shared proxy briefly rate-limits heavy use, an amber "⚠ PROXY LIMIT" indicator now appears in the header status bar (hover it for details) and clears automatically after about a minute — affected fetches can be retried with REFRESH.

## v2026.07.17-g — 2026-07-17

- 3D view phase 3 — vertical hazards and live traffic: FAA obstacles, towers, and dams with known heights now rise from the terrain as bold vertical height lines at their true AGL height (colored by the same hazard scale as their 2D markers). Live ADS-B aircraft appear in 3D at their actual altitude above the terrain — each plane is an X marker at its AGL altitude with a thin drop line to the ground so you can judge its height and position at a glance — updating with every 5-second traffic poll, with a clickable ground dot for the full aircraft popup. The weather radar layer now also drapes in 3D (current frame, follows the frame stepper).

## v2026.07.17-f — 2026-07-17

- Fixed: viewshed and canopy overlays rendered wrong in the 3D view — large chunks were sliced off along straight tile-boundary lines (the 2D view was always correct). Cause was a terrain-draping bug in the 3D engine version the app was loading; upgrading the engine (MapLibre GL 4.7.1 → 5.24.0) fixes it. Overlays now drape completely and match the 2D view exactly.

## v2026.07.17-e — 2026-07-17

- 3D view phase 2 — data overlays now appear in 3D: TFRs, NOTAMs, airspace, LAANC, obstacles, wires, power lines, towers, airports, NWS alerts, fire perimeters, trails, water, hospitals/LZs, land status, observers, and the drawn ops area all drape onto the 3D terrain with their 2D colors. Clicking features in 3D opens the same paginated multi-feature popup as the 2D map. Icon markers (airports, towers, etc.) render as colored dots in 3D for now; live aircraft and radar remain 2D-only until phase 3.
- Update reliability fix: installing an app update could silently keep stale copies of the app files if the browser's HTTP cache still held them (the update banner would show the new version but old code kept running). The service worker now bypasses the HTTP cache when downloading an update, so "Reload & Update" always installs the code it says it does.

## v2026.07.17-d — 2026-07-17

- New 3D terrain view: the "⛰ 3D" button (under the theme toggle) switches the map to a tilt-and-rotate 3D view with real terrain relief. Whatever imagery the 2D map is showing — satellite, topo, FAA sectional, hillshade, parcels, streets, and the canopy/viewshed overlays — drapes over the terrain, and the camera position carries over when switching between 2D and 3D. Data overlays (TFRs, wires, airports, etc.) and the drawing tools remain 2D for now; starting a draw or viewshed pick automatically returns to 2D. The 3D engine loads on first use and needs an internet connection.

## v2026.07.17-c — 2026-07-17

- New "Update Available" modal: when the app discovers a newly deployed version (on load, when returning to the app, or via Config → Check for Updates), a modal now pops up showing exactly what changed in the update, with a "Reload & Update" button and a "Later" option. Dismissing it keeps the small update banner at the top as a reminder, so updates are never missed but never forced.

## v2026.07.17-b — 2026-07-17

- Streets/Labels overlay: road lines now stay visible when zoomed in close. The Esri street tiles stop drawing road geometry past zoom 15 (labels only), so the app now upscales the zoom-15 tiles at closer zooms — lines and names get slightly softer the further you zoom, but the road vector no longer disappears.

## v2026.07.17 — 2026-07-17

- New "Streets / Labels" map overlay: transparent street lines with road names plus town/place labels (Esri hybrid reference tiles), designed to drape over the Satellite base layer — but it works over any base. Toggle it in the layer list right under the base layers; it can also be pre-downloaded for offline use in Config → Offline Tiles.
- New "Named Trails (OSM)" layer: named hiking trails, footpaths, 4WD tracks, bridleways and cycleways from OpenStreetMap for the drawn operational area, shown as pink dashed lines. Tap a trail for its name, type, surface and difficulty (SAC scale). Unlike the NFS/MVUM layers this covers all land ownership, is cached for offline use, and IS included in the CalTopo/KML export (as a "Named Trail (OSM)" folder).
- A "Named Trails (OSM)" section on the Terrain tab shows the trail count with the standard freshness row and UPDATE button.

## v2026.07.13-g — 2026-07-13

- Vegetation Height and Viewshed overlays no longer reappear after zooming when their Map Layers checkbox is off: unchecking them in the layer control now clears the internal “overlay wanted” flag that the zoom handler (which re-attaches overlays after the mobile display-size cap) was still honoring. Re-checking them also goes through that size cap, so the mobile memory protection still applies.

## v2026.07.13-f — 2026-07-13

- Lightning layer fixed and renamed: the Weather Imagery lightning layer now requests the correct NOAA nowCOAST GeoServer layer (lightning_detection:ldn_lightning_strike_density) — the previous endpoint returned errors, so the layer always rendered blank. Renamed from “Lightning (GOES GLM)” to “Lightning strike density (NOAA)”: the nowCOAST product is 15-minute strike density from ground-based lightning detection networks, not GOES GLM satellite data.
- GOES GeoColor cloud layer fixed: the WMS request no longer computes a “now minus 30 minutes” TIME value — GIBS ingest lag regularly exceeds that buffer (2+ hours observed), which made every tile come back blank. TIME is now omitted so GIBS always serves its latest available frame.
- NWS alert details: alert cards now show the full hazard description (wind gusts, hail size, flooding, etc.) and safety instructions instead of only the one-line headline, and map polygon popups include the description too — a Special Weather Statement now tells you what the weather actually is.
- GOES Clouds layer now shows its frame time and age (e.g. “frame 22:40Z (2h 05m old)”) in the Map Layers control, refreshed each time the layer is enabled, so users know how current the satellite imagery actually is.
- Aviation weather source switched to NWS api.weather.gov station observations: aviationweather.gov’s API does not allow cross-origin browser requests, so the METAR fetch always failed with a NetworkError and the Flight Category / cloud-ceiling readout never populated. The app now resolves the nearest reporting stations via api.weather.gov (CORS-enabled, includes the raw METAR) and skips automated stations that report no ceiling or visibility.
- SNODAS snow-depth layer fixed: the WMS request asked for sublayer 3 (a boundary outline) instead of sublayer 5 (the snow-depth image), and used EPSG:3857 coordinates the NOHRSC ArcGIS server does not support — both meant the layer never showed snow. Now requests sublayer 5 in EPSG:4326.
- Fire danger nationwide: outside California the fire-danger card now pulls NFDRS from the nearest RAWS station via the USDA FEMS API (current ERC/BI and fuel moistures, with percentile colors computed against that station’s own climatological thresholds). Previously the danger indices only populated inside California (CA_NFDRS); active-fire perimeters were already nationwide.

## v2026.07.03-b — 2026-07-03

- New GOES-East GeoColor cloud layer (Map Layers → Weather Imagery): near-real-time geostationary satellite imagery (true-color by day, IR at night) via NASA GIBS — see cloud decks and storm systems approaching your area, complementing the precipitation radar.
- New GOES GLM lightning layer (Map Layers → Weather Imagery): near-real-time lightning strike density from NOAA nowCOAST for at-a-glance thunderstorm situational awareness. Both new imagery layers are off by default.

## v2026.07.03-a — 2026-07-03

- New Flight Category & cloud ceiling: the Weather tab now shows the observed ceiling and VFR/MVFR/IFR/LIFR flight category from the nearest reporting station (FAA aviationweather.gov METAR), and a Part 107 §107.51(c) cloud-clearance gate flags CAUTION/NO-GO when the ceiling can't keep you 500 ft below clouds or visibility is below the 3 sm minimum. The required cloud clearance is an editable threshold (Config → Weather).
- New Freezing Level readout (Open-Meteo 0 °C isotherm): flags a CAUTION for icing aloft when the freezing level sits within your flight envelope (launch elevation up to launch + max AGL).
- New NOAA HMS wildfire-smoke layer: toggle current-day satellite smoke plumes (Light / Medium / Heavy) under Map Layers → Smoke. A Medium/Heavy plume over your area raises a reduced-visibility/VLOS CAUTION.
- New optional Winter Ops layer group: avalanche danger zones (avalanche.org, danger 1–5 with active-warning flags) and NOHRSC SNODAS snow-depth. A Considerable-or-higher danger level or warning over the launch point raises a ground-team-hazard CAUTION. Both layers are off by default.

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
