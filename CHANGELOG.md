# Changelog

All notable changes to the SAR UAS Pre-Flight Intelligence Tool, newest first.

> Generated from `CHANGELOG_ENTRIES` in `sar-preflight-core.js` by `build.js` — edit there, not here.

## v2026.08.01-d — 2026-08-01

- Fixed vegetation data failing with "NO DATA" over some areas even though the data was there. Reproduced over a Contra Costa search area: the tile existed, the server was healthy, every byte of it downloaded correctly — but the reader we use was configured with a block size too small for how these files are laid out, and it gave up part-way through. That area now loads normally.
- When vegetation tiles do fail, the app now tells you WHY instead of just "no data". The underlying error was being discarded, so a missing tile, a blocked request and a decoder fault all looked identical — which is exactly what made this one hard to pin down.

## v2026.08.01-c — 2026-08-01

- Fixed a hang when the vegetation layer was switched on while zoomed well out. The app would sit on "Fetching..." forever and the tab could stop responding. It now says ZOOM IN straight away, the same as it already did on phones — the wide view was asking for tens of billions of pixels across a dozen source tiles.
- Vegetation data now loads in bounded chunks on desktop as well as on phones, so the map stays usable while it works instead of locking up for seconds at a time. Peak memory during a load is capped at about 27 MB.
- Long operations no longer waste time waiting when the app is in a background tab, which could add a second per step for no benefit.
- Fixed a test that quietly depended on the calendar month and had gone red for August; it now covers nesting season, autumn migration and winter explicitly.

## v2026.08.01-b — 2026-08-01

- VEG ADD now fills dense forest. It was doing the opposite of what it should: painting sunlit grass and road verges while leaving thick canopy — the very places missing canopy data — untouched. On a dense stand it now covers 99% of the area instead of 50%.
- The reason: a cell had to be bright enough to judge by colour, and dense conifer canopy is mostly deep shadow. Measurement showed 84% of those rejected cells had no lit pixel at all, so no colour rule could ever rescue them. A dark area ringed by treetops is that canopy’s own shadow, and is now treated as trees. Dark ground out in the open, with no canopy around it, is still left alone.
- Turning the slider to maximum used to paint dry grass, because the bottom of its range sat just below grass’s score. The range now stops above grass, bare dirt and asphalt, so the top of the slider reaches for marginal vegetation rather than bare ground.
- Added a colour key under the preview. The amber checkerboard means "too dark to judge, left alone" — it is easily misread as "trees found", which is nearly its opposite.
- Cells reclaimed as canopy shadow no longer count in the "skipped" total, so that number now reflects what the tool genuinely could not judge.

## v2026.08.01-a — 2026-08-01

- VEG CUT now actually clears open ground. Field testing over a scattered-conifer meadow showed it clearing well under a tenth of the ground that was obviously treeless; on the same area it now clears about 98% of it. Dense forest still barely cuts at all, which is correct.
- The cause was a 6 m protective margin drawn around every tree AND every tree shadow. Where trees stand 15-20 m apart those margins merged and covered the whole meadow, throwing away roughly 80% of valid clearing. Shadows are already protected in their own right, so that margin is now off by default.
- Clearing also required every last sub-cell under a map cell to look bare before it would touch it, so the ground actually cleared was much smaller than the area you reviewed and approved. It now goes by majority, which tracks what you saw in the preview.
- The SENSITIVITY slider was working backwards when cutting — dragging it to maximum protected more and cut less. Higher now always means "do more of this", and the centre of the slider is the tuned default for both adding and cutting.
- Edits you already saved keep the behaviour they were saved with; these changes only affect new ones.

## v2026.07.31-a — 2026-07-31

- Canopy EDIT has a new VEG tool: draw an area and the app reads the satellite imagery underneath it, works out which pixels are trees, and shows you the result before anything is changed. ADD paints canopy at a height you enter wherever the imagery is green; CUT clears canopy wherever it is not. Meant for fixing a stale canopy map — a clearcut, a burn scar, a new subdivision, trees that have grown in — without brushing it by hand.
- Nothing is applied until you approve it. The candidate cells are drawn over the map (cyan to add, red to cut) and a SENSITIVITY slider re-classifies instantly, with no further downloads, so you can tune it against what you can see. CUT also asks for confirmation, because removing trees makes the viewshed predict MORE visibility than really exists.
- Cells the tool could not judge — deep shadow, or a gap in the imagery — are shown as an amber checkerboard and are never painted and never cleared. Tree shadows in particular are dark, not green, so treating them as "no trees" would have eaten the shaded edges of real stands.
- ADD only fills gaps: a cell that already carries a measured height from the vegetation data keeps it, and no edit ever makes a stand shorter than it was.
- Read the caveat on the toolbar before trusting a result. The imagery is a mosaic of unknown date and may be OLDER than the canopy data; lawns, brush and crops all score green; and tall trees on slopes lean away from their trunks in the imagery. Treat VEG as a fast first pass, then correct it with BRUSH and POLY.
- VEG edits save, persist and replay onto viewsheds like every other canopy edit — recompute a viewshed to see the effect.
- Fixed: switching away from the app while a viewshed was computing could leave it stuck at a frozen percentage forever, needing a reload. Long computations now keep running in the background.

## v2026.07.30-a — 2026-07-30

- The Enter Coordinates button is now Go To: the same box still takes coordinates (DD / DDM / DMS / UTM), but you can also type a place name ("Jenkinson Lake", "Pyramid Peak", "Desolation Wilderness") or a street address and the map goes there. It opens a proper dialog instead of the old browser prompt.
- When a name matches more than one place — there are several Mount Baldys in California and Nevada — every match is listed with its type, county and state, and how far it is from you, closest first. Distances are measured from your device GPS when the app already has a fix, otherwise from the map center; searching never triggers a location permission prompt of its own.
- Places with a real extent (a lake, a wilderness area) zoom to fit that area rather than a fixed zoom. Selecting a result only moves the map — tick "Create op area" in the dialog if you want it to build the operational area and run the full pre-flight instead.
- Coordinates are still resolved entirely on-device: typing a coordinate makes no network request and works offline exactly as before. Searches are cached for 30 days, so a place you looked up at base can be found again in the field with no signal (flagged as cached, with its age).
- Search results always show the full matched name, and if you type a street number that could not be matched exactly the app says so rather than silently dropping a pin on the nearest road. Place search is powered by OpenStreetMap / Nominatim.

## v2026.07.29-a — 2026-07-29

- Vegetation Height and Sun Shadow now switch on and off from the Map Layers panel (under Analysis) like every other overlay — their Terrain-tab checkboxes are gone. Both rows are always listed, so an overlay you turned off can be turned back on from the same place. The Terrain tab keeps the opacity sliders, Refresh-for-view and the canopy EDIT link, and the two opacity sliders for each overlay now stay in step.
- Map Layers categories collapse: tap a heading (FACILITIES, TRAFFIC, WIRE HAZARDS, …) to fold that category away. Collapsed sections are remembered between sessions — useful on a phone now that the panel runs to 22 categories.
- New PLANS button in the header: a pre-mission declutter that switches off and collapses Radar, Traffic, Operations and Smoke. It stays on until you press it again, so a background data refresh will not quietly put the radar back — but re-checking any layer by hand still sticks.
- Placing a viewshed observer now draws a dashed VLOS range ring that follows the cursor, so you can see how far the range actually reaches before committing to a spot. Every placed observer keeps a ring at its own stored VLOS range (visible on touch devices too), and the rings hide with the Observers layer.
- Fixed: clearing the operational area left the sun shadow overlay stranded on the map, where scrubbing the time bar no longer updated it.

## v2026.07.23-b — 2026-07-23

- Two new California wire-hazard layers from authoritative utility GIS: PG&E Distribution Circuits (yellow) — real primary-distribution feeder routing from PG&E's GRIP/ICA public portal, the rural pole lines OpenStreetMap rarely has — and CA Transmission (CEC, red) — the California Energy Commission's transmission layer (voltage, owner, overhead/underground), far fresher than the retired federal HIFLD data. Both load automatically for op areas in their coverage; outside it (Tahoe basin, Roseville, out of state) nothing changes and the existing OSM wire layers remain the source everywhere.
- Limits, stated in every popup: PG&E feeders carry no overhead-vs-underground flag and never include service drops to individual buildings, so treat every mapped line as an overhead hazard — and never treat the absence of lines as the absence of wires. Utility circuits cache for offline reuse (30 days) and count toward the wire totals in the briefing and mission log.

## v2026.07.23-a — 2026-07-23

- The app now opens offline: the service worker previously refused to answer page-load (navigation) requests, so launching the installed PWA without connectivity failed with "not connected to the internet" even though everything was cached. Navigations are now served cache-first with an offline fallback to the cached app shell.
- Install is more resilient: a single failed CDN download no longer aborts the entire first-visit precache (which previously left NOTHING cached), and the app fonts are now precached for offline use.
- Enter Coordinates has a new map-waypoint (pin) icon; its old crosshair icon now lives on a new toolbar button that centers the map on the device's current GPS location.

## v2026.07.20-f — 2026-07-20

- Land Ownership works again: BLM's upgraded server began rejecting the app's surface-management query outright (every fetch errored with "no data"). The query now requests server-side generalized polygons (~110 m simplification — the advisory public/private percentage and map shading are unaffected), which the server accepts.
- The Parcels layer is now real parcel DATA, not just boundary lines: the ReGrid tile overlay is replaced by a live vector layer that taps El Dorado County GIS where available (APN, situs address, acreage, land use, year built, jurisdiction, fire district) and falls back to the CA statewide assessor layer (LightBox via DWR — APN + address only, quarterly) everywhere else in California. Tap any parcel for its details in the aggregated popup.
- Parcels are planning intelligence, NOT survey data: a one-time disclaimer on first enable, a permanent "not survey accurate" line in every parcel popup, and a persistent provenance chip over the map showing which source is live, cache age when offline, and truncation when a view is too big. If parcel data cannot be loaded at all the chip says so explicitly — never interpret an empty parcel layer as public land.
- Parcels load for the current view at zoom 15+ (the chip says "zoom in" below that), refetch as you pan, cache to IndexedDB for 90 days for offline reuse, and stay out of KML/GeoJSON exports. Neither source publishes owner names. Owner notification workflows, offline area staging, and more Tier-1 counties are future work.

## v2026.07.20-e — 2026-07-20

- Viewsheds now export as vector polygons inside the KML/GeoJSON file itself (new "Viewshed Polygons" folder, on by default in the export dialog) — real geometry CalTopo and Google Earth treat like any drawn shape, alongside the existing GeoTIFF/KMZ rasters. Each computed observer contributes simplified low-poly outlines of its visible regions (holes included); tiny fragments and holes are dropped and parts are capped, so the raster export remains the authoritative representation.

## v2026.07.20-d — 2026-07-20

- Observer popups now carry two visual-observation advisories: today's sun-glare windows (with a bearing range, e.g. "06:10–08:40 brg 050°–115°" — looking that way then means tracking the drone in/near the sun's glare), and terrain-backdrop sectors (compass directions where the drone would appear below the terrain/canopy skyline instead of against open sky). The glare sun-elevation cutoff is derived from each observer's AGL + VLOS (the band the drone actually occupies over ~90% of the flight area, plus a 15° glare cone) instead of a fixed angle; near-overhead passes can glare any time the sun is up, and the popup says so.
- Glare windows are terrain-aware: a bare-earth horizon profile out to ~10 km around each observer masks times when a ridge actually hides the sun (a mountain on the sunrise bearing delays the morning window until the sun clears it). When terrain shields the low sun entirely — a deep canyon or cirque — the popup says so explicitly instead of staying silent. Trees are not in the horizon, so glare can be over-reported near cover — never silently under-reported.
- Terrain-backdrop sectors count only drone positions the observer can actually SEE (hidden positions are a coverage problem, not a backdrop problem), and the skyline behind them now extends past the VLOS grid using the same ~10 km horizon — a mountainside rising beyond VLOS backdrops the drone correctly.
- Both advisories also ride along in the KML/GeoJSON (CalTopo) observer placemark descriptions, with glare computed for the export day. Backdrop sectors use the same terrain+canopy+buildings surface as the viewshed and are computed per observer — recompute existing observers to add them; backdrop skyline is only assessed out to the VLOS range.
- The briefing (Copy / PDF / Email) gains an OBSERVERS section: each observer's position, AGL/VLOS profile, viewshed coverage, and the sun-glare + terrain-backdrop advisories.

## v2026.07.20-c — 2026-07-20

- The "Enter Coordinates" tool now accepts DD (38.78673, -120.61770), DDM (38°47.204', -120°37.062'), DMS (38°47'12", -120°37'04"), and UTM (10S 0706918E 4295806N). Degree/minute/second symbols and UTM E/N letters are optional — "38 47 12, -120 37 04" works too, as do N/S/E/W hemisphere letters.
- The radius is now optional in coordinate entry: with a radius (meters) an operational area is created as before; without one the map simply moves to that coordinate.

## v2026.07.20-b — 2026-07-20

- Viewsheds now treat OSM buildings as sight-line obstacles, using the same footprints and heights as the 3D building prisms (measured heights where OSM has them, estimates otherwise). The result line and observer export note how many buildings were included; if OSM is unreachable the viewshed still computes from terrain + canopy only. Recompute existing observers to pick up buildings. Coverage is only as complete as OSM building data for the area.

## v2026.07.20-a — 2026-07-20

- Multiple observer viewsheds can now be shown at the same time: tapping an observer marker (or the ◉/○ button in the Terrain-tab observer list) toggles that viewshed on/off instead of switching, and every shown viewshed drapes together on the map, in 3D, and behind the opacity slider. Previously only one viewshed could display at a time.
- The observer info popup now opens above the marker pin instead of covering it, so the pin stays visible and tappable for the next toggle.
- Where shown viewsheds overlap, the overlay shades darker green — mid green where 2 observers can see the drone, deep green for 3 or more.
- Fixed: adding several observers in quick succession could silently skip computing the later ones — queued viewshed computes now always run when the current one finishes.

## v2026.07.18-d — 2026-07-18

- Canopy editing (Terrain tab → EDIT next to the vegetation overlay): correct the canopy data where it is wrong — draw a polygon (drag its corners to refine, then DELETE) to remove phantom trees, or paint missing trees in with a brush (S/M/L sizes, painted at the average tree height of the current view). UNDO reverts the last 20 paints/deletes. Edit mode pins the satellite basemap under the canopy so you can trace what is actually on the ground, and works with touch.
- Saved canopy edits persist offline and apply everywhere the canopy is used — the map overlay, NEW viewshed computations (recompute existing observers to pick them up), the 3D vegetation surface, and GeoTIFF/KMZ exports — and survive re-downloads of the source data. "Clear Canopy Edits" in Config → Cache Status restores the original data.

## v2026.07.18-c — 2026-07-18

- Observer perspective view (3D): tap an observer dot in the 3D view to stand at that observer — the camera drops to the observer's position at eye height (ground + 5.5 ft, the same eye the viewshed uses) so you can preview exactly what a visual observer would see. Drag or scroll to look around in any direction from the fixed position; terrain, canopy, and buildings render right up close (the render clip plane is pulled to arm's length while in this view). Tap the ground (or the EXIT VIEW button) to return to the normal 3D view; tap a different observer dot to jump to that perspective. Entering also switches the draped viewshed overlay to that observer.
- 2D map: tapping an observer marker now switches the displayed viewshed to that observer instantly (previously only the Terrain-tab list could switch).

## v2026.07.18-b — 2026-07-18

- New Sun Shadow overlay (Terrain tab): shows which terrain is in shade vs. direct sun at the selected hour. Shadows are cast from real 3DEP terrain using the computed sun position, and scrubbing the forecast time bar re-casts them instantly, so you can preview how shade moves across the search area through the day. Toggleable with its own opacity slider (layer list → Analysis → "Sun Shadow"), works in both the 2D map and the 3D view, and shows the % of the view in shade. Shadow edges render as a soft graded penumbra (marginal cells fade instead of flickering), so low-sun shade over rough terrain looks natural rather than speckled. After sunset the whole area reads as shaded (night). Bare-earth terrain only — tree and building shade are not modeled.

## v2026.07.18-a — 2026-07-18

- 3D buildings: OSM building footprints for the operational area now render in 3D as extruded, sun-shaded buildings (fetched automatically on first 3D entry; heights from OSM tags where mapped, estimated otherwise — treat as approximate). In 2D they appear as a shaded footprint layer under Facilities. A new Config option ("Buildings in 3D view") can force flat draped footprints instead of 3D — chosen automatically on phones/tablets.
- 3D vegetation surface: the canopy overlay now renders in 3D as a solid green canopy-height surface hugging the terrain at treetop height (full resolution on desktop), replacing the flat draped image. First build shows a progress bar with a Cancel button; the built surface is cached, so toggling the layer or switching 2D/3D is instant afterwards.
- Sun & moon lighting in 3D: terrain, buildings, and the canopy surface are shaded by the real sun position (or the moon at night, dimmed by phase — flat ambient when neither is up). Scrubbing the time bar swings the lighting across the day instantly.
- Fixed 3D rendering stability: buildings no longer shimmer or change appearance when rotating the camera (vertex precision fix), and the canopy surface no longer flickers against the ground (near-ground scrub below 2 m is culled and the surface floats slightly above terrain).
- Tower heights: OSM height tags with unit suffixes (e.g. "150 ft") are now parsed correctly instead of being misread as meters, and towers with no height in OSM say "Height not in OSM" in their popup instead of omitting the line.
- Vegetation overlay toggle no longer re-downloads canopy data when re-enabled for the same area.

## v2026.07.17-j — 2026-07-17

- Fixed: the "Update Available" modal could loop — clicking "Reload & Update" reloaded back into the old version (typically within ~10 minutes of a release, when the browser's HTTP cache still held the old files). Applying an update now refreshes the offline app cache directly from the network before reloading, instead of dropping it and re-reading the stale HTTP cache.

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
