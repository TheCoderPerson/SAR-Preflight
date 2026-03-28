# SAR UAS Pre-Flight Intelligence Tool

A browser-based pre-flight intelligence tool for UAS (drone) operators conducting Search and Rescue missions. Consolidates weather, airspace, terrain, fire danger, and operational data into a single map-based interface for Part 107 compliance.

## How to Use

1. **Open the app** in a browser (desktop or mobile)
2. The map centers on your GPS location (or defaults to central California)
3. **Draw an operational area** on the map using the rectangle, circle, or polygon tools (left toolbar), or enter coordinates manually
4. All data tabs auto-populate with conditions for your area
5. The **GO / CAUTION / NO-GO** assessment banner appears based on current conditions
6. Use the **Data Panel** tabs (Weather, Wind, Airspace, Traffic, Terrain, Sun/Moon, GNSS, NOTAMs, Ops) to review detailed information
7. **Export** a pre-flight briefing as PDF, email, clipboard text, or KML

### Map Features
- Toggle map layers (satellite, topo, FAA sectional, weather radar, airspace, towers, wire hazards, fire perimeters, live aircraft traffic) via the **Map Layers** control
- Import FAA sectional chart GeoTIFFs for offline chart overlay
- Use the **timebar** at the bottom to scrub through 24-hour wind and sun direction forecasts
- **Wind arrow** (blue) and **sun arrow** (yellow) on the map update as you scrub

## Data Sources

All data is fetched from free, public APIs. No API keys are required.

| Data | Source | Update Frequency |
|---|---|---|
| Current weather, temperature, humidity, pressure, visibility | [Open-Meteo](https://open-meteo.com/) | ~30 min |
| 24-hour hourly forecast (temp, wind, precip) | [Open-Meteo](https://open-meteo.com/) | ~30 min |
| Upper winds (80m, 120m, 180m) | [Open-Meteo](https://open-meteo.com/) | ~30 min |
| Air quality (AQI, PM2.5, PM10, ozone) | [Open-Meteo Air Quality](https://open-meteo.com/) | ~30 min |
| Cursor elevation | [Open-Meteo Elevation](https://open-meteo.com/) | Static |
| Terrain elevation grid | [Open-Elevation](https://open-elevation.com/) | Static |
| Sunrise, sunset, civil/nautical twilight | [Sunrise-Sunset.org](https://sunrise-sunset.org/) | Daily |
| Sun azimuth and elevation | Calculated (solar position algorithm) | Real-time |
| Moon phase and illumination | Calculated (lunar phase algorithm) | Real-time |
| Geomagnetic Kp index (GNSS accuracy) | [NOAA SWPC](https://www.swpc.noaa.gov/) | ~1 hr |
| NWS severe weather alerts | [NWS Weather API](https://www.weather.gov/documentation/services-web-api) | ~15 min |
| Weather radar animation | [RainViewer](https://www.rainviewer.com/) | ~10 min |
| Class B/C/D/E airspace boundaries | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| Special use airspace (MOAs, restricted, prohibited) | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| TFR areas (national defense) | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| LAANC grid ceilings | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| National security UAS restrictions | [FAA UDDS](https://udds.faa.gov/) via ArcGIS | Static |
| Airports, heliports, seaplane bases | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API | Cached 7 days |
| Towers (comm, water, wind turbine, chimney, etc.) | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API | Cached 7 days |
| Wire/cable hazards (power, telecom, aerialway) | [OpenStreetMap](https://www.openstreetmap.org/) via Overpass API | Cached 7 days |
| Power transmission lines with voltage | [HIFLD](https://hifld-geoplatform.opendata.arcgis.com/) via ArcGIS | Static |
| Active wildfire perimeters | [NIFC](https://data-nifc.opendata.arcgis.com/) via ArcGIS | ~5 min |
| Fire danger rating (CA only: BI, ERC, fuel moisture) | [NIFC CA NFDRS](https://data-nifc.opendata.arcgis.com/) via ArcGIS | Daily |
| Dams | [HIFLD](https://hifld-geoplatform.opendata.arcgis.com/) via ArcGIS | Static |
| Wilderness areas | [USFS](https://services1.arcgis.com/) via ArcGIS | Static |
| National parks | [NPS](https://services1.arcgis.com/) via ArcGIS | Static |
| Live ADS-B aircraft traffic (with 15-min trails) | [adsb.fi](https://adsb.fi/), [airplanes.live](https://airplanes.live/), [adsb.lol](https://www.adsb.lol/) (fallback chain) | 5 sec polling |
| Magnetic declination | Approximate WMM 2025 model | Static |
| Density altitude | Calculated from station pressure and temperature | Real-time |
| Battery derating | Calculated from temperature, altitude, wind | Real-time |
| Bird strike risk | Calculated from season, time of day, terrain, altitude | Real-time |

**Note:** FAA NOTAM and TFR data requires a CORS proxy or backend and is not available directly in the browser. The app provides links to FAA sources for manual verification.

## Offline Use

The app uses a service worker to cache resources for offline use. You can pre-download map tiles for your area of operations via the Settings tab. Previously fetched API data is cached in IndexedDB with configurable TTLs.

## Disclaimer

**This tool is provided for informational and planning purposes only.**

The data displayed in this application may be incomplete, inaccurate, outdated, or incorrect. Data is sourced from third-party APIs and open data services that may experience outages, delays, or errors. Calculated values (density altitude, airspace classification, risk assessments, etc.) are approximations and may not reflect actual conditions.

**Users must independently verify all data before flight operations.** Always cross-check critical information (airspace, TFRs, NOTAMs, weather) against official FAA sources, certified weather briefings, and current aeronautical publications. The GO/CAUTION/NO-GO assessment is advisory only and does not replace the Remote Pilot In Command's responsibility to evaluate flight safety.

This software is not certified by the FAA or any aviation authority. Use at your own risk. The developers assume no liability for decisions made based on information provided by this tool.
