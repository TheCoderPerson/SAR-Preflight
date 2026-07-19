// ============================================================
// SAR Preflight — Pure Computation Functions
// Zero DOM / Leaflet / fetch dependencies — fully testable
// ============================================================

// --- Wire Hazard Categories ---
const WIRE_CATEGORIES = {
  power_line:       { label: 'Power Transmission',  color: '#FF0000', weight: 3 },
  power_minor_line: { label: 'Power Distribution',  color: '#FF8000', weight: 2 },
  power_cable:      { label: 'Power Cables',        color: '#AA0000', weight: 2 },
  telecom_line:     { label: 'Telecom Lines',       color: '#0088FF', weight: 2 },
  aerialway:        { label: 'Aerialways',           color: '#AA00AA', weight: 3 },
};

// --- Changelog (single source of truth) ---
// Newest first. The app renders the latest entry in a "What's New" dialog after an
// update, and build.js regenerates CHANGELOG.md from this list for the GitHub page.
// Keep CHANGELOG_ENTRIES[0].version in sync with SAR_VERSION in version.js.
const CHANGELOG_URL = 'https://github.com/TheCoderPerson/SAR-Preflight/blob/master/CHANGELOG.md';
const CHANGELOG_ENTRIES = [
  {
    version: '2026.07.18-d',
    date: '2026-07-18',
    changes: [
      'Canopy editing (Terrain tab → EDIT next to the vegetation overlay): correct the canopy data where it is wrong — draw a polygon (drag its corners to refine, then DELETE) to remove phantom trees, or paint missing trees in with a brush (S/M/L sizes, painted at the average tree height of the current view). UNDO reverts the last 20 paints/deletes. Edit mode pins the satellite basemap under the canopy so you can trace what is actually on the ground, and works with touch.',
      'Saved canopy edits persist offline and apply everywhere the canopy is used — the map overlay, NEW viewshed computations (recompute existing observers to pick them up), the 3D vegetation surface, and GeoTIFF/KMZ exports — and survive re-downloads of the source data. "Clear Canopy Edits" in Config → Cache Status restores the original data.',
    ],
  },
  {
    version: '2026.07.18-c',
    date: '2026-07-18',
    changes: [
      'Observer perspective view (3D): tap an observer dot in the 3D view to stand at that observer — the camera drops to the observer\'s position at eye height (ground + 5.5 ft, the same eye the viewshed uses) so you can preview exactly what a visual observer would see. Drag or scroll to look around in any direction from the fixed position; terrain, canopy, and buildings render right up close (the render clip plane is pulled to arm\'s length while in this view). Tap the ground (or the EXIT VIEW button) to return to the normal 3D view; tap a different observer dot to jump to that perspective. Entering also switches the draped viewshed overlay to that observer.',
      '2D map: tapping an observer marker now switches the displayed viewshed to that observer instantly (previously only the Terrain-tab list could switch).',
    ],
  },
  {
    version: '2026.07.18-b',
    date: '2026-07-18',
    changes: [
      'New Sun Shadow overlay (Terrain tab): shows which terrain is in shade vs. direct sun at the selected hour. Shadows are cast from real 3DEP terrain using the computed sun position, and scrubbing the forecast time bar re-casts them instantly, so you can preview how shade moves across the search area through the day. Toggleable with its own opacity slider (layer list → Analysis → "Sun Shadow"), works in both the 2D map and the 3D view, and shows the % of the view in shade. Shadow edges render as a soft graded penumbra (marginal cells fade instead of flickering), so low-sun shade over rough terrain looks natural rather than speckled. After sunset the whole area reads as shaded (night). Bare-earth terrain only — tree and building shade are not modeled.',
    ],
  },
  {
    version: '2026.07.18-a',
    date: '2026-07-18',
    changes: [
      '3D buildings: OSM building footprints for the operational area now render in 3D as extruded, sun-shaded buildings (fetched automatically on first 3D entry; heights from OSM tags where mapped, estimated otherwise — treat as approximate). In 2D they appear as a shaded footprint layer under Facilities. A new Config option ("Buildings in 3D view") can force flat draped footprints instead of 3D — chosen automatically on phones/tablets.',
      '3D vegetation surface: the canopy overlay now renders in 3D as a solid green canopy-height surface hugging the terrain at treetop height (full resolution on desktop), replacing the flat draped image. First build shows a progress bar with a Cancel button; the built surface is cached, so toggling the layer or switching 2D/3D is instant afterwards.',
      'Sun & moon lighting in 3D: terrain, buildings, and the canopy surface are shaded by the real sun position (or the moon at night, dimmed by phase — flat ambient when neither is up). Scrubbing the time bar swings the lighting across the day instantly.',
      'Fixed 3D rendering stability: buildings no longer shimmer or change appearance when rotating the camera (vertex precision fix), and the canopy surface no longer flickers against the ground (near-ground scrub below 2 m is culled and the surface floats slightly above terrain).',
      'Tower heights: OSM height tags with unit suffixes (e.g. "150 ft") are now parsed correctly instead of being misread as meters, and towers with no height in OSM say "Height not in OSM" in their popup instead of omitting the line.',
      'Vegetation overlay toggle no longer re-downloads canopy data when re-enabled for the same area.',
    ],
  },
  {
    version: '2026.07.17-j',
    date: '2026-07-17',
    changes: [
      'Fixed: the "Update Available" modal could loop — clicking "Reload & Update" reloaded back into the old version (typically within ~10 minutes of a release, when the browser\'s HTTP cache still held the old files). Applying an update now refreshes the offline app cache directly from the network before reloading, instead of dropping it and re-reading the stale HTTP cache.',
    ],
  },
  {
    version: '2026.07.17-i',
    date: '2026-07-17',
    changes: [
      'Wording cleanup: the built-in data proxy and the PDF briefing header are now described generically (no team-specific naming).',
    ],
  },
  {
    version: '2026.07.17-h',
    date: '2026-07-17',
    changes: [
      'Works out of the box — no proxy setup needed: the app now ships with a built-in default data proxy, so the vegetation overlay, viewshed canopy, live TFRs/NOTAMs, ADS-B proxy route, and USFS/BLM layers work immediately without deploying your own Cloudflare Worker. Entering your own Worker URL in Config still overrides the default (needed for forks hosted on other origins); clearing the field returns to the built-in proxy.',
      'If the shared proxy briefly rate-limits heavy use, an amber "⚠ PROXY LIMIT" indicator now appears in the header status bar (hover it for details) and clears automatically after about a minute — affected fetches can be retried with REFRESH.',
    ],
  },
  {
    version: '2026.07.17-g',
    date: '2026-07-17',
    changes: [
      '3D view phase 3 — vertical hazards and live traffic: FAA obstacles, towers, and dams with known heights now rise from the terrain as bold vertical height lines at their true AGL height (colored by the same hazard scale as their 2D markers). Live ADS-B aircraft appear in 3D at their actual altitude above the terrain — each plane is an X marker at its AGL altitude with a thin drop line to the ground so you can judge its height and position at a glance — updating with every 5-second traffic poll, with a clickable ground dot for the full aircraft popup. The weather radar layer now also drapes in 3D (current frame, follows the frame stepper).',
    ],
  },
  {
    version: '2026.07.17-f',
    date: '2026-07-17',
    changes: [
      'Fixed: viewshed and canopy overlays rendered wrong in the 3D view — large chunks were sliced off along straight tile-boundary lines (the 2D view was always correct). Cause was a terrain-draping bug in the 3D engine version the app was loading; upgrading the engine (MapLibre GL 4.7.1 → 5.24.0) fixes it. Overlays now drape completely and match the 2D view exactly.',
    ],
  },
  {
    version: '2026.07.17-e',
    date: '2026-07-17',
    changes: [
      '3D view phase 2 — data overlays now appear in 3D: TFRs, NOTAMs, airspace, LAANC, obstacles, wires, power lines, towers, airports, NWS alerts, fire perimeters, trails, water, hospitals/LZs, land status, observers, and the drawn ops area all drape onto the 3D terrain with their 2D colors. Clicking features in 3D opens the same paginated multi-feature popup as the 2D map. Icon markers (airports, towers, etc.) render as colored dots in 3D for now; live aircraft and radar remain 2D-only until phase 3.',
      'Update reliability fix: installing an app update could silently keep stale copies of the app files if the browser\'s HTTP cache still held them (the update banner would show the new version but old code kept running). The service worker now bypasses the HTTP cache when downloading an update, so "Reload & Update" always installs the code it says it does.',
    ],
  },
  {
    version: '2026.07.17-d',
    date: '2026-07-17',
    changes: [
      'New 3D terrain view: the "⛰ 3D" button (under the theme toggle) switches the map to a tilt-and-rotate 3D view with real terrain relief. Whatever imagery the 2D map is showing — satellite, topo, FAA sectional, hillshade, parcels, streets, and the canopy/viewshed overlays — drapes over the terrain, and the camera position carries over when switching between 2D and 3D. Data overlays (TFRs, wires, airports, etc.) and the drawing tools remain 2D for now; starting a draw or viewshed pick automatically returns to 2D. The 3D engine loads on first use and needs an internet connection.',
    ],
  },
  {
    version: '2026.07.17-c',
    date: '2026-07-17',
    changes: [
      'New "Update Available" modal: when the app discovers a newly deployed version (on load, when returning to the app, or via Config → Check for Updates), a modal now pops up showing exactly what changed in the update, with a "Reload & Update" button and a "Later" option. Dismissing it keeps the small update banner at the top as a reminder, so updates are never missed but never forced.',
    ],
  },
  {
    version: '2026.07.17-b',
    date: '2026-07-17',
    changes: [
      'Streets/Labels overlay: road lines now stay visible when zoomed in close. The Esri street tiles stop drawing road geometry past zoom 15 (labels only), so the app now upscales the zoom-15 tiles at closer zooms — lines and names get slightly softer the further you zoom, but the road vector no longer disappears.',
    ],
  },
  {
    version: '2026.07.17',
    date: '2026-07-17',
    changes: [
      'New "Streets / Labels" map overlay: transparent street lines with road names plus town/place labels (Esri hybrid reference tiles), designed to drape over the Satellite base layer — but it works over any base. Toggle it in the layer list right under the base layers; it can also be pre-downloaded for offline use in Config → Offline Tiles.',
      'New "Named Trails (OSM)" layer: named hiking trails, footpaths, 4WD tracks, bridleways and cycleways from OpenStreetMap for the drawn operational area, shown as pink dashed lines. Tap a trail for its name, type, surface and difficulty (SAC scale). Unlike the NFS/MVUM layers this covers all land ownership, is cached for offline use, and IS included in the CalTopo/KML export (as a "Named Trail (OSM)" folder).',
      'A "Named Trails (OSM)" section on the Terrain tab shows the trail count with the standard freshness row and UPDATE button.',
    ],
  },
  {
    version: '2026.07.13-g',
    date: '2026-07-13',
    changes: [
      'Vegetation Height and Viewshed overlays no longer reappear after zooming when their Map Layers checkbox is off: unchecking them in the layer control now clears the internal “overlay wanted” flag that the zoom handler (which re-attaches overlays after the mobile display-size cap) was still honoring. Re-checking them also goes through that size cap, so the mobile memory protection still applies.',
    ],
  },
  {
    version: '2026.07.13-f',
    date: '2026-07-13',
    changes: [
      'Lightning layer fixed and renamed: the Weather Imagery lightning layer now requests the correct NOAA nowCOAST GeoServer layer (lightning_detection:ldn_lightning_strike_density) — the previous endpoint returned errors, so the layer always rendered blank. Renamed from “Lightning (GOES GLM)” to “Lightning strike density (NOAA)”: the nowCOAST product is 15-minute strike density from ground-based lightning detection networks, not GOES GLM satellite data.',
      'GOES GeoColor cloud layer fixed: the WMS request no longer computes a “now minus 30 minutes” TIME value — GIBS ingest lag regularly exceeds that buffer (2+ hours observed), which made every tile come back blank. TIME is now omitted so GIBS always serves its latest available frame.',
      'NWS alert details: alert cards now show the full hazard description (wind gusts, hail size, flooding, etc.) and safety instructions instead of only the one-line headline, and map polygon popups include the description too — a Special Weather Statement now tells you what the weather actually is.',
      'GOES Clouds layer now shows its frame time and age (e.g. “frame 22:40Z (2h 05m old)”) in the Map Layers control, refreshed each time the layer is enabled, so users know how current the satellite imagery actually is.',
      'Aviation weather source switched to NWS api.weather.gov station observations: aviationweather.gov’s API does not allow cross-origin browser requests, so the METAR fetch always failed with a NetworkError and the Flight Category / cloud-ceiling readout never populated. The app now resolves the nearest reporting stations via api.weather.gov (CORS-enabled, includes the raw METAR) and skips automated stations that report no ceiling or visibility.',
      'SNODAS snow-depth layer fixed: the WMS request asked for sublayer 3 (a boundary outline) instead of sublayer 5 (the snow-depth image), and used EPSG:3857 coordinates the NOHRSC ArcGIS server does not support — both meant the layer never showed snow. Now requests sublayer 5 in EPSG:4326.',
      'Fire danger nationwide: outside California the fire-danger card now pulls NFDRS from the nearest RAWS station via the USDA FEMS API (current ERC/BI and fuel moistures, with percentile colors computed against that station’s own climatological thresholds). Previously the danger indices only populated inside California (CA_NFDRS); active-fire perimeters were already nationwide.',
    ],
  },
  {
    version: '2026.07.03-b',
    date: '2026-07-03',
    changes: [
      'New GOES-East GeoColor cloud layer (Map Layers → Weather Imagery): near-real-time geostationary satellite imagery (true-color by day, IR at night) via NASA GIBS — see cloud decks and storm systems approaching your area, complementing the precipitation radar.',
      'New GOES GLM lightning layer (Map Layers → Weather Imagery): near-real-time lightning strike density from NOAA nowCOAST for at-a-glance thunderstorm situational awareness. Both new imagery layers are off by default.',
    ],
  },
  {
    version: '2026.07.03-a',
    date: '2026-07-03',
    changes: [
      'New Flight Category & cloud ceiling: the Weather tab now shows the observed ceiling and VFR/MVFR/IFR/LIFR flight category from the nearest reporting station (FAA aviationweather.gov METAR), and a Part 107 §107.51(c) cloud-clearance gate flags CAUTION/NO-GO when the ceiling can\'t keep you 500 ft below clouds or visibility is below the 3 sm minimum. The required cloud clearance is an editable threshold (Config → Weather).',
      'New Freezing Level readout (Open-Meteo 0 °C isotherm): flags a CAUTION for icing aloft when the freezing level sits within your flight envelope (launch elevation up to launch + max AGL).',
      'New NOAA HMS wildfire-smoke layer: toggle current-day satellite smoke plumes (Light / Medium / Heavy) under Map Layers → Smoke. A Medium/Heavy plume over your area raises a reduced-visibility/VLOS CAUTION.',
      'New optional Winter Ops layer group: avalanche danger zones (avalanche.org, danger 1–5 with active-warning flags) and NOHRSC SNODAS snow-depth. A Considerable-or-higher danger level or warning over the launch point raises a ground-team-hazard CAUTION. Both layers are off by default.',
    ],
  },
  {
    version: '2026.06.20-j',
    date: '2026-06-20',
    changes: [
      'The 24-hour timeline now drives the entire data panel, not just the sun & wind arrows: drag it and the weather, wind-by-altitude profile, ops/battery estimates, GNSS outlook and the overall GO/CAUTION/NO-GO all update to the selected forecast hour, so you can scrub to find the best launch window. A "FORECAST +Xh" banner makes clear when you are viewing a future hour, and notes that airspace, TFRs, fire and live traffic remain current-time.',
      'Weather radar now uses the traditional NWS color scale (green → yellow → orange → red → magenta, with blue for snow) instead of the previous blue-heavy palette, so heavy rain no longer shows as blue.',
      'CalTopo export now includes the LAANC ceiling grid (even when it is hidden on the map) and disclaimer-flagged emergency-LZ terrain estimates.',
      'CalTopo export no longer includes layers CalTopo already provides natively and that would be stale by the time the file is imported: ADS-B aircraft, MVUM roads & trails, USFS trails, cell coverage & towers, land ownership, dams and parcels. These layers still appear and remain clickable on the map.',
    ],
  },
  {
    version: '2026.06.20-i',
    date: '2026-06-20',
    changes: [
      'Aircraft profiles are now built in: pick your drone (DJI Matrice 300/350 RTK, 30T, 4T, 4TD, Mavic 3T, Skydio X10, Neo, Avata/Avata 2, Mini 3/4/5 Pro and more) in Config → Aircraft & SOP Profile and every threshold — max wind, flight time, service ceiling, and operating-temperature limits — is set from that airframe\'s published specs. Wind NO-GO uses the rated max wind resistance with a CAUTION at ~65% of it.',
      'The old separate "Aircraft Profile" section is merged into the profile picker, so loading a profile sets the aircraft AND all risk thresholds at once. Editing any value recalculates the GO/CAUTION/NO-GO assessment live; "Save Profile" stores your own custom set.',
      'Many more Part 107 / safety thresholds are now editable: gust margin, hot & cold temperature limits, density altitude (caution & NO-GO), the Part 107 400 ft AGL ceiling, service-ceiling proximity, Kp geomagnetic index, air-quality (AQI) caution & NO-GO, and active-fire caution/NO-GO distances.',
      'New automatic flags: out-of-spec heat or cold for the selected aircraft, high density altitude, launching near/above the aircraft\'s service ceiling, elevated Kp (GNSS degradation), and hazardous air quality / wildfire smoke.',
    ],
  },
  {
    version: '2026.06.20-h',
    date: '2026-06-20',
    changes: [
      'Added privacy-first anonymous usage analytics (Cloudflare Web Analytics) so the team can gauge how often the tool is used. It is cookieless and country-level only: nothing from your map (GPS, drawn operational area, observer/viewshed coordinates) is ever sent, no precise location or IP is stored, and analytics never run offline or in the single-file field build. Browser Do-Not-Track / Global Privacy Control is honored, and you can opt out anytime in Config → Privacy.',
    ],
  },
  {
    version: '2026.06.20-g',
    date: '2026-06-20',
    changes: [
      'Each new data source (Ground Access, Land Ownership, Water, Hospitals & LZs) now has its own section in the Terrain tab showing when it was last updated and an UPDATE button to refresh just that source — matching the other data items.',
    ],
  },
  {
    version: '2026.06.20-f',
    date: '2026-06-20',
    changes: [
      'New map overlays for mission planning: forest roads, trails & Motor Vehicle Use Map (MVUM) routes, BLM routes, public-land ownership, water (streams & lakes), hospitals & helicopter landing zones, terrain hillshade, parcel boundaries, and per-carrier cell coverage.',
      'New CAUTION when part of your operating area is on private / non-public land (verify landowner permission) — based on the BLM Surface Management Agency layer.',
      'Per-carrier (AT&T / T-Mobile / Verizon) FCC LTE/5G cell coverage now drives the cell-service readout and a "no coverage" caution. Requires a one-time data build (see tools/cell-coverage) and ships with no data by default.',
      'Added "Cache Data for Current View" to pre-download all data layers (plus optional terrain DEM & vegetation) for offline use; cache status now shows storage used vs. quota, and Hillshade/Parcels were added to the map-tile download.',
      'Removed the unused "Optional API keys" field from Config (live NOTAMs/TFRs use the data proxy).',
      'Forest-service & BLM layers load through the data proxy — redeploy your Cloudflare Worker (tools/canopy-proxy) to enable them.',
    ],
  },
  {
    version: '2026.06.20-e',
    date: '2026-06-20',
    changes: [
      'Added a "setup guide" link in Config → Data Sources → Data proxy URL that opens step-by-step instructions and code on GitHub for deploying your own free Cloudflare Worker data proxy.',
    ],
  },
  {
    version: '2026.06.20-d',
    date: '2026-06-20',
    changes: [
      'Added an in-app changelog: a "What\'s New" dialog now appears the first time you open the app after an update, with a link to the full changelog on GitHub.',
      'Fixed "Check for Updates" so it accurately detects a newer version and prompts you to reload, instead of always reporting "up to date".',
    ],
  },
  {
    version: '2026.06.20-c',
    date: '2026-06-20',
    changes: [
      'Moved the diagnostics report from an automatic popup to a "View Diagnostics Report" button in Config → App Version.',
    ],
  },
  {
    version: '2026.06.20-b',
    date: '2026-06-20',
    changes: [
      'Removed the Flight Plan Suggestion and Other Aircraft sections from the Ops tab.',
      'Removed the Training Mode and Audit Trail sections from the Config tab.',
    ],
  },
];

// --- Math Utilities ---

function lerp(a, b, t) { return a + (b - a) * t; }

function degToCompass(d) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((d%360)+360)%360/22.5)%16];
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// --- Weather Code Lookup ---

function wmoCodeToText(code) {
  const codes = {0:'Clear',1:'Mainly Clear',2:'Partly Cloudy',3:'Overcast',45:'Fog',48:'Rime Fog',
    51:'Light Drizzle',53:'Drizzle',55:'Heavy Drizzle',61:'Light Rain',63:'Rain',65:'Heavy Rain',
    71:'Light Snow',73:'Snow',75:'Heavy Snow',77:'Snow Grains',80:'Rain Showers',81:'Mod Rain Showers',
    82:'Heavy Rain Showers',85:'Snow Showers',86:'Heavy Snow Showers',95:'Thunderstorm',96:'T-Storm w/ Hail',99:'Severe T-Storm'};
  return codes[code] || `WMO ${code}`;
}

// --- Astronomical Calculations ---

function calcSunPosition(lat, lng, date) {
  const now = date || new Date();
  const jd = now.getTime()/86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474*n) % 360;
  const g = ((357.528 + 0.9856003*n) % 360) * Math.PI/180;
  const lambda = (L + 1.915*Math.sin(g) + 0.020*Math.sin(2*g)) * Math.PI/180;
  const epsilon = 23.439 * Math.PI/180;
  const ra = Math.atan2(Math.cos(epsilon)*Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(epsilon)*Math.sin(lambda));
  const gmst = (280.46061837 + 360.98564736629*(jd-2451545.0)) % 360;
  const ha = ((gmst + lng) * Math.PI/180 - ra);
  const latR = lat * Math.PI/180;
  const el = Math.asin(Math.sin(latR)*Math.sin(dec) + Math.cos(latR)*Math.cos(dec)*Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.cos(latR)*Math.tan(dec)-Math.sin(latR)*Math.cos(ha));
  return { elevation: el*180/Math.PI, azimuth: ((az*180/Math.PI)+360)%360 };
}

// Truncated Meeus (ch. 47) lunar position → alt/az, ~1° accuracy — plenty
// for lighting and planning. Same return shape as calcSunPosition.
function calcMoonPosition(lat, lng, date) {
  const now = date || new Date();
  const jd = now.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const rad = Math.PI / 180;
  const Lp = (218.3164477 + 481267.88123421 * T) % 360; // mean longitude
  const D = (297.8501921 + 445267.1114034 * T) % 360;   // mean elongation
  const M = (357.5291092 + 35999.0502909 * T) % 360;    // sun mean anomaly
  const Mp = (134.9633964 + 477198.8675055 * T) % 360;  // moon mean anomaly
  const F = (93.2720950 + 483202.0175233 * T) % 360;    // argument of latitude
  const lon = Lp
    + 6.288774 * Math.sin(Mp * rad)
    + 1.274027 * Math.sin((2 * D - Mp) * rad)
    + 0.658314 * Math.sin(2 * D * rad)
    + 0.213618 * Math.sin(2 * Mp * rad)
    - 0.185116 * Math.sin(M * rad)
    - 0.114332 * Math.sin(2 * F * rad);
  const beta =
    5.128122 * Math.sin(F * rad)
    + 0.280602 * Math.sin((Mp + F) * rad)
    + 0.277693 * Math.sin((Mp - F) * rad);
  const eps = 23.439 * rad;
  const lonR = lon * rad, betaR = beta * rad;
  const ra = Math.atan2(Math.sin(lonR) * Math.cos(eps) - Math.tan(betaR) * Math.sin(eps), Math.cos(lonR));
  const dec = Math.asin(Math.sin(betaR) * Math.cos(eps) + Math.cos(betaR) * Math.sin(eps) * Math.sin(lonR));
  const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360;
  const ha = (gmst + lng) * rad - ra;
  const latR = lat * rad;
  const el = Math.asin(Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.cos(latR) * Math.tan(dec) - Math.sin(latR) * Math.cos(ha));
  return { elevation: el / rad, azimuth: ((az / rad) + 360) % 360 };
}

// Az/el (deg) → unit vector in the local ENU frame (x=east, y=north, z=up),
// pointing FROM the scene TOWARD the light source.
function lightVecENU(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180;
  return [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
}

// Scene lighting for the 3D view at a time+place: sun when up, else the
// moon dimmed by its phase illumination (night ops), else a flat overhead
// ambient so nothing goes black. diffuse/ambient are Lambert terms:
// brightness = ambient + diffuse * max(0, N·L), clamped to 1.
function lightForTime(lat, lng, date) {
  const sun = calcSunPosition(lat, lng, date);
  if (sun.elevation > 0) {
    return { source: 'sun', dir: lightVecENU(sun.azimuth, sun.elevation), diffuse: 0.6, ambient: 0.45 };
  }
  const moon = calcMoonPosition(lat, lng, date);
  if (moon.elevation > 0) {
    const illum = calcMoonPhase(date).illumination / 100;
    return { source: 'moon', dir: lightVecENU(moon.azimuth, moon.elevation), diffuse: 0.2 + 0.3 * illum, ambient: 0.35 };
  }
  return { source: 'ambient', dir: [0, 0, 1], diffuse: 0.15, ambient: 0.4 };
}

// Scene light → MapLibre hillshade paint params for the terrain: the
// illumination direction is the light's azimuth, and the shading strength
// grows as the light drops toward the horizon (low sun/moon = long-shadow
// contrast, overhead sun = subtle). Moonlight shades at reduced strength;
// no light up = faint default-direction relief so terrain never goes flat.
function hillshadeParams(light) {
  if (!light || light.source === 'ambient' || !light.dir) {
    return { azimuth: 335, exaggeration: 0.15 };
  }
  const azimuth = (Math.atan2(light.dir[0], light.dir[1]) * 180 / Math.PI + 360) % 360;
  const sinEl = Math.max(0, Math.min(1, light.dir[2]));
  let exaggeration = 0.25 + 0.55 * (1 - sinEl);
  if (light.source === 'moon') exaggeration *= 0.6;
  return { azimuth, exaggeration: Math.round(exaggeration * 100) / 100 };
}

function calcMoonPhase(date) {
  const now = date || new Date();
  const year = now.getFullYear(), month = now.getMonth()+1, day = now.getDate();
  let c = 0, e = 0;
  if (month < 3) { c = year - 1; e = month + 12; } else { c = year; e = month; }
  const jd = Math.floor(365.25*(c+4716)) + Math.floor(30.6001*(e+1)) + day - 1524.5;
  const daysSinceNew = (jd - 2451550.1) % 29.530588853;
  const phase = daysSinceNew / 29.530588853;
  const illum = Math.round((1 - Math.cos(phase * 2 * Math.PI)) / 2 * 100);
  const names = ['New Moon','Waxing Crescent','First Quarter','Waxing Gibbous','Full Moon','Waning Gibbous','Last Quarter','Waning Crescent'];
  const idx = Math.round(phase * 8) % 8;
  return { name: names[idx], illumination: illum, phase };
}

// --- Wire Hazard Name Builder ---

function wireHazardName(tags, cat) {
  if (cat === 'power_line') {
    const parts = [];
    if (tags.voltage) { try { parts.push(Math.round(parseInt(tags.voltage) / 1000) + 'kV'); } catch(e) { parts.push(tags.voltage); } }
    if (tags.operator) parts.push(tags.operator);
    if (tags.ref) parts.push('Ref: ' + tags.ref);
    return parts.join(' — ') || 'Transmission Line';
  }
  if (cat === 'power_minor_line') {
    const parts = [];
    if (tags.voltage) parts.push(tags.voltage + 'V');
    if (tags.operator) parts.push(tags.operator);
    return parts.join(' — ') || 'Distribution Line';
  }
  if (cat === 'power_cable') return 'Power Cable (' + (tags.location || 'overhead') + ')';
  if (cat === 'telecom_line') return [tags.operator, tags['telecom:medium']].filter(Boolean).join(' — ') || 'Telecom Line';
  if (cat === 'aerialway') {
    const type = (tags.aerialway || '').replace(/_/g, ' ');
    return tags.name ? `${tags.name} (${type})` : type || 'Aerialway';
  }
  return '';
}

// --- OSM height tag parsing ---
// OSM height values default to meters but may carry a unit suffix
// ("164 ft", "164'", "50 m"). Returns meters, or null for missing/zero/
// negative/unparseable values so callers can distinguish "unknown".
function parseHeightToMeters(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return isFinite(raw) && raw > 0 ? raw : null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|foot|')?\.?$/);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (!isFinite(val) || val <= 0) return null;
  const unit = m[2] || 'm';
  if (unit === 'ft' || unit === 'feet' || unit === 'foot' || unit === "'") return val * 0.3048;
  return val;
}

// Tower height from OSM tags: `height` wins over `tower:height` over
// `est_height`. Returns { heightFt, raw } or null when no tag parses.
function osmTowerHeightFt(tags) {
  if (!tags) return null;
  for (const key of ['height', 'tower:height', 'est_height']) {
    const meters = parseHeightToMeters(tags[key]);
    if (meters !== null) return { heightFt: Math.round(meters * 3.28084), raw: String(tags[key]).trim() };
  }
  return null;
}

// --- Changelog markdown parser (update-available modal) ---
// Parses the CHANGELOG.md that build.js generates (`## v<version> — <date>`
// headers with `- <change>` items) back into entry objects. Used to show the
// DEPLOYED version's release notes before reloading — the running app's own
// CHANGELOG_ENTRIES are stale by definition when an update is available.
// Returns entries newer than sinceVersion (stops when it reaches it).
function parseChangelogMd(md, sinceVersion) {
  const entries = [];
  let cur = null;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const h = raw.match(/^##\s+v(\S+)(?:\s+—\s+(\S+))?\s*$/);
    if (h) {
      if (sinceVersion && h[1] === sinceVersion) break;
      cur = { version: h[1], date: h[2] || '', changes: [] };
      entries.push(cur);
      continue;
    }
    const item = raw.match(/^-\s+(.*\S)\s*$/);
    if (item && cur) cur.changes.push(item[1]);
  }
  return entries;
}

// --- OSM Named Trails (Overpass) ---
// Named foot/offroad routes from OpenStreetMap. Ways only (route relations are
// out of scope); `out geom` returns each way's geometry inline, so no node-join
// pass is needed.

const TRAIL_HIGHWAY_TYPES = ['path', 'footway', 'track', 'bridleway', 'cycleway'];

// bbox: "south,west,north,east" string (same shape the app builds elsewhere).
function buildTrailsOverpassQuery(bbox) {
  return `[out:json][timeout:45];(`
    + `way["highway"~"^(${TRAIL_HIGHWAY_TYPES.join('|')})$"]["name"](${bbox});`
    + `);out geom tags;`;
}

// Overpass `out geom` JSON -> neutral trail records:
//   [{ id, name, type, surface, sacScale, coords: [[lat,lng],...] }]
// Drops unnamed ways, non-ways, non-trail highway types, and degenerate
// geometry (< 2 points).
function parseOverpassTrails(data) {
  const out = [];
  ((data && data.elements) || []).forEach(el => {
    if (el.type !== 'way' || !el.tags || !el.tags.name) return;
    if (TRAIL_HIGHWAY_TYPES.indexOf(el.tags.highway) === -1) return;
    const coords = (el.geometry || [])
      .filter(p => p && p.lat != null && p.lon != null)
      .map(p => [p.lat, p.lon]);
    if (coords.length < 2) return;
    out.push({
      id: el.id,
      name: el.tags.name,
      type: el.tags.highway || '',
      surface: el.tags.surface || null,
      sacScale: el.tags.sac_scale || null,
      coords,
    });
  });
  return out;
}

function trailTypeLabel(type) {
  const m = {
    path: 'Trail (path)', footway: 'Footpath', track: 'Track / 4WD',
    bridleway: 'Bridleway', cycleway: 'Cycleway',
  };
  return m[type] || 'Trail';
}

// --- FAA Digital Obstacle File (DOF) helpers ---
// The DOF is the FAA's authoritative man-made obstacle database. Each record
// carries a verified height (AGL/AMSL), a structure type code, lighting and
// marking status, and a verified/unverified flag. CAUTION: the DOF is NOT a
// complete low-altitude inventory — below ~200' AGL away from airports it is
// intentionally sparse, so absence of an obstacle is not proof of clear air.

// DOF lighting codes -> short description (per DOF_README).
const DOF_LIGHTING = {
  R: 'Red', D: 'Med strobe + red', H: 'High strobe + red', M: 'Med strobe',
  S: 'High strobe', F: 'Flood', C: 'Dual med catenary', W: 'Synced red',
  L: 'Lighted (type unknown)', N: 'None', U: 'Unknown',
};
function obstacleLighting(code) {
  const c = (code || '').toString().trim().toUpperCase();
  return DOF_LIGHTING[c] || 'Unknown';
}

// Marker color by height above ground (ft AGL), relative to the drone band:
// tall structures that reach well into the band are red, mid-height amber,
// low yellow, unknown gray.
function obstacleMarkerColor(aglFt) {
  const agl = Number(aglFt);
  if (!isFinite(agl) || agl <= 0) return '#9ca3af';
  if (agl >= 200) return '#ef4444';
  if (agl >= 100) return '#f59e0b';
  return '#facc15';
}

// Title-case the all-caps DOF type code, preserving separators and short
// acronym segments (e.g. "T-L TOWER" -> "T-L Tower", "SOLAR PANELS" ->
// "Solar Panels"). Only alphabetic runs are recased so hyphens/spaces survive.
function obstacleLabel(props) {
  const p = props || {};
  const type = (p.Type_Code || p.TYPE_CODE || 'Obstacle').toString().trim() || 'Obstacle';
  return type.replace(/[A-Za-z]+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Summarize an array of DOF features (GeoJSON Features or raw property objects)
// for the panel + assessment. aglCeiling = drone max AGL (default 400').
function summarizeObstacles(features, aglCeiling) {
  const ceiling = Number(aglCeiling) > 0 ? Number(aglCeiling) : 400;
  const list = (features || [])
    .map(f => (f && f.properties) ? f.properties : f)
    .filter(Boolean);
  let total = 0, maxAgl = 0, maxAmsl = 0, tallCount = 0, unverified = 0, unlit = 0;
  let tallestType = null;
  const byType = {};
  for (const p of list) {
    total++;
    const agl = Number(p.AGL);
    const amsl = Number(p.AMSL);
    if (isFinite(agl)) {
      if (agl > maxAgl) { maxAgl = agl; tallestType = p.Type_Code || p.TYPE_CODE || null; }
      if (agl >= 200) tallCount++;
    }
    if (isFinite(amsl) && amsl > maxAmsl) maxAmsl = amsl;
    if ((p.Verified || p.VERIFIED || '').toString().trim().toUpperCase() === 'U') unverified++;
    const lt = (p.Lighting || p.LIGHTING || '').toString().trim().toUpperCase();
    if (lt === '' || lt === 'N' || lt === 'U') unlit++;
    const type = (p.Type_Code || p.TYPE_CODE || 'UNKNOWN').toString().trim().toUpperCase();
    byType[type] = (byType[type] || 0) + 1;
  }
  return { total, maxAgl, maxAmsl, tallCount, unverified, unlit, byType, tallestType, ceiling };
}

// Panel/assessment hazard level from an obstacle summary. Red when any tall
// (>=200' AGL) structure is present, amber for shorter obstacles, green when
// the DOF returned none (NOT a guarantee of clear airspace — see caveat above).
function obstacleHazardLevel(summary) {
  if (!summary || !summary.total) return 'green';
  if (summary.tallCount > 0) return 'red';
  return 'amber';
}

// --- Default Risk Thresholds ---

// A profile is one flat object holding BOTH the aircraft specs and the
// environmental gates, so picking a drone profile sets every threshold at once.
// Existing keys keep their names/defaults (back-compat with saved profiles & tests);
// new keys are additive and default to current behavior when absent.
const DEFAULT_THRESHOLDS = {
  name: 'Default',
  model: 'Default / generic',
  // --- Aircraft (overridden per drone profile) ---
  maxWindTol: 27,        // mph — sustained-wind NO-GO (airframe rated max wind resistance)
  windCaution: 15,       // mph — sustained-wind CAUTION (drone profiles use ~0.65× rated)
  gustMargin: 5,         // mph — gust NO-GO = maxWindTol + this
  flightTime: 38,        // min — nominal endurance (battery-derating baseline)
  serviceCeiling: 16404, // ft MSL — max takeoff altitude (info + approaching-ceiling gate)
  maxSpeed: 47,          // mph — airframe max horizontal speed (info vs Part 107 100 mph)
  // --- Weather (Part 107 / SOP) ---
  visNoGo: 1,            // statute miles — below this = NO-GO
  visCaution: 5,         // statute miles — below this = CAUTION (Part 107 §107.51 min is 3 sm)
  precipNoGo: 60,        // percent — above this = NO-GO
  precipCaution: 30,     // percent — above this = CAUTION
  tempCaution: 35,       // °F — below this = CAUTION (cold-battery margin)
  tempColdNoGo: 14,      // °F — below this = NO-GO (airframe operating minimum)
  tempHotCaution: 95,    // °F — above this = CAUTION (heat stress)
  tempHotNoGo: 104,      // °F — above this = NO-GO (airframe operating maximum)
  weatherCodeNoGo: 95,   // WMO code — at or above = NO-GO (thunderstorm)
  cloudClearanceFt: 500, // ft — required vertical clearance below clouds (Part 107 §107.51(c))
  // --- Terrain / Ops ---
  elevCaution: 6000,     // ft MSL — terrain elevation CAUTION
  densAltCaution: 5000,  // ft — density altitude CAUTION
  densAltNoGo: 9000,     // ft — density altitude NO-GO
  ceilingMarginFt: 1500, // ft — CAUTION when takeoff elev within this of serviceCeiling
  maxAltAGL: 400,        // ft AGL — Part 107 §107.51(b) operating ceiling
  // --- GNSS / Air quality / Fire ---
  kpCaution: 5,          // Kp index — at or above = CAUTION (GNSS degradation)
  aqiCaution: 150,       // US AQI — at or above = CAUTION (unhealthy / wildfire smoke)
  aqiNoGo: 250,          // US AQI — at or above = NO-GO (hazardous)
  fireCautionNm: 30,     // nm — active fire within this = CAUTION
  fireNoGoNm: 10,        // nm — active fire within this = NO-GO
};

// Built-in aircraft profiles for commonly-flown SAR/DJI airframes.
// Wind NO-GO (maxWindTol) = manufacturer rated max wind resistance (mph);
// Wind CAUTION (windCaution) = round(0.65 × rated). tempColdNoGo / tempHotNoGo =
// published operating-temperature range. serviceCeiling = manufacturer max takeoff
// altitude (ft MSL). Environmental gates inherit DEFAULT_THRESHOLDS. Numbers are
// from manufacturer spec pages (researched 2026-06; see CLAUDE.md history) — verify
// against the current spec sheet before relying on them operationally.
const DRONE_PROFILES = [
  { ...DEFAULT_THRESHOLDS, name: 'DJI Matrice 300 RTK', model: 'DJI Matrice 300 RTK', maxWindTol: 27, windCaution: 17, flightTime: 55, serviceCeiling: 22966, maxSpeed: 51, tempColdNoGo: -4, tempHotNoGo: 122 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Matrice 350 RTK', model: 'DJI Matrice 350 RTK', maxWindTol: 27, windCaution: 17, flightTime: 55, serviceCeiling: 22966, maxSpeed: 51, tempColdNoGo: -4, tempHotNoGo: 122 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Matrice 30T', model: 'DJI Matrice 30T', maxWindTol: 27, windCaution: 17, flightTime: 41, serviceCeiling: 22966, maxSpeed: 51, tempColdNoGo: -4, tempHotNoGo: 122 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Matrice 4T', model: 'DJI Matrice 4T', maxWindTol: 27, windCaution: 17, flightTime: 49, serviceCeiling: 19686, maxSpeed: 47, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Matrice 4TD', model: 'DJI Matrice 4TD', maxWindTol: 27, windCaution: 17, flightTime: 54, serviceCeiling: 21326, maxSpeed: 47, tempColdNoGo: -4, tempHotNoGo: 122 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Mavic 3T', model: 'DJI Mavic 3T', maxWindTol: 27, windCaution: 17, flightTime: 45, serviceCeiling: 19685, maxSpeed: 47, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'Skydio X10', model: 'Skydio X10', maxWindTol: 28, windCaution: 18, flightTime: 40, serviceCeiling: 15000, maxSpeed: 45, tempColdNoGo: -4, tempHotNoGo: 113 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Neo', model: 'DJI Neo', maxWindTol: 18, windCaution: 12, flightTime: 18, serviceCeiling: 6562, maxSpeed: 36, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Neo 2 (unreleased — uses DJI Neo specs)', model: 'DJI Neo 2', maxWindTol: 18, windCaution: 12, flightTime: 18, serviceCeiling: 6562, maxSpeed: 36, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Avata', model: 'DJI Avata', maxWindTol: 24, windCaution: 16, flightTime: 18, serviceCeiling: 16404, maxSpeed: 60, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Avata 2', model: 'DJI Avata 2', maxWindTol: 24, windCaution: 16, flightTime: 23, serviceCeiling: 16404, maxSpeed: 60, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Avata 360 (unreleased — uses Avata 2 specs)', model: 'DJI Avata 360', maxWindTol: 24, windCaution: 16, flightTime: 23, serviceCeiling: 16404, maxSpeed: 60, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Mini 3 Pro', model: 'DJI Mini 3 Pro', maxWindTol: 24, windCaution: 16, flightTime: 34, serviceCeiling: 13124, maxSpeed: 36, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Mini 4 Pro', model: 'DJI Mini 4 Pro', maxWindTol: 24, windCaution: 16, flightTime: 34, serviceCeiling: 13123, maxSpeed: 36, tempColdNoGo: 14, tempHotNoGo: 104 },
  { ...DEFAULT_THRESHOLDS, name: 'DJI Mini 5 Pro', model: 'DJI Mini 5 Pro', maxWindTol: 27, windCaution: 17, flightTime: 36, serviceCeiling: 19685, maxSpeed: 40, tempColdNoGo: 14, tempHotNoGo: 104 },
];

// --- Hourly weather snapshot ---
// Build a weather object shaped like the Open-Meteo `current` object but for a
// chosen forecast hour, so the data panel can render any timeline hour with the
// same render/compute functions. Starts from `current` (so non-hourly scalars are
// always present) and overrides every field that has an hourly array at idx.
// Returns the live `current` object when no hourly data is available. idx is
// clamped to [0, min(24, time.length)-1]. Adds _idx / _isNow / _time metadata.
const WX_HOURLY_FIELDS = [
  'temperature_2m', 'dew_point_2m', 'apparent_temperature', 'relative_humidity_2m',
  'surface_pressure', 'visibility', 'uv_index', 'cloud_cover', 'weather_code',
  'freezing_level_height',
  'precipitation_probability', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
  'wind_speed_80m', 'wind_speed_120m', 'wind_speed_180m',
  'wind_direction_80m', 'wind_direction_120m', 'wind_direction_180m', 'is_day',
];
function wxAtHour(hourly, idx, current) {
  current = current || {};
  if (!hourly || !hourly.time || !hourly.time.length) {
    return Object.assign({}, current, { _idx: 0, _isNow: true, _time: null });
  }
  const n = Math.min(24, hourly.time.length);
  const i = Math.max(0, Math.min(n - 1, Math.round(Number(idx) || 0)));
  const snap = Object.assign({}, current);
  WX_HOURLY_FIELDS.forEach(f => {
    const arr = hourly[f];
    if (Array.isArray(arr) && arr[i] != null) snap[f] = arr[i];
  });
  snap._idx = i;
  snap._isNow = (i === 0);
  snap._time = hourly.time[i];
  return snap;
}

// Kp index for a given time from the SWPC 3-hourly forecast rows [{t, kp}] (t in
// ms epoch). Returns the kp of the row nearest in time (matching the app's
// "closest to now" selection); null when there are no rows.
function kpAtTime(rows, dateMs) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let best = null, bestDiff = Infinity;
  for (const r of rows) {
    if (!r || r.t == null || r.kp == null) continue;
    const diff = Math.abs(dateMs - r.t);
    if (diff < bestDiff) { bestDiff = diff; best = r; }
  }
  return best ? best.kp : null;
}

// --- Density Altitude ---

function calcDensityAltitude(tempF, surfacePressureHPa) {
  const tempC = (tempF - 32) * 5/9;
  const pressAlt = (1013.25 - surfacePressureHPa) * 30;
  return Math.round(pressAlt + (120 * (tempC - (15 - 2 * pressAlt / 1000))));
}

// --- Battery Derating ---

function calcBatteryDerating(tempF, elevFt, maxWindMph) {
  const tempC = (tempF - 32) * 5/9;
  const tempFactor = tempC < 0 ? 0.70 : tempC < 5 ? 0.82 : tempC < 10 ? 0.90 : tempC > 35 ? 0.92 : 1.0;
  const altFactor = elevFt > 8000 ? 0.75 : elevFt > 6000 ? 0.82 : elevFt > 4000 ? 0.90 : elevFt > 2000 ? 0.95 : 1.0;
  const windFactor = maxWindMph > 25 ? 0.65 : maxWindMph > 20 ? 0.72 : maxWindMph > 15 ? 0.80 : maxWindMph > 10 ? 0.88 : 1.0;
  const combined = tempFactor * altFactor * windFactor;
  return { tempFactor, altFactor, windFactor, combined };
}

// --- Prop Icing Risk ---
// Quadcopter props can accrete ice even above freezing when air is near saturation —
// venturi/evaporative cooling on blade surfaces drops temperatures below ambient.
function assessPropIcing(tempF, dewF) {
  if (tempF == null) return { risk: 'No data', level: 'green', severity: 'none', reason: null };
  const t = Math.round(tempF);
  const hasDew = dewF != null && !Number.isNaN(dewF);
  const spread = hasDew ? Math.round(tempF - dewF) : null;

  if (hasDew && tempF <= 32 && spread <= 5) {
    return { risk: 'Likely', level: 'red', severity: 'nogo', reason: `${t}°F / ${spread}°F spread (freezing + saturated)` };
  }
  if (hasDew && tempF < 41 && spread <= 5) {
    return { risk: 'Possible', level: 'amber', severity: 'caution', reason: `${t}°F / ${spread}°F spread` };
  }
  if (tempF < 32) {
    return { risk: 'Possible', level: 'amber', severity: 'caution', reason: `${t}°F sub-freezing` };
  }
  return { risk: 'None', level: 'green', severity: 'none', reason: null };
}

// --- Risk Assessment ---

function assessRisk(wx, wind, elev, maxWindTol, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  // maxWindTol arg kept for back-compat; fall back to the profile value when omitted.
  const windTol = (maxWindTol != null) ? maxWindTol : (t.maxWindTol ?? 27);
  const gustMargin = t.gustMargin ?? 5;
  const maxWind = wind.maxWind ?? 0;
  const maxGust = wind.maxGust ?? 0;
  const vis = wx.visibility ? wx.visibility / 1609.34 : 99;
  const temp = wx.temperature_2m ?? 65;
  const precip = wx.precipitation_probability ?? 0;
  const weatherCode = wx.weather_code ?? 0;
  const centerElev = elev.center ?? 0;

  const issues = [];
  if (maxWind > windTol || maxGust > windTol + gustMargin) { issues.push(`Wind ${maxWind}/${maxGust}g exceeds limits`); }
  if (vis < t.visNoGo) { issues.push(`Visibility ${vis.toFixed(1)} mi`); }
  if (precip > t.precipNoGo) { issues.push(`Precip ${precip}%`); }
  if (weatherCode >= t.weatherCodeNoGo) { issues.push('Thunderstorm activity'); }
  if (t.tempColdNoGo != null && wx.temperature_2m != null && temp < t.tempColdNoGo) { issues.push(`Temp ${Math.round(temp)}°F below aircraft limit`); }
  if (t.tempHotNoGo != null && temp > t.tempHotNoGo) { issues.push(`Temp ${Math.round(temp)}°F above aircraft limit`); }
  if (t.serviceCeiling != null && centerElev > t.serviceCeiling) { issues.push(`Launch elev ${Math.round(centerElev)} ft above aircraft ceiling`); }

  const cautions = [];
  if (maxWind > t.windCaution && maxWind <= windTol) { cautions.push('Elevated winds'); }
  if (vis >= t.visNoGo && vis < t.visCaution) { cautions.push('Reduced visibility'); }
  if (precip > t.precipCaution && precip <= t.precipNoGo) { cautions.push(`Precip ${precip}%`); }
  if (temp < t.tempCaution && !(t.tempColdNoGo != null && temp < t.tempColdNoGo)) { cautions.push('Cold — battery impact'); }
  if (t.tempHotCaution != null && temp > t.tempHotCaution && !(t.tempHotNoGo != null && temp > t.tempHotNoGo)) { cautions.push('Heat — battery/motor stress'); }
  if (centerElev > t.elevCaution) { cautions.push('High elevation'); }
  // Approaching the airframe's max takeoff altitude (e.g. small drones in high terrain)
  if (t.serviceCeiling != null && t.ceilingMarginFt != null &&
      centerElev <= t.serviceCeiling && centerElev > t.serviceCeiling - t.ceilingMarginFt) {
    cautions.push('Near aircraft service ceiling');
  }
  // Density altitude (only when pressure is available so it stays inert in unit tests)
  if (wx.surface_pressure != null && wx.temperature_2m != null && typeof calcDensityAltitude === 'function') {
    const densAlt = calcDensityAltitude(temp, wx.surface_pressure);
    if (t.densAltNoGo != null && densAlt > t.densAltNoGo) { issues.push(`Density altitude ${densAlt} ft`); }
    else if (t.densAltCaution != null && densAlt > t.densAltCaution) { cautions.push(`High density altitude (${densAlt} ft)`); }
  }

  const icing = assessPropIcing(wx.temperature_2m, wx.dew_point_2m);
  if (icing.severity === 'nogo') { issues.push(`Prop icing — ${icing.reason}`); }
  else if (icing.severity === 'caution') { cautions.push(`Prop icing — ${icing.reason}`); }

  // Freezing level (0°C isotherm) within the flight envelope — icing aloft (advisory).
  // Guarded on presence so it stays inert where no freezing-level data is supplied.
  if (wx.freezing_level_height != null) {
    const fz = freezingLevelRisk(wx.freezing_level_height, centerElev, t.maxAltAGL);
    if (fz) cautions.push(`Freezing level — ${fz.reason}`);
  }

  let level = 'GO', text = 'All conditions nominal for UAS operations';
  if (issues.length > 0) { level = 'NO-GO'; text = issues.join(' • '); }
  else if (cautions.length > 0) { level = 'CAUTION'; text = cautions.join(' • '); }

  return { level, text, issues, cautions };
}

// --- Freezing level (icing aloft) ---
// Open-Meteo `freezing_level_height` is the 0°C isotherm altitude in METERS above
// sea level. Returns an advisory (amber) when that level sits within the flight
// envelope — from launch elevation up to launch + maxAltAGL — else null. Icing aloft
// is a pilot-judgement CAUTION, never an automatic NO-GO.
function freezingLevelRisk(freezingLevelM, launchElevFt, maxAltAGL) {
  if (freezingLevelM == null || Number.isNaN(Number(freezingLevelM))) return null;
  const fzFt = Math.round(Number(freezingLevelM) * 3.28084);
  const baseFt = launchElevFt ?? 0;
  const topFt = baseFt + (maxAltAGL ?? 400);
  if (fzFt <= baseFt) {
    return { level: 'amber', freezingLevelFt: fzFt, reason: `0°C level ${fzFt.toLocaleString()} ft at/below launch elevation` };
  }
  if (fzFt <= topFt) {
    return { level: 'amber', freezingLevelFt: fzFt, reason: `0°C level ${fzFt.toLocaleString()} ft within flight envelope` };
  }
  return null;
}

// --- Aviation weather (METAR-derived) ---
// Ceiling = the lowest cloud base (ft AGL) among BROKEN / OVERCAST / obscured layers.
// `clouds` is the array of { cover, base } from the aviationweather.gov METAR JSON.
// Returns null when there is no broken/overcast layer (sky clear or only few/scattered
// → no ceiling / unlimited).
function metarCeilingFt(clouds) {
  if (!Array.isArray(clouds)) return null;
  let ceil = null;
  for (const c of clouds) {
    if (!c) continue;
    const cover = String(c.cover || '').toUpperCase();
    if (cover === 'BKN' || cover === 'OVC' || cover === 'OVX') {
      const base = Number(c.base);
      if (Number.isFinite(base) && (ceil === null || base < ceil)) ceil = base;
    }
  }
  return ceil;
}

// Aviation flight category from ceiling (ft AGL; null = unlimited) and visibility
// (statute miles; null = unrestricted). Matches the FAA/AWC thresholds. Returns one
// of 'VFR' | 'MVFR' | 'IFR' | 'LIFR'.
function flightCategory(ceilingFt, visSm) {
  const ceil = (ceilingFt == null) ? Infinity : ceilingFt;
  const vis = (visSm == null) ? 99 : visSm;
  if (ceil < 500 || vis < 1) return 'LIFR';
  if (ceil < 1000 || vis < 3) return 'IFR';
  if (ceil <= 3000 || vis <= 5) return 'MVFR';
  return 'VFR';
}

// Part 107 §107.51(c) cloud-clearance + minimum-visibility gate from observed METAR.
// ceilingFt: ft AGL (null = no ceiling). visSm: statute miles. maxAltAGL: planned
// operating ceiling (ft AGL). Returns { issues:[], cautions:[] } to merge into the
// assessment. Below 3 sm visibility is the FAA legal minimum (NO-GO); a ceiling that
// leaves no room for the required clearance is a NO-GO; a ceiling that only trims the
// usable envelope below the planned altitude is a CAUTION.
function assessCloudClearance(ceilingFt, visSm, maxAltAGL, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  const clearance = t.cloudClearanceFt ?? 500;
  const planAgl = maxAltAGL ?? t.maxAltAGL ?? 400;
  const issues = [], cautions = [];
  if (visSm != null && visSm < 3) {
    issues.push(`METAR visibility ${visSm} sm below Part 107 3 sm minimum`);
  } else if (visSm != null && visSm < 5) {
    cautions.push(`METAR visibility ${visSm} sm — marginal`);
  }
  if (ceilingFt != null) {
    const usable = ceilingFt - clearance;
    if (usable <= 0) {
      issues.push(`Ceiling ${ceilingFt.toLocaleString()} ft — cannot maintain ${clearance} ft cloud clearance`);
    } else if (usable < planAgl) {
      cautions.push(`Ceiling ${ceilingFt.toLocaleString()} ft limits ops to ~${usable.toLocaleString()} ft AGL (${clearance} ft cloud clearance)`);
    }
  }
  return { issues, cautions };
}

// --- Terrain Classification ---

function classifyTerrain(centerElevFt) {
  return centerElevFt > 6000 ? 'Mountainous' : centerElevFt > 3000 ? 'Hilly/Foothill' : centerElevFt > 1000 ? 'Rolling' : 'Flat';
}

function estimateVegetation(centerElevFt) {
  return centerElevFt > 7000 ? 'Subalpine — sparse trees, rock' :
         centerElevFt > 5000 ? 'Mixed conifer — 60-120 ft canopy' :
         centerElevFt > 3000 ? 'Pine/oak — 40-80 ft canopy' :
         centerElevFt > 1500 ? 'Oak woodland — 20-50 ft' : 'Grassland/valley oak — 10-30 ft';
}

function estimateCellCoverage(centerElevFt) {
  if (centerElevFt > 6000) return { label: 'Unlikely — plan for no connectivity', level: 'red' };
  if (centerElevFt > 4000) return { label: 'Marginal — verify on-site', level: 'amber' };
  return { label: 'Likely available', level: 'green' };
}

// --- Airport Distance Filter (haversine-based) ---

function filterAirportsByDistance(airports, lat, lng, maxDistKm) {
  return airports
    .map(a => ({ ...a, distKm: haversine(lat, lng, a.lat, a.lng) }))
    .filter(a => a.distKm <= maxDistKm)
    .sort((a, b) => a.distKm - b.distKm);
}

// --- Airspace Classification Estimator ---

function classifyAirspace(nearestAirport, distKm) {
  if (!nearestAirport) return { class: 'G', label: 'Class G — Uncontrolled', controlled: false };
  const type = nearestAirport.type;
  const distNm = distKm * 0.539957;

  if (type === 'large_airport') {
    if (distNm <= 5)  return { class: 'B', label: `Class B — ${nearestAirport.icao} surface area`, controlled: true };
    if (distNm <= 10) return { class: 'B-shelf', label: `Class B shelf — ${nearestAirport.icao}`, controlled: true };
    if (distNm <= 20) return { class: 'C-outer', label: `Class C outer ring — ${nearestAirport.icao}`, controlled: true };
  }
  if (type === 'medium_airport') {
    if (distNm <= 5)  return { class: 'D', label: `Class D — ${nearestAirport.icao} surface area`, controlled: true };
    if (distNm <= 10) return { class: 'E-transition', label: `Class E transition — near ${nearestAirport.icao}`, controlled: false };
  }
  if (type === 'small_airport') {
    if (distNm <= 5)  return { class: 'E-surface', label: `Class E surface — ${nearestAirport.icao}`, controlled: false };
  }
  if (type === 'heliport') {
    if (distNm <= 2)  return { class: 'G-heliport', label: `Class G — heliport traffic area ${nearestAirport.icao}`, controlled: false };
  }
  return { class: 'G', label: 'Class G — Uncontrolled', controlled: false };
}

// --- Wind Assessment: Gust Factor ---

function calcGustFactor(maxGust, maxSustained) {
  if (!maxSustained || maxSustained === 0) return 0;
  return maxGust / maxSustained;
}

// --- Wind Assessment: Wind Shear ---

function calcWindShear(windProfile) {
  // Calculate max speed change and max direction change between adjacent layers
  let maxSpeedChange = 0, maxDirChange = 0;
  for (let i = 1; i < windProfile.length; i++) {
    const speedDiff = Math.abs(windProfile[i].speed - windProfile[i-1].speed);
    let dirDiff = Math.abs(windProfile[i].dir - windProfile[i-1].dir);
    if (dirDiff > 180) dirDiff = 360 - dirDiff;
    maxSpeedChange = Math.max(maxSpeedChange, speedDiff);
    maxDirChange = Math.max(maxDirChange, dirDiff);
  }
  const level = (maxSpeedChange > 15 || maxDirChange > 45) ? 'red' :
                (maxSpeedChange > 8 || maxDirChange > 25) ? 'amber' : 'green';
  return { maxSpeedChange, maxDirChange, level };
}

// ============================================================
// Phase 4: Advanced Terrain Analysis & Mission Planning
// ============================================================

// --- Elevation Grid Generation ---

function generateElevationGrid(centerLat, centerLng, boundsNE, boundsSW, gridSize) {
  const points = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const t_lat = gridSize > 1 ? row / (gridSize - 1) : 0.5;
      const t_lng = gridSize > 1 ? col / (gridSize - 1) : 0.5;
      const latitude  = boundsSW.lat + t_lat * (boundsNE.lat - boundsSW.lat);
      const longitude = boundsSW.lng + t_lng * (boundsNE.lng - boundsSW.lng);
      points.push({ latitude, longitude });
    }
  }
  return points;
}

// --- Slope Calculation from Grid ---

function calcSlopeFromGrid(elevationsFt, gridSize, cellSizeKm) {
  const cellSizeFt = cellSizeKm * 3280.84; // km -> ft
  const slopeGrid = [];

  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (r === 0 || r === gridSize - 1 || c === 0 || c === gridSize - 1) {
        slopeGrid.push(null); // edge cell — no full neighborhood
        continue;
      }
      const idx = r * gridSize + c;
      const dz_dx = (elevationsFt[idx + 1] - elevationsFt[idx - 1]) / (2 * cellSizeFt);
      const dz_dy = (elevationsFt[(r + 1) * gridSize + c] - elevationsFt[(r - 1) * gridSize + c]) / (2 * cellSizeFt);
      const slopeRad = Math.atan(Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy));
      slopeGrid.push(slopeRad * 180 / Math.PI);
    }
  }

  const interior = slopeGrid.filter(v => v !== null);
  const avgSlopeDeg = interior.length > 0 ? interior.reduce((s, v) => s + v, 0) / interior.length : 0;
  const maxSlopeDeg = interior.length > 0 ? Math.max(...interior) : 0;

  return { avgSlopeDeg, maxSlopeDeg, slopeGrid };
}

// --- Dominant Aspect ---

function calcAspect(elevationsFt, gridSize) {
  if (gridSize < 2) return 'flat';

  // Compute average elevation of each edge
  let northAvg = 0, southAvg = 0, eastAvg = 0, westAvg = 0;
  for (let c = 0; c < gridSize; c++) {
    northAvg += elevationsFt[c];                           // top row (north)
    southAvg += elevationsFt[(gridSize - 1) * gridSize + c]; // bottom row (south)
  }
  for (let r = 0; r < gridSize; r++) {
    westAvg += elevationsFt[r * gridSize];                 // left col (west)
    eastAvg += elevationsFt[r * gridSize + gridSize - 1];  // right col (east)
  }
  northAvg /= gridSize;
  southAvg /= gridSize;
  eastAvg  /= gridSize;
  westAvg  /= gridSize;

  // Gradient vector: points downhill from high to low
  const dx = eastAvg - westAvg;   // positive = slopes east (higher west, faces east)
  const dy = northAvg - southAvg; // positive = slopes north (higher south, faces north)

  const threshold = 5; // ft — below this consider flat
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return 'flat';

  // Aspect angle: direction the slope faces (downhill direction)
  // atan2 with negated dy because grid north row = index 0 but elevation increase going south means slope faces north
  const angleDeg = ((Math.atan2(-dx, -dy) * 180 / Math.PI) + 360) % 360;

  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(angleDeg / 45) % 8;
  return dirs[idx];
}

// --- Terrain Feature Detection ---

function detectTerrainFeatures(elevationsFt, gridSize, rangeFt) {
  const features = [];
  let hasCanyons = false, hasRidges = false, hasFunneling = false;

  if (gridSize < 3) {
    return { hasCanyons, hasRidges, hasFunneling, features };
  }

  // Center row/col averages vs edge averages
  const midRow = Math.floor(gridSize / 2);
  const midCol = Math.floor(gridSize / 2);

  let centerRowAvg = 0, topRowAvg = 0, bottomRowAvg = 0;
  for (let c = 0; c < gridSize; c++) {
    centerRowAvg += elevationsFt[midRow * gridSize + c];
    topRowAvg    += elevationsFt[c];
    bottomRowAvg += elevationsFt[(gridSize - 1) * gridSize + c];
  }
  centerRowAvg /= gridSize;
  topRowAvg    /= gridSize;
  bottomRowAvg /= gridSize;

  let centerColAvg = 0, leftColAvg = 0, rightColAvg = 0;
  for (let r = 0; r < gridSize; r++) {
    centerColAvg += elevationsFt[r * gridSize + midCol];
    leftColAvg   += elevationsFt[r * gridSize];
    rightColAvg  += elevationsFt[r * gridSize + gridSize - 1];
  }
  centerColAvg /= gridSize;
  leftColAvg   /= gridSize;
  rightColAvg  /= gridSize;

  const edgeRowAvg = (topRowAvg + bottomRowAvg) / 2;
  const edgeColAvg = (leftColAvg + rightColAvg) / 2;
  const canyonThreshold = rangeFt * 0.25;

  // Canyon: center significantly lower than edges
  if (edgeRowAvg - centerRowAvg > canyonThreshold || edgeColAvg - centerColAvg > canyonThreshold) {
    hasCanyons = true;
    features.push('Canyon/valley — center lower than edges');
  }

  // Ridge: center significantly higher than edges
  if (centerRowAvg - edgeRowAvg > canyonThreshold || centerColAvg - edgeColAvg > canyonThreshold) {
    hasRidges = true;
    features.push('Ridge/crest — center higher than edges');
  }

  // Funneling: two sides high, two sides low (creates wind funneling)
  const nsHigh = topRowAvg > centerRowAvg && bottomRowAvg > centerRowAvg;
  const ewLow  = leftColAvg < centerColAvg || rightColAvg < centerColAvg;
  const ewHigh = leftColAvg > centerColAvg && rightColAvg > centerColAvg;
  const nsLow  = topRowAvg < centerColAvg || bottomRowAvg < centerColAvg;

  if ((nsHigh && ewLow) || (ewHigh && nsLow)) {
    if (rangeFt > 200) {
      hasFunneling = true;
      features.push('Terrain funneling — aligned slopes may accelerate wind');
    }
  }

  return { hasCanyons, hasRidges, hasFunneling, features };
}

// --- LZ Fitness Scoring ---

function scoreLZFitness(elevFt, slopeDeg, vegetationType) {
  // Slope score
  let slopeScore;
  if (slopeDeg < 5)       slopeScore = 1.0;
  else if (slopeDeg < 10) slopeScore = 0.6;
  else if (slopeDeg < 15) slopeScore = 0.3;
  else                     slopeScore = 0.0;

  // Vegetation score — ordered longest-key-first to avoid substring false matches
  // (e.g. 'subalpine' contains 'pine', so check subalpine before pine)
  const vegEntries = [
    ['mixed conifer', 0.1],
    ['oak woodland', 0.6],
    ['subalpine', 0.5],
    ['grassland', 1.0],
    ['pine', 0.3],
  ];
  const vegLower = (vegetationType || '').toLowerCase();
  let vegScore = 0.5; // default for unknown
  for (const [key, score] of vegEntries) {
    if (vegLower.includes(key)) { vegScore = score; break; }
  }

  // Elevation penalty: >8000 ft thin air
  let elevPenalty = 1.0;
  if (elevFt > 10000) elevPenalty = 0.7;
  else if (elevFt > 8000) elevPenalty = 0.85;

  // Weighted average: slope most important (50%), veg (30%), elevation (20%)
  return slopeScore * 0.5 + vegScore * 0.3 + elevPenalty * 0.2;
}

// --- Find Emergency LZs ---

function findEmergencyLZs(elevPoints, gridSize, cellSizeKm) {
  if (!elevPoints || elevPoints.length === 0) return [];

  const cellSizeFt = cellSizeKm * 3280.84;
  const candidates = [];

  for (let i = 0; i < elevPoints.length; i++) {
    const pt = elevPoints[i];
    const r = Math.floor(i / gridSize);
    const c = i % gridSize;

    // Only score interior points where we can calculate slope from neighbors
    if (r === 0 || r === gridSize - 1 || c === 0 || c === gridSize - 1) continue;

    const dz_dx = (elevPoints[i + 1].elevFt - elevPoints[i - 1].elevFt) / (2 * cellSizeFt);
    const dz_dy = (elevPoints[(r + 1) * gridSize + c].elevFt - elevPoints[(r - 1) * gridSize + c].elevFt) / (2 * cellSizeFt);
    const slopeDeg = Math.atan(Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy)) * 180 / Math.PI;

    // Estimate vegetation from elevation
    const vegType = pt.elevFt > 7000 ? 'subalpine' :
                    pt.elevFt > 5000 ? 'mixed conifer' :
                    pt.elevFt > 3000 ? 'pine' :
                    pt.elevFt > 1500 ? 'oak woodland' : 'grassland';

    const score = scoreLZFitness(pt.elevFt, slopeDeg, vegType);
    if (score > 0.6) {
      let description = `Elev ${Math.round(pt.elevFt)} ft, slope ${slopeDeg.toFixed(1)} deg`;
      if (slopeDeg < 5) description += ', flat terrain';
      else if (slopeDeg < 10) description += ', moderate slope';
      else description += ', steep slope';

      candidates.push({
        lat: pt.lat,
        lng: pt.lng,
        elevFt: pt.elevFt,
        score: Math.round(score * 100) / 100,
        slopeDeg: Math.round(slopeDeg * 10) / 10,
        description,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}

// --- Terrain Turbulence Assessment ---

function assessTerrainTurbulence(elevationsFt, gridSize, rangeFt, windDirDeg, windSpeedMph) {
  const factors = [];
  let riskScore = 0;

  if (!windSpeedMph || windSpeedMph === 0) {
    return { risk: 'low', factors: ['Calm winds — minimal turbulence'], level: 'green' };
  }

  const terrain = detectTerrainFeatures(elevationsFt, gridSize, rangeFt);

  // Base terrain contribution
  if (rangeFt > 1000) { riskScore += 2; factors.push(`High terrain relief (${rangeFt} ft range)`); }
  else if (rangeFt > 500) { riskScore += 1; factors.push(`Moderate terrain relief (${rangeFt} ft range)`); }

  // Wind speed contribution
  if (windSpeedMph > 25) { riskScore += 3; factors.push(`Strong winds (${windSpeedMph} mph)`); }
  else if (windSpeedMph > 15) { riskScore += 2; factors.push(`Moderate winds (${windSpeedMph} mph)`); }
  else if (windSpeedMph > 8) { riskScore += 1; factors.push(`Light winds (${windSpeedMph} mph)`); }

  // Ridge + wind interaction
  if (terrain.hasRidges && windSpeedMph > 10) {
    // Determine ridge orientation from aspect
    const aspect = calcAspect(elevationsFt, gridSize);
    const aspectDeg = { 'N': 0, 'NE': 45, 'E': 90, 'SE': 135, 'S': 180, 'SW': 225, 'W': 270, 'NW': 315 }[aspect];
    if (aspectDeg !== undefined) {
      let angleDiff = Math.abs(windDirDeg - aspectDeg);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;
      if (angleDiff < 45) {
        riskScore += 3;
        factors.push('Wind perpendicular to ridge — lee-side turbulence/rotor likely');
      } else if (angleDiff < 90) {
        riskScore += 1;
        factors.push('Wind oblique to ridge — some turbulence expected');
      }
    }
  }

  // Canyon + wind funneling
  if (terrain.hasCanyons && windSpeedMph > 10) {
    riskScore += 2;
    factors.push('Canyon terrain may accelerate/channel winds');
  }
  if (terrain.hasFunneling && windSpeedMph > 10) {
    riskScore += 2;
    factors.push('Terrain funneling likely — expect gusty conditions');
  }

  let risk, level;
  if (riskScore >= 5) { risk = 'high'; level = 'red'; }
  else if (riskScore >= 3) { risk = 'moderate'; level = 'amber'; }
  else { risk = 'low'; level = 'green'; }

  if (factors.length === 0) factors.push('Minimal terrain/wind interaction');

  return { risk, factors, level };
}

// --- GPS Terrain Masking ---

function analyzeGPSMasking(centerElevFt, elevPoints, gridSize, flightAltAGL) {
  if (!elevPoints || elevPoints.length === 0) {
    return { maskedDirections: [], skyVisibilityPct: 100, description: 'No terrain data — assuming clear sky view' };
  }

  const GPS_MASK_ANGLE = 15; // degrees — typical GPS mask angle
  const centerR = Math.floor(gridSize / 2);
  const centerC = Math.floor(gridSize / 2);
  const flightElevFt = centerElevFt + flightAltAGL;

  // Direction mapping: for each compass direction, which edge cells to check
  const directions = {
    'N':  { rows: [0],              cols: null },                     // top row
    'NE': { rows: [0],              cols: [gridSize - 1] },          // top-right corner
    'E':  { rows: null,             cols: [gridSize - 1] },          // right col
    'SE': { rows: [gridSize - 1],   cols: [gridSize - 1] },          // bottom-right corner
    'S':  { rows: [gridSize - 1],   cols: null },                     // bottom row
    'SW': { rows: [gridSize - 1],   cols: [0] },                     // bottom-left corner
    'W':  { rows: null,             cols: [0] },                      // left col
    'NW': { rows: [0],              cols: [0] },                      // top-left corner
  };

  const maskedDirections = [];

  for (const [dir, spec] of Object.entries(directions)) {
    let maxAngle = -Infinity;

    // Collect edge points for this direction
    const points = [];
    if (spec.rows !== null && spec.cols !== null) {
      // Corner: specific cell(s)
      for (const r of spec.rows) {
        for (const c of spec.cols) {
          points.push({ r, c, idx: r * gridSize + c });
        }
      }
    } else if (spec.rows !== null) {
      // Full row
      for (const r of spec.rows) {
        for (let c = 0; c < gridSize; c++) {
          points.push({ r, c, idx: r * gridSize + c });
        }
      }
    } else if (spec.cols !== null) {
      // Full column
      for (const c of spec.cols) {
        for (let r = 0; r < gridSize; r++) {
          points.push({ r, c, idx: r * gridSize + c });
        }
      }
    }

    for (const pt of points) {
      const terrainElev = elevPoints[pt.idx].elevFt !== undefined ? elevPoints[pt.idx].elevFt :
                          (typeof elevPoints[pt.idx] === 'number' ? elevPoints[pt.idx] : 0);
      const dRow = pt.r - centerR;
      const dCol = pt.c - centerC;
      const cellDist = Math.sqrt(dRow * dRow + dCol * dCol);
      if (cellDist === 0) continue;

      // Elevation angle from flight altitude to terrain point
      const rise = terrainElev - flightElevFt;
      // Use cell distance as proportional measure (actual distance scaling cancels out in angle)
      const angle = Math.atan2(rise, cellDist) * 180 / Math.PI;
      maxAngle = Math.max(maxAngle, angle);
    }

    if (maxAngle > GPS_MASK_ANGLE) {
      maskedDirections.push(dir);
    }
  }

  const skyVisibilityPct = Math.round((8 - maskedDirections.length) / 8 * 100);

  let description;
  if (maskedDirections.length === 0) {
    description = 'Good sky visibility — no significant terrain masking';
  } else if (maskedDirections.length <= 2) {
    description = `Partial GPS masking from ${maskedDirections.join(', ')} — plan for reduced accuracy`;
  } else if (maskedDirections.length <= 4) {
    description = `Significant GPS masking from ${maskedDirections.join(', ')} — reduced satellite count likely`;
  } else {
    description = `Severe GPS masking from ${maskedDirections.join(', ')} — GPS reliability compromised`;
  }

  return { maskedDirections, skyVisibilityPct, description };
}

// --- Battery Swap Recommendation ---

function calcSwapRecommendation(estFlightTimeMin, cruiseSpeedMph, lzs) {
  const swapTimeMin = estFlightTimeMin * 0.70;
  const swapRadiusKm = (cruiseSpeedMph * swapTimeMin / 60) * 1.609 / 2;

  let nearestLZ = null;
  if (lzs && lzs.length > 0) {
    // Find highest-scored LZ (already sorted by score in findEmergencyLZs)
    nearestLZ = { lat: lzs[0].lat, lng: lzs[0].lng, score: lzs[0].score };
  }

  let recommendation;
  if (swapTimeMin < 5) {
    recommendation = `Very short endurance (${swapTimeMin.toFixed(0)} min to swap) — limited operational range`;
  } else if (nearestLZ) {
    recommendation = `Swap at ${swapTimeMin.toFixed(0)} min (${swapRadiusKm.toFixed(1)} km radius). LZ available (score: ${nearestLZ.score})`;
  } else {
    recommendation = `Swap at ${swapTimeMin.toFixed(0)} min (${swapRadiusKm.toFixed(1)} km radius). No suitable LZ found — plan manual recovery`;
  }

  return { swapTimeMin, swapRadiusKm, nearestLZ, recommendation };
}

// ============================================================
// ADS-B HELPERS
// ============================================================

/**
 * Compute search radius (NM) from operational area bounds + 10 NM buffer.
 * Uses point+radius API format — finds farthest corner from center.
 */
function computeAdsbSearchRadius(centerLat, centerLng, ne, sw) {
  const corners = [
    [ne.lat, ne.lng],           // NE
    [ne.lat, sw.lng],           // NW
    [sw.lat, ne.lng],           // SE
    [sw.lat, sw.lng],           // SW
  ];
  let maxKm = 0;
  for (const [lat, lng] of corners) {
    const d = haversine(centerLat, centerLng, lat, lng);
    if (d > maxKm) maxKm = d;
  }
  const nm = maxKm / 1.852;
  const buffered = nm + 10;   // 10 NM buffer for approaching aircraft
  return Math.ceil(Math.min(Math.max(buffered, 15), 50));
}

/**
 * Parse raw ADS-B API response into normalized, sorted aircraft array.
 * Filters stale positions, computes distance and AGL.
 */
// groundElev may be either a fixed elevation in feet (legacy single-point AGL,
// the AOI-centre elevation) OR a function (lat, lng) => elevationFt that returns
// the terrain elevation directly under each aircraft. The function form lets AGL
// reflect the ground beneath the plane rather than the operating site; it should
// return null/NaN when it has no data for that point so we can fall back to 0.
function parseAdsbAircraft(acArray, centerLat, centerLng, groundElev) {
  if (!Array.isArray(acArray)) return [];
  const groundFn = typeof groundElev === 'function'
    ? groundElev
    : () => (typeof groundElev === 'number' ? groundElev : 0);
  return acArray
    .filter(ac => ac.lat != null && ac.lon != null && (ac.seen_pos == null || ac.seen_pos <= 60))
    .map(ac => {
      const altBaro = ac.alt_baro === 'ground' ? 0 : (typeof ac.alt_baro === 'number' ? ac.alt_baro : null);
      const altGeom = typeof ac.alt_geom === 'number' ? ac.alt_geom : null;
      const alt = altBaro != null ? altBaro : (altGeom != null ? altGeom : 0);
      let groundElevFt = groundFn(ac.lat, ac.lon);
      if (groundElevFt == null || !isFinite(groundElevFt)) groundElevFt = 0;
      const agl = Math.max(0, alt - groundElevFt);
      const distKm = haversine(centerLat, centerLng, ac.lat, ac.lon);
      return {
        hex: ac.hex || '',
        flight: (ac.flight || '').trim(),
        reg: ac.r || '',
        type: ac.t || '',
        lat: ac.lat,
        lon: ac.lon,
        alt_baro: altBaro,
        alt_geom: altGeom,
        groundElevFt: Math.round(groundElevFt),
        agl: Math.round(agl),
        gs: ac.gs != null ? ac.gs : null,
        track: ac.track != null ? ac.track : null,
        baro_rate: ac.baro_rate != null ? ac.baro_rate : null,
        squawk: ac.squawk || '',
        emergency: ac.emergency || 'none',
        seen: ac.seen != null ? ac.seen : null,
        seen_pos: ac.seen_pos != null ? ac.seen_pos : null,
        distNm: +(distKm / 1.852).toFixed(1),
      };
    })
    .sort((a, b) => a.distNm - b.distNm);
}

/**
 * Format AGL altitude for compact icon labels.
 */
function formatAltitudeAgl(aglFt) {
  if (aglFt <= 0) return 'GND';
  if (aglFt < 1000) return String(Math.round(aglFt));
  return (aglFt / 1000).toFixed(1) + 'k';
}

// ============================================================
// TFR / NOTAM IMPORT — pure helpers (no DOM/Leaflet except DOMParser-guarded)
// Polygons use [lat, lng] vertex order to match the KML parser convention.
// ============================================================

// --- Geometry ---

function pointInPolygon(lat, lng, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1];
    const yj = poly[j][0], xj = poly[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonBBox(poly) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const p of poly) {
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLng) minLng = p[1];
    if (p[1] > maxLng) maxLng = p[1];
  }
  return { minLat, minLng, maxLat, maxLng };
}

function bboxesOverlap(a, b) {
  return a.minLat <= b.maxLat && a.maxLat >= b.minLat &&
         a.minLng <= b.maxLng && a.maxLng >= b.minLng;
}

// Segment intersection via orientation tests. Points are [lat, lng] = [y, x].
function segmentsIntersect(p1, p2, p3, p4) {
  function ccw(a, b, c) {
    return (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
  }
  const d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2);
  const d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// True if two rings overlap: bbox prefilter, then vertex-containment (both
// directions, catches full containment), then edge crossing (partial overlap).
function polygonsIntersect(a, b) {
  if (!a || !b || a.length < 3 || b.length < 3) return false;
  if (!bboxesOverlap(polygonBBox(a), polygonBBox(b))) return false;
  for (const p of a) if (pointInPolygon(p[0], p[1], b)) return true;
  for (const p of b) if (pointInPolygon(p[0], p[1], a)) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

// Approximate a circle (meters) as a closed ring of [lat,lng] vertices.
function circleToPolygon(lat, lng, radiusM, segments) {
  segments = segments || 24;
  const R = 6371000;
  const latR = lat * Math.PI / 180, lngR = lng * Math.PI / 180;
  const dByR = radiusM / R;
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const brng = 2 * Math.PI * i / segments;
    const lat2 = Math.asin(Math.sin(latR) * Math.cos(dByR) +
      Math.cos(latR) * Math.sin(dByR) * Math.cos(brng));
    const lng2 = lngR + Math.atan2(
      Math.sin(brng) * Math.sin(dByR) * Math.cos(latR),
      Math.cos(dByR) - Math.sin(latR) * Math.sin(lat2));
    pts.push([lat2 * 180 / Math.PI, lng2 * 180 / Math.PI]);
  }
  pts.push(pts[0]);
  return pts;
}

// Even-odd point-in-rings test — handles polygons with holes and multipolygons.
// `rings` is an array of rings, each ring an array of [lat, lng] points. A point
// inside an odd number of rings is inside the polygon (so holes subtract).
function pointInRings(lat, lng, rings) {
  if (!rings || !rings.length) return false;
  let count = 0;
  for (const ring of rings) {
    if (pointInPolygon(lat, lng, ring)) count++;
  }
  return (count % 2) === 1;
}

// Shortest distance from point P to segment AB in a flat (e.g. pixel) plane.
// Used for hit-testing clicks against polylines.
function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ============================================================
// PUBLIC vs PRIVATE LAND (BLM Surface Management Agency classification)
// The BLM National SMA layer assigns every surface a managing-agency code.
// PVT (private) and UND (undetermined) are the only non-public codes; everything
// else (BLM/USFS/NPS/FWS, state, local, tribal, military, other federal) is
// public/managed land. Used to flag when an operating area is partly on private
// land (advisory — "verify landowner permission", never an auto NO-GO).
// ============================================================

const SMA_NONPUBLIC_CODES = new Set(['PVT', 'UND', '']);

// Map an SMA ADMIN_AGENCY_CODE to a display label, map color, and public flag.
function smaAgencyInfo(code) {
  const c = String(code == null ? '' : code).toUpperCase().trim();
  const PUB = {
    BLM: ['Bureau of Land Management', '#f4a460'], USFS: ['US Forest Service', '#2e8b3d'],
    USDA: ['USDA', '#2e8b3d'], NPS: ['National Park Service', '#5b8c3e'],
    FWS: ['US Fish & Wildlife', '#3aa17e'], USBR: ['Bureau of Reclamation', '#4682b4'],
    USACE: ['Army Corps of Engineers', '#4f7fb5'], DOE: ['Dept. of Energy', '#5f9ea0'],
    DOD: ['Dept. of Defense', '#6b8e9e'], ARMY: ['US Army', '#6b8e9e'],
    NAVY: ['US Navy', '#6b8e9e'], USAF: ['US Air Force', '#6b8e9e'],
    USMC: ['US Marine Corps', '#6b8e9e'], USCG: ['US Coast Guard', '#6b8e9e'],
    BIA: ['Bureau of Indian Affairs', '#cd853f'], NTVALL: ['Tribal Land', '#cd853f'],
    NTVPIC: ['Tribal Land', '#cd853f'], ST: ['State', '#9370db'],
    LG: ['Local Government', '#7b68ee'], VA: ['Veterans Affairs', '#5f9ea0'],
    DOI: ['Dept. of Interior', '#5f9ea0'], DOT: ['Dept. of Transportation', '#5f9ea0'],
    FAA: ['FAA', '#5f9ea0'], GSA: ['General Services Admin', '#5f9ea0'],
    BPA: ['Bonneville Power', '#5f9ea0'], BOP: ['Bureau of Prisons', '#5f9ea0'],
    NOAA: ['NOAA', '#5f9ea0'], USPS: ['US Postal Service', '#5f9ea0'],
    HHS: ['Health & Human Svcs', '#5f9ea0'], OTHFE: ['Other Federal', '#5f9ea0'],
    FHA: ['Federal Highway', '#5f9ea0'],
  };
  if (PUB[c]) return { code: c, label: PUB[c][0], color: PUB[c][1], isPublic: true };
  if (c === 'PVT') return { code: 'PVT', label: 'Private', color: '#b04a4a', isPublic: false };
  if (c === 'UND' || c === '') return { code: 'UND', label: 'Undetermined', color: '#8a8a8a', isPublic: false };
  // Unknown future code: treat as managed unless it's an explicit non-public code.
  return { code: c, label: c, color: '#6b9e8e', isPublic: !SMA_NONPUBLIC_CODES.has(c) };
}

function smaIsPublic(code) { return smaAgencyInfo(code).isPublic; }

// What fraction of an operating area falls on non-public land.
// aoiRing: closed ring of [lat,lng]; publicRings: flat array of public-land rings
// ([lat,lng] each). Lays an n×n lattice over the AOI bbox, keeps the points inside
// the AOI, and counts a point private when it is inside ZERO public rings. Callers
// should suppress the caution when there was no public data at all (no coverage ≠
// private) — check `anyPublic`/the feature count before trusting privateFrac.
function classifyAreaPublicPrivate(aoiRing, publicRings, n) {
  n = n || 11;
  const res = { sampled: 0, privateCount: 0, privateFrac: 0, anyPublic: !!(publicRings && publicRings.length) };
  if (!aoiRing || aoiRing.length < 3) return res;
  const bb = polygonBBox(aoiRing);
  const span = (n > 1) ? (n - 1) : 1;
  const latStep = (bb.maxLat - bb.minLat) / span;
  const lngStep = (bb.maxLng - bb.minLng) / span;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const lat = bb.minLat + i * latStep;
      const lng = bb.minLng + j * lngStep;
      if (!pointInPolygon(lat, lng, aoiRing)) continue;
      res.sampled++;
      let isPublic = false;
      for (const ring of (publicRings || [])) {
        if (pointInPolygon(lat, lng, ring)) { isPublic = true; break; }
      }
      if (!isPublic) res.privateCount++;
    }
  }
  res.privateFrac = res.sampled ? res.privateCount / res.sampled : 0;
  return res;
}

// Per-carrier LTE coverage at a point. `carriers` is { att, tmobile, verizon },
// each a flat array of coverage rings ([lat,lng]). Returns booleans + a count.
function cellCoverageAt(lat, lng, carriers) {
  const out = { att: false, tmobile: false, verizon: false, count: 0, anyCovered: false };
  if (!carriers) return out;
  ['att', 'tmobile', 'verizon'].forEach(k => {
    const rings = carriers[k];
    if (rings && rings.length) {
      for (const ring of rings) { if (pointInPolygon(lat, lng, ring)) { out[k] = true; break; } }
    }
    if (out[k]) out.count++;
  });
  out.anyCovered = out.count > 0;
  return out;
}

// --- Coordinate parsing ---

// Parse an FAA coordinate. Handles two FAA encodings:
//  - decimal degrees with trailing hemisphere: "120.01666667W" -> -120.0166...
//  - packed DMS with trailing hemisphere:      "1200100W" (DDDMMSS) -> -120.0166...
// A leading "-" is also honored. Returns NaN on failure.
function parseFaaCoord(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  let sign = 1;
  const last = s.charAt(s.length - 1).toUpperCase();
  if (last === 'N' || last === 'S' || last === 'E' || last === 'W') {
    if (last === 'S' || last === 'W') sign = -1;
    s = s.slice(0, -1).trim();
  } else if (s.charAt(0) === '-') {
    sign = -1; s = s.slice(1);
  }
  s = s.replace(/[^0-9.]/g, '');
  if (!s) return NaN;
  const dotIdx = s.indexOf('.');
  const intLen = (dotIdx === -1 ? s.length : dotIdx);
  // Decimal degrees: 2-3 integer digits (lat <=90, lon <=180)
  if (dotIdx !== -1 && intLen <= 3) {
    const v = parseFloat(s);
    return isNaN(v) ? NaN : sign * v;
  }
  if (dotIdx === -1 && intLen <= 3) {
    const v = parseFloat(s);
    return isNaN(v) ? NaN : sign * v;
  }
  // Packed DMS: trailing 2 digits = seconds, next 2 = minutes, rest = degrees
  const intPart = dotIdx === -1 ? s : s.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? '' : s.slice(dotIdx);
  let deg, min, sec;
  if (intPart.length >= 5) {
    sec = parseInt(intPart.slice(-2), 10) + (fracPart ? parseFloat('0' + fracPart) : 0);
    min = parseInt(intPart.slice(-4, -2), 10);
    deg = parseInt(intPart.slice(0, -4), 10);
  } else {
    sec = 0;
    min = parseInt(intPart.slice(-2), 10);
    deg = parseInt(intPart.slice(0, -2), 10);
  }
  if (isNaN(deg) || isNaN(min) || isNaN(sec)) return NaN;
  return sign * (deg + min / 60 + sec / 3600);
}

// Normalize an FAA date string to an ISO-8601 instant. Detail-XML times are
// emitted without an offset but flagged UTC, so assume Z when none is present.
function normalizeFaaDate(s) {
  if (!s) return null;
  s = String(s).trim();
  if (!s) return null;
  if (/[Zz]$|[+\-]\d{2}:?\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s + 'Z';
  return s;
}

// --- TFR ingest ---

// Outer rings of a GeoJSON geometry, as [lat,lng] (GeoJSON stores [lng,lat]).
function geoJsonOuterRings(geom) {
  if (!geom) return [];
  const swap = ring => ring.map(c => [c[1], c[0]]);
  if (geom.type === 'Polygon') {
    return (geom.coordinates && geom.coordinates[0]) ? [swap(geom.coordinates[0])] : [];
  }
  if (geom.type === 'MultiPolygon') {
    return (geom.coordinates || [])
      .map(poly => (poly && poly[0]) ? swap(poly[0]) : null)
      .filter(Boolean);
  }
  return [];
}

// Normalized TFR shape produced by every parser:
// { id, name, type, artcc, state, lowerAlt, upperAlt, altUom,
//   effectiveStart, effectiveEnd, reason, source, polygons:[[ [lat,lng], ... ]] }

// Parse the GeoServer GeoJSON (TFR:V_TFR_LOC) — primary, geometry-bearing path.
// Also accepts the exportTfrList array shape (delegates to parseTfrList).
function parseTfrGeoJson(input) {
  const errors = [], tfrs = [];
  let obj;
  try { obj = (typeof input === 'string') ? JSON.parse(input) : input; }
  catch (e) { return { tfrs, errors: ['Invalid JSON: ' + (e.message || e)] }; }
  if (!obj) return { tfrs, errors: ['Empty input'] };
  if (Array.isArray(obj)) return parseTfrList(obj);
  let features = null;
  if (obj.type === 'FeatureCollection') features = obj.features || [];
  else if (obj.type === 'Feature') features = [obj];
  else if (Array.isArray(obj.features)) features = obj.features;
  if (!features) return { tfrs, errors: ['Not a GeoJSON FeatureCollection or TFR list'] };
  features.forEach((f, idx) => {
    try {
      const p = f.properties || {};
      const polygons = geoJsonOuterRings(f.geometry);
      if (!polygons.length) return;
      const key = p.NOTAM_KEY || p.notam_id || p.NOTAM || '';
      const id = key ? String(key).split('-')[0] : ('TFR-' + (idx + 1));
      tfrs.push({
        id,
        name: p.TITLE || p.NAME || p.description || id,
        type: p.LEGAL || p.type || p.TYPE_CODE || '',
        artcc: p.CNS_LOCATION_ID || p.facility || '',
        state: p.STATE || p.state || '',
        lowerAlt: null, upperAlt: null, altUom: null,
        effectiveStart: null, effectiveEnd: null,
        reason: p.TITLE || '',
        source: 'geojson',
        polygons,
      });
    } catch (e) { errors.push('Feature ' + idx + ': ' + (e.message || e)); }
  });
  return { tfrs, errors };
}

// Parse the exportTfrList JSON (no geometry — informational list only).
function parseTfrList(input) {
  const errors = [], tfrs = [];
  let arr;
  try { arr = (typeof input === 'string') ? JSON.parse(input) : input; }
  catch (e) { return { tfrs, errors: ['Invalid JSON: ' + (e.message || e)] }; }
  if (!Array.isArray(arr)) return { tfrs, errors: ['Expected a TFR list array'] };
  arr.forEach((e, idx) => {
    const id = e.notam_id || e.NOTAM_ID || ('TFR-' + (idx + 1));
    tfrs.push({
      id: String(id),
      name: e.description || e.TITLE || String(id),
      type: e.type || e.TYPE || '',
      artcc: e.facility || e.FACILITY || '',
      state: e.state || e.STATE || '',
      lowerAlt: null, upperAlt: null, altUom: null,
      effectiveStart: null, effectiveEnd: null,
      reason: e.description || '',
      source: 'list',
      polygons: [],
    });
  });
  return { tfrs, errors };
}

function _tagText(el, tag) {
  if (!el) return null;
  const n = el.getElementsByTagName(tag);
  return n.length ? (n[0].textContent || '').trim() : null;
}

function _avxRing(parent) {
  const ring = [];
  const avxs = parent.getElementsByTagName('Avx');
  for (let v = 0; v < avxs.length; v++) {
    const lat = parseFaaCoord(_tagText(avxs[v], 'geoLat'));
    const lng = parseFaaCoord(_tagText(avxs[v], 'geoLong'));
    if (!isNaN(lat) && !isNaN(lng)) ring.push([lat, lng]);
  }
  return ring;
}

function _extractDetailPolygons(not) {
  const polys = [];
  const areas = not.getElementsByTagName('abdMergedArea');
  for (let a = 0; a < areas.length; a++) {
    const ring = _avxRing(areas[a]);
    if (ring.length >= 3) polys.push(ring);
  }
  const abds = not.getElementsByTagName('Abd');
  for (let a = 0; a < abds.length; a++) {
    const avxs = abds[a].getElementsByTagName('Avx');
    for (let v = 0; v < avxs.length; v++) {
      const ctNode = avxs[v].getElementsByTagName('codeType')[0];
      const ct = ctNode ? (ctNode.textContent || '').trim() : '';
      if (ct === 'CIR') {
        const lat = parseFaaCoord(_tagText(avxs[v], 'geoLat'));
        const lng = parseFaaCoord(_tagText(avxs[v], 'geoLong'));
        const rad = parseFloat(_tagText(avxs[v], 'valRadiusArc'));
        const uom = (_tagText(avxs[v], 'uomRadiusArc') || 'NM').toUpperCase();
        if (!isNaN(lat) && !isNaN(lng) && !isNaN(rad)) {
          const radM = uom === 'KM' ? rad * 1000 : rad * 1852;
          polys.push(circleToPolygon(lat, lng, radM, 36));
        }
      }
    }
  }
  if (polys.length === 0) {
    for (let a = 0; a < abds.length; a++) {
      const ring = _avxRing(abds[a]);
      if (ring.length >= 3) polys.push(ring);
    }
  }
  return polys;
}

// Normalize a parsed FAA "XNOTAM-Update" detail document (altitudes + times).
function normalizeTfrDetailDoc(doc) {
  const errors = [], tfrs = [];
  if (!doc) return { tfrs, errors: ['No document'] };
  const nots = doc.getElementsByTagName('Not');
  for (let i = 0; i < nots.length; i++) {
    try {
      const not = nots[i];
      const id = _tagText(not, 'txtLocalName') || _tagText(not, 'noSeqNo') || ('TFR-' + (i + 1));
      const upper = _tagText(not, 'valDistVerUpper');
      const lower = _tagText(not, 'valDistVerLower');
      const uom = _tagText(not, 'uomDistVerUpper') || _tagText(not, 'uomDistVerLower');
      const reason = _tagText(not, 'txtDescrPurpose') || _tagText(not, 'codeType') || '';
      tfrs.push({
        id: String(id),
        name: _tagText(not, 'txtNameTitle') || _tagText(not, 'txtNameCity') || reason || String(id),
        type: _tagText(not, 'codeType') || '',
        artcc: _tagText(not, 'codeFacility') || '',
        state: _tagText(not, 'txtNameUSState') || '',
        lowerAlt: lower != null ? Number(lower) : null,
        upperAlt: upper != null ? Number(upper) : null,
        altUom: uom || null,
        effectiveStart: normalizeFaaDate(_tagText(not, 'dateEffective')),
        effectiveEnd: normalizeFaaDate(_tagText(not, 'dateExpire')),
        reason,
        source: 'detail-xml',
        polygons: _extractDetailPolygons(not),
      });
    } catch (e) { errors.push('Not ' + i + ': ' + (e.message || e)); }
  }
  return { tfrs, errors };
}

// DOMParser-guarded wrapper around normalizeTfrDetailDoc.
function parseTfrDetailXml(str) {
  if (typeof str !== 'string') return { tfrs: [], errors: ['Expected XML string'] };
  if (typeof DOMParser === 'undefined') return { tfrs: [], errors: ['DOMParser unavailable'] };
  let doc;
  try { doc = new DOMParser().parseFromString(str, 'text/xml'); }
  catch (e) { return { tfrs: [], errors: ['XML parse error: ' + (e.message || e)] }; }
  if (doc.getElementsByTagName('parsererror').length) return { tfrs: [], errors: ['Malformed XML'] };
  return normalizeTfrDetailDoc(doc);
}

// TFRs whose geometry intersects the drawn area polygon.
function filterTfrsIntersectingArea(tfrs, areaPoly) {
  if (!Array.isArray(tfrs) || !areaPoly || areaPoly.length < 3) return [];
  return tfrs.filter(t => Array.isArray(t.polygons) &&
    t.polygons.some(ring => polygonsIntersect(ring, areaPoly)));
}

// Whether a TFR is active at the given instant. Null times => treat active
// (a missing window must never silently suppress a NO-GO).
function isTfrActiveNow(tfr, nowMs) {
  const now = (nowMs == null) ? Date.now() : nowMs;
  const start = tfr.effectiveStart ? Date.parse(tfr.effectiveStart) : NaN;
  const end = tfr.effectiveEnd ? Date.parse(tfr.effectiveEnd) : NaN;
  if (!isNaN(start) && now < start) return false;
  if (!isNaN(end) && now > end) return false;
  return true;
}

// --- NOTAM ingest (best-effort) ---

function _icaoDate(s) {
  if (!/^\d{10}$/.test(s)) return null;
  return `${2000 + +s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:00Z`;
}

function _parseOneNotam(block) {
  const obj = {
    id: '', location: '', type: '', body: block.trim(),
    effectiveStart: null, effectiveEnd: null,
    lowerAlt: null, upperAlt: null, lat: null, lng: null, polygons: [], source: 'text',
  };
  let m = block.match(/!\s*([A-Z]{3,4})\s+([A-Z0-9]+\/[A-Z0-9]+)/);
  if (m) { obj.location = m[1]; obj.id = m[2]; obj.type = 'FDC/domestic'; }
  const paren = block.match(/\(([A-Z]\d{4}\/\d{2})\b/); if (paren && !obj.id) obj.id = paren[1];
  const ntype = block.match(/\bNOTAM([NRC])\b/); if (ntype && !obj.type) obj.type = 'NOTAM' + ntype[1];
  const a = block.match(/\bA\)\s*([A-Z]{4})/); if (a) obj.location = obj.location || a[1];
  const q = block.match(/\bQ\)\s*([A-Z]{4})/); if (q && !obj.location) obj.location = q[1];
  const b1 = block.match(/\bB\)\s*(\d{10})/); if (b1) obj.effectiveStart = _icaoDate(b1[1]);
  const c1 = block.match(/\bC\)\s*(\d{10})/); if (c1) obj.effectiveEnd = _icaoDate(c1[1]);
  const idm = block.match(/\b([A-Z]\d{4}\/\d{2})\b/); if (idm && !obj.id) obj.id = idm[1];
  // ICAO F)/G) altitude fields
  const f1 = block.match(/\bF\)\s*([^\n]*?)(?=\s+[A-GQ]\)|$)/m); if (f1) obj.lowerAlt = f1[1].trim();
  const g1 = block.match(/\bG\)\s*([^\n]*?)(?=\s+[A-GQ]\)|$)/m); if (g1) obj.upperAlt = g1[1].trim();
  // Domestic altitude band, e.g. "SFC-2000FT AGL", "1000FT-FL180 MSL"
  if (obj.lowerAlt == null && obj.upperAlt == null) {
    const alt = block.match(/\b(SFC|GND|UNL|FL\d{2,3}|\d{3,5}\s?FT)\s?-\s?(SFC|GND|UNL|FL\d{2,3}|\d{3,5}\s?FT)(?:\s*(AGL|MSL))?/i);
    if (alt) {
      const ref = alt[3] ? ' ' + alt[3].toUpperCase() : '';
      obj.lowerAlt = alt[1].toUpperCase().replace(/\s+/g, '') + ref;
      obj.upperAlt = alt[2].toUpperCase().replace(/\s+/g, '') + ref;
    }
  }
  // Coordinates. Domestic NOTAMs express areas as a list of DMS vertices OR a
  // radius around a center point. DMS may carry decimal seconds (e.g. 382948.90N).
  const coordRe = /(\d{6}(?:\.\d+)?)([NS])\s*(\d{7}(?:\.\d+)?)([EW])/g;
  const verts = [];
  let cm;
  while ((cm = coordRe.exec(block)) !== null) {
    const lat = parseFaaCoord(cm[1] + cm[2]);
    const lng = parseFaaCoord(cm[3] + cm[4]);
    if (!isNaN(lat) && !isNaN(lng)) verts.push([lat, lng]);
  }
  // Circle: "5NM RADIUS OF <coord>" or "WI 5NM OF <coord>". The radius pattern is
  // \d*\.?\d+ so a leading-decimal radius like ".25NM" is captured as 0.25, not 25.
  const circ = block.match(/(\d*\.?\d+)\s*NM\s+RADIUS\s+OF\s+(\d{6}(?:\.\d+)?)([NS])\s*(\d{7}(?:\.\d+)?)([EW])/i)
            || block.match(/\bWI\s+(\d*\.?\d+)\s*NM\s+OF\s+(\d{6}(?:\.\d+)?)([NS])\s*(\d{7}(?:\.\d+)?)([EW])/i);
  if (circ) {
    const radNm = parseFloat(circ[1]);
    const clat = parseFaaCoord(circ[2] + circ[3]);
    const clng = parseFaaCoord(circ[4] + circ[5]);
    if (!isNaN(radNm) && !isNaN(clat) && !isNaN(clng)) {
      obj.polygons = [circleToPolygon(clat, clng, radNm * 1852, 32)];
      obj.lat = clat; obj.lng = clng;
    }
  }
  if (!obj.polygons.length && verts.length >= 3) {
    const ring = verts.slice();
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    obj.polygons = [ring];
    obj.lat = verts.reduce((s, v) => s + v[0], 0) / verts.length;
    obj.lng = verts.reduce((s, v) => s + v[1], 0) / verts.length;
  } else if (!obj.polygons.length && verts.length >= 1) {
    obj.lat = verts[0][0];
    obj.lng = verts[0][1];
  }
  // Domestic time window, e.g. "2601121600-2608220400" (YYMMDDHHMM-YYMMDDHHMM, UTC)
  if (!obj.effectiveStart && !obj.effectiveEnd) {
    const tr = block.match(/\b(\d{10})-(\d{10})\b/);
    if (tr) { obj.effectiveStart = _icaoDate(tr[1]); obj.effectiveEnd = _icaoDate(tr[2]); }
  }
  if (!obj.id) obj.id = '(unparsed)';
  return obj;
}

// Parse NOTAM text pasted/copied from the FAA NOTAM Search results page, or
// from an opened PDF/Excel, into normalized records. Tolerant of copied-page
// furniture and of records that are not blank-line separated.
// Parse a US "MM/DD/YYYY HHMM" date (optional trailing EST=estimated) to ISO UTC.
function _usDate(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/^PERM/i.test(s)) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})(\d{2})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:00Z` : null;
}

function parseNotamText(text) {
  const errors = [], notams = [];
  if (typeof text !== 'string' || !text.trim()) return { notams, errors };
  let raw = text.replace(/\r\n?/g, '\n');
  // Strip common copied-page furniture: page numbers, bare URLs, print timestamps.
  raw = raw.replace(/^[ \t]*Page \d+ of \d+.*$/gim, '')
           .replace(/^[ \t]*https?:\/\/\S+[ \t]*$/gim, '')
           .replace(/^[ \t]*\d{1,2}\/\d{1,2}\/\d{2,4},?[ \t]+\d{1,2}:\d{2}.*$/gim, '');

  // FAA NOTAM Search WEB-DISPLAY format: records delimited by a metadata header
  // like "<FAC>Number: 6/9738 Class: ProcedureStart Date UTC: 04/08/2026 1836End Date UTC: PERM".
  const headerRe = /([A-Z]{2,4})Number:\s*(\S+)\s+Class:\s*([A-Za-z]+?)Start Date UTC:\s*([\d/]+\s+\d{3,4})\s*End Date UTC:\s*([^\n]*)/g;
  const heads = [];
  let hm;
  while ((hm = headerRe.exec(raw)) !== null) {
    heads.push({ start: hm.index, end: headerRe.lastIndex, fac: hm[1], num: hm[2], cls: hm[3], sd: hm[4], ed: hm[5] });
  }
  if (heads.length) {
    // Any text before the first header is the tail of an un-captured NOTAM
    // (minus the "Digital NOTAM"/"Letter to Airmen" prefix that labels the first header).
    const lead = raw.slice(0, heads[0].start)
      .replace(/(?:Digital NOTAM|Letter to Airmen)\s*$/i, '').trim();
    if (lead && /[A-Z]{2,}/.test(lead)) { try { notams.push(_parseOneNotam(lead)); } catch (_) {} }
    heads.forEach((h, i) => {
      try {
        const bodyEnd = (i + 1 < heads.length) ? heads[i + 1].start : raw.length;
        let body = raw.slice(h.end, bodyEnd)
          .replace(/(?:Digital NOTAM|Letter to Airmen)\s*$/i, '').trim();
        const rec = _parseOneNotam(body || h.num);
        rec.id = h.num;
        rec.location = h.fac;
        rec.type = h.cls;
        if (!rec.effectiveStart) rec.effectiveStart = _usDate(h.sd);
        if (!rec.effectiveEnd) rec.effectiveEnd = _usDate(h.ed);
        notams.push(rec);
      } catch (e) { errors.push('Record ' + i + ': ' + (e.message || e)); }
    });
    return { notams, errors };
  }

  // RAW/ICAO format: blank-line separated blocks.
  let blocks = raw.split(/\n[ \t]*\n/).map(b => b.trim()).filter(Boolean);
  // Fallback: if it did not segment, split before NOTAM start markers.
  if (blocks.length <= 1) {
    const parts = raw.split(/\n(?=!\s*[A-Z]{3,4}\b|\([A-Z]\d{4}\/\d{2}\b|FDC\s+\d|[A-Z]{4}\s+[A-Z]\d{4}\/\d{2}\b)/)
      .map(b => b.trim()).filter(Boolean);
    if (parts.length > 1) blocks = parts;
  }
  blocks.forEach((b, idx) => {
    try { notams.push(_parseOneNotam(b)); }
    catch (e) { errors.push('Block ' + idx + ': ' + (e.message || e)); }
  });
  return { notams, errors };
}

// Minimal static identifier->coord fallback for offline NOTAM geolocation.
const ARTCC_REF = {
  KSMF: [38.6954, -121.5908], KSAC: [38.5125, -121.4935], KMCC: [38.6676, -121.4008],
  KPVF: [38.7243, -120.7533], KTRK: [39.3200, -120.1396], KOAK: [37.7213, -122.2207],
  KSFO: [37.6213, -122.3790], KRNO: [39.4991, -119.7681], ZOA: [38.5, -121.5],
};

// Best-effort: set notam.lat/lng from embedded coords, live airports, or fallback.
function geolocateNotam(notam, airports) {
  if (!notam) return notam;
  if (notam.lat != null && notam.lng != null && !isNaN(notam.lat) && !isNaN(notam.lng)) return notam;
  const loc = (notam.location || '').toUpperCase();
  if (loc && Array.isArray(airports)) {
    const hit = airports.find(a => (a.icao || '').toUpperCase() === loc);
    if (hit) { notam.lat = hit.lat; notam.lng = hit.lng; return notam; }
  }
  if (loc && ARTCC_REF[loc]) { notam.lat = ARTCC_REF[loc][0]; notam.lng = ARTCC_REF[loc][1]; }
  return notam;
}

// --- ARTCC scoping for deep-links (approximate; for human-readable labels) ---

const ARTCC_BOUNDS = [
  { id: 'ZOA', name: 'Oakland Center',     bbox: { minLat: 36.4, maxLat: 42.1, minLng: -124.6, maxLng: -119.4 } },
  { id: 'ZLA', name: 'Los Angeles Center', bbox: { minLat: 32.0, maxLat: 37.2, minLng: -121.6, maxLng: -114.0 } },
  { id: 'ZSE', name: 'Seattle Center',     bbox: { minLat: 42.0, maxLat: 49.1, minLng: -125.0, maxLng: -116.0 } },
  { id: 'ZLC', name: 'Salt Lake Center',   bbox: { minLat: 37.0, maxLat: 44.5, minLng: -119.3, maxLng: -109.0 } },
  { id: 'ZDV', name: 'Denver Center',      bbox: { minLat: 36.9, maxLat: 45.2, minLng: -111.1, maxLng: -102.0 } },
];

function artccForPoint(lat, lng) {
  for (const a of ARTCC_BOUNDS) {
    const b = a.bbox;
    if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) {
      return { id: a.id, name: a.name };
    }
  }
  return null;
}

function artccsForArea(areaPoly) {
  if (!Array.isArray(areaPoly) || !areaPoly.length) return [];
  const bb = polygonBBox(areaPoly);
  const probes = [
    [bb.minLat, bb.minLng], [bb.minLat, bb.maxLng],
    [bb.maxLat, bb.minLng], [bb.maxLat, bb.maxLng],
    [(bb.minLat + bb.maxLat) / 2, (bb.minLng + bb.maxLng) / 2],
  ];
  const found = {};
  for (const p of probes) {
    const a = artccForPoint(p[0], p[1]);
    if (a) found[a.id] = a;
  }
  return Object.values(found);
}

// --- FAA VFR Sectional chart edition helpers ---
// The FAA VFR Sectional tile service publishes a new edition every 56 days.
// parseSectionalEdition() extracts the YYYY-MM-DD edition stamp from the
// ArcGIS MapServer `description` field, e.g.:
//   "Updated with the latest charts on 2026-05-13 16:18:39.073216"
// Returns the date string, or null if none is present.
function parseSectionalEdition(description) {
  if (typeof description !== 'string') return null;
  const m = description.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Deterministic 56-day cycle used ONLY as a cold-start fallback edition when
// the device has never reached the service. Anchored to the verified
// 2026-05-13 edition; the live `?f=json` description is authoritative whenever
// the device is online. Returns the latest cycle date <= todayISO.
const SECTIONAL_CYCLE_ANCHOR = '2026-05-13';
const SECTIONAL_CYCLE_DAYS = 56;
function currentSectionalCycle(todayISO) {
  const MS_DAY = 86400000;
  const anchor = Date.parse(SECTIONAL_CYCLE_ANCHOR + 'T00:00:00Z');
  const t = todayISO
    ? Date.parse(/T/.test(todayISO) ? todayISO : todayISO + 'T00:00:00Z')
    : anchor;
  if (isNaN(t)) return SECTIONAL_CYCLE_ANCHOR;
  const cycleMs = SECTIONAL_CYCLE_DAYS * MS_DAY;
  const k = Math.floor((t - anchor) / cycleMs);
  return new Date(anchor + k * cycleMs).toISOString().slice(0, 10);
}

// --- FAA NOTAM Search backend (notamSearch/search) JSON → app NOTAM objects ---
// The Worker proxies the public FAA NOTAM Search backend; this turns its JSON
// into the same NOTAM shape used by the file/paste importer. Undocumented source
// — treated as advisory; safety-critical NOTAMs must still be verified officially.
function _notamSearchDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
  const s = String(v).trim();
  if (/^perm/i.test(s)) return 'PERM'; // permanent — keep for display; no expiry
  // FAA NOTAM Search format: MM/DD/YYYY HHMM (24h, no colon), optional glued TZ
  // (e.g. "1953EST"). Treat as UTC (most NOTAM times are; a rare TZ-tagged one is
  // off by its offset — acceptable for an advisory display).
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})(\d{2})/);
  if (m) {
    const iso = `${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:00Z`;
    return isNaN(Date.parse(iso)) ? s : iso;
  }
  if (/^\d{12,}$/.test(s)) { const d = new Date(Number(s)); return isNaN(d.getTime()) ? s : d.toISOString(); }
  const t = Date.parse(s);
  return isNaN(t) ? s : new Date(t).toISOString();
}

function parseNotamSearchItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.cancelledOrExpired === true) return null;
  let lat = null, lng = null;
  if (item.mapPointer) {
    const m = String(item.mapPointer).match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
    if (m) { lng = parseFloat(m[1]); lat = parseFloat(m[2]); } // WKT is POINT(lon lat)
  }
  const location = item.facilityDesignator || item.icaoId || item.airportName || '';
  const body = item.traditionalMessage || item.icaoMessage || item.plainLanguageMessage || '';
  const id = item.notamNumber || item.id || (location + ' ' + (item.featureName || '')).trim() || 'NOTAM';
  const n = {
    id: String(id),
    location: String(location),
    type: String(item.keyword || item.featureName || ''),
    body: String(body).trim(),
    effectiveStart: _notamSearchDate(item.startDate),
    effectiveEnd: _notamSearchDate(item.endDate),
    lowerAlt: null, upperAlt: null,
    lat, lng, polygons: [],
    source: 'notamSearch',
  };
  // Enrich from the message text: the FAA backend gives only a point, but the
  // body often defines the real area ("3NM RADIUS OF <dms>"), altitude band, and
  // schedule. Reuse the existing NOTAM-text parser to recover those.
  try {
    const ext = _parseOneNotam(n.body);
    if (ext) {
      if (ext.polygons && ext.polygons.length) {
        n.polygons = ext.polygons;
        if (ext.lat != null && ext.lng != null) { n.lat = ext.lat; n.lng = ext.lng; } // real-area center beats the point
      }
      if (n.lowerAlt == null && ext.lowerAlt != null) n.lowerAlt = ext.lowerAlt;
      if (n.upperAlt == null && ext.upperAlt != null) n.upperAlt = ext.upperAlt;
      if (n.effectiveStart == null && ext.effectiveStart != null) n.effectiveStart = ext.effectiveStart;
      if (n.effectiveEnd == null && ext.effectiveEnd != null) n.effectiveEnd = ext.effectiveEnd;
    }
  } catch (_) { /* keep base fields */ }
  return n;
}

function parseNotamSearchResponse(data) {
  const out = [];
  let obj = data;
  if (typeof data === 'string') { try { obj = JSON.parse(data); } catch (_) { return out; } }
  if (!obj || !Array.isArray(obj.notamList)) return out;
  obj.notamList.forEach(item => { const n = parseNotamSearchItem(item); if (n) out.push(n); });
  return out;
}

// ============================================================
// NOTAM readability + UAS relevance (for the live NOTAM feed)
// ============================================================

// FAA/ICAO NOTAM contraction -> plain English (high-frequency domestic + airport
// + airspace + obstacle set). Used by expandNotamText. Single-letter and
// ICAO-field-marker-colliding tokens are intentionally omitted.
const NOTAM_CONTRACTIONS = {
  ACT: 'active', ACTV: 'active', ABN: 'abandoned', AVBL: 'available',
  CLSD: 'closed', CMSND: 'commissioned', DCMSND: 'decommissioned',
  DEACTVT: 'deactivated', DSPLCD: 'displaced', INOP: 'inoperative',
  OTS: 'out of service', UNUSBL: 'unusable', USBL: 'usable', WIP: 'work in progress',
  UNMKD: 'unmarked', UNLGTD: 'unlighted', OPR: 'operate', OPRG: 'operating',
  OPN: 'open', OBSC: 'obscured', RMVD: 'removed', RPLCD: 'replaced',
  REL: 'released', REP: 'report', RSTD: 'restricted', SVC: 'service',
  TEMPO: 'temporary', TEMP: 'temporary', WEF: 'with effect from',
  UFN: 'until further notice', COND: 'condition', EXC: 'except', EXCP: 'except',
  MAINT: 'maintenance', CTC: 'contact', CHG: 'change', CNL: 'cancel', CXL: 'cancel',
  DEP: 'departure', ARR: 'arrival', CTL: 'control', MON: 'monitor', ESTD: 'established',
  ACFT: 'aircraft', UAS: 'unmanned aircraft system', UA: 'unmanned aircraft',
  RPA: 'remotely piloted aircraft', HEL: 'helicopter', GLD: 'glider', BLN: 'balloon',
  PJE: 'parachute jumping exercise', AEROBATIC: 'aerobatic', ARSPC: 'airspace',
  AIRSPACE: 'airspace', FLT: 'flight', OPS: 'operations', TFC: 'traffic', TFFC: 'traffic',
  VEH: 'vehicle', PERS: 'personnel', EQPT: 'equipment', LSR: 'laser', FRNG: 'firing',
  ARPT: 'airport', AD: 'aerodrome', APRX: 'approximately', RWY: 'runway', RY: 'runway',
  TWY: 'taxiway', TXWY: 'taxiway', APRON: 'apron', RAMP: 'ramp', TWR: 'tower',
  TDZ: 'touchdown zone', THR: 'threshold', THLD: 'threshold', SWY: 'stopway',
  CWY: 'clearway', OVRN: 'overrun', HLDG: 'holding', INTXN: 'intersection',
  PRKG: 'parking', DTHR: 'displaced threshold', AGL: 'above ground level',
  AMSL: 'above mean sea level', MSL: 'mean sea level', SFC: 'surface', GND: 'ground',
  ELEV: 'elevation', HGT: 'height', LGT: 'light', LGTD: 'lighted', LGTS: 'lights',
  HIRL: 'high intensity runway lights', MIRL: 'medium intensity runway lights',
  LIRL: 'low intensity runway lights', REIL: 'runway end identifier lights',
  PAPI: 'precision approach path indicator', VASI: 'visual approach slope indicator',
  ALS: 'approach lighting system', MALSR: 'medium approach lighting w/ runway alignment',
  RVR: 'runway visual range', PCL: 'pilot controlled lighting',
  OBST: 'obstacle', OBSTN: 'obstruction', CRANE: 'crane', BLDG: 'building',
  POLE: 'pole', ANT: 'antenna', STACK: 'stack', HAZ: 'hazard', UNL: 'unlimited',
  WLDLF: 'wildlife', NAV: 'navigation', NAVAID: 'navigational aid',
  VORTAC: 'VORTAC', DME: 'distance measuring equipment', TACAN: 'TACAN',
  NDB: 'nondirectional beacon', ILS: 'instrument landing system', LOC: 'localizer',
  GP: 'glide path', GS: 'glide slope', LDA: 'localizer directional aid',
  WAAS: 'wide area augmentation system', GPS: 'GPS', GNSS: 'GNSS', RNAV: 'area navigation',
  RNP: 'required navigation performance', ATIS: 'automatic terminal information service',
  AWOS: 'automated weather observing system', ASOS: 'automated surface observing system',
  COM: 'communications', FREQ: 'frequency', FREQS: 'frequencies',
  CTAF: 'common traffic advisory frequency', RMK: 'remark', RMKS: 'remarks',
  APCH: 'approach', APP: 'approach', IAP: 'instrument approach procedure',
  SID: 'standard instrument departure', STAR: 'standard terminal arrival',
  ODP: 'obstacle departure procedure', IFR: 'IFR', VFR: 'VFR',
  MVA: 'minimum vectoring altitude', MEA: 'minimum enroute altitude',
  FAF: 'final approach fix', MAP: 'missed approach point', IAF: 'initial approach fix',
  MOA: 'military operations area', TFR: 'temporary flight restriction',
  ADIZ: 'air defense identification zone', CTR: 'control zone', FIR: 'flight information region',
  ARTCC: 'air route traffic control center', TRACON: 'terminal radar approach control',
  ATC: 'air traffic control', CLNC: 'clearance',
  FL: 'flight level', FT: 'feet', NM: 'nautical miles', SM: 'statute miles',
  KT: 'knots', KTS: 'knots', DEG: 'degrees', MAG: 'magnetic', RDL: 'radial',
  PSN: 'position', RAD: 'radius', NE: 'northeast', NW: 'northwest', SE: 'southeast',
  SW: 'southwest', NNE: 'north-northeast', ENE: 'east-northeast', ESE: 'east-southeast',
  SSE: 'south-southeast', SSW: 'south-southwest', WSW: 'west-southwest',
  WNW: 'west-northwest', NNW: 'north-northwest', BTN: 'between', WI: 'within',
  VCY: 'vicinity', ADJ: 'adjacent', ABV: 'above', BLW: 'below', BYD: 'beyond',
  OVR: 'over', THRU: 'through', DLY: 'daily', H24: '24 hours', HR: 'hour', HRS: 'hours',
  SR: 'sunrise', SS: 'sunset', UTC: 'UTC', LCL: 'local', PERM: 'permanent',
  EST: 'estimated', DURG: 'during', WX: 'weather', TS: 'thunderstorm', VIS: 'visibility',
  WND: 'wind', AUTH: 'authorized', UNAUTH: 'unauthorized', CONT: 'continuous',
  DIST: 'distance', EFF: 'effective', GA: 'general aviation', MIL: 'military',
  CIV: 'civil', NR: 'number', PPR: 'prior permission required', REQ: 'request',
  TKOF: 'takeoff', LDG: 'landing', PROC: 'procedure',
};

// Expand contractions in a NOTAM body for display, protecting coordinates,
// runway identifiers, frequencies, flight levels, ids and date groups.
function expandNotamText(body) {
  if (typeof body !== 'string' || !body.trim()) return '';
  const masks = [];
  const stash = (re) => { body = body.replace(re, (m) => { const t = '\x00' + masks.length + '\x00'; masks.push(m); return t; }); };
  stash(/\d{6}(?:\.\d+)?[NS]\s*\d{7}(?:\.\d+)?[EW]/g);                 // DMS pair
  stash(/\b(?:RWY|RY|TWY|TXWY)\s*\d{1,2}[LRC]?(?:\/\d{1,2}[LRC]?)?/gi); // RWY 09L/27R
  stash(/\b[A-Z]\d{4}\/\d{2}\b/g);                                     // NOTAM id
  stash(/!\s*[A-Z]{3,4}\b/g);                                          // !OAK header tag
  stash(/\b\d{10}(?:-\d{10})?\b/g);                                    // date groups
  stash(/\bFL\d{2,3}\b/g);                                             // flight levels
  stash(/\b\d{3}\.\d{1,3}\b/g);                                        // frequencies
  stash(/-?\d{1,3}\.\d+[NSEW]?/g);                                     // decimal coords
  const keys = Object.keys(NOTAM_CONTRACTIONS).sort((a, b) => b.length - a.length);
  const re = new RegExp('\\b(' + keys.join('|') + ')\\b', 'g');
  body = body.replace(re, (t) => NOTAM_CONTRACTIONS[t] || t);
  body = body.replace(/\x00(\d+)\x00/g, (_, i) => masks[+i]);
  return body.replace(/[ \t]{2,}/g, ' ').trim();
}

function toDmsDisplay(lat, lng) {
  const d = (v, pos, neg, deg) => {
    const hemi = v < 0 ? neg : pos; v = Math.abs(v);
    const D = Math.floor(v), mF = (v - D) * 60; let M = Math.floor(mF), S = Math.round((mF - M) * 60);
    if (S === 60) { S = 0; M += 1; }
    return `${String(D).padStart(deg, '0')}°${String(M).padStart(2, '0')}'${String(S).padStart(2, '0')}"${hemi}`;
  };
  return `${d(lat, 'N', 'S', 2)} ${d(lng, 'E', 'W', 3)}`;
}

function fmtNotamDate(iso, withYear) {
  if (!iso) return null;
  if (iso === 'PERM') return 'permanent';
  const t = Date.parse(iso); if (isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
}

function fmtAlt(a) {
  if (a == null) return null;
  const s = String(a).toUpperCase().replace(/\s+/g, '');
  if (/^(SFC|GND)/.test(s)) return 'surface';
  if (/^UNL/.test(s)) return 'unlimited';
  let m = s.match(/^FL(\d{2,3})/); if (m) return `${(+m[1] * 100).toLocaleString()} ft (FL${m[1]})`;
  m = s.match(/^(\d{2,6})FT/) || s.match(/^(\d{2,6})$/);
  if (m) return `${(+m[1]).toLocaleString()} ft`;
  return null;
}

const NOTAM_SUBJECTS = {
  AIRSPACE: 'Airspace activity', OBSTACLE: 'Obstacle', GPS: 'GPS/GNSS or surveillance issue',
  HAZARD_ACTIVITY: 'Low-altitude hazard activity', TFR: 'Flight restriction', UAS: 'UAS operations',
  AERODROME: 'Aerodrome notice', RUNWAY_TWY: 'Runway/taxiway notice', PROCEDURE: 'Instrument procedure notice',
  NAVAID: 'Navaid notice', COM: 'Communications notice', SERVICE: 'Airport service notice',
  OTHER: 'NOTAM', UNKNOWN: 'NOTAM',
};

function ringRadiusNm(center, ring) {
  if (!center || !Array.isArray(ring) || ring.length < 3) return 0;
  let sum = 0;
  for (const v of ring) sum += haversine(center[0], center[1], v[0], v[1]);
  return (sum / ring.length) / 1.852;
}

// A single readable sentence describing a NOTAM, built from parsed fields.
function notamPlainSummary(notam) {
  if (!notam) return '';
  const body = String(notam.body || '');
  const category = (notam._relevance && notam._relevance.category) || classifyNotamForUAS(notam, null).category;
  let subject = NOTAM_SUBJECTS[category] || 'NOTAM';
  // Enrich AIRSPACE/HAZARD subject with the activity phrase from the body.
  if (category === 'AIRSPACE' || category === 'HAZARD_ACTIVITY' || category === 'OBSTACLE') {
    // Strip "!FAC id ARTCC KEYWORD " then grab the 1-2 word activity phrase.
    const lead = body.replace(/^!\s*[A-Z]{3,4}\s+\S+\s+[A-Z]{3,4}\s+[A-Z]+\s+/, '').match(/^([A-Z][A-Z\/]+(?:\s+[A-Z][A-Z\/]+){0,1})/);
    if (lead) { const e = expandNotamText(lead[1]); if (e && e.length <= 42) subject = e.charAt(0).toUpperCase() + e.slice(1); }
  }
  // geometry
  let geo = '';
  if (notam.lat != null && notam.lng != null && !isNaN(notam.lat) && !isNaN(notam.lng)) {
    const dms = toDmsDisplay(notam.lat, notam.lng);
    const r = ringRadiusNm([notam.lat, notam.lng], notam.polygons && notam.polygons[0]);
    const rel = body.match(/\(([\d.]+)\s*NM\s+([NSEW]{1,3})\s+(?:OF\s+)?([A-Z0-9]{3,4})\)/i);
    const relTxt = rel ? ` (${rel[1]} NM ${rel[2].toUpperCase()} of ${rel[3].toUpperCase()})` : '';
    if (r > 0.02) { const rr = r < 1 ? Math.round(r * 100) / 100 : Math.round(r * 10) / 10; geo = `within ${rr} NM of ${dms}${relTxt}`; }
    else if (notam.polygons && notam.polygons.length) geo = `over an area near ${dms}${relTxt}`;
    else geo = `near ${dms}${relTxt}`;
  }
  // altitude
  const lo = fmtAlt(notam.lowerAlt), hi = fmtAlt(notam.upperAlt);
  let alt = '';
  if (lo && hi) alt = lo === hi ? `at ${hi}` : `${lo} to ${hi}`;
  else if (hi) alt = `below ${hi}`;
  else if (lo) alt = `above ${lo}`;
  // schedule (time-of-day)
  let sched = '';
  const sm = body.match(/\bDLY\s+(\d{4})-(\d{4})\b/) || body.match(/\b(\d{4})-(\d{4})\b(?!\d)/);
  if (sm) sched = `${/\bDLY\b/.test(body) ? 'daily ' : ''}${sm[1]}-${sm[2]}Z`;
  // effective window
  const sY = (notam.effectiveStart || '').slice(0, 4), eY = (notam.effectiveEnd || '').slice(0, 4);
  const sameYr = sY && eY && sY === eY;
  const s = fmtNotamDate(notam.effectiveStart, !sameYr || !notam.effectiveEnd);
  const e = notam.effectiveEnd ? fmtNotamDate(notam.effectiveEnd, true) : null;
  let eff = '';
  if (s && e) eff = `${s} – ${e}`;
  else if (s) eff = `from ${s}`;

  const head = [subject, geo].filter(Boolean).join(' ');
  const tail = [alt, sched].filter(Boolean).join(', ');
  let out = head + (tail ? ', ' + tail : '');
  if (eff) out += ` (${eff})`;
  return (out || 'NOTAM').replace(/\s+,/g, ',').trim().replace(/\.*$/, '') + '.';
}

// --- UAS relevance classifier (safety-reviewed: errs toward KEEP) ---
const NOTAM_ALT_FLOOR_THRESH_FT = 1500;
// Category relevance for a SFC-400ft drone. 'launch' = only if at the launch area.
const NOTAM_CATEGORY_RELEVANT = {
  AIRSPACE: true, TFR: true, UAS: true, OBSTACLE: true, GPS: true, HAZARD_ACTIVITY: true,
  AERODROME: 'launch', RUNWAY_TWY: 'launch',
  PROCEDURE: false, NAVAID: false, COM: false, SERVICE: false,
  OTHER: true, UNKNOWN: true,
};

function _notamFloorFt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^(SFC|GND)/.test(s)) return 0;
  if (/^UNL/.test(s)) return null;
  const fl = s.match(/^FL(\d{2,3})/); if (fl) return parseInt(fl[1], 10) * 100;
  const ft = s.match(/^(\d{1,5})FT/) || s.match(/^(\d{1,5})$/); if (ft) return parseInt(ft[1], 10);
  return null;
}

// Categorize a NOTAM. Body-signal detection runs FIRST and is authoritative so a
// mis-keyworded surface hazard can never be filed into a "not relevant" bucket.
function notamCategory(notam) {
  const body = String((notam && (notam.body || notam.icaoMessage)) || '').toUpperCase();
  const kw = String((notam && notam.type) || '').toUpperCase();
  if (/\bTFR\b|TEMPORARY FLIGHT RESTRICT|SECURITY INSTRUCTION|STADIUM|PROHIBITED AREA|NO\s*S?UAS|NO\s*DRONE|UAS\s*PROHIBIT/.test(body)) return 'TFR';
  if (/\bUAS\b|UNMANNED|\bDRONE\b|\bSUAS\b/.test(body)) return 'UAS';
  if (/\bGPS\b|\bGNSS\b|\bRAIM\b|WAAS|JAMMING|INTERFERENCE|ADS-?B|MODE\s?C|TRANSPONDER|TIS-?B|FIS-?B/.test(body)) return 'GPS';
  if (/PARACHUTE|\bPJE\b|\bJUMP|A[EC]ROBATIC|\bLASER\b|AIR\s?SHOW|\bGLIDER\b|BALLOON|FIREWORK|PYROTECHNIC|HANG\s?GLID/.test(body)) return 'HAZARD_ACTIVITY';
  if (/\bCRANE\b|\bOBST\b|OBSTRUCT|ANTENNA|WIND\s?TURBINE|\bTOWER\b(?!\s+CLSD)/.test(body)) return 'OBSTACLE';
  if (/AIRSPACE/.test(kw)) return 'AIRSPACE';
  if (/OBST/.test(kw)) return 'OBSTACLE';
  if (/\bUAS\b|UNMANNED|^U$/.test(kw)) return 'UAS';
  if (/GPS|GNSS/.test(kw)) return 'GPS';
  if (/TFR|SECURITY|VIP/.test(kw)) return 'TFR';
  if (/IAP|SID|STAR|ODP|PROCEDURE|RNAV|AIRWAY|ROUTE/.test(kw)) return 'PROCEDURE';
  if (/ILS|VOR|DME|TACAN|NDB|NAVAID|\bNAV\b|LOC/.test(kw)) return 'NAVAID';
  if (/COM|FREQ|RADIO/.test(kw)) return 'COM';
  if (/RWY|RUNWAY|TWY|TAXIWAY/.test(kw)) return 'RUNWAY_TWY';
  if (/AERODROME|APRON|RAMP|\bAD\b/.test(kw)) return 'AERODROME';
  if (/SVC|SERVICE|FUEL|RVR/.test(kw)) return 'SERVICE';
  return 'UNKNOWN';
}

// Decide whether a NOTAM is relevant to a SFC-400ft UAS operating in the AOI.
// aoi = { center:{lat,lng}, radiusNm, polygon:[[lat,lng]...], searchRadiusNm } or null.
function classifyNotamForUAS(notam, aoi) {
  try {
    const category = notamCategory(notam);
    let kwRel = NOTAM_CATEGORY_RELEVANT[category];
    if (kwRel === undefined) kwRel = true;
    const reasons = [];

    // Distance — only from real coordinates; missing geometry => keep.
    let distanceNm = null, tooFar = false;
    if (notam && notam.lat != null && notam.lng != null && !isNaN(notam.lat) && !isNaN(notam.lng) && aoi && aoi.center) {
      const notamRadNm = (notam.polygons && notam.polygons[0]) ? ringRadiusNm([notam.lat, notam.lng], notam.polygons[0]) : 0;
      let overlap = false;
      if (notam.polygons && notam.polygons.length && aoi.polygon && aoi.polygon.length >= 3) {
        overlap = notam.polygons.some(r => r && r.length >= 3 && polygonsIntersect(r, aoi.polygon));
      }
      if (overlap) distanceNm = 0;
      else {
        const cd = haversine(aoi.center.lat, aoi.center.lng, notam.lat, notam.lng) / 1.852;
        distanceNm = Math.max(0, cd - (aoi.radiusNm || 0) - notamRadNm);
      }
      const buffer = Math.max(aoi.radiusNm || 0, aoi.searchRadiusNm || 0) + notamRadNm + 5;
      if (distanceNm > buffer) { tooFar = true; reasons.push(`${Math.round(distanceNm)} NM from your area`); }
    }

    // Altitude — only ever hides enroute PROCEDURE/NAVAID with a high floor.
    let tooHigh = false;
    if (category === 'PROCEDURE' || category === 'NAVAID') {
      const floor = _notamFloorFt(notam.lowerAlt);
      if (floor != null && floor > NOTAM_ALT_FLOOR_THRESH_FT) tooHigh = true;
    }

    // Conditional categories: keep only if at the launch area (unknown distance => keep).
    if (kwRel === 'launch') {
      const atLaunch = (distanceNm === null) ? true : distanceNm <= Math.max((aoi && aoi.radiusNm) || 0, 1);
      kwRel = atLaunch;
      if (!atLaunch) reasons.push('runway/aerodrome notice away from your area');
    }
    if (kwRel === false) reasons.push(NOTAM_SUBJECTS[category] + ' — not relevant to low-altitude UAS');

    return { relevant: !!kwRel && !tooFar && !tooHigh, category, distanceNm, tooFar, tooHigh, reasons };
  } catch (_) {
    return { relevant: true, category: 'UNKNOWN', distanceNm: null, tooFar: false, tooHigh: false, reasons: [] };
  }
}

// ============================================================
// KML EXPORT BUILDERS (pure — assembled by doExport in sar-preflight.js)
// Coordinate format matches getKMLCoords: "lng,lat,alt".
// ============================================================

function kmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Popup descriptions carry arbitrary HTML — wrap in CDATA, escaping any "]]>".
function kmlCdata(html) {
  return '<![CDATA[' + String(html == null ? '' : html).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';
}

// Flatten HTML (popup markup) to readable plain text — block/break tags become
// newlines, list items get a bullet, remaining tags are stripped and entities
// decoded. Used so KML descriptions read as plain text (e.g. in CalTopo notes)
// instead of raw markup.
function htmlToPlainText(html) {
  if (html == null) return '';
  let s = String(html);
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*li[^>]*>/gi, '• ');
  s = s.replace(/<\s*(p|div|tr|h[1-6]|table|section)[^>]*>/gi, '\n');   // opening block tags
  s = s.replace(/<\/\s*(p|div|tr|li|h[1-6]|ul|ol|table|section)\s*>/gi, '\n'); // closing block tags
  s = s.replace(/<[^>]+>/g, '');                       // strip remaining tags
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'");
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function _kmlCoord(lng, lat, alt) {
  return `${(+lng).toFixed(6)},${(+lat).toFixed(6)},${alt || 0}`;
}

// Ring of [lat,lng] pairs -> "lng,lat,0 ..." (auto-closed).
function kmlRingFromLatLng(ring) {
  const pts = (ring || []).filter(p => p && isFinite(p[0]) && isFinite(p[1])).map(p => _kmlCoord(p[1], p[0]));
  if (pts.length && pts[0] !== pts[pts.length - 1]) pts.push(pts[0]);
  return pts.join(' ');
}

// Ring of GeoJSON [lng,lat] pairs -> "lng,lat,0 ..." (auto-closed).
function kmlRingFromGeoJson(ring) {
  const pts = (ring || []).filter(p => p && isFinite(p[0]) && isFinite(p[1])).map(p => _kmlCoord(p[0], p[1]));
  if (pts.length && pts[0] !== pts[pts.length - 1]) pts.push(pts[0]);
  return pts.join(' ');
}

function _kmlHead(name, styleUrl, description, timestamp) {
  return `<Placemark><name>${kmlEscape(name)}</name>` +
    (styleUrl ? `<styleUrl>#${styleUrl}</styleUrl>` : '') +
    (timestamp ? `<TimeStamp><when>${kmlEscape(timestamp)}</when></TimeStamp>` : '') +
    (description ? `<description>${kmlCdata(description)}</description>` : '');
}

// rings: array of coordinate STRINGS (build with kmlRingFrom*). rings[0]=outer, rest=holes.
function kmlPolygonPlacemark(o) {
  const r = (o.rings || []).filter(Boolean);
  if (!r.length) return '';
  const outer = `<outerBoundaryIs><LinearRing><coordinates>${r[0]}</coordinates></LinearRing></outerBoundaryIs>`;
  const inner = r.slice(1).map(h => `<innerBoundaryIs><LinearRing><coordinates>${h}</coordinates></LinearRing></innerBoundaryIs>`).join('');
  return _kmlHead(o.name, o.styleUrl, o.description, o.timestamp) + `<Polygon>${outer}${inner}</Polygon></Placemark>`;
}

function kmlPointPlacemark(o) {
  if (!isFinite(o.lat) || !isFinite(o.lng)) return '';
  return _kmlHead(o.name, o.styleUrl, o.description, o.timestamp) +
    `<Point><coordinates>${_kmlCoord(o.lng, o.lat)}</coordinates></Point></Placemark>`;
}

// coords: array of [lat,lng] pairs.
function kmlLinePlacemark(o) {
  const pts = (o.coords || []).filter(p => p && isFinite(p[0]) && isFinite(p[1])).map(p => _kmlCoord(p[1], p[0]));
  if (pts.length < 2) return '';
  return _kmlHead(o.name, o.styleUrl, o.description, o.timestamp) +
    `<LineString><tessellate>1</tessellate><coordinates>${pts.join(' ')}</coordinates></LineString></Placemark>`;
}

function kmlFolder(name, inner, opts) {
  opts = opts || {};
  if (!inner) return '';
  return `<Folder><name>${kmlEscape(name)}</name>` +
    (opts.description ? `<description>${kmlCdata(opts.description)}</description>` : '') +
    inner + `</Folder>`;
}

function kmlDocument(name, styles, folders, description) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<name>${kmlEscape(name)}</name>` +
    (description ? `<description>${kmlCdata(description)}</description>` : '') +
    (styles || '') + (folders || '') + `</Document></kml>`;
}

// Shared <Style> blocks. Colors are KML AABBGGRR (app palette). Every style covers
// icon + line + poly so any geometry type renders sensibly under it. `icon` is a
// Google KML shape href applied to point features (plane for airports, circle-H
// for heliports, etc.) — rendered by Google Earth; CalTopo maps it to a marker.
const KML_ICON_BASE = 'https://maps.google.com/mapfiles/kml/shapes/';
const KML_STYLE_DEFS = {
  opsArea:   { color: 'fffd8b3d', fill: '20fd8b3d', width: 2 }, // blue
  restrict:  { color: 'ff4444ef', fill: '404444ef', width: 2, icon: 'caution.png' }, // red — TFR/NOTAM/prohibited/NS/alert
  sua:       { color: 'ff0b9ef5', fill: '300b9ef5', width: 2 }, // amber — special use
  airspace:  { color: 'fffd8b3d', fill: '1afd8b3d', width: 2 }, // blue — class airspace/LAANC
  fire:      { color: 'ff4444ef', fill: '304444ef', width: 2, icon: 'firedept.png' }, // red — fire perimeter
  protected: { color: 'ff5ec522', fill: '205ec522', width: 2 }, // green — wilderness/parks
  wire:      { color: 'ff0b9ef5', width: 3 },                   // amber — wires/cables
  obstacle:  { color: 'ff0b9ef5', width: 2, icon: 'caution.png' },   // amber — obstacles
  airport:   { color: 'fffd8b3d', width: 2, icon: 'airports.png' },  // blue — airports (plane)
  heliport:  { color: 'fffa8ba7', width: 2, icon: 'heliport.png' },  // purple — heliports (circle-H)
  tower:     { color: 'ff0b9ef5', width: 2, icon: 'electronics.png' }, // amber — towers
  dam:       { color: 'ffd4b606', width: 2, icon: 'water.png' },     // cyan — dams
  aircraft:  { color: 'ffd4b606', width: 2, icon: 'airports.png' },  // cyan — ADS-B (plane)
  observer:  { color: 'ff5ec522', width: 2, icon: 'placemark_circle.png' }, // green — viewshed observer
  trail:     { color: 'ffb672f4', width: 2 },                   // pink — OSM named trails
  generic:   { color: 'ffffffff', fill: '20ffffff', width: 2 }, // white — fallback
  sunArrow:  { color: 'ff00ccff', width: 3 },                   // gold — sun
  windArrow: { color: 'ffd4b606', width: 3 },                   // cyan — wind
};

function kmlStyles() {
  let out = '';
  for (const id in KML_STYLE_DEFS) {
    const d = KML_STYLE_DEFS[id];
    out += `<Style id="${id}">` +
      `<IconStyle><color>${d.color}</color><scale>1.1</scale>` +
      (d.icon ? `<Icon><href>${KML_ICON_BASE}${d.icon}</href></Icon>` : '') +
      `</IconStyle>` +
      `<LabelStyle><scale>0.8</scale></LabelStyle>` +
      `<LineStyle><color>${d.color}</color><width>${d.width || 2}</width></LineStyle>` +
      (d.fill ? `<PolyStyle><color>${d.fill}</color></PolyStyle>` : `<PolyStyle><fill>0</fill></PolyStyle>`) +
      `</Style>`;
  }
  return out;
}

// A standalone KML document with a single GroundOverlay — the reliable way to put
// a georeferenced raster into CalTopo (and Google Earth). `href` is the image path
// inside the KMZ; `bounds` is {west,south,east,north} in EPSG:4326.
function groundOverlayKml(name, bounds, href, opts) {
  opts = opts || {};
  const b = bounds;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<name>${kmlEscape(name)}</name>` +
    `<GroundOverlay><name>${kmlEscape(name)}</name>` +
    (opts.description ? `<description>${kmlCdata(opts.description)}</description>` : '') +
    `<Icon><href>${kmlEscape(href)}</href></Icon>` +
    `<LatLonBox><north>${b.north}</north><south>${b.south}</south><east>${b.east}</east><west>${b.west}</west><rotation>0</rotation></LatLonBox>` +
    `</GroundOverlay></Document></kml>`;
}

// ============================================================
// SUN / WIND HOURLY ARROWS (pure)
// ============================================================

// Equirectangular offset — adequate at the few-km arrow lengths used here.
function destPoint(lat, lng, bearingDeg, distM) {
  const br = bearingDeg * Math.PI / 180;
  const dLat = (distM * Math.cos(br)) / 111320;
  const dLng = (distM * Math.sin(br)) / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat + dLat, lng + dLng];
}

// A plain bearing line from the centre out along `bearingDeg` (no arrowhead —
// KML has no native one, and CalTopo lets the user set a line-arrow pattern
// after import if desired).
function bearingLineGeometry(centerLat, centerLng, bearingDeg, lengthM) {
  const tip = destPoint(centerLat, centerLng, bearingDeg, lengthM);
  return `<LineString><tessellate>1</tessellate><coordinates>${_kmlCoord(centerLng, centerLat)} ${_kmlCoord(tip[1], tip[0])}</coordinates></LineString>`;
}

function _bearingPlacemark(name, centerLat, centerLng, bearingDeg, lengthM, styleUrl, description, timestamp) {
  return _kmlHead(name, styleUrl, description, timestamp) +
    bearingLineGeometry(centerLat, centerLng, bearingDeg, lengthM) + `</Placemark>`;
}

// Sun arrows for each timestamp where the sun is above the horizon. Arrow points
// TOWARD the sun (azimuth). `opts.calcSunPosition` overridable for tests.
function sunArrowsKml(lat, lng, times, centerLat, centerLng, opts) {
  opts = opts || {};
  const lengthM = opts.lengthM || 1500;
  const calc = opts.calcSunPosition || (typeof calcSunPosition === 'function' ? calcSunPosition : null);
  if (!calc || !Array.isArray(times)) return '';
  let inner = '';
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const d = new Date(t);
    if (isNaN(d.getTime())) continue;
    const sp = calc(lat, lng, d);
    if (!sp || !(sp.elevation > 0)) continue; // sun down — skip
    const az = Math.round(sp.azimuth), el = Math.round(sp.elevation);
    const hhmm = String(t).slice(11, 16);
    const name = `Sun ${hhmm} — AZ ${az}° EL ${el}°`;
    const desc = `Sun position at ${t}\nAzimuth: ${az}° (true) — line points toward the sun\nElevation: ${el}° above horizon`;
    inner += _bearingPlacemark(name, centerLat, centerLng, sp.azimuth, lengthM, 'sunArrow', desc, t);
  }
  return inner;
}

// Wind arrows for each timestamp. Arrow points DOWNWIND (where the wind blows
// toward = drift direction); label reports the meteorological "FROM" bearing.
function windArrowsKml(times, dir, speed, gust, centerLat, centerLng, opts) {
  opts = opts || {};
  if (!Array.isArray(times)) return '';
  const lengthM = opts.lengthM || 1500;
  const speedMax = opts.speedMax || 30; // mph reference for length scaling
  let inner = '';
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const from = dir && isFinite(dir[i]) ? dir[i] : null;
    if (from == null) continue;
    const spd = speed && isFinite(speed[i]) ? speed[i] : null;
    const g = gust && isFinite(gust[i]) ? gust[i] : null;
    const toward = (from + 180) % 360;
    const frac = spd != null ? Math.min(spd, speedMax) / speedMax : 0.5;
    const len = lengthM * (0.4 + 0.6 * frac);
    const hhmm = String(t).slice(11, 16);
    const name = `Wind ${hhmm} — FROM ${Math.round(from)}°` + (spd != null ? ` ${Math.round(spd)} mph` : '');
    const desc = `Wind at ${t}\nFROM ${Math.round(from)}° (true)\nSpeed: ${spd != null ? Math.round(spd) + ' mph' : '--'}` +
      (g != null ? `\nGust: ${Math.round(g)} mph` : '') + `\nLine points downwind (direction of drift).`;
    inner += _bearingPlacemark(name, centerLat, centerLng, toward, len, 'windArrow', desc, t);
  }
  return inner;
}

// ============================================================
// GEOJSON EXPORT (CalTopo native format) — pure builders
// ============================================================
// CalTopo imports GeoJSON with its folder hierarchy intact (unlike KML, which it
// flattens by geometry type). A folder is a Feature with geometry:null and
// class:"Folder"; every object references its folder via properties.folderId.
// Styling is the simplestyle spec (stroke/fill/marker-symbol), derived here from
// the same KML_STYLE_DEFS so colors live in one place.

// KML AABBGGRR hex -> { hex:'#rrggbb', opacity:0..1 }. (e.g. '20fd8b3d' -> #3d8bfd, 0.1254902)
function kmlColorToRgba(aabbggrr) {
  const s = String(aabbggrr == null ? '' : aabbggrr).replace(/[^0-9a-fA-F]/g, '').padStart(8, 'f').slice(-8);
  const a = parseInt(s.slice(0, 2), 16);
  const b = parseInt(s.slice(2, 4), 16);
  const g = parseInt(s.slice(4, 6), 16);
  const r = parseInt(s.slice(6, 8), 16);
  const h2 = n => (isFinite(n) ? n : 0).toString(16).padStart(2, '0');
  return { hex: '#' + h2(r) + h2(g) + h2(b), opacity: (isFinite(a) ? a : 255) / 255 };
}

// CalTopo simplestyle props for a shared style id. Markers carry stroke (their
// color, per CalTopo's own exports) + marker-symbol; filled styles add fill.
function caltopoStyleProps(styleId) {
  const d = KML_STYLE_DEFS[styleId] || KML_STYLE_DEFS.generic;
  const line = kmlColorToRgba(d.color);
  const props = { stroke: line.hex, 'stroke-width': d.width || 2, 'stroke-opacity': line.opacity };
  if (d.fill) { const f = kmlColorToRgba(d.fill); props.fill = f.hex; props['fill-opacity'] = f.opacity; }
  if (d.icon) props['marker-symbol'] = KML_ICON_BASE + d.icon;
  return props;
}

function geojsonFolderFeature(id, title) {
  return { type: 'Feature', id, geometry: null,
    properties: { title, class: 'Folder', visible: true, labelVisible: true } };
}

// o: { name, description, lat, lng, styleId }
function geojsonMarkerFeature(id, folderId, o) {
  if (!isFinite(o.lat) || !isFinite(o.lng)) return null;
  const props = Object.assign({ title: o.name, class: 'Marker' }, caltopoStyleProps(o.styleId));
  if (o.description) props.description = o.description;
  if (folderId) props.folderId = folderId;
  return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [+o.lng, +o.lat, 0, 0] }, properties: props };
}

// o: { name, description, geometry, styleId } — geometry is a GeoJSON LineString/Polygon.
function geojsonShapeFeature(id, folderId, o) {
  if (!o.geometry || !o.geometry.coordinates || !o.geometry.coordinates.length) return null;
  const props = Object.assign({ title: o.name, class: 'Shape' }, caltopoStyleProps(o.styleId));
  if (o.description) props.description = o.description;
  if (folderId) props.folderId = folderId;
  return { type: 'Feature', id, geometry: o.geometry, properties: props };
}

// coords: array of [lat,lng] -> GeoJSON LineString ([lng,lat]).
function geojsonLineGeometry(coords) {
  const pts = (coords || []).filter(p => p && isFinite(p[0]) && isFinite(p[1])).map(p => [+p[1], +p[0]]);
  return { type: 'LineString', coordinates: pts };
}

// rings: array of [lat,lng] rings (rings[0] outer) -> GeoJSON Polygon (auto-closed, [lng,lat]).
function geojsonPolygonGeometry(rings) {
  const out = (rings || []).map(ring => {
    const c = (ring || []).filter(p => p && isFinite(p[0]) && isFinite(p[1])).map(p => [+p[1], +p[0]]);
    if (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1])) c.push(c[0]);
    return c;
  }).filter(r => r.length >= 4);
  return { type: 'Polygon', coordinates: out };
}

function geojsonFeatureCollection(features) {
  return { type: 'FeatureCollection', features: (features || []).filter(Boolean) };
}

// ============================================================
// SECTION FRESHNESS — pure helpers for the per-section
// "last updated / cached / error" line + UPDATE button state.
// All DOM-free and time-injected (nowMs / tz) so they unit-test
// deterministically. Consumed by renderSectionMeta() in the app.
// ============================================================

// Absolute local time, e.g. "Jun 20, 10:45 AM". Returns an em-dash for
// missing/invalid input. `tz` is an IANA zone (e.g. "America/Los_Angeles").
function formatStamp(ms, nowMs, tz) {
  if (ms == null || isNaN(ms)) return '—';
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  try {
    return new Date(ms).toLocaleString('en-US', opts);
  } catch (e) {
    // Bad/unknown tz — fall back to the host zone rather than throwing.
    delete opts.timeZone;
    return new Date(ms).toLocaleString('en-US', opts);
  }
}

// Relative age bucket ("<1m" / "5m" / "2h" / "3d"). Mirrors offline.js
// formatAge but takes explicit (ms, nowMs) so it stays pure. Empty string
// for missing/future timestamps.
function relAge(ms, nowMs) {
  if (ms == null) return '';
  const d = (nowMs == null ? 0 : nowMs) - ms;
  if (!isFinite(d) || d < 0) return '';
  if (d < 60000) return '<1m';
  if (d < 3600000) return Math.round(d / 60000) + 'm';
  if (d < 86400000) return Math.round(d / 3600000) + 'h';
  return Math.round(d / 86400000) + 'd';
}

// Build the freshness line for one section.
// meta: { status:'never'|'live'|'cached'|'error', updatedAt, cachedAt, error, errorAt, loading }
// Returns { state, tone, text, ageText, title, canUpdate }.
// Precedence: loading -> error -> cached -> live -> never.
function buildSectionMetaLine(meta, nowMs, tz) {
  meta = meta || {};
  if (meta.loading) {
    return { state: 'loading', tone: 'muted', text: 'Updating…', ageText: '', title: '', canUpdate: false };
  }
  const status = meta.status || 'never';
  const upd = meta.updatedAt, cab = meta.cachedAt;
  if (status === 'error') {
    const at = meta.errorAt != null ? meta.errorAt : (upd != null ? upd : cab);
    const failAge = relAge(at, nowMs);
    const failFrag = failAge ? ' (' + failAge + ' ago)' : '';
    const prior = upd != null ? upd : cab;
    const text = prior != null
      ? '⚠ Update failed' + failFrag + ' — showing ' + formatStamp(prior, nowMs, tz) + ' data'
      : '⚠ Update failed' + failFrag + ' — no data';
    return { state: 'error', tone: 'error', text, ageText: '', title: meta.error || '', canUpdate: true };
  }
  if (status === 'cached' && cab != null) {
    const age = relAge(cab, nowMs);
    const ageText = age ? '(' + age + ' ago)' : '';
    const text = 'Cached ' + formatStamp(cab, nowMs, tz) + (ageText ? ' ' + ageText : '');
    return { state: 'cached', tone: 'cached', text, ageText, title: meta.error || '', canUpdate: true };
  }
  if (upd != null) {
    const age = relAge(upd, nowMs);
    const ageText = age ? '(' + age + ' ago)' : '';
    const text = 'Updated ' + formatStamp(upd, nowMs, tz) + (ageText ? ' ' + ageText : '');
    return { state: 'live', tone: 'live', text, ageText, title: '', canUpdate: true };
  }
  return { state: 'never', tone: 'muted', text: 'Not loaded', ageText: '', title: '', canUpdate: false };
}

// Roll up several sub-source metas (e.g. Obstacles = wire+DOF+protected,
// Airspace = FAA+airports) into one meta-shaped object that
// buildSectionMetaLine can consume. Worst-of tone (error > cached > live),
// oldest timestamp so the header reflects its stalest piece. Adds `.detail`.
function rollupSources(sources, nowMs) {
  const names = Object.keys(sources || {});
  if (!names.length) return { status: 'never' };
  let anyError = false, anyCached = false, allLive = true;
  let oldestUpdated = null, oldestCached = null, latestError = null, errMsg = null;
  const detail = [];
  for (const name of names) {
    const s = sources[name] || {};
    const st = s.status || 'never';
    if (st === 'error') {
      anyError = true; allLive = false;
      if (s.errorAt != null && (latestError == null || s.errorAt > latestError)) latestError = s.errorAt;
      errMsg = errMsg || s.error;
    } else if (st === 'cached') {
      anyCached = true; allLive = false;
      if (s.cachedAt != null && (oldestCached == null || s.cachedAt < oldestCached)) oldestCached = s.cachedAt;
    } else if (st === 'live') {
      if (s.updatedAt != null && (oldestUpdated == null || s.updatedAt < oldestUpdated)) oldestUpdated = s.updatedAt;
    } else {
      allLive = false;
    }
    detail.push(name + ' ' + st);
  }
  let status = 'never';
  if (anyError) status = 'error';
  else if (anyCached) status = 'cached';
  else if (allLive) status = 'live';
  return {
    status,
    updatedAt: oldestUpdated,
    cachedAt: oldestCached,
    error: errMsg,
    errorAt: latestError,
    detail: detail.join(' · '),
  };
}

// Tone -> CSS class for the freshness line.
function metaToneClass(tone) {
  if (tone === 'live') return 'section-meta-live';
  if (tone === 'cached') return 'section-meta-cached';
  if (tone === 'error') return 'section-meta-error';
  return 'section-meta-muted';
}

// ============================================================
// 3D TERRAIN VIEW — pure style + camera helpers (MapLibre)
// The 3D toggle drapes the raster layers the 2D map is showing over real
// terrain. These builders are pure (no DOM/MapLibre) so they are testable
// in Node; sar-preflight.js snapshots the live 2D layer state and feeds it
// to build3dStyle().
// ============================================================
// AWS Open Data terrain tiles (Mapzen/Terrarium encoding — global, free, no key).
const TERRAIN_DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Leaflet zoom is defined against 256 px tiles, MapLibre style zoom against
// 512 px — the same view scale is one zoom level apart.
function leafletToMaplibreCamera(lat, lng, zoom) {
  return { center: [lng, lat], zoom: Math.max(0, (zoom || 0) - 1) };
}
function maplibreToLeafletCamera(lng, lat, zoom) {
  return { lat, lng, zoom: (zoom || 0) + 1 };
}

// --- Observer perspective view (first-person free-look) math ---
// Pitch here is MapLibre camera pitch: 0 = straight down, 90 = horizon.
// >90 looks above the horizon (MapLibre >=4.2 allows maxPitch up to 180).
const OBSERVER_PITCH_MIN = 5;
const OBSERVER_PITCH_MAX = 110;
const OBSERVER_MAX_PITCH = 110;   // map maxPitch while in observer mode
const OBSERVER_START_PITCH = 88;  // just below the horizon

// Normalize a bearing to [-180, 180).
function wrapBearing(deg) {
  const d = Number(deg) || 0;
  return ((d + 180) % 360 + 360) % 360 - 180;
}

function clampObserverPitch(pitch) {
  if (!Number.isFinite(pitch)) return OBSERVER_START_PITCH;
  return Math.min(OBSERVER_PITCH_MAX, Math.max(OBSERVER_PITCH_MIN, pitch));
}

// "Drag the world" convention (Street View feel): drag right -> look left,
// drag down -> look up. Sign constants live only here.
function applyLookDrag(pitch, bearing, dxPx, dyPx, degPerPx) {
  const k = degPerPx == null ? 0.25 : degPerPx;
  return {
    pitch: clampObserverPitch(pitch + (dyPx || 0) * k),
    bearing: wrapBearing(bearing - (dxPx || 0) * k),
  };
}

// Wheel/trackpad look: scroll up -> look up, horizontal scroll -> turn.
function wheelLook(pitch, bearing, deltaX, deltaY, degPerDelta) {
  const k = degPerDelta == null ? 0.12 : degPerDelta;
  return {
    pitch: clampObserverPitch(pitch - (deltaY || 0) * k),
    bearing: wrapBearing(bearing + (deltaX || 0) * k),
  };
}

// Camera altitude for an eye standing on (exaggerated) rendered ground.
// groundM comes from queryTerrainElevation (already exaggerated), so only
// the eye offset itself gets scaled by the exaggeration factor.
function observerEyeAltitudeM(groundM, eyeM, exaggeration) {
  const g = Number.isFinite(groundM) ? groundM : 0;
  return g + (eyeM || 0) * (exaggeration || 1);
}

function _raster3dSource(urls, maxzoom) {
  return { type: 'raster', tiles: Array.isArray(urls) ? urls : [urls], tileSize: 256, maxzoom };
}

// Build a complete MapLibre style document from a snapshot of 2D layer state.
// opts: {
//   theme: 'dark'|'light',
//   base: null|'satellite'|'topo'|'sectional',
//   sectionalUrl: FAA sectional XYZ template (used only when base==='sectional'),
//   overlays: { slope, parcels, streets } booleans,
//   rasters: [{ id, url, bounds:{west,south,east,north}, opacity }],  // canopy/viewshed data-URL images
//   exaggeration: vertical terrain exaggeration (default 1),
// }
function build3dStyle(opts) {
  const o = opts || {};
  const theme = o.theme === 'light' ? 'light' : 'dark';
  const cartoSubs = ['a', 'b', 'c', 'd'];
  const sources = {
    dem: {
      type: 'raster-dem', tiles: [TERRAIN_DEM_URL], encoding: 'terrarium',
      tileSize: 256, maxzoom: 15, attribution: 'Terrain: Mapzen/AWS, USGS 3DEP',
    },
    basemap: _raster3dSource(
      cartoSubs.map(s => `https://${s}.basemaps.cartocdn.com/${theme === 'light' ? 'light_all' : 'dark_all'}/{z}/{x}/{y}.png`), 19),
  };
  const layers = [
    { id: 'bg', type: 'background', paint: { 'background-color': theme === 'light' ? '#dfe8f0' : '#0a0e14' } },
    { id: 'basemap', type: 'raster', source: 'basemap' },
  ];
  // Mutually exclusive base overlay (same trio as the 2D layer control).
  if (o.base === 'satellite') {
    sources.satellite = _raster3dSource('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 19);
    layers.push({ id: 'satellite', type: 'raster', source: 'satellite' });
  } else if (o.base === 'topo') {
    sources.topo = _raster3dSource(['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), 17);
    layers.push({ id: 'topo', type: 'raster', source: 'topo' });
  } else if (o.base === 'sectional' && o.sectionalUrl) {
    sources.sectional = _raster3dSource(o.sectionalUrl, 12); // native z12 — MapLibre overzooms past it
    layers.push({ id: 'sectional', type: 'raster', source: 'sectional' });
  }
  const ov = o.overlays || {};
  if (ov.slope) {
    sources.slope = _raster3dSource('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', 19);
    layers.push({ id: 'slope', type: 'raster', source: 'slope', paint: { 'raster-opacity': 0.6 } });
  }
  if (ov.parcels) {
    sources.parcels = _raster3dSource('https://tiles.arcgis.com/tiles/KzeiCaQsMoeCfoCq/arcgis/rest/services/Regrid_Nationwide_Parcel_Boundaries_v1/MapServer/tile/{z}/{y}/{x}', 17);
    layers.push({ id: 'parcels', type: 'raster', source: 'parcels', paint: { 'raster-opacity': 0.85 } });
  }
  if (ov.streets) {
    sources.streets_roads = _raster3dSource('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', 15);
    sources.streets_places = _raster3dSource('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', 15);
    layers.push({ id: 'streets_roads', type: 'raster', source: 'streets_roads' });
    layers.push({ id: 'streets_places', type: 'raster', source: 'streets_places' });
  }
  // Sun/moon terrain shading: a native hillshade layer whose illumination
  // direction tracks the scene light (hillshadeParams), draped over the base
  // imagery. Needs its own raster-dem source — sharing the terrain source
  // with a hillshade layer is unsupported.
  sources.demShade = {
    type: 'raster-dem', tiles: [TERRAIN_DEM_URL], encoding: 'terrarium',
    tileSize: 256, maxzoom: 15,
  };
  layers.push({
    id: 'sunshade', type: 'hillshade', source: 'demShade',
    paint: {
      'hillshade-illumination-direction': o.lightAzimuth == null ? 335 : Math.round(o.lightAzimuth) % 360,
      'hillshade-illumination-anchor': 'map',
      'hillshade-exaggeration': o.lightShade == null ? 0.4 : o.lightShade,
      'hillshade-shadow-color': '#000810',
      'hillshade-highlight-color': '#ffffff',
    },
  });
  // Canopy / viewshed data-URL rasters draped as georeferenced images.
  (o.rasters || []).forEach(r => {
    if (!r || !r.url || !r.bounds) return;
    const b = r.bounds;
    sources['img_' + r.id] = {
      type: 'image', url: r.url,
      coordinates: [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]],
    };
    layers.push({
      id: 'img_' + r.id, type: 'raster', source: 'img_' + r.id,
      paint: { 'raster-opacity': r.opacity == null ? 0.7 : r.opacity },
    });
  });
  // Live weather radar (current frame only) drapes above imagery, below the
  // analysis rasters and vectors. RainViewer tiles are native z7.
  if (o.radarUrl) {
    sources.radar = _raster3dSource(o.radarUrl, 7);
    layers.push({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.5 } });
  }
  // Vector overlay groups (Phase 2) draw on top of every raster. Less-important
  // groups (higher pri) first, so safety-critical ones (TFRs etc.) paint on top.
  (o.vectors || [])
    .slice()
    .sort((a, b) => (b.pri == null ? 7 : b.pri) - (a.pri == null ? 7 : a.pri))
    .forEach(g => {
      const built = vector3dSourceAndLayers(g);
      if (!built) return;
      sources[built.srcId] = built.source;
      built.layers.forEach(l => layers.push(l));
    });
  return {
    version: 8,
    name: 'sar-3d',
    sources,
    layers,
    terrain: { source: 'dem', exaggeration: o.exaggeration == null ? 1 : o.exaggeration },
  };
}

// --- 3D vector overlays -------------------------------------------------
// Leaflet path options → the flat style props stored on each GeoJSON feature
// for data-driven paint (Leaflet's own defaults where unset).
function leafletStyleTo3d(opts) {
  const o = opts || {};
  const stroke = o.color || '#3388ff';
  return {
    stroke,
    strokeWidth: o.weight == null ? 3 : o.weight,
    strokeOpacity: o.opacity == null ? 1 : o.opacity,
    fill: o.fillColor || stroke,
    fillOpacity: o.fillOpacity == null ? 0.2 : o.fillOpacity,
  };
}

function _isLatLngLike(p) { return !!p && typeof p.lat === 'number' && typeof p.lng === 'number'; }

function _ring3dCoords(ring) {
  const out = ring.map(p => [p.lng, p.lat]);
  if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
    out.push([out[0][0], out[0][1]]);
  }
  return out;
}

// Normalize Leaflet Polygon.getLatLngs() nesting ({lat,lng} objects — a bare
// ring, a [ring,holes...] polygon, or a multi-polygon) into closed GeoJSON
// MultiPolygon coordinates ([[[ [lng,lat], ... ]]]).
function latlngsToMultiPolygon(latlngs) {
  if (!Array.isArray(latlngs) || !latlngs.length) return [];
  if (_isLatLngLike(latlngs[0])) return [[_ring3dCoords(latlngs)]];
  if (Array.isArray(latlngs[0]) && _isLatLngLike(latlngs[0][0])) return [latlngs.map(_ring3dCoords)];
  return latlngs.map(poly => (Array.isArray(poly) ? poly.map(_ring3dCoords) : [])).filter(p => p.length);
}

// Normalize Polyline.getLatLngs() (flat or nested) into MultiLineString coords.
function latlngsToMultiLine(latlngs) {
  const segs = [];
  const collect = a => {
    if (!Array.isArray(a) || !a.length) return;
    if (_isLatLngLike(a[0])) segs.push(a.map(p => [p.lng, p.lat]));
    else a.forEach(collect);
  };
  collect(latlngs);
  return segs;
}

// Leaflet dashArray ("6,4", px) → MapLibre line-dasharray (multiples of line width).
function dashArrayTo3d(dashArray, strokeWidth) {
  if (!dashArray) return null;
  const w = strokeWidth > 0 ? strokeWidth : 3;
  const parts = String(dashArray).split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (parts.length < 2) return null;
  return parts.map(n => n / w);
}

// Cylinder footprint radius for an extruded obstacle/tower of height hM —
// wide enough to see at VLOS-planning zooms, never absurd for tall towers.
function cylRadiusForHeightM(hM) {
  const h = Number(hM);
  if (!Number.isFinite(h) || h <= 0) return 8;
  return Math.min(40, Math.max(8, h * 0.15));
}

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0.24, 0.55, 0.99]; // accent blue fallback
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Pull the vertical (cylinder) records out of harvested vector groups into
// renderable segments for the custom 3D layer: narrow records (obstacle/tower
// heights, aircraft drop lines) become vertical lines; wide records (the
// aircraft position slab) become an X marker at that altitude. Heights are
// metres above the terrain surface at the feature.
function collectVerticalSegments(groups) {
  const out = [];
  (groups || []).forEach(g => ((g && g.features) || []).forEach(f => {
    if (!f || f.kind !== 'cylinder' || !(f.topM > 0)) return;
    const color = hexToRgb01(f.style && (f.style.fill || f.style.stroke));
    if (f.radiusM >= 20) {
      out.push({ type: 'cross', lat: f.lat, lng: f.lng, atM: Math.max(0, f.baseM || 0), armM: f.radiusM, color, thin: !!f.thin });
    } else {
      out.push({ type: 'line', lat: f.lat, lng: f.lng, fromM: Math.max(0, f.baseM || 0), toM: f.topM, color, thin: !!f.thin });
    }
  }));
  return out;
}

// --- Airspace palettes (shared by the 2D airspace layers) ----------------
const AIRSPACE_CLASS_COLORS = { B: '#3d8bfd', C: '#a78bfa', D: '#06b6d4', E: '#888888' };
const SUA_COLORS = { M: '#f59e0b', R: '#ef4444', P: '#991b1b', A: '#f59e0b', W: '#f59e0b' };
const LAANC_COLORS = { 0: '#ef4444', 100: '#f97316', 200: '#f59e0b', 300: '#86efac', 400: '#22c55e' };

function laancCeilingColor(ceil) {
  if (ceil == null || !Number.isFinite(Number(ceil)) || Number(ceil) < 0) return '#888888';
  const c = Number(ceil);
  if (c === 0) return LAANC_COLORS[0];
  if (c <= 100) return LAANC_COLORS[100];
  if (c <= 200) return LAANC_COLORS[200];
  if (c <= 300) return LAANC_COLORS[300];
  return LAANC_COLORS[400];
}

// --- 3D buildings (OSM footprints → terrain-anchored prisms) -------------

// Clamp a geographic bbox to a maximum span in degrees about its center.
// Guards Overpass building fetches against accidentally huge bboxes (a
// zoomed-out map view would otherwise request an entire region and get an
// arbitrary server-capped subset).
function clampBBoxSpan(south, west, north, east, maxSpanDeg) {
  const max = maxSpanDeg || 0.15;
  const cLat = (south + north) / 2, cLng = (west + east) / 2;
  const halfLat = Math.min(Math.abs(north - south) / 2, max / 2);
  const halfLng = Math.min(Math.abs(east - west) / 2, max / 2);
  return { south: cLat - halfLat, west: cLng - halfLng, north: cLat + halfLat, east: cLng + halfLng };
}

// Buildings-in-3D display mode: 'prisms' (extruded) or 'flat' (draped 2D
// footprints only — cheaper). 'auto' (or anything unrecognized) picks flat
// on resource-constrained devices, prisms otherwise.
function resolveBuildings3dMode(setting, constrained) {
  if (setting === 'prisms' || setting === 'flat') return setting;
  return constrained ? 'flat' : 'prisms';
}

// Building height in meters from OSM tags: explicit height tag (any unit)
// wins, then building:levels × 3 m/story, else a 5 m one-story default.
// Rural OSM rarely tags heights, so the default carries most buildings.
function buildingHeightM(tags) {
  const t = tags || {};
  const h = parseHeightToMeters(t.height);
  if (h !== null) return h;
  const levels = parseFloat(t['building:levels']);
  if (isFinite(levels) && levels >= 1) return levels * 3;
  return 5;
}

// Overpass `way["building"]` response → [{ id, footprint:[[lng,lat]...],
// heightM, name }]. Footprints are open rings (no repeated closing point)
// with degenerate (<3 distinct points) ways dropped. cap bounds the output.
function parseOverpassBuildings(data, cap) {
  const elements = (data && data.elements) || [];
  const nodes = {};
  elements.forEach(el => { if (el.type === 'node') nodes[el.id] = [el.lon, el.lat]; });
  const out = [];
  const max = cap || 4000;
  for (const el of elements) {
    if (out.length >= max) break;
    if (el.type !== 'way' || !el.tags || !el.tags.building) continue;
    let pts = (el.nodes || []).map(nid => nodes[nid]).filter(Boolean);
    if (pts.length >= 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
      pts = pts.slice(0, -1);
    }
    // Drop consecutive duplicates, then require a real polygon.
    const fp = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    if (fp.length < 3) continue;
    out.push({
      id: el.id,
      footprint: fp,
      heightM: buildingHeightM(el.tags),
      est: parseHeightToMeters(el.tags.height) === null, // true = levels-derived or default
      name: el.tags.name || null,
      type: el.tags.building !== 'yes' ? el.tags.building : null,
    });
  }
  return out;
}

// Minimal ear-clipping triangulation of a simple polygon (open ring of
// [x,y]-likes, no holes — Overpass ways can't carry holes). Returns index
// triples into the ring. Falls back to a triangle fan if clipping stalls
// (self-intersecting footprint) so every building still renders something.
function earClipTriangulate(ring) {
  const n = ring.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  // Signed area doubles as winding: ensure CCW index order for the ear test.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(area >= 0 ? i : n - 1 - i);
  const inTri = (p, a, b, c) =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const tris = [];
  let guard = n * n; // bounded: a simple polygon clips one ear per O(n) scan
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = ring[ia], b = ring[ib], c = ring[ic];
      if (cross(a, b, c) <= 0) continue; // reflex vertex — not an ear
      let contains = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(ring[j], a, b, c)) { contains = true; break; }
      }
      if (contains) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate/self-intersecting — bail to fan
  }
  if (idx.length === 3) {
    tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }
  // Fallback fan from vertex 0 (imperfect for concave shapes but never fails).
  const fan = [];
  for (let i = 1; i < n - 1; i++) fan.push([0, i, i + 1]);
  return fan;
}

// Footprint + height → prism mesh in geographic terms: triangle vertices as
// { lng, lat, top, normal } where top=true means the vertex sits at roof
// height and normal is the outward unit surface normal in the local ENU
// frame (x=east, y=north, z=up) — the 3D shader lights it by sun/moon
// position. Walls get their edge's outward horizontal normal (winding-aware
// via the shoelace sign), roofs point straight up.
function buildingMeshLocal(footprint, heightM) {
  const n = footprint.length;
  const verts = [];
  if (n < 3 || !(heightM > 0)) return verts;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area >= 0 ? 1 : -1; // CCW in lng/lat: outward = (d_north, -d_east)
  const cosLat = Math.cos((footprint[0][1] || 0) * Math.PI / 180);
  const push = (p, top, normal) => verts.push({ lng: p[0], lat: p[1], top, normal });
  for (let i = 0; i < n; i++) {
    const a = footprint[i], b = footprint[(i + 1) % n];
    const de = (b[0] - a[0]) * cosLat, dn = b[1] - a[1];
    const len = Math.hypot(de, dn) || 1;
    const normal = [sign * dn / len, sign * -de / len, 0];
    push(a, false, normal); push(b, false, normal); push(b, true, normal);
    push(a, false, normal); push(b, true, normal); push(a, true, normal);
  }
  const up = [0, 0, 1];
  earClipTriangulate(footprint).forEach(t => {
    push(footprint[t[0]], true, up);
    push(footprint[t[1]], true, up);
    push(footprint[t[2]], true, up);
  });
  return verts;
}

// ADS-B aircraft → cylinder records for the 3D view: a floating slab at the
// aircraft's AGL altitude plus a thin full-height "how high is it" drop line.
// MapLibre renders fill-extrusions relative to the terrain surface when
// terrain is enabled, so base 0 = the ground beneath the aircraft; aglM
// should already carry the terrain exaggeration for a matched vertical scale.
// aircraft: [{ lat, lng, aglM, color, popupHtml }]
function aircraft3dRecords(aircraft) {
  const out = [];
  (aircraft || []).forEach(ac => {
    if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lng)) return;
    const aglM = Number(ac.aglM);
    if (!Number.isFinite(aglM) || aglM <= 0) return;
    const style = { stroke: ac.color || '#06b6d4', fill: ac.color || '#06b6d4' };
    const common = { popupHtml: ac.popupHtml || '', label: 'Aircraft', pri: 2, style };
    // thin: aircraft verticals stay 1px; obstacle/tower lines render as thick quads
    out.push(Object.assign({ kind: 'cylinder', lat: ac.lat, lng: ac.lng, radiusM: 3, baseM: 0, topM: aglM, thin: true }, common));
    out.push(Object.assign({ kind: 'cylinder', lat: ac.lat, lng: ac.lng, radiusM: 50, baseM: aglM, topM: aglM + 25, thin: true }, common));
  });
  return out;
}

// One harvested overlay group → a MapLibre geojson source + fill/line/circle
// style layers with data-driven paint. Returns null when the group has no
// flat geometry. 'cylinder' records (vertical extents) are NOT styled here —
// MapLibre's fill-extrusion misplaces GeoJSON extrusions over high terrain
// (elevation sampling bug, maplibre-gl-js#2560 family), so verticals render
// via the custom WebGL layer instead (collectVerticalSegments + _vert3dLayer).
// group: { id, features: [{ kind:'polygon'|'line'|'point'|'cylinder',
//   multiPolygon?|multiLine?|point:[lng,lat]|lat+lng+radiusM+baseM+topM,
//   radius?, dashArray?, style:{stroke,strokeWidth,strokeOpacity,fill,fillOpacity},
//   popupHtml, label, pri }] }
function vector3dSourceAndLayers(group) {
  const g = group || {};
  const feats = [];
  let hasPoly = false, hasLine = false, hasPoint = false, dash = null;
  (g.features || []).forEach(f => {
    if (!f) return;
    let geometry = null;
    if (f.kind === 'polygon' && f.multiPolygon && f.multiPolygon.length) {
      geometry = { type: 'MultiPolygon', coordinates: f.multiPolygon };
      hasPoly = true; hasLine = true;
    } else if (f.kind === 'line' && f.multiLine && f.multiLine.length) {
      geometry = { type: 'MultiLineString', coordinates: f.multiLine };
      hasLine = true;
    } else if (f.kind === 'point' && f.point) {
      geometry = { type: 'Point', coordinates: f.point };
      hasPoint = true;
    }
    if (!geometry) return;
    const s = f.style || {};
    if (!dash && f.dashArray) dash = dashArrayTo3d(f.dashArray, s.strokeWidth);
    feats.push({
      type: 'Feature',
      geometry,
      properties: {
        stroke: s.stroke || '#3388ff',
        strokeWidth: s.strokeWidth == null ? 3 : s.strokeWidth,
        strokeOpacity: s.strokeOpacity == null ? 1 : s.strokeOpacity,
        fill: s.fill || s.stroke || '#3388ff',
        fillOpacity: s.fillOpacity == null ? 0.2 : s.fillOpacity,
        radius: f.radius == null ? 6 : f.radius,
        popupHtml: f.popupHtml || '',
        label: f.label || '',
        pri: f.pri == null ? 7 : f.pri,
        ...(f.featId != null ? { featId: f.featId } : {}),
      },
    });
  });
  if (!feats.length) return null;
  const srcId = 'vec_' + g.id;
  const layers = [];
  if (hasPoly) {
    layers.push({
      id: srcId + '_fill', type: 'fill', source: srcId,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] },
    });
  }
  if (hasLine) {
    const paint = {
      'line-color': ['get', 'stroke'],
      'line-width': ['get', 'strokeWidth'],
      'line-opacity': ['get', 'strokeOpacity'],
    };
    if (dash) paint['line-dasharray'] = dash;
    layers.push({
      id: srcId + '_line', type: 'line', source: srcId,
      filter: ['!=', ['geometry-type'], 'Point'],
      paint,
    });
  }
  if (hasPoint) {
    layers.push({
      id: srcId + '_pt', type: 'circle', source: srcId,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'fill'],
        'circle-opacity': ['get', 'fillOpacity'],
        'circle-stroke-color': ['get', 'stroke'],
        'circle-stroke-width': 1.5,
        'circle-stroke-opacity': ['get', 'strokeOpacity'],
      },
    });
  }
  return { srcId, source: { type: 'geojson', data: { type: 'FeatureCollection', features: feats } }, layers };
}

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WIRE_CATEGORIES, CHANGELOG_ENTRIES, CHANGELOG_URL, lerp, degToCompass, haversine, wmoCodeToText,
    parseSectionalEdition, currentSectionalCycle,
    calcSunPosition, calcMoonPhase, calcMoonPosition, lightVecENU, lightForTime, hillshadeParams,
    wireHazardName, parseHeightToMeters, osmTowerHeightFt,
    parseChangelogMd,
    TRAIL_HIGHWAY_TYPES, buildTrailsOverpassQuery, parseOverpassTrails, trailTypeLabel,
    DOF_LIGHTING, obstacleLighting, obstacleMarkerColor, obstacleLabel,
    summarizeObstacles, obstacleHazardLevel,
    wxAtHour, kpAtTime, calcDensityAltitude, calcBatteryDerating, assessPropIcing, assessRisk,
    freezingLevelRisk, metarCeilingFt, flightCategory, assessCloudClearance,
    DEFAULT_THRESHOLDS, DRONE_PROFILES,
    classifyTerrain, estimateVegetation, estimateCellCoverage,
    SMA_NONPUBLIC_CODES, smaAgencyInfo, smaIsPublic, classifyAreaPublicPrivate, cellCoverageAt,
    filterAirportsByDistance, classifyAirspace,
    calcGustFactor, calcWindShear,
    generateElevationGrid, calcSlopeFromGrid, calcAspect,
    detectTerrainFeatures, scoreLZFitness, findEmergencyLZs,
    assessTerrainTurbulence, analyzeGPSMasking,
    calcSwapRecommendation,
    computeAdsbSearchRadius, parseAdsbAircraft, formatAltitudeAgl,
    pointInPolygon, pointInRings, distPointToSegment, polygonBBox, bboxesOverlap, segmentsIntersect, polygonsIntersect,
    circleToPolygon, parseFaaCoord, normalizeFaaDate, geoJsonOuterRings,
    parseTfrGeoJson, parseTfrList, normalizeTfrDetailDoc, parseTfrDetailXml,
    filterTfrsIntersectingArea, isTfrActiveNow, parseNotamText, geolocateNotam,
    parseNotamSearchResponse, parseNotamSearchItem,
    NOTAM_CONTRACTIONS, expandNotamText, toDmsDisplay, fmtNotamDate, fmtAlt,
    NOTAM_SUBJECTS, ringRadiusNm, notamPlainSummary,
    notamCategory, classifyNotamForUAS, NOTAM_CATEGORY_RELEVANT,
    ARTCC_REF, ARTCC_BOUNDS, artccForPoint, artccsForArea,
    kmlEscape, kmlCdata, htmlToPlainText, kmlRingFromLatLng, kmlRingFromGeoJson,
    kmlPolygonPlacemark, kmlPointPlacemark, kmlLinePlacemark, kmlFolder, kmlDocument,
    KML_STYLE_DEFS, kmlStyles, groundOverlayKml, destPoint, bearingLineGeometry,
    sunArrowsKml, windArrowsKml,
    KML_ICON_BASE, kmlColorToRgba, caltopoStyleProps, geojsonFolderFeature, geojsonMarkerFeature,
    geojsonShapeFeature, geojsonLineGeometry, geojsonPolygonGeometry, geojsonFeatureCollection,
    formatStamp, relAge, buildSectionMetaLine, rollupSources, metaToneClass,
    TERRAIN_DEM_URL, leafletToMaplibreCamera, maplibreToLeafletCamera, build3dStyle,
    OBSERVER_PITCH_MIN, OBSERVER_PITCH_MAX, OBSERVER_MAX_PITCH, OBSERVER_START_PITCH,
    wrapBearing, clampObserverPitch, applyLookDrag, wheelLook, observerEyeAltitudeM,
    leafletStyleTo3d, latlngsToMultiPolygon, latlngsToMultiLine, dashArrayTo3d, vector3dSourceAndLayers,
    cylRadiusForHeightM, aircraft3dRecords, hexToRgb01, collectVerticalSegments,
    AIRSPACE_CLASS_COLORS, SUA_COLORS, LAANC_COLORS, laancCeilingColor,
    buildingHeightM, parseOverpassBuildings, earClipTriangulate, buildingMeshLocal, clampBBoxSpan,
    resolveBuildings3dMode,
  };
}
