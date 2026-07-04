# SAR UAS Pre-Flight Intelligence Tool

A browser-based pre-flight intelligence tool for UAS (drone) operators conducting Search and Rescue missions. Consolidates weather, airspace, terrain, fire danger, and operational data into a single map-based interface for Part 107 compliance.

## Disclaimer

**This tool is provided for informational and planning purposes only.**

The data displayed in this application may be incomplete, inaccurate, outdated, or incorrect. Data is sourced from third-party APIs and open data services that may experience outages, delays, or errors. Calculated values (density altitude, airspace classification, risk assessments, etc.) are approximations and may not reflect actual conditions.

**Users must independently verify all data before flight operations.** Always cross-check critical information (airspace, TFRs, NOTAMs, weather) against official FAA sources, certified weather briefings, and current aeronautical publications. The GO/CAUTION/NO-GO assessment is advisory only and does not replace the Remote Pilot In Command's responsibility to evaluate flight safety.

## Website

https://thecoderperson.github.io/SAR-Preflight/sar-preflight.html

## Changelog

Version history is in [CHANGELOG.md](CHANGELOG.md). In the app, a **What's New** dialog appears after each update, and a **What's New / Changelog** button lives in Config → App Version.

## How to Use

1. **Open the app** in a browser (desktop or mobile)
2. The map centers on your GPS location (or defaults to central California)
3. **Draw an operational area** on the map using the rectangle, circle, or polygon tools (left toolbar), or enter coordinates manually
4. All data tabs auto-populate with conditions for your area
5. The **GO / CAUTION / NO-GO** assessment banner appears based on current conditions
6. Use the **Data Panel** tabs (Weather, Wind, Airspace, Traffic, Terrain, Sun/Moon, GNSS, NOTAMs, Ops) to review detailed information
7. **Export** a pre-flight briefing as PDF, email, clipboard text, or KML. The KML export captures **every currently-visible map layer** as real geometry — airspace, TFRs, NOTAMs, obstacles, wires, airports, towers, fires, NWS alerts, ADS-B, etc. — with plain-text descriptions, category icons (plane for airports, circle-H for heliports), and NOTAM/TFR folders that lead with a plain-English summary before the raw text. It also adds **hourly sun & wind bearing lines** (24 h, time-slider animation; sun omitted while below the horizon, wind drawn downwind). Canopy and viewshed overlays export as **georeferenced GeoTIFFs in Web Mercator (EPSG:3857)** — the projection CalTopo's *Map Sheet* import expects — and, optionally, as **KMZ GroundOverlays** for Google Earth. Wire, obstacle, NOTAM and TFR folders carry a *"verify independently — not a complete inventory"* note

### Map Features
- Toggle map layers (satellite, topo, FAA sectional, weather radar, GOES cloud imagery + GLM lightning, airspace, LAANC grid, FAA obstacles, towers, wire hazards, dams, fire perimeters, wildfire smoke plumes, live aircraft traffic, and an optional **Winter Ops** group — avalanche danger zones + SNODAS snow depth) via the **Map Layers** control
- **Click any point to inspect overlapping features.** A single click hit-tests every visible layer and shows all matches in one popup with `← n/N →` pagination, so overlapping airspace, an obstacle, a LAANC cell, and a NOTAM at the same spot can all be read without toggling layers off
- The **FAA Obstacles (DOF)** layer plots verified man-made obstacles color-coded by height (red ≥ 200 ft AGL, amber 100–199, yellow < 100); popups show AGL/AMSL height, lighting, and marking status
- The **FAA Sectional** layer streams the current official FAA VFR sectional (56-day cycle); drawing an operational area auto-caches its tiles for offline use, and the cached edition is shown / refreshed when a newer one is published
- Import FAA sectional chart GeoTIFFs for full-resolution offline chart overlay (backup to the live sectional)
- **Active TFRs & NOTAMs**: when the data proxy is configured (see below) the app auto-fetches live TFRs *and* NOTAMs for your area on every draw — TFRs plot + feed the assessment; NOTAMs plot + list in the NOTAMs tab (advisory — sourced from the unofficial FAA NOTAM Search backend; verify officially). Without a proxy it falls back to area-scoped deep-links + in-app file/paste import
- Toggle a **vegetation height overlay** (Meta/WRI 1 m canopy) over the current view with an opacity slider (Terrain tab → *Canopy & Visibility*)
- Run a **viewshed**: tap an observer location and the tool shades every spot where a drone at your entered AGL would be visible to a 5.5 ft-eye observer, factoring terrain *and* vegetation into line-of-sight (Terrain tab, or the eye icon on the draw toolbar)
- **Scout multiple observer locations**: add several observers, each with its own saved viewshed. Only one viewshed is shown at a time — flip between them instantly (no recomputation), recompute, rename, or delete from the observer list. Saved viewsheds persist per operational area in IndexedDB, so they redraw on reload without recomputing. Exporting writes every observer as a KML point plus one georeferenced GeoTIFF per observer's viewshed for CalTopo
- **Live ADS-B traffic with terrain-relative AGL** (Traffic tab): nearby aircraft are polled live, and each aircraft's height-above-ground is computed against the terrain *directly beneath it* (USGS 3DEP) rather than your launch elevation — so AGL stays meaningful across ridges and canyons. Low, close traffic (below 1,500 ft AGL within 5 NM — the deconfliction-relevant set) is sharpened to 3DEP's native resolution; the popup also shows raw barometric MSL and the terrain elevation under the plane
- Use the **timebar** at the bottom to scrub through 24-hour wind and sun direction forecasts
- **Wind arrow** (blue) and **sun arrow** (yellow) on the map update as you scrub

## Data Sources

All data is fetched from free, public APIs. No API keys are required.

| Data | Source | Update Frequency |
|---|---|---|
| Current weather, temperature, humidity, pressure, visibility | [Open-Meteo](https://open-meteo.com/) | ~30 min |
| 24-hour hourly forecast (temp, wind, precip) | [Open-Meteo](https://open-meteo.com/) | ~30 min |
| Upper winds (80m, 120m, 180m) | [Open-Meteo](https://open-meteo.com/) | ~30 min |
| Freezing level (0 °C isotherm, icing-aloft flag) | [Open-Meteo](https://open-meteo.com/) | ~30 min |
| Observed ceiling, visibility & flight category (VFR/MVFR/IFR/LIFR) for the Part 107 cloud-clearance gate | [FAA Aviation Weather Center METAR](https://aviationweather.gov/data/api/) | ~hourly |
| Air quality (AQI, PM2.5, PM10, ozone) | [Open-Meteo Air Quality](https://open-meteo.com/) | ~30 min |
| Cursor elevation | [Open-Meteo Elevation](https://open-meteo.com/) | Static |
| Terrain elevation grid | [Open-Elevation](https://open-elevation.com/) | Static |
| Terrain DEM — viewshed (best-available, ~3 m effective) **and** ADS-B traffic AGL (cached area raster + per-aircraft `getSamples` point sampling) | [USGS 3DEP](https://www.usgs.gov/3d-elevation-program) Elevation ImageServer (CORS-enabled) | Static |
| Vegetation (canopy) height — 1 m, for the overlay & viewshed | [Meta/WRI Global Canopy Height](https://registry.opendata.aws/dataforgood-fb-forests/) via a self-hosted Cloudflare Worker proxy (see [`tools/canopy-proxy`](tools/canopy-proxy)) | Static |
| Sunrise, sunset, civil/nautical twilight | [Sunrise-Sunset.org](https://sunrise-sunset.org/) | Daily |
| Sun azimuth and elevation | Calculated (solar position algorithm) | Real-time |
| Moon phase and illumination | Calculated (lunar phase algorithm) | Real-time |
| Geomagnetic Kp index (GNSS accuracy) | [NOAA SWPC](https://www.swpc.noaa.gov/) | ~1 hr |
| NWS severe weather alerts | [NWS Weather API](https://www.weather.gov/documentation/services-web-api) | ~15 min |
| Weather radar animation | [RainViewer](https://www.rainviewer.com/) | ~10 min |
| GOES-East GeoColor cloud imagery (Weather Imagery layer) | [NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/) / NOAA GOES-East | ~10 min |
| GOES GLM lightning strike density (Weather Imagery layer) | [NOAA nowCOAST](https://nowcoast.noaa.gov/) via WMS | ~15 min |
| Class B/C/D/E airspace boundaries | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| Special use airspace (MOAs, restricted, prohibited) | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| TFR areas (national defense) | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| LAANC grid ceilings | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| National security UAS restrictions | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| Man-made obstacles — verified AGL/AMSL height, lighting, marking, type (towers, antennas, stacks, cranes, met towers, etc.) | [FAA Digital Obstacle File](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/dof/) via ArcGIS | 56-day cycle |
| Current FAA VFR sectional chart tiles | [FAA Aeronautical Information Services](https://www.faa.gov/air_traffic/flight_info/aeronav/) via ArcGIS | 56-day cycle |
| Active TFRs — live auto-fetch when the data proxy is set, else in-app import / deep-link | [FAA TFR GeoServer](https://tfr.faa.gov/) (live via the [`tools/canopy-proxy`](tools/canopy-proxy) Worker, `/tfr/` route) | Per area draw |
| NOTAMs — live auto-fetch when the data proxy is set (advisory), else file/paste import | FAA NOTAM Search backend (unofficial) via the [`tools/canopy-proxy`](tools/canopy-proxy) Worker, `/notam` route | Per area draw |
| Airports, heliports, seaplane bases | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API | Cached 7 days |
| Towers (comm, water, wind turbine, chimney, etc.) | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API | Cached 7 days |
| Wire/cable hazards & power transmission lines (with voltage where tagged) | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API | Cached 7 days |
| Active wildfire perimeters | [NIFC](https://data-nifc.opendata.arcgis.com/) via ArcGIS | ~5 min |
| Wildfire smoke plumes (Light/Medium/Heavy) | [NOAA HMS Smoke](https://www.ospo.noaa.gov/products/land/hms.html) via ArcGIS | Daily |
| Avalanche danger zones (danger 1–5, warnings) — Winter Ops layer | [avalanche.org](https://api.avalanche.org/) public API | ~Daily (season) |
| Snow depth (SNODAS) — Winter Ops layer | [NOAA NOHRSC](https://www.nohrsc.noaa.gov/) via WMS | Daily |
| Fire danger rating (CA only: BI, ERC, fuel moisture) | [NIFC CA NFDRS](https://data-nifc.opendata.arcgis.com/) via ArcGIS | Daily |
| Dams | [HIFLD](https://hifld-geoplatform.opendata.arcgis.com/) via ArcGIS | Static |
| Wilderness areas | [USFS](https://services1.arcgis.com/) via ArcGIS | Static |
| National parks | [NPS](https://services1.arcgis.com/) via ArcGIS | Static |
| Live ADS-B aircraft traffic (with 15-min trails; AGL computed against the terrain beneath each aircraft via USGS 3DEP, MSL shown as raw barometric) | [adsb.fi](https://adsb.fi/), [airplanes.live](https://airplanes.live/), [adsb.lol](https://www.adsb.lol/) (fallback chain; routed through the data proxy's `/adsb` route when configured, since these providers increasingly block browser CORS) | 5 sec polling |
| Magnetic declination | Approximate WMM 2025 model | Static |
| Density altitude | Calculated from station pressure and temperature | Real-time |
| Battery derating | Calculated from temperature, altitude, wind | Real-time |
| Bird strike risk | Calculated from season, time of day, terrain, altitude | Real-time |

**Notes:**
- **FAA TFR:** the FAA TFR GeoServer is CORS-restricted, so direct browser polling is blocked. With the optional data proxy ([`tools/canopy-proxy`](tools/canopy-proxy)) configured, the app fetches live TFR polygons for your area through the Worker's `/tfr/` route (proxied server-side with a near-zero cache so they stay current). Without a proxy, it falls back to area-scoped deep-links + an in-app file/paste importer.
- **FAA NOTAM:** the official FAA NOTAM API is not self-serve. With the data proxy configured, the app instead drives the **public FAA NOTAM Search backend** (`notamSearch/search`) through the Worker's `/notam` route (it handles the session cookie, full form parameters, and pagination server-side) and plots/lists the results per area. **This is an unofficial, undocumented endpoint — treat it as advisory, it may change without notice, and it is cached/rate-limited politely.** The file/paste importer remains available as a fallback. Always confirm NOTAMs against an official briefing source before flight.
  - **UAS relevance filtering + readability:** live NOTAMs are parsed for their real geometry (e.g. `3NM RADIUS OF …` → a plotted circle), altitude band, and schedule; rendered as a plain-language one-liner (contractions expanded); and filtered to those relevant to a SFC–400 ft drone in the drawn area (by distance to the NOTAM's actual coordinates and by type). Filtering errs toward keeping anything surface-affecting (obstacles, GPS/ADS-B outages, parachute/laser/UAS/TFR are never hidden by altitude), and a **"show all (N filtered)"** toggle always reveals the hidden set — nothing is permanently suppressed.
- **FAA Digital Obstacle File:** the DOF catalogs verified obstacles but is **not a complete low-altitude inventory** — below ~200 ft AGL away from airports it is intentionally sparse, so the absence of an obstacle is not proof of clear airspace. It complements (does not replace) the OpenStreetMap wire/tower hazard layers and visual reconnaissance.
- **Vegetation / viewshed:** the USGS 3DEP terrain DEM is read directly in-browser (CORS-enabled), so the viewshed works "bare-earth" with no setup. The Meta 1 m canopy tiles, however, are served from an AWS bucket that sends no CORS headers, so the canopy overlay and vegetation-aware viewshed require a small **self-hosted Cloudflare Worker** proxy (free tier; one-time setup — see [`tools/canopy-proxy/README.md`](tools/canopy-proxy/README.md)) whose URL is set in the Config tab. Viewed areas are cached in IndexedDB for offline use. The viewshed is a **modeled** line-of-sight from terrain + canopy and is not a substitute for legal VLOS or on-scene judgment.
- **ADS-B traffic altitude:** each aircraft's AGL is its reported altitude minus the ground elevation *under the aircraft*, from USGS 3DEP (no proxy needed — 3DEP is CORS-enabled). A single coarse DEM (~110–360 m/cell, sized to the 15–50 NM traffic search radius) is fetched once per area and cached in IndexedDB for offline reuse; aircraft that are both low and close (below 1,500 ft AGL within 5 NM — the deconfliction-relevant set) are additionally refined to 3DEP's native resolution via a batched `getSamples` point query and tagged "(3DEP point)" in the popup. **Caveats:** the displayed **MSL is the raw barometric altitude** reported by the aircraft (referenced to the standard 29.92 inHg datum, *not* local pressure, so it can differ from true MSL on a non-standard-pressure day), and AGL over distant terrain is only as precise as the coarse cell. Treat traffic altitudes as advisory situational awareness, not deconfliction-grade values.

## Data proxy setup (Cloudflare Worker)

A few of the app's data sources can't be read directly from a browser — they either block cross-origin (CORS) requests or have to be driven server-side. A tiny, free **Cloudflare Worker** stands in front of them as a CORS proxy so the app can use them:

- **Vegetation / canopy height** (Meta/WRI 1 m tiles) — powers the canopy overlay and the vegetation-aware viewshed
- **Live TFRs** (FAA TFR GeoServer) — auto-fetched per operational area
- **Live NOTAMs** (FAA NOTAM Search backend — *unofficial, advisory*) — auto-fetched per area
- **Live ADS-B traffic** — routed through the proxy when configured, since the public providers increasingly block browser CORS

The proxy is **optional**. Without it the terrain viewshed (USGS 3DEP) still works, and TFRs/NOTAMs fall back to deep-links + in-app file/paste import. It runs on Cloudflare's **free** Workers plan, which has **no usage-based billing** — if the daily request limit is ever hit it simply returns errors until the next day, so it can never run up a bill. Real SAR usage is a few hundred requests/day, far below the limit.

The Worker source is **[`tools/canopy-proxy/worker.js`](tools/canopy-proxy/worker.js)**. Set it up one of two ways.

### Option A — Cloudflare dashboard (no tools, ~5 min)

1. Create a free Cloudflare account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages → Create application → Create Worker.** Give it a name (e.g. `sar-canopy-proxy`), click **Deploy** to create the starter, then **Edit code**.
3. Open **[`tools/canopy-proxy/worker.js`](tools/canopy-proxy/worker.js)** here on GitHub, click **Raw**, and copy the whole file. Paste it into the Worker editor, replacing the starter code.
4. **Edit the `ALLOWED_ORIGINS` list** near the top so it includes the site you load the app from. The production GitHub Pages origin is already listed; add your own host (or `http://localhost:8000` for local testing) if you self-host. The Worker returns `403` to any other origin, so this step isn't optional when you host the app yourself.
5. Click **Deploy**. Copy the Worker URL it shows — `https://sar-canopy-proxy.<your-subdomain>.workers.dev`.
6. In the app, open **Config → Data Sources → Data proxy URL**, paste that URL, and click **Save**.

### Option B — Wrangler CLI

If you'd rather deploy from a terminal (and have Node installed):

```bash
npm i -g wrangler          # one-time
wrangler login             # one-time, opens a browser
cd tools/canopy-proxy
wrangler deploy
```

`wrangler deploy` prints the Worker URL — paste it into **Config → Data Sources → Data proxy URL** in the app. Edit `ALLOWED_ORIGINS` in `worker.js` first if you host the app somewhere other than the preconfigured origins, then re-run `wrangler deploy`.

### Security & abuse protection

The Worker is locked down so it can't be misused or cost you money:

- **Not an open proxy** — it only ever forwards the specific upstreams listed above (and rejects `..`), so it can't be repurposed to fetch arbitrary URLs.
- **Origin allowlist** — requests whose `Origin`/`Referer` isn't in `ALLOWED_ORIGINS` get a `403`, so other sites can't hot-link it and burn your quota.
- **No overage billing** — the free Workers plan has no usage-based charges (see above).

For an extra layer you can add a **Rate limiting rule** in the Cloudflare dashboard (Security → WAF → Rate limiting rules) to cap requests per IP. Full details and a route-by-route breakdown are in **[`tools/canopy-proxy/README.md`](tools/canopy-proxy/README.md)**.

## Offline Use

The app uses a service worker to cache resources for offline use. You can pre-download map tiles for your area of operations via the Settings tab. Previously fetched API data is cached in IndexedDB with configurable TTLs.

## Privacy & Usage Analytics

When deployed with analytics enabled, the tool counts **anonymous page opens** and your **approximate country** (no finer geography) using [Cloudflare Web Analytics](https://www.cloudflare.com/web-analytics/) — solely to gauge how often the tool is used and to prioritize features. It is **cookieless** and stores **no** precise location, IP address, mission area, or personal data; **nothing from your map** (GPS, drawn operational area, observer/viewshed points) is ever transmitted, and analytics **never run offline** or in the single-file field build. Browser Do-Not-Track / Global Privacy Control is honored, and you can opt out anytime in the **Config** tab. Analytics activate when a Cloudflare Web Analytics token is set (`CF_ANALYTICS_TOKEN` in `sar-preflight.js`) and stay disabled on localhost, offline, and in the single-file field build.

---

This software is not certified by the FAA or any aviation authority. Use at your own risk. The developers assume no liability for decisions made based on information provided by this tool.
