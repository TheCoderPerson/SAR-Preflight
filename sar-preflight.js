// ============================================================
// SAR Preflight — Application Logic
// Depends on: sar-preflight-core.js (loaded first in browser)
// ============================================================

// ============================================================
// STATE
// ============================================================
const S = {
  map: null, drawnItems: null, currentArea: null,
  areaCenter: null, areaBounds: null, areaType: null, areaCoords: [],
  drawHandler: null, panelOpen: true, activeTab: 'wx',
  mapLayers: {}, apiKeys: {}, wireHazardCounts: {}, faaCharts: {},
  // Cached live data
  wx: {}, wind: {}, elev: {}, astro: {}, notams: [],
  nwsAlerts: [],
  faaAirspace: null,
  // Track data source errors for retry/display
  dataSourceErrors: {},
  // Track active fetches for header status
  _activeFetches: {},
  // SOP Risk Profile
  activeProfile: null,
  // Training mode flag
  _trainingMode: false,
};

function trackFetchStart(source) {
  S._activeFetches[source] = true;
  _updateFetchActivity();
}

function trackFetchEnd(source) {
  delete S._activeFetches[source];
  _updateFetchActivity();
}

function _updateFetchActivity() {
  const el = document.getElementById('fetchActivity');
  if (!el) return;
  const active = Object.keys(S._activeFetches);
  if (active.length === 0) {
    el.style.display = 'none';
    el.textContent = '';
    // Pulse the status dot green briefly to indicate completion
    const dot = document.getElementById('statusDot');
    if (dot) { dot.style.background = 'var(--accent-green)'; dot.style.animation = ''; }
  } else {
    el.style.display = '';
    el.textContent = `\u21BB ${active.join(', ')}...`;
    // Pulse the status dot cyan while fetching
    const dot = document.getElementById('statusDot');
    if (dot) { dot.style.background = 'var(--accent-cyan)'; dot.style.animation = 'pulse 0.8s infinite'; }
  }
}

// ============================================================
// DOM HELPERS
// ============================================================
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setColor(id, level) {
  const el = document.getElementById(id); if (!el) return;
  el.classList.remove('green','amber','red','cyan'); el.classList.add(level);
}
function setStatus(id, type, text) {
  const el = document.getElementById(id); if (!el) return;
  el.className = 'fetch-status ' + type; el.textContent = text;
}

// ============================================================
// MAP INIT
// ============================================================
function initMap() {
  S.map = L.map('map', { center: [38.685, -120.99], zoom: 11, zoomControl: false, attributionControl: false });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; CARTO' }).addTo(S.map);
  S.mapLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
  S.mapLayers.topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 });
  S.mapLayers.sectional = L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Specialty/World_Navigation_Charts/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 10, maxZoom: 18, opacity: 0.85, attribution: 'Esri World Navigation Charts' });
  S.drawnItems = new L.FeatureGroup();
  S.map.addLayer(S.drawnItems);
  // Cursor coordinate + elevation display
  const _elevCache = new Map();
  let _elevTimer = null;
  let _elevAbort = null;
  S.map.on('mousemove', e => {
    document.getElementById('cursorCoord').textContent = `${e.latlng.lat.toFixed(5)}°, ${e.latlng.lng.toFixed(5)}°`;

    // Debounced cursor elevation lookup via Open-Meteo
    if (_elevTimer) clearTimeout(_elevTimer);
    if (_elevAbort) { _elevAbort.abort(); _elevAbort = null; }

    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    const cacheKey = lat.toFixed(3) + '_' + lng.toFixed(3);

    const elevEl = document.getElementById('cursorElev');
    if (_elevCache.has(cacheKey)) {
      if (elevEl) elevEl.textContent = _elevCache.get(cacheKey) + ' ft';
      return;
    }

    _elevTimer = setTimeout(async () => {
      try {
        _elevAbort = new AbortController();
        const res = await fetch(
          `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}`,
          { signal: _elevAbort.signal }
        );
        _elevAbort = null;
        if (!res.ok) return;
        const data = await res.json();
        if (data.elevation && data.elevation.length > 0) {
          const elevFt = Math.round(data.elevation[0] * 3.28084);
          _elevCache.set(cacheKey, elevFt);
          if (_elevCache.size > 5000) _elevCache.delete(_elevCache.keys().next().value);
          if (elevEl) elevEl.textContent = elevFt + ' ft';
        }
      } catch (_) { /* abort or network error — non-critical */ }
    }, 300);
  });
  S.map.on(L.Draw.Event.CREATED, e => {
    S.drawnItems.clearLayers();
    e.layer.setStyle({ color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4' });
    S.drawnItems.addLayer(e.layer);
    processArea(e.layer, e.layerType);
    clearDrawBtns();
  });
  L.control.zoom({ position: 'bottomright' }).addTo(S.map);

  // Start with panel collapsed on mobile
  if (window.innerWidth <= 900) {
    S.panelOpen = false;
    document.getElementById('sidePanel')?.classList.add('collapsed');
  }

  // Middle-mouse button panning (allows map drag while drawing tools are active)
  // Use capture phase to intercept before Leaflet.Draw sees the events
  let _mmDragging = false, _mmStart = null;
  S.map.getContainer().addEventListener('mousedown', e => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      _mmDragging = true;
      _mmStart = { x: e.clientX, y: e.clientY };
    }
  }, true);
  S.map.getContainer().addEventListener('mousemove', e => {
    if (!_mmDragging) return;
    e.stopPropagation();
    const dx = e.clientX - _mmStart.x;
    const dy = e.clientY - _mmStart.y;
    _mmStart = { x: e.clientX, y: e.clientY };
    S.map.panBy([-dx, -dy], { animate: false });
  }, true);
  S.map.getContainer().addEventListener('mouseup', e => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      _mmDragging = false;
    }
  }, true);
  buildLayerControl();
}

// ============================================================
// DRAW
// ============================================================
function startDraw(type) {
  if (S.drawHandler) { S.drawHandler.disable(); S.drawHandler = null; }
  clearDrawBtns();
  const opts = { shapeOptions: { color: '#3d8bfd', weight: 2, fillOpacity: 0.08, dashArray: '6,4' } };
  if (type === 'rectangle') { S.drawHandler = new L.Draw.Rectangle(S.map, opts); document.getElementById('drawRect').classList.add('active'); }
  else if (type === 'circle') { S.drawHandler = new L.Draw.Circle(S.map, opts); document.getElementById('drawCircle').classList.add('active'); }
  else if (type === 'polygon') { S.drawHandler = new L.Draw.Polygon(S.map, { shapeOptions: opts.shapeOptions, allowIntersection: false }); document.getElementById('drawPolygon').classList.add('active'); }
  if (S.drawHandler) S.drawHandler.enable();
}
function clearDrawBtns() { document.querySelectorAll('.draw-btn').forEach(b => b.classList.remove('active')); }
function clearArea() {
  S.drawnItems.clearLayers(); S.currentArea = null; S.areaCenter = null;
  Object.keys(WIRE_CATEGORIES).forEach(k => { if (S.mapLayers['wire_' + k]) S.mapLayers['wire_' + k].clearLayers(); });
  if (S.mapLayers.airports) S.mapLayers.airports.clearLayers();
  if (S.mapLayers.nws_alerts) S.mapLayers.nws_alerts.clearLayers();
  if (S.mapLayers.cell_towers) S.mapLayers.cell_towers.clearLayers();
  // Clear radar layers and stop animation
  if (S.radarAnim) {
    if (S.radarAnim.interval) clearInterval(S.radarAnim.interval);
    if (S.radarAnim.layers) S.radarAnim.layers.forEach(l => { if (S.map && S.map.hasLayer(l)) S.map.removeLayer(l); });
    S.radarAnim = null;
  }
  const radarControls = document.getElementById('radarControls');
  if (radarControls) radarControls.style.display = 'none';
  hideTimeBar();
  if (S.mapLayers.emergency_lz) S.mapLayers.emergency_lz.clearLayers();
  if (S.mapLayers.swap_radius) S.mapLayers.swap_radius.clearLayers();
  if (S.mapLayers.flight_plan) S.mapLayers.flight_plan.clearLayers();
  if (S.mapLayers.faa_class_airspace) S.mapLayers.faa_class_airspace.clearLayers();
  if (S.mapLayers.faa_sua) S.mapLayers.faa_sua.clearLayers();
  if (S.mapLayers.faa_tfr) S.mapLayers.faa_tfr.clearLayers();
  if (S.mapLayers.faa_laanc) S.mapLayers.faa_laanc.clearLayers();
  if (S.mapLayers.dams) S.mapLayers.dams.clearLayers();
  if (S.mapLayers.wilderness) S.mapLayers.wilderness.clearLayers();
  if (S.mapLayers.national_parks) S.mapLayers.national_parks.clearLayers();
  S.faaAirspace = null;
  S.protectedAreas = null;
  S.lzs = [];
  S.wireHazardCounts = {};
  S.towerCount = 0;
  S.nwsAlerts = [];
  S.dataSourceErrors = {};
  const dsWarn = document.getElementById('dataSourceWarning');
  if (dsWarn) dsWarn.remove();
  document.getElementById('noAreaOverlay').style.display = '';
  document.getElementById('assessmentBanner').style.display = 'none';
  document.getElementById('areaInfoBar').style.display = 'none';
  document.getElementById('noAreaState').style.display = '';
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  const alertSection = document.getElementById('alertSection');
  if (alertSection) alertSection.style.display = 'none';
  const forecastSection = document.getElementById('forecastSection');
  if (forecastSection) forecastSection.style.display = 'none';
}
function enterCoords() {
  const input = prompt('Enter center lat, lng, radius_meters:\nExample: 38.685, -120.99, 2000');
  if (!input) return;
  const p = input.split(',').map(s => parseFloat(s.trim()));
  if (p.length === 3 && !p.some(isNaN)) {
    S.drawnItems.clearLayers();
    const c = L.circle([p[0], p[1]], { radius: p[2], color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4' });
    S.drawnItems.addLayer(c);
    S.map.fitBounds(c.getBounds(), { padding: [40, 40] });
    processArea(c, 'circle');
  }
}

// ============================================================
// PROCESS AREA — Triggers all API fetches
// ============================================================
async function processArea(layer, type) {
  document.getElementById('noAreaOverlay').style.display = 'none';
  document.getElementById('assessmentBanner').style.display = 'flex';
  document.getElementById('areaInfoBar').style.display = 'flex';
  document.getElementById('noAreaState').style.display = 'none';

  let center, bounds, perimKm = 0, maxDimKm = 0;
  if (type === 'circle') {
    center = layer.getLatLng(); bounds = layer.getBounds(); S.areaType = 'CIRCLE';
    const radiusKm = layer.getRadius() / 1000;
    const areaKm2 = Math.PI * radiusKm * radiusKm;
    const acres = areaKm2 * 247.105;
    document.getElementById('areaSize').textContent = `R=${radiusKm.toFixed(2)} km (${Math.round(acres)} ac)`;
    perimKm = 2 * Math.PI * radiusKm;
    maxDimKm = 2 * radiusKm;
  } else {
    bounds = layer.getBounds(); center = bounds.getCenter();
    S.areaType = type === 'rectangle' ? 'RECTANGLE' : 'POLYGON';
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
    const area = Math.abs((ne.lat-sw.lat)*111.32*(ne.lng-sw.lng)*111.32*Math.cos((ne.lat+sw.lat)/2*Math.PI/180));
    const acres = area * 247.105;
    document.getElementById('areaSize').textContent = `${area.toFixed(2)} km² (${Math.round(acres)} ac)`;

    if (type === 'rectangle') {
      // Rectangle: perimeter from haversine of edges, max dim = diagonal
      const nw = { lat: ne.lat, lng: sw.lng };
      const se = { lat: sw.lat, lng: ne.lng };
      const widthKm = haversine(ne.lat, ne.lng, nw.lat, nw.lng);
      const heightKm = haversine(ne.lat, ne.lng, se.lat, se.lng);
      perimKm = 2 * (widthKm + heightKm);
      maxDimKm = haversine(ne.lat, ne.lng, sw.lat, sw.lng);
    } else {
      // Polygon: perimeter = sum of edges, max dim = max vertex-to-vertex distance
      const verts = layer.getLatLngs()[0];
      for (let i = 0; i < verts.length; i++) {
        const j = (i + 1) % verts.length;
        perimKm += haversine(verts[i].lat, verts[i].lng, verts[j].lat, verts[j].lng);
      }
      for (let i = 0; i < verts.length; i++) {
        for (let j = i + 1; j < verts.length; j++) {
          const d = haversine(verts[i].lat, verts[i].lng, verts[j].lat, verts[j].lng);
          if (d > maxDimKm) maxDimKm = d;
        }
      }
    }
  }
  S.areaCenter = center; S.areaBounds = bounds; S.currentArea = layer;
  document.getElementById('areaCenter').textContent = `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
  document.getElementById('areaType').textContent = S.areaType;

  if (typeof logAudit === 'function') logAudit('area_defined', { center: { lat: center.lat, lng: center.lng }, type: S.areaType, size: document.getElementById('areaSize')?.textContent });
  document.getElementById('areaPerimeter').textContent = `${perimKm.toFixed(2)} km`;
  document.getElementById('areaMaxDim').textContent = `${maxDimKm.toFixed(2)} km`;

  // Show active tab
  switchTab(S.activeTab);

  // Render airport markers (sync — from local dataset)
  renderAirportMarkers(center.lat, center.lng);

  // Fetch all data in parallel
  await Promise.allSettled([
    fetchWeather(center.lat, center.lng),
    fetchElevation(center, bounds),
    fetchSunMoon(center.lat, center.lng),
    fetchNOTAMs(center.lat, center.lng),
    fetchWireHazards(bounds),
    fetchNWSAlerts(center.lat, center.lng),
    fetchRadar(),
    fetchFAAairspace(bounds),
    fetchProtectedAreas(bounds),
  ]);

  // Compute derived data after fetches complete
  computeOpsData();
  computeAssessment();
  showDataSourceStatus();
}

function recordDataSourceError(source, error) {
  S.dataSourceErrors[source] = {
    message: error?.message || String(error),
    timestamp: Date.now(),
    status: error?.status || null,
  };
}

function clearDataSourceError(source) {
  delete S.dataSourceErrors[source];
}

async function retryFailedSource(source) {
  if (!S.areaCenter) return;
  const lat = S.areaCenter.lat, lng = S.areaCenter.lng;
  const bounds = S.areaBounds;
  const retryMap = {
    'Weather': () => fetchWeather(lat, lng),
    'Elevation': () => fetchElevation(S.areaCenter, bounds),
    'Sun/Moon': () => fetchSunMoon(lat, lng),
    'Wire Hazards': () => fetchWireHazards(bounds),
    'NWS Alerts': () => fetchNWSAlerts(lat, lng),
    'Radar': () => fetchRadar(),
    'FAA Airspace': () => fetchFAAairspace(bounds),
    'Protected Areas': () => fetchProtectedAreas(bounds),
  };
  const fn = retryMap[source];
  if (fn) {
    await fn();
    computeOpsData();
    computeAssessment();
    showDataSourceStatus();
  }
}

async function retryAllFailed() {
  const sources = Object.keys(S.dataSourceErrors);
  for (const src of sources) {
    await retryFailedSource(src);
  }
}

function showDataSourceStatus() {
  const banner = document.getElementById('assessmentBanner');
  if (!banner) return;
  const existing = document.getElementById('dataSourceWarning');
  if (existing) existing.remove();

  const errors = Object.entries(S.dataSourceErrors);
  if (errors.length === 0) return;

  const div = document.createElement('div');
  div.id = 'dataSourceWarning';
  div.style.cssText = 'padding:8px 16px;background:rgba(239,68,68,0.1);border-bottom:1px solid var(--border);font-family:var(--font-mono);font-size:10px;color:var(--accent-red);';

  const summary = document.createElement('div');
  summary.style.cssText = 'display:flex;align-items:center;gap:8px;';
  summary.innerHTML = `<span>\u26A0 DATA SOURCE ERRORS: ${errors.map(e => e[0]).join(', ')}</span>`
    + `<button class="btn btn-ghost" style="padding:2px 8px;font-size:9px;color:var(--accent-red);border-color:var(--accent-red);" onclick="retryAllFailed()">RETRY ALL</button>`
    + `<span style="color:var(--text-muted);cursor:pointer;font-size:9px;" onclick="this.parentElement.nextElementSibling.style.display=this.parentElement.nextElementSibling.style.display==='none'?'block':'none'">[details]</span>`;
  div.appendChild(summary);

  const details = document.createElement('div');
  details.style.cssText = 'display:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--border);';
  errors.forEach(([name, err]) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;';
    const age = err.timestamp ? formatAge(Date.now() - err.timestamp) : '';
    row.innerHTML = `<span style="min-width:90px;"><b>${name}</b></span>`
      + `<span style="color:var(--text-muted);flex:1;">${err.message}${err.status ? ' (HTTP ' + err.status + ')' : ''}${age ? ' \u2014 ' + age + ' ago' : ''}</span>`
      + `<button class="btn btn-ghost" style="padding:1px 6px;font-size:9px;color:var(--accent-cyan);" onclick="retryFailedSource('${name}')">RETRY</button>`;
    details.appendChild(row);
  });
  div.appendChild(details);

  banner.parentElement.insertBefore(div, banner.nextSibling);
}

function refreshData() {
  if (typeof logAudit === 'function') logAudit('data_refreshed');
  if (S.areaCenter) processArea(S.currentArea, S.areaType.toLowerCase());
}

// ============================================================
// API: OPEN-METEO — Weather + Wind + AQI (FREE, no key)
// ============================================================
async function fetchWeather(lat, lng) {
  trackFetchStart('Weather');
  setStatus('wxStatus', 'loading', 'Fetching...');
  setStatus('windStatus', 'loading', 'Fetching...');
  try {
    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,surface_pressure,` +
      `cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,` +
      `weather_code,uv_index,is_day` +
      `&hourly=wind_speed_80m,wind_speed_120m,wind_speed_180m,wind_direction_80m,wind_direction_120m,wind_direction_180m` +
      `,temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,weather_code` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America/Los_Angeles` +
      `&forecast_hours=24`;

    const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
      `&current=us_aqi,pm2_5,pm10,ozone&timezone=America/Los_Angeles`;

    const [wxRes, aqiRes] = await Promise.all([fetch(wxUrl), fetch(aqiUrl)]);
    const wx = await wxRes.json();
    const aqi = await aqiRes.json();

    if (wx.current) {
      const c = wx.current;
      S.wx = c;

      setText('wxTemp', `${Math.round(c.temperature_2m)}°F`);
      setText('wxFeels', `${Math.round(c.apparent_temperature)}°F`);
      setText('wxDew', `${Math.round(c.dew_point_2m)}°F`);
      setText('wxHumidity', `${Math.round(c.relative_humidity_2m)}%`);

      const inHg = (c.surface_pressure * 0.02953).toFixed(2);
      setText('wxPressure', `${inHg} inHg`);

      // Density altitude — uses extracted core function
      const elevFt = S.elev.center || 1500;
      const densAlt = calcDensityAltitude(c.temperature_2m, c.surface_pressure, elevFt);
      setText('wxDensity', `${densAlt.toLocaleString()} ft`);
      setColor('wxDensity', densAlt < 5000 ? 'green' : densAlt < 7500 ? 'amber' : 'red');

      const visMi = (c.visibility / 1609.34).toFixed(1);
      setText('wxVis', `${visMi} mi`);
      setColor('wxVis', visMi > 5 ? 'green' : visMi > 3 ? 'amber' : 'red');

      setText('wxCloud', `${c.cloud_cover}%`);
      const ceilFt = c.cloud_cover < 10 ? 'CLR' : c.cloud_cover < 30 ? '15,000+ ft' : c.cloud_cover < 70 ? '5,000-15,000 ft' : '< 5,000 ft';
      setText('wxCeiling', ceilFt);
      setText('wxConditions', wmoCodeToText(c.weather_code));

      const precip = c.precipitation_probability ?? 0;
      setText('wxPrecip', `${precip}%`);
      setColor('wxPrecip', precip < 20 ? 'green' : precip < 50 ? 'amber' : 'red');
      setText('wxLightning', c.weather_code >= 95 ? 'Active' : precip > 40 ? 'Possible' : 'None');
      setColor('wxLightning', c.weather_code >= 95 ? 'red' : precip > 40 ? 'amber' : 'green');
      setText('wxUV', c.uv_index?.toFixed(1) ?? '--');

      const tempC = (c.temperature_2m - 32) * 5/9;
      setText('wxIcing', tempC < 0 ? 'Possible' : 'None');
      setColor('wxIcing', tempC < 0 ? 'amber' : 'green');

      const fireDanger = c.relative_humidity_2m < 20 ? 'Very High' : c.relative_humidity_2m < 30 ? 'High' : c.relative_humidity_2m < 45 ? 'Moderate' : 'Low';
      setText('wxFire', fireDanger);
      setColor('wxFire', c.relative_humidity_2m < 20 ? 'red' : c.relative_humidity_2m < 30 ? 'red' : c.relative_humidity_2m < 45 ? 'amber' : 'green');

      // ---- WIND ----
      const groundWind = Math.round(c.wind_speed_10m);
      const groundGust = Math.round(c.wind_gusts_10m);
      const groundDir = Math.round(c.wind_direction_10m);

      const h = wx.hourly || {};
      const w80 = Math.round(h.wind_speed_80m?.[0] ?? groundWind * 1.3);
      const w120 = Math.round(h.wind_speed_120m?.[0] ?? groundWind * 1.5);
      const w180 = Math.round(h.wind_speed_180m?.[0] ?? groundWind * 1.7);
      const d80 = Math.round(h.wind_direction_80m?.[0] ?? groundDir);
      const d120 = Math.round(h.wind_direction_120m?.[0] ?? groundDir);
      const d180 = Math.round(h.wind_direction_180m?.[0] ?? groundDir);

      const windProfile = [
        { alt: 'Ground (10m)', speed: groundWind, gust: groundGust, dir: groundDir },
        { alt: '100 ft AGL', speed: Math.round(lerp(groundWind, w80, 0.37)), gust: Math.round(groundGust * 1.1), dir: Math.round(lerp(groundDir, d80, 0.37)) },
        { alt: '200 ft AGL', speed: Math.round(lerp(groundWind, w80, 0.74)), gust: Math.round(groundGust * 1.2), dir: Math.round(lerp(groundDir, d80, 0.74)) },
        { alt: '300 ft AGL', speed: Math.round(lerp(w80, w120, 0.5)), gust: Math.round(groundGust * 1.3), dir: Math.round(lerp(d80, d120, 0.5)) },
        { alt: '400 ft AGL', speed: w120, gust: Math.round(groundGust * 1.4), dir: d120 },
      ];
      S.wind = { profile: windProfile, maxWind: Math.max(...windProfile.map(w => w.speed)), maxGust: Math.max(...windProfile.map(w => w.gust)) };

      document.getElementById('windTableBody').innerHTML = windProfile.map(w =>
        `<tr><td>${w.alt}</td><td>${w.speed} mph</td><td>${w.gust} mph</td><td>${w.dir}° (${degToCompass(w.dir)})</td></tr>`
      ).join('');

      setText('windMax', `${S.wind.maxWind} mph`);
      setColor('windMax', S.wind.maxWind < 15 ? 'green' : S.wind.maxWind < 25 ? 'amber' : 'red');
      setText('windGustMax', `${S.wind.maxGust} mph`);
      setColor('windGustMax', S.wind.maxGust < 20 ? 'green' : S.wind.maxGust < 30 ? 'amber' : 'red');
      setText('windDir', `${groundDir}° (${degToCompass(groundDir)})`);
      setText('windImpact', S.wind.maxWind < 10 ? 'Minimal — full flight time' : S.wind.maxWind < 20 ? 'Moderate — ~15% battery penalty' : 'Significant — ~30% battery penalty');

      // Gust Factor
      const gustFactor = calcGustFactor(S.wind.maxGust, S.wind.maxWind);
      setText('windGustFactor', gustFactor > 0 ? `${gustFactor.toFixed(1)}x` : '--');
      setColor('windGustFactor', gustFactor < 1.5 ? 'green' : gustFactor <= 2.0 ? 'amber' : 'red');

      // Wind Shear
      const shear = calcWindShear(windProfile);
      setText('windShear', `${shear.maxSpeedChange}mph / ${shear.maxDirChange}°`);
      setColor('windShear', shear.level);

      // Terrain Turbulence — requires elevation data
      if (S.elev.points && typeof assessTerrainTurbulence === 'function') {
        const elevFtArray = S.elev.points.map(p => p.elevFt);
        const turbulence = assessTerrainTurbulence(elevFtArray, S.elev.gridSize, S.elev.range, groundDir, groundWind);
        const factorText = turbulence.factors.join('; ');
        setText('windTurbulence', `${turbulence.risk.toUpperCase()} — ${factorText}`);
        setColor('windTurbulence', turbulence.level);
      }

      setStatus('wxStatus', 'live', 'LIVE');
      setStatus('windStatus', 'live', 'LIVE');
      clearDataSourceError('Weather');
    }

    // Store hourly forecast data
    if (wx.hourly && wx.hourly.time) {
      S.wx.hourly = {
        time: wx.hourly.time,
        temperature_2m: wx.hourly.temperature_2m,
        precipitation_probability: wx.hourly.precipitation_probability,
        wind_speed_10m: wx.hourly.wind_speed_10m,
        wind_direction_10m: wx.hourly.wind_direction_10m,
        wind_gusts_10m: wx.hourly.wind_gusts_10m,
        cloud_cover: wx.hourly.cloud_cover,
        weather_code: wx.hourly.weather_code,
      };
      renderForecastChart(S.wx.hourly);
      initTimeBar();
    }

    // AQI
    if (aqi.current) {
      setText('wxAQI', `${aqi.current.us_aqi}`);
      setColor('wxAQI', aqi.current.us_aqi < 50 ? 'green' : aqi.current.us_aqi < 100 ? 'amber' : 'red');
      setText('wxPM25', `${aqi.current.pm2_5?.toFixed(1)} µg/m³`);
      setText('wxPM10', `${aqi.current.pm10?.toFixed(1) ?? '--'} µg/m³`);
      setText('wxOzone', `${aqi.current.ozone?.toFixed(1) ?? '--'} µg/m³`);
    }

    // Cache weather and AQI data to IndexedDB
    if (typeof cacheApiResponse === 'function') {
      const k = areaKey(lat, lng);
      cacheApiResponse('weather', k, wx);
      cacheApiResponse('aqi', k, aqi);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    await fetchKpIndex();

  } catch (err) {
    console.error('Weather fetch error:', err);
    recordDataSourceError('Weather', err);
    // Try cached weather data before showing ERROR
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(lat, lng) : `${lat.toFixed(3)}_${lng.toFixed(3)}`;
        const cachedWx = await getCachedApiResponse('weather', k);
        if (cachedWx && cachedWx.data) {
          const c = cachedWx.data.current || cachedWx.data;
          S.wx = c;
          setText('wxTemp', `${Math.round(c.temperature_2m)}°F`);
          const visMi = (c.visibility / 1609.34).toFixed(1);
          setText('wxVis', `${visMi} mi`);
          setColor('wxVis', visMi > 5 ? 'green' : visMi > 3 ? 'amber' : 'red');
          setText('wxPrecip', `${c.precipitation_probability ?? 0}%`);
          const groundWind = Math.round(c.wind_speed_10m);
          const groundGust = Math.round(c.wind_gusts_10m);
          setText('windMax', `${groundWind} mph`);
          setColor('windMax', groundWind < 15 ? 'green' : groundWind < 25 ? 'amber' : 'red');
          setText('windGustMax', `${groundGust} mph`);
          setColor('windGustMax', groundGust < 20 ? 'green' : groundGust < 30 ? 'amber' : 'red');
          const age = Date.now() - cachedWx.timestamp;
          const badge = cachedWx.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('wxStatus', badge, label);
          setStatus('windStatus', badge, label);
        } else {
          setStatus('wxStatus', 'error', 'ERROR');
          setStatus('windStatus', 'error', 'ERROR');
        }
        const cachedAqi = await getCachedApiResponse('aqi', k);
        if (cachedAqi && cachedAqi.data && cachedAqi.data.current) {
          setText('wxAQI', `${cachedAqi.data.current.us_aqi}`);
          setColor('wxAQI', cachedAqi.data.current.us_aqi < 50 ? 'green' : cachedAqi.data.current.us_aqi < 100 ? 'amber' : 'red');
        }
      } catch (cacheErr) {
        console.warn('Weather cache fallback failed:', cacheErr);
        setStatus('wxStatus', 'error', 'ERROR');
        setStatus('windStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('wxStatus', 'error', 'ERROR');
      setStatus('windStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Weather');
  }
}

async function fetchKpIndex() {
  trackFetchStart('Kp Index');
  try {
    const res = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
    const data = await res.json();
    // Find the entry closest to current time (row 0 is headers)
    const now = Date.now();
    let kp = 2;
    let bestDiff = Infinity;
    for (let i = 1; i < data.length; i++) {
      const t = new Date(data[i][0] + ' UTC').getTime();
      const diff = Math.abs(now - t);
      if (diff < bestDiff) { bestDiff = diff; kp = parseFloat(data[i][1]) || 2; }
    }
    setText('wxKp', kp.toFixed(1));
    setColor('wxKp', kp <= 3 ? 'green' : kp <= 5 ? 'amber' : 'red');
    setText('satKp', kp.toFixed(1));
    setColor('satKp', kp <= 3 ? 'green' : kp <= 5 ? 'amber' : 'red');
    setText('satAccuracy', kp <= 3 ? '< 2m horizontal' : '2-5m horizontal');
    setText('satAssessment', kp <= 3 ? 'Nominal — good GNSS conditions' : kp <= 5 ? 'Marginal — monitor positioning' : 'Degraded — expect position errors');

    const baseSats = kp <= 3 ? 20 : kp <= 5 ? 16 : 12;

    // GPS Terrain Masking — adjust sat count if terrain data available
    let skyVisPct = 100;
    if (S.elev.points && typeof analyzeGPSMasking === 'function') {
      const masking = analyzeGPSMasking(S.elev.center, S.elev.points, S.elev.gridSize, 400);
      skyVisPct = masking.skyVisibilityPct;
      setText('satSkyVis', `${skyVisPct}%`);
      setColor('satSkyVis', skyVisPct > 80 ? 'green' : skyVisPct > 60 ? 'amber' : 'red');
      setText('satMasked', masking.maskedDirections.length > 0 ? masking.maskedDirections.join(', ') : 'None');
      setColor('satMasked', masking.maskedDirections.length === 0 ? 'green' : masking.maskedDirections.length <= 2 ? 'amber' : 'red');
    }

    document.getElementById('satTableBody').innerHTML = [100,200,300,400].map(alt => {
      const rawSats = baseSats + Math.round(alt/200);
      const sats = Math.round(rawSats * skyVisPct / 100);
      const pdop = (1.0 + kp * 0.3 - alt/1000).toFixed(1);
      const q = sats > 16 ? 'Excellent' : sats > 12 ? 'Good' : 'Fair';
      const qColor = sats > 16 ? 'var(--accent-green)' : sats > 12 ? 'var(--accent-amber)' : 'var(--accent-red)';
      return `<tr><td>Below ${alt} ft</td><td>${sats} sats</td><td>${pdop}</td><td style="color:${qColor}">${q}</td></tr>`;
    }).join('');

    // Cache Kp data
    if (typeof cacheApiResponse === 'function') cacheApiResponse('kp', 'global', data);
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());
  } catch(e) {
    console.warn('Kp fetch failed', e);
    // Try cached Kp data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('kp', 'global');
        if (cached && cached.data) {
          const kp = parseFloat(cached.data[1]?.[1]) || 2;
          setText('wxKp', kp.toFixed(1));
          setColor('wxKp', kp <= 3 ? 'green' : kp <= 5 ? 'amber' : 'red');
          setText('satKp', kp.toFixed(1));
          setColor('satKp', kp <= 3 ? 'green' : kp <= 5 ? 'amber' : 'red');
          setText('satAccuracy', kp <= 3 ? '< 2m horizontal' : '2-5m horizontal');
          setText('satAssessment', kp <= 3 ? 'Nominal — good GNSS conditions' : kp <= 5 ? 'Marginal — monitor positioning' : 'Degraded — expect position errors');
        }
      } catch (cacheErr) { console.warn('Kp cache fallback failed:', cacheErr); }
    }
  } finally {
    trackFetchEnd('Kp Index');
  }
}

// ============================================================
// FORECAST CHART (24h SVG)
// ============================================================
function renderForecastChart(hourlyData) {
  const container = document.getElementById('forecastChart');
  const section = document.getElementById('forecastSection');
  if (!container || !section) return;
  if (!hourlyData || !hourlyData.time || hourlyData.time.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  const times = hourlyData.time;
  const temps = hourlyData.temperature_2m || [];
  const winds = hourlyData.wind_speed_10m || [];
  const precips = hourlyData.precipitation_probability || [];
  const n = Math.min(times.length, 24);
  if (n === 0) { section.style.display = 'none'; return; }

  const W = 440, H = 180, padL = 36, padR = 10, padT = 18, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // Auto-scale temp & wind
  const tSlice = temps.slice(0, n), wSlice = winds.slice(0, n), pSlice = precips.slice(0, n);
  const tMin = Math.min(...tSlice.filter(v => v != null)), tMax = Math.max(...tSlice.filter(v => v != null));
  const wMin = 0, wMax = Math.max(Math.max(...wSlice.filter(v => v != null)), 5);
  const tRange = Math.max(tMax - tMin, 1), wRange = Math.max(wMax - wMin, 1);

  function xPos(i) { return padL + (i / (n - 1)) * plotW; }
  function yTemp(v) { return padT + plotH - ((v - tMin) / tRange) * plotH; }
  function yWind(v) { return padT + plotH - ((v - wMin) / wRange) * plotH; }

  // Build SVG
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg">`;
  // Background grid lines
  for (let i = 0; i < n; i += 3) {
    const x = xPos(i);
    svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="0.5"/>`;
  }

  // Precip bars (bottom, blue fill)
  const barW = Math.max(plotW / n * 0.6, 2);
  for (let i = 0; i < n; i++) {
    const p = pSlice[i] ?? 0;
    if (p <= 0) continue;
    const barH = (p / 100) * plotH * 0.4;
    const x = xPos(i) - barW / 2;
    const y = padT + plotH - barH;
    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="var(--accent-blue)" opacity="0.35" rx="1"/>`;
  }

  // Temp polyline (cyan)
  let tempPts = [];
  for (let i = 0; i < n; i++) { if (tSlice[i] != null) tempPts.push(`${xPos(i).toFixed(1)},${yTemp(tSlice[i]).toFixed(1)}`); }
  if (tempPts.length > 1) svg += `<polyline points="${tempPts.join(' ')}" fill="none" stroke="var(--accent-cyan)" stroke-width="1.8" stroke-linejoin="round"/>`;

  // Wind polyline (amber)
  let windPts = [];
  for (let i = 0; i < n; i++) { if (wSlice[i] != null) windPts.push(`${xPos(i).toFixed(1)},${yWind(wSlice[i]).toFixed(1)}`); }
  if (windPts.length > 1) svg += `<polyline points="${windPts.join(' ')}" fill="none" stroke="var(--accent-amber)" stroke-width="1.8" stroke-linejoin="round"/>`;

  // X-axis labels every 3 hours
  for (let i = 0; i < n; i += 3) {
    const x = xPos(i);
    const dt = new Date(times[i]);
    const label = dt.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: 'America/Los_Angeles' }).replace(' ', '');
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--text-muted)" font-family="var(--font-mono)" font-size="8">${label}</text>`;
  }

  // Y-axis labels (temp left)
  svg += `<text x="${padL - 4}" y="${padT + 4}" text-anchor="end" fill="var(--accent-cyan)" font-family="var(--font-mono)" font-size="8">${Math.round(tMax)}\u00b0</text>`;
  svg += `<text x="${padL - 4}" y="${padT + plotH}" text-anchor="end" fill="var(--accent-cyan)" font-family="var(--font-mono)" font-size="8">${Math.round(tMin)}\u00b0</text>`;
  // Y-axis labels (wind right)
  svg += `<text x="${W - padR + 2}" y="${padT + 4}" text-anchor="start" fill="var(--accent-amber)" font-family="var(--font-mono)" font-size="8">${Math.round(wMax)}mph</text>`;

  // "now" marker
  const nowMs = Date.now();
  const t0 = new Date(times[0]).getTime();
  const tN = new Date(times[n - 1]).getTime();
  if (nowMs >= t0 && nowMs <= tN) {
    const frac = (nowMs - t0) / (tN - t0);
    const nx = padL + frac * plotW;
    svg += `<line x1="${nx}" y1="${padT}" x2="${nx}" y2="${padT + plotH}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3,3"/>`;
    svg += `<text x="${nx}" y="${padT - 4}" text-anchor="middle" fill="var(--text-muted)" font-family="var(--font-mono)" font-size="7">NOW</text>`;
  }

  // Legend
  svg += `<circle cx="${padL}" cy="${H - 16}" r="3" fill="var(--accent-cyan)"/><text x="${padL + 6}" y="${H - 13}" fill="var(--accent-cyan)" font-family="var(--font-mono)" font-size="7">Temp</text>`;
  svg += `<circle cx="${padL + 40}" cy="${H - 16}" r="3" fill="var(--accent-amber)"/><text x="${padL + 46}" y="${H - 13}" fill="var(--accent-amber)" font-family="var(--font-mono)" font-size="7">Wind</text>`;
  svg += `<rect x="${padL + 80}" y="${H - 19}" width="6" height="6" fill="var(--accent-blue)" opacity="0.5" rx="1"/><text x="${padL + 90}" y="${H - 13}" fill="var(--accent-blue)" font-family="var(--font-mono)" font-size="7">Precip%</text>`;

  // Interactive crosshair + tooltip (hidden until hover)
  svg += `<line id="fc-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--text-secondary)" stroke-width="1" stroke-dasharray="2,2" style="display:none"/>`;
  svg += `<circle id="fc-dot-t" r="3" fill="var(--accent-cyan)" style="display:none"/>`;
  svg += `<circle id="fc-dot-w" r="3" fill="var(--accent-amber)" style="display:none"/>`;
  svg += `<g id="fc-tip" style="display:none">`;
  svg += `<rect id="fc-tip-bg" rx="3" fill="var(--bg-card)" stroke="var(--border)" stroke-width="0.5" opacity="0.95" x="0" y="0" width="74" height="52"/>`;
  svg += `<text id="fc-tip-time" font-family="var(--font-mono)" font-size="8" fill="var(--text-secondary)" x="0" y="0"></text>`;
  svg += `<text id="fc-tip-temp" font-family="var(--font-mono)" font-size="8" fill="var(--accent-cyan)" x="0" y="0"></text>`;
  svg += `<text id="fc-tip-wind" font-family="var(--font-mono)" font-size="8" fill="var(--accent-amber)" x="0" y="0"></text>`;
  svg += `<text id="fc-tip-prec" font-family="var(--font-mono)" font-size="8" fill="var(--accent-blue)" x="0" y="0"></text>`;
  svg += `</g>`;
  svg += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" id="fc-overlay"/>`;

  svg += `</svg>`;
  container.innerHTML = svg;

  // Attach tooltip interaction
  const svgEl = container.querySelector('svg');
  if (svgEl) {
    const cd = { times: times.slice(0, n), temps: tSlice, winds: wSlice, precips: pSlice, n, W, padL, plotW, plotH, padT, xPos, yTemp, yWind };
    const overlay = svgEl.querySelector('#fc-overlay');
    if (overlay) {
      overlay.addEventListener('mousemove', function(ev) { _fcTooltipMove(ev, svgEl, cd); });
      overlay.addEventListener('mouseleave', function() { _fcTooltipHide(svgEl); });
    }
  }
}

function _fcTooltipMove(e, svg, d) {
  const rect = svg.getBoundingClientRect();
  const mx = (e.clientX - rect.left) / rect.width * d.W;
  const frac = (mx - d.padL) / d.plotW;
  if (frac < 0 || frac > 1) { _fcTooltipHide(svg); return; }

  const idx = Math.max(0, Math.min(d.n - 1, Math.round(frac * (d.n - 1))));
  const cx = d.xPos(idx);

  // Crosshair line
  const cross = svg.querySelector('#fc-cross');
  cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
  cross.style.display = '';

  // Data point dots
  const dotT = svg.querySelector('#fc-dot-t');
  const dotW = svg.querySelector('#fc-dot-w');
  if (d.temps[idx] != null) { dotT.setAttribute('cx', cx); dotT.setAttribute('cy', d.yTemp(d.temps[idx])); dotT.style.display = ''; }
  else dotT.style.display = 'none';
  if (d.winds[idx] != null) { dotW.setAttribute('cx', cx); dotW.setAttribute('cy', d.yWind(d.winds[idx])); dotW.style.display = ''; }
  else dotW.style.display = 'none';

  // Values
  const dt = new Date(d.times[idx]);
  const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });
  const temp = d.temps[idx] != null ? Math.round(d.temps[idx]) + '\u00b0F' : '--';
  const wind = d.winds[idx] != null ? Math.round(d.winds[idx]) + ' mph' : '--';
  const prec = d.precips[idx] != null ? d.precips[idx] + '%' : '--';

  // Position tooltip (flip side near right edge)
  const tipX = cx < d.padL + d.plotW * 0.7 ? cx + 8 : cx - 82;
  const tipY = d.padT + 4;

  svg.querySelector('#fc-tip-bg').setAttribute('x', tipX);
  svg.querySelector('#fc-tip-bg').setAttribute('y', tipY);
  const tx = tipX + 5;
  const el = (id, text, y) => { const t = svg.querySelector(id); t.textContent = text; t.setAttribute('x', tx); t.setAttribute('y', y); };
  el('#fc-tip-time', timeStr, tipY + 11);
  el('#fc-tip-temp', temp, tipY + 23);
  el('#fc-tip-wind', wind, tipY + 35);
  el('#fc-tip-prec', prec, tipY + 47);
  svg.querySelector('#fc-tip').style.display = '';
}

function _fcTooltipHide(svg) {
  ['#fc-cross', '#fc-dot-t', '#fc-dot-w', '#fc-tip'].forEach(id => {
    const el = svg.querySelector(id);
    if (el) el.style.display = 'none';
  });
}

// ============================================================
// API: OPEN-ELEVATION (FREE)
// ============================================================
async function fetchElevation(center, bounds) {
  trackFetchStart('Elevation');
  setStatus('elevStatus', 'loading', 'Fetching...');
  try {
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();

    // Use 25-point grid if core function is available, else fall back to 9-point
    let points;
    let gridSize = 0;
    if (typeof generateElevationGrid === 'function') {
      points = generateElevationGrid(center.lat, center.lng, ne, sw, 5);
      gridSize = 5;
    } else {
      const mid = center;
      points = [
        { latitude: center.lat, longitude: center.lng },
        { latitude: ne.lat, longitude: ne.lng },
        { latitude: ne.lat, longitude: sw.lng },
        { latitude: sw.lat, longitude: ne.lng },
        { latitude: sw.lat, longitude: sw.lng },
        { latitude: mid.lat, longitude: ne.lng },
        { latitude: mid.lat, longitude: sw.lng },
        { latitude: ne.lat, longitude: mid.lng },
        { latitude: sw.lat, longitude: mid.lng },
      ];
      gridSize = 3;
    }

    const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: points }),
    });
    const data = await res.json();

    // Store full point array with elevation data
    const elevPoints = data.results.map((r, i) => ({
      lat: points[i].latitude,
      lng: points[i].longitude,
      elevFt: Math.round(r.elevation * 3.28084),
    }));
    const elevations = elevPoints.map(p => p.elevFt);
    const centerElev = elevations[0];
    const minElev = Math.min(...elevations);
    const maxElev = Math.max(...elevations);
    const range = maxElev - minElev;

    // Calculate cell size using haversine between adjacent grid points
    let cellSizeKm = 0;
    if (gridSize >= 2 && elevPoints.length >= 2) {
      cellSizeKm = haversine(elevPoints[0].lat, elevPoints[0].lng, elevPoints[1].lat, elevPoints[1].lng);
    }

    S.elev = { center: centerElev, min: minElev, max: maxElev, range, points: elevPoints, gridSize, cellSizeKm };

    setText('terrMin', `${minElev.toLocaleString()} ft AMSL`);
    setText('terrMax', `${maxElev.toLocaleString()} ft AMSL`);
    setText('terrRange', `${range.toLocaleString()} ft`);
    setColor('terrRange', range < 200 ? 'green' : range < 800 ? 'amber' : 'red');
    setText('terrLaunch', `${centerElev.toLocaleString()} ft AMSL`);

    // Uses extracted core functions
    setText('terrClass', classifyTerrain(centerElev));

    // Compute slope using grid if available, else fallback to diagonal
    if (gridSize >= 3 && cellSizeKm > 0 && typeof calcSlopeFromGrid === 'function') {
      const slopes = calcSlopeFromGrid(elevations, gridSize, cellSizeKm);
      const maxSlope = slopes.length > 0 ? Math.max(...slopes) : 0;
      const avgSlope = slopes.length > 0 ? slopes.reduce((a, b) => a + b, 0) / slopes.length : 0;
      const slopePerKm = cellSizeKm > 0 ? Math.round(range / (cellSizeKm * (gridSize - 1))) : 0;
      setText('terrSlope', `~${slopePerKm} ft/km`);
    } else {
      const ne2sw = Math.abs(elevations[1] - elevations[Math.min(4, elevations.length - 1)]);
      const diagDistKm = center.distanceTo(ne) / 1000;
      const slopePerKm = diagDistKm > 0 ? Math.round(ne2sw / diagDistKm) : 0;
      setText('terrSlope', `~${slopePerKm} ft/km`);
    }

    setText('terrVeg', estimateVegetation(centerElev));

    const cell = estimateCellCoverage(centerElev);
    setText('terrCell', cell.label);
    setColor('terrCell', cell.level);

    // Terrain feature detection
    if (typeof detectTerrainFeatures === 'function' && gridSize >= 3) {
      const features = detectTerrainFeatures(elevations, gridSize, range);
      renderTerrainFeatures(features);
    }

    // Find emergency LZs
    if (typeof findEmergencyLZs === 'function' && cellSizeKm > 0) {
      S.lzs = findEmergencyLZs(elevPoints, gridSize, cellSizeKm);
      renderLZMarkers(S.lzs);
      buildLayerControl();
    }
    setText('terrRID', centerElev > 5000 ? 'Internet unlikely — use RID module' : 'Internet likely available');

    // Cache elevation data
    if (typeof cacheApiResponse === 'function') cacheApiResponse('elevation', areaKey(center.lat, center.lng), data);
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    setStatus('elevStatus', 'live', 'LIVE');
    clearDataSourceError('Elevation');
  } catch (err) {
    console.error('Elevation fetch error:', err);
    recordDataSourceError('Elevation', err);
    // Try cached elevation data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(center.lat, center.lng) : `${center.lat.toFixed(3)}_${center.lng.toFixed(3)}`;
        const cached = await getCachedApiResponse('elevation', k);
        if (cached && cached.data && cached.data.results) {
          const elevations = cached.data.results.map(r => Math.round(r.elevation * 3.28084));
          const centerElev = elevations[0];
          const minElev = Math.min(...elevations);
          const maxElev = Math.max(...elevations);
          const range = maxElev - minElev;
          S.elev = { center: centerElev, min: minElev, max: maxElev, range };
          setText('terrMin', `${minElev.toLocaleString()} ft AMSL`);
          setText('terrMax', `${maxElev.toLocaleString()} ft AMSL`);
          setText('terrRange', `${range.toLocaleString()} ft`);
          setColor('terrRange', range < 200 ? 'green' : range < 800 ? 'amber' : 'red');
          setText('terrLaunch', `${centerElev.toLocaleString()} ft AMSL`);
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('elevStatus', badge, label);
        } else {
          setStatus('elevStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Elevation cache fallback failed:', cacheErr);
        setStatus('elevStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('elevStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Elevation');
  }
}

// ============================================================
// API: SUNRISE-SUNSET.ORG (FREE)
// ============================================================
async function fetchSunMoon(lat, lng) {
  trackFetchStart('Sun/Moon');
  setStatus('astroStatus', 'loading', 'Fetching...');
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(`https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lng}&date=${today}&formatted=0`);
    const data = await res.json();

    if (data.status === 'OK') {
      const r = data.results;
      const fmt = iso => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });

      setText('astSunrise', fmt(r.sunrise));
      setText('astSunset', fmt(r.sunset));
      setText('astTwilightAM', fmt(r.civil_twilight_begin));
      setText('astTwilightPM', fmt(r.civil_twilight_end));
      setText('astNauticalAM', fmt(r.nautical_twilight_begin));
      setText('astNauticalPM', fmt(r.nautical_twilight_end));
      setText('astSolarNoon', fmt(r.solar_noon));

      const twAM = fmt(r.civil_twilight_begin);
      const twPM = fmt(r.civil_twilight_end);
      setText('astDayWindow', `${twAM} — ${twPM} PDT`);

      const sunPos = calcSunPosition(lat, lng);
      setText('astSunAz', `${sunPos.azimuth.toFixed(1)}°`);
      setText('astSunEl', `${sunPos.elevation.toFixed(1)}°`);

      if (sunPos.elevation > 5) {
        const shadowMult = (1 / Math.tan(sunPos.elevation * Math.PI / 180)).toFixed(1);
        setText('astShadow', `${shadowMult}x object height`);
      } else {
        setText('astShadow', 'Sun low — long shadows');
      }

      const moonPhase = calcMoonPhase();
      setText('astMoonPhase', moonPhase.name);
      setText('astMoonIllum', `${moonPhase.illumination}%`);

      const nightAssess = moonPhase.illumination > 50 ? 'Good lunar illumination for night ops' :
                          moonPhase.illumination > 20 ? 'Moderate lunar light — supplement with anti-collision' :
                          'Low illumination — ensure adequate anti-collision lighting';
      setText('astNightOps', nightAssess);

      setText('astMagDec', `${(13.2 + (lng + 121) * 0.3).toFixed(1)}° E`);

      S.astro = { sunrise: r.sunrise, sunset: r.sunset, twAM: r.civil_twilight_begin, twPM: r.civil_twilight_end, moonPhase };

      // Cache sunrise data
      if (typeof cacheApiResponse === 'function') cacheApiResponse('sunrise', areaKey(lat, lng), data);
      if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

      setStatus('astroStatus', 'live', 'LIVE');
      clearDataSourceError('Sun/Moon');
    }
  } catch (err) {
    console.error('Sun/Moon fetch error:', err);
    recordDataSourceError('Sun/Moon', err);
    // Try cached sunrise data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(lat, lng) : `${lat.toFixed(3)}_${lng.toFixed(3)}`;
        const cached = await getCachedApiResponse('sunrise', k);
        if (cached && cached.data && cached.data.status === 'OK') {
          const r = cached.data.results;
          const fmt = iso => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
          setText('astSunrise', fmt(r.sunrise));
          setText('astSunset', fmt(r.sunset));
          setText('astTwilightAM', fmt(r.civil_twilight_begin));
          setText('astTwilightPM', fmt(r.civil_twilight_end));
          setText('astDayWindow', `${fmt(r.civil_twilight_begin)} — ${fmt(r.civil_twilight_end)} PDT`);
          S.astro = { sunrise: r.sunrise, sunset: r.sunset, twAM: r.civil_twilight_begin, twPM: r.civil_twilight_end };
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('astroStatus', badge, label);
        } else {
          setStatus('astroStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Sunrise cache fallback failed:', cacheErr);
        setStatus('astroStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('astroStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Sun/Moon');
  }
}

// ============================================================
// API: FAA TFRs
// ============================================================
async function fetchNOTAMs(lat, lng) {
  trackFetchStart('NOTAMs');
  setStatus('notamStatus', 'loading', 'Checking...');
  try {
    const res = await fetch('https://tfr.faa.gov/tfr2/list.html');
    throw new Error('CORS restricted — use FAA API key');
  } catch (err) {
    const notamDiv = document.getElementById('notamList');
    notamDiv.innerHTML = `
      <div class="notam-card notam-style">
        <div class="notam-header">
          <span class="notam-id">TFR CHECK REQUIRED</span>
          <span class="notam-type notam-type-tag">Manual</span>
        </div>
        <div class="notam-body">
          FAA TFR/NOTAM APIs require CORS proxy or backend. Check these sources before flight:
          <br><br>
          <strong>\u2022 <a href="https://tfr.faa.gov/tfr2/list.html" target="_blank" style="color:var(--accent-cyan);">FAA TFR List</a></strong><br>
          <strong>\u2022 <a href="https://notams.aim.faa.gov/notamSearch/" target="_blank" style="color:var(--accent-cyan);">FAA NOTAM Search</a></strong><br>
          <strong>\u2022 <a href="https://skyvector.com/?ll=${lat},${lng}&chart=301" target="_blank" style="color:var(--accent-cyan);">SkyVector (Airspace)</a></strong><br>
          <strong>\u2022 B4UFLY App</strong> or <strong>Aloft (AirMap)</strong>
        </div>
        <div class="notam-meta">Radius: 25 nm from center \u2022 Check \u2264 1 hr before launch</div>
      </div>
      <div class="notam-card tfr">
        <div class="notam-header">
          <span class="notam-id">WILDFIRE TFR ALERT</span>
          <span class="notam-type tfr-type">Seasonal</span>
        </div>
        <div class="notam-body">
          El Dorado County is in a high fire-risk zone. Wildfire TFRs can activate with &lt;30 min notice.
          Always verify no active wildfire TFRs before and during operations.
        </div>
      </div>
    `;
    computeAirspace(lat, lng);
    setStatus('notamStatus', 'error', 'MANUAL');
  } finally {
    trackFetchEnd('NOTAMs');
  }
}

function computeAirspace(lat, lng) {
  // Always compute nearest airport from local dataset (for nearest airport/heliport display)
  const nearby = filterAirportsByDistance(AIRPORTS_CA, lat, lng, 100);
  const nearest = nearby.length > 0 ? nearby[0] : null;
  const nearDist = nearest ? nearest.distKm : Infinity;
  const nearNm = (nearDist * 0.539957).toFixed(1);

  setText('airNearAirport', nearest ? `${nearest.icao} \u2014 ${nearest.name}` : 'None found');
  setText('airNearDist', nearest ? `${nearNm} nm` : '--');
  setColor('airNearDist', nearDist < 9.26 ? 'red' : nearDist < 18.52 ? 'amber' : 'green');

  // Count nearby heliports
  const heliports = nearby.filter(a => a.type === 'heliport');
  if (heliports.length > 0) {
    const hList = heliports.slice(0, 3).map(h => `${h.icao} (${h.distKm.toFixed(1)} km)`).join(', ');
    setText('airHeliports', `${heliports.length} nearby: ${hList}`);
    setColor('airHeliports', 'amber');
  } else {
    setText('airHeliports', 'None within range');
    setColor('airHeliports', 'green');
  }

  // Use live FAA data if available, otherwise fall back to hardcoded logic
  if (S.faaAirspace && S.faaAirspace.classAirspace && S.faaAirspace.classAirspace.features && S.faaAirspace.classAirspace.features.length > 0) {
    // Find the most restrictive class airspace intersecting the area
    const classPriority = { B: 1, C: 2, D: 3, E: 4 };
    let mostRestrictive = null;
    S.faaAirspace.classAirspace.features.forEach(f => {
      const cls = (f.properties.CLASS || '').charAt(0);
      const pri = classPriority[cls] || 99;
      if (!mostRestrictive || pri < (classPriority[mostRestrictive.cls] || 99)) {
        const upper = f.properties.UPPER_VAL ? `${f.properties.UPPER_VAL} ${f.properties.UPPER_UOM || 'MSL'}` : '';
        const lower = f.properties.LOWER_VAL != null ? `${f.properties.LOWER_VAL} ${f.properties.LOWER_UOM || ''}` : 'Surface';
        mostRestrictive = {
          cls: cls,
          name: f.properties.IDENT || f.properties.NAME || '',
          label: `Class ${cls} \u2014 ${f.properties.IDENT || f.properties.NAME || ''} ${lower} to ${upper}`.trim(),
          controlled: cls === 'B' || cls === 'C' || cls === 'D',
        };
      }
    });

    if (mostRestrictive) {
      setText('airClass', mostRestrictive.label);
      setColor('airClass', mostRestrictive.controlled ? 'amber' : 'green');
      setText('airLAANC', mostRestrictive.controlled ? 'Yes \u2014 required' : 'N/A (Class G)');
      setColor('airLAANC', mostRestrictive.controlled ? 'amber' : 'green');
    } else {
      setText('airClass', 'Class G \u2014 Uncontrolled');
      setColor('airClass', 'green');
      setText('airLAANC', 'N/A (Class G)');
      setColor('airLAANC', 'green');
    }

    // LAANC ceiling from facility map
    if (S.faaAirspace.laanc && S.faaAirspace.laanc.features && S.faaAirspace.laanc.features.length > 0) {
      // Find the minimum ceiling (most restrictive) in the operational area
      let minCeiling = Infinity;
      S.faaAirspace.laanc.features.forEach(f => {
        const ceil = f.properties.CEILING;
        if (ceil != null && ceil < minCeiling) minCeiling = ceil;
      });
      if (minCeiling < Infinity) {
        setText('airLAANCAlt', minCeiling === 0 ? 'No UAS operations (0 ft)' : `${minCeiling} ft AGL`);
        setColor('airLAANCAlt', minCeiling === 0 ? 'red' : minCeiling <= 100 ? 'amber' : 'green');
      } else {
        setText('airLAANCAlt', '400 ft AGL');
      }
    } else {
      setText('airLAANCAlt', (mostRestrictive && mostRestrictive.controlled) ? 'No LAANC grid data' : '400 ft AGL');
    }
  } else {
    // Fallback: use hardcoded classification
    const airspace = classifyAirspace(nearest, nearDist);
    setText('airClass', airspace.label);
    setColor('airClass', airspace.controlled ? 'amber' : 'green');
    setText('airLAANC', airspace.controlled ? 'Yes \u2014 required' : 'N/A (Class G)');
    setColor('airLAANC', airspace.controlled ? 'amber' : 'green');
    setText('airLAANCAlt', airspace.controlled ? 'Check grid cell' : '400 ft AGL');
  }

  // Special Use Airspace from FAA data
  if (S.faaAirspace && S.faaAirspace.sua && S.faaAirspace.sua.features) {
    const moas = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('M'));
    const restricted = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('R'));
    const prohibited = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('P'));

    if (moas.length > 0) {
      setText('airMOA', moas.map(f => f.properties.NAME || 'MOA').join(', '));
      setColor('airMOA', 'amber');
    } else {
      setText('airMOA', 'None');
      setColor('airMOA', 'green');
    }
    if (restricted.length > 0) {
      setText('airRestricted', restricted.map(f => f.properties.NAME || 'Restricted').join(', '));
      setColor('airRestricted', 'red');
    } else {
      setText('airRestricted', 'None');
      setColor('airRestricted', 'green');
    }
    if (prohibited.length > 0) {
      setText('airProhibited', prohibited.map(f => f.properties.NAME || 'Prohibited').join(', '));
      setColor('airProhibited', 'red');
    } else {
      setText('airProhibited', 'None');
      setColor('airProhibited', 'green');
    }
  }

  // TFRs from FAA data
  if (S.faaAirspace && S.faaAirspace.tfrs && S.faaAirspace.tfrs.features) {
    if (S.faaAirspace.tfrs.features.length > 0) {
      setText('airTFR', S.faaAirspace.tfrs.features.map(f => f.properties.NAME || 'TFR').join(', '));
      setColor('airTFR', 'red');
    } else {
      setText('airTFR', 'None');
      setColor('airTFR', 'green');
    }
  }

  // National Security UAS Restrictions
  if (S.faaAirspace && S.faaAirspace.nsRestrictions && S.faaAirspace.nsRestrictions.features) {
    if (S.faaAirspace.nsRestrictions.features.length > 0) {
      setText('airNSRestrict', S.faaAirspace.nsRestrictions.features.map(f => f.properties.NAME || 'NS Restriction').join(', '));
      setColor('airNSRestrict', 'red');
    } else {
      setText('airNSRestrict', 'None');
      setColor('airNSRestrict', 'green');
    }
  }
}

// ============================================================
// AIRPORT MARKERS ON MAP
// ============================================================
function renderAirportMarkers(lat, lng) {
  if (!S.mapLayers.airports) {
    S.mapLayers.airports = L.layerGroup().addTo(S.map);
  } else {
    S.mapLayers.airports.clearLayers();
  }

  const nearby = filterAirportsByDistance(AIRPORTS_CA, lat, lng, 55);

  nearby.forEach(a => {
    const distNm = (a.distKm * 0.539957).toFixed(1);
    const typeLabel = a.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const isHeli = a.type === 'heliport';
    const sz = isHeli ? 22 : (a.type === 'large_airport' ? 26 : a.type === 'medium_airport' ? 22 : 18);
    const color = isHeli ? '#a78bfa' : '#f59e0b';

    const svgIcon = isHeli
      ? `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="${color}" fill-opacity="0.85" stroke="#fff" stroke-width="1.5"/><text x="12" y="17" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold" font-family="sans-serif">H</text></svg>`
      : `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="${color}" stroke="#fff" stroke-width="0.8"/></svg>`;

    const icon = L.divIcon({
      html: svgIcon,
      className: '',
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2],
    });

    const marker = L.marker([a.lat, a.lng], { icon });

    marker.bindTooltip(a.icao, {
      permanent: false,
      direction: 'top',
      className: 'airport-tooltip',
      offset: [0, -sz/2],
    });

    marker.bindPopup(
      `<div style="font-family:var(--font-mono,monospace);font-size:12px;">` +
      `<b style="color:${color}">${a.icao}</b> — ${a.name}<br>` +
      `<span style="opacity:0.7">${typeLabel}</span><br>` +
      `Elev: ${a.elevation_ft.toLocaleString()} ft<br>` +
      `${a.municipality}<br>` +
      `<b>${distNm} nm</b> from area center</div>`
    );

    S.mapLayers.airports.addLayer(marker);
  });
}

// ============================================================
// API: NWS SEVERE WEATHER ALERTS (FREE, no key, CORS-friendly)
// ============================================================
async function fetchNWSAlerts(lat, lng) {
  trackFetchStart('NWS Alerts');
  setStatus('alertStatus', 'loading', 'Checking...');
  try {
    const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lng}`, {
      headers: { 'User-Agent': '(SAR-Preflight-Tool, contact@edsar.org)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features || [];

    S.nwsAlerts = features.map(f => ({
      id: f.properties.id || f.id,
      event: f.properties.event,
      severity: f.properties.severity,
      urgency: f.properties.urgency,
      headline: f.properties.headline,
      description: f.properties.description,
      instruction: f.properties.instruction,
      onset: f.properties.onset,
      expires: f.properties.expires,
      senderName: f.properties.senderName,
      geometry: f.geometry,
    }));

    renderNWSAlertCards();
    renderNWSAlertPolygons();
    buildLayerControl();

    // Cache NWS alerts data
    if (typeof cacheApiResponse === 'function') cacheApiResponse('nws', areaKey(lat, lng), data);
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    clearDataSourceError('NWS Alerts');
    if (S.nwsAlerts.length > 0) {
      setStatus('alertStatus', 'live', `${S.nwsAlerts.length} ALERT${S.nwsAlerts.length > 1 ? 'S' : ''}`);
    } else {
      setStatus('alertStatus', 'live', 'CLEAR');
    }
  } catch (err) {
    console.error('NWS Alerts fetch error:', err);
    recordDataSourceError('NWS Alerts', err);
    // Try cached NWS alerts data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(lat, lng) : `${lat.toFixed(3)}_${lng.toFixed(3)}`;
        const cached = await getCachedApiResponse('nws', k);
        if (cached && cached.data && cached.data.features) {
          S.nwsAlerts = cached.data.features.map(f => ({
            id: f.properties.id || f.id,
            event: f.properties.event,
            severity: f.properties.severity,
            urgency: f.properties.urgency,
            headline: f.properties.headline,
            description: f.properties.description,
            instruction: f.properties.instruction,
            onset: f.properties.onset,
            expires: f.properties.expires,
            senderName: f.properties.senderName,
            geometry: f.geometry,
          }));
          renderNWSAlertCards();
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('alertStatus', badge, label);
        } else {
          S.nwsAlerts = [];
          renderNWSAlertCards();
          setStatus('alertStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('NWS alerts cache fallback failed:', cacheErr);
        S.nwsAlerts = [];
        renderNWSAlertCards();
        setStatus('alertStatus', 'error', 'ERROR');
      }
    } else {
      S.nwsAlerts = [];
      renderNWSAlertCards();
      setStatus('alertStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('NWS Alerts');
  }
}

function renderNWSAlertCards() {
  const section = document.getElementById('alertSection');
  const list = document.getElementById('alertList');
  if (!section || !list) return;

  if (S.nwsAlerts.length === 0) {
    section.style.display = '';
    list.innerHTML = `<div class="notam-card" style="border-left:3px solid var(--accent-green);">
      <div class="notam-header"><span class="notam-id" style="color:var(--accent-green);">NO ACTIVE ALERTS</span>
      <span class="notam-type" style="background:rgba(34,197,94,0.15);color:var(--accent-green);">Clear</span></div>
      <div class="notam-body">No NWS weather alerts active for this area.</div></div>`;
    return;
  }

  section.style.display = '';
  list.innerHTML = S.nwsAlerts.map(a => {
    const sevColor = a.severity === 'Extreme' || a.severity === 'Severe'
      ? 'var(--accent-red)' : a.severity === 'Moderate'
      ? 'var(--accent-amber)' : 'var(--accent-cyan)';
    const sevBg = a.severity === 'Extreme' || a.severity === 'Severe'
      ? 'rgba(239,68,68,0.15)' : a.severity === 'Moderate'
      ? 'rgba(245,158,11,0.15)' : 'rgba(6,182,212,0.15)';
    const onset = a.onset ? new Date(a.onset).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const expires = a.expires ? new Date(a.expires).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const desc = (a.description || '').substring(0, 300) + ((a.description || '').length > 300 ? '...' : '');

    return `<div class="notam-card" style="border-left:3px solid ${sevColor};">
      <div class="notam-header">
        <span class="notam-id" style="color:${sevColor};">${a.event}</span>
        <span class="notam-type" style="background:${sevBg};color:${sevColor};">${a.severity}</span>
      </div>
      <div class="notam-body">${a.headline || desc}</div>
      <div class="notam-meta">${onset ? `Onset: ${onset}` : ''}${expires ? ` \u2022 Expires: ${expires}` : ''}${a.senderName ? ` \u2022 ${a.senderName}` : ''}</div>
    </div>`;
  }).join('');
}

function renderNWSAlertPolygons() {
  if (!S.mapLayers.nws_alerts) {
    S.mapLayers.nws_alerts = L.layerGroup().addTo(S.map);
  } else {
    S.mapLayers.nws_alerts.clearLayers();
  }

  S.nwsAlerts.forEach(a => {
    if (!a.geometry) return;
    const fillColor = (a.severity === 'Extreme' || a.severity === 'Severe') ? '#ef4444' : '#f59e0b';
    const layer = L.geoJSON(a.geometry, {
      style: { color: fillColor, weight: 2, fillColor: fillColor, fillOpacity: 0.15, dashArray: '4,4' },
    });
    layer.bindPopup(`<b>${a.event}</b><br>${a.severity} \u2014 ${a.urgency}<br><span style="font-size:11px;">${(a.headline || '').substring(0, 200)}</span>`);
    S.mapLayers.nws_alerts.addLayer(layer);
  });
}

// ============================================================
// API: FAA UDDS — Airspace, SUA, TFR, LAANC, NS Restrictions
// ============================================================
async function fetchFAAairspace(bounds) {
  trackFetchStart('FAA Airspace');
  setStatus('faaAirspaceStatus', 'loading', 'Fetching...');
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const geom = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;
  const base = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
  const cacheKey = `${sw.lat.toFixed(3)}_${sw.lng.toFixed(3)}_${ne.lat.toFixed(3)}_${ne.lng.toFixed(3)}`;

  const urls = {
    classAirspace: `${base}/Class_Airspace/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=IDENT,NAME,CLASS,UPPER_VAL,UPPER_UOM,LOWER_VAL,LOWER_UOM,LOCAL_TYPE&outSR=4326&f=geojson&resultRecordCount=500`,
    sua: `${base}/Special_Use_Airspace/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=NAME,TYPE_CODE,LOCAL_TYPE,UPPER_VAL,LOWER_VAL&outSR=4326&f=geojson&resultRecordCount=500`,
    tfrs: `${base}/National_Defense_Airspace_TFR_Areas/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=NAME,TYPE_CODE,LOCAL_TYPE,CITY,STATE&outSR=4326&f=geojson&resultRecordCount=200`,
    laanc: `${base}/FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=CEILING,APT1_FAAID,APT1_NAME&outSR=4326&f=geojson&resultRecordCount=2000`,
    nsRestrictions: `${base}/Part_Time_National_Security_UAS_Flight_Restrictions/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=NAME,TYPE_CODE,LOCAL_TYPE&outSR=4326&f=geojson&resultRecordCount=200`,
  };

  try {
    const keys = Object.keys(urls);
    const results = await Promise.allSettled(keys.map(k => fetch(urls[k]).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })));

    const data = {};
    keys.forEach((k, i) => {
      if (results[i].status === 'fulfilled') {
        data[k] = results[i].value;
      } else {
        data[k] = { type: 'FeatureCollection', features: [] };
      }
    });

    S.faaAirspace = data;

    // Render map layers
    renderFAAairspaceLayers();
    // Update airspace tab with live FAA data
    computeAirspace(S.areaCenter.lat, S.areaCenter.lng);

    // Cache
    if (typeof cacheApiResponse === 'function') {
      cacheApiResponse('faa_airspace', cacheKey, data);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    clearDataSourceError('FAA Airspace');
    setStatus('faaAirspaceStatus', 'live', 'LIVE');
    buildLayerControl();
  } catch (err) {
    console.error('FAA Airspace fetch error:', err);
    recordDataSourceError('FAA Airspace', err);
    // Try cached data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('faa_airspace', cacheKey);
        if (cached && cached.data) {
          S.faaAirspace = cached.data;
          renderFAAairspaceLayers();
          computeAirspace(S.areaCenter.lat, S.areaCenter.lng);
          buildLayerControl();
          const age = Date.now() - cached.timestamp;
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('faaAirspaceStatus', 'cached', label);
        } else {
          setStatus('faaAirspaceStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('FAA airspace cache fallback failed:', cacheErr);
        setStatus('faaAirspaceStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('faaAirspaceStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('FAA Airspace');
  }
}

function renderFAAairspaceLayers() {
  if (typeof L === 'undefined') return;
  if (!S.faaAirspace) return;

  const classColors = { B: '#3d8bfd', C: '#a78bfa', D: '#06b6d4', E: '#888888' };
  const suaColors = { M: '#f59e0b', R: '#ef4444', P: '#991b1b', A: '#f59e0b', W: '#f59e0b' };
  const laancColors = { 0: '#ef4444', 100: '#f97316', 200: '#f59e0b', 300: '#86efac', 400: '#22c55e' };

  // Class Airspace layer
  if (S.mapLayers.faa_class_airspace) S.mapLayers.faa_class_airspace.clearLayers();
  else S.mapLayers.faa_class_airspace = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_class_airspace && S.faaAirspace.classAirspace && S.faaAirspace.classAirspace.features) {
    S.faaAirspace.classAirspace.features.forEach(f => {
      const cls = (f.properties.CLASS || '').charAt(0);
      const color = classColors[cls] || '#888888';
      const layer = L.geoJSON(f, {
        style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.10 },
      });
      const name = f.properties.NAME || f.properties.IDENT || '';
      const upper = f.properties.UPPER_VAL ? `${f.properties.UPPER_VAL} ${f.properties.UPPER_UOM || ''}` : '';
      const lower = f.properties.LOWER_VAL != null ? `${f.properties.LOWER_VAL} ${f.properties.LOWER_UOM || ''}` : 'SFC';
      layer.bindPopup(`<b>Class ${cls}</b> — ${name}<br>${lower} to ${upper}`);
      S.mapLayers.faa_class_airspace.addLayer(layer);
    });
  }

  // SUA layer
  if (S.mapLayers.faa_sua) S.mapLayers.faa_sua.clearLayers();
  else S.mapLayers.faa_sua = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_sua && S.faaAirspace.sua && S.faaAirspace.sua.features) {
    S.faaAirspace.sua.features.forEach(f => {
      const tc = (f.properties.TYPE_CODE || '').charAt(0);
      const color = suaColors[tc] || '#f59e0b';
      const layer = L.geoJSON(f, {
        style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.12, dashArray: '5,5' },
      });
      layer.bindPopup(`<b>${f.properties.NAME || 'SUA'}</b><br>Type: ${f.properties.LOCAL_TYPE || f.properties.TYPE_CODE || '--'}`);
      S.mapLayers.faa_sua.addLayer(layer);
    });
  }

  // TFR layer
  if (S.mapLayers.faa_tfr) S.mapLayers.faa_tfr.clearLayers();
  else S.mapLayers.faa_tfr = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_tfr && S.faaAirspace.tfrs && S.faaAirspace.tfrs.features) {
    S.faaAirspace.tfrs.features.forEach(f => {
      const layer = L.geoJSON(f, {
        style: { color: '#ef4444', weight: 3, fillColor: '#ef4444', fillOpacity: 0.20, dashArray: '3,3' },
      });
      layer.bindPopup(`<b>TFR</b> — ${f.properties.NAME || ''}<br>${f.properties.CITY || ''} ${f.properties.STATE || ''}`);
      S.mapLayers.faa_tfr.addLayer(layer);
    });
  }

  // LAANC grid layer
  if (S.mapLayers.faa_laanc) S.mapLayers.faa_laanc.clearLayers();
  else S.mapLayers.faa_laanc = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_laanc && S.faaAirspace.laanc && S.faaAirspace.laanc.features) {
    S.faaAirspace.laanc.features.forEach(f => {
      const ceil = f.properties.CEILING != null ? f.properties.CEILING : -1;
      let color = '#888888';
      if (ceil === 0) color = laancColors[0];
      else if (ceil <= 100) color = laancColors[100];
      else if (ceil <= 200) color = laancColors[200];
      else if (ceil <= 300) color = laancColors[300];
      else if (ceil > 300) color = laancColors[400];
      const layer = L.geoJSON(f, {
        style: { color: color, weight: 1, fillColor: color, fillOpacity: 0.15 },
      });
      const aptName = f.properties.APT1_NAME || f.properties.APT1_FAAID || '';
      layer.bindPopup(`<b>LAANC Grid</b><br>Ceiling: ${ceil} ft AGL<br>${aptName}`);
      S.mapLayers.faa_laanc.addLayer(layer);
    });
  }
}

// ============================================================
// API: CRITICAL INFRASTRUCTURE & PROTECTED AREAS (FREE, no key)
// Dams (49 USC § 46307), Wilderness (USFS), National Parks (NPS)
// ============================================================
async function fetchProtectedAreas(bounds) {
  trackFetchStart('Protected Areas');
  setStatus('protectedAreasStatus', 'loading', 'Fetching...');
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  // Extend bounding box by ~0.02 degrees (~2km) to catch nearby features
  const pad = 0.02;
  const geom = `${sw.lng - pad},${sw.lat - pad},${ne.lng + pad},${ne.lat + pad}`;
  const cacheKey = `${sw.lat.toFixed(3)}_${sw.lng.toFixed(3)}_${ne.lat.toFixed(3)}_${ne.lng.toFixed(3)}`;

  const urls = {
    dams: `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Dams_in_America_Trace3/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=DAM_NAME,LATITUDE,LONGITUDE,HAZARD,OWN_NAME,STATE,NID_HEIGHT,PURPOSES&outSR=4326&f=geojson&resultRecordCount=200`,
    wilderness: `https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/S_USA_Wilderness/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=WILDERNE_1,GIS_ACRES,WID&outSR=4326&f=geojson&resultRecordCount=50`,
    nationalParks: `https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=PARKNAME,UNIT_TYPE&outSR=4326&f=geojson&resultRecordCount=50`,
  };

  try {
    const keys = Object.keys(urls);
    const results = await Promise.allSettled(keys.map(k => fetch(urls[k]).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })));

    const data = { dams: [], wilderness: [], nationalParks: [] };
    keys.forEach((k, i) => {
      if (results[i].status === 'fulfilled') {
        const gj = results[i].value;
        data[k] = (gj && gj.features) ? gj.features : [];
      }
    });

    S.protectedAreas = data;
    renderProtectedAreaLayers();

    // Update terrain tab dam info
    if (data.dams.length > 0) {
      setText('terrHwy', `${data.dams.length} dam${data.dams.length > 1 ? 's' : ''} within area \u2014 see map`);
    }

    // Cache
    if (typeof cacheApiResponse === 'function') {
      cacheApiResponse('protected_areas', cacheKey, data);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    clearDataSourceError('Protected Areas');
    const total = data.dams.length + data.wilderness.length + data.nationalParks.length;
    setStatus('protectedAreasStatus', 'live', total > 0 ? `${total} FOUND` : 'CLEAR');
    buildLayerControl();
  } catch (err) {
    console.error('Protected Areas fetch error:', err);
    recordDataSourceError('Protected Areas', err);
    // Try cached data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('protected_areas', cacheKey);
        if (cached && cached.data) {
          S.protectedAreas = cached.data;
          renderProtectedAreaLayers();
          if (cached.data.dams && cached.data.dams.length > 0) {
            setText('terrHwy', `${cached.data.dams.length} dam${cached.data.dams.length > 1 ? 's' : ''} within area \u2014 see map`);
          }
          buildLayerControl();
          const age = Date.now() - cached.timestamp;
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('protectedAreasStatus', 'cached', label);
        } else {
          setStatus('protectedAreasStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Protected areas cache fallback failed:', cacheErr);
        setStatus('protectedAreasStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('protectedAreasStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Protected Areas');
  }
}

function renderProtectedAreaLayers() {
  if (typeof L === 'undefined') return;
  if (!S.protectedAreas) return;

  // Dams layer — "D" marker at each dam location (geometry is river trace, not dam structure)
  if (S.mapLayers.dams) S.mapLayers.dams.clearLayers();
  else S.mapLayers.dams = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.dams && S.protectedAreas.dams) {
    S.protectedAreas.dams.forEach(f => {
      const p = f.properties || {};
      const popup = [
        `<b style="color:#ef4444">${p.DAM_NAME || 'Dam'}</b>`,
        p.NID_HEIGHT ? `Height: ${p.NID_HEIGHT} ft` : '',
        p.HAZARD ? `Hazard: ${p.HAZARD === 'H' ? 'HIGH' : p.HAZARD === 'S' ? 'SIGNIFICANT' : p.HAZARD}` : '',
        p.OWN_NAME ? `Owner: ${p.OWN_NAME}` : '',
        `<span style="color:#ef4444;font-size:10px;font-weight:bold;">UAS prohibited within 400ft \u2014 49 USC \u00A7 46307</span>`,
      ].filter(Boolean).join('<br>');
      // Place marker at the dam's reported coordinates (not the river trace geometry)
      if (p.LATITUDE && p.LONGITUDE && typeof L.divIcon === 'function') {
        const sz = 22;
        const icon = L.divIcon({
          html: `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#ef4444" fill-opacity="0.9" stroke="#fff" stroke-width="1.5"/><text x="12" y="17" text-anchor="middle" fill="#fff" font-size="12" font-weight="bold" font-family="sans-serif">D</text></svg>`,
          className: '', iconSize: [sz, sz], iconAnchor: [sz/2, sz/2],
        });
        L.marker([p.LATITUDE, p.LONGITUDE], { icon }).bindPopup(popup).addTo(S.mapLayers.dams);
      }
    });
  }

  // Wilderness layer — dark green polygons
  if (S.mapLayers.wilderness) S.mapLayers.wilderness.clearLayers();
  else S.mapLayers.wilderness = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.wilderness && S.protectedAreas.wilderness) {
    S.protectedAreas.wilderness.forEach(f => {
      const p = f.properties || {};
      const layer = L.geoJSON(f, {
        style: { color: '#166534', weight: 2, fillColor: '#166534', fillOpacity: 0.15 },
      });
      const acres = p.GIS_ACRES ? `${Math.round(p.GIS_ACRES).toLocaleString()} acres` : '';
      layer.bindPopup(
        `<b style="color:#166534">${p.WILDERNE_1 || 'Wilderness Area'}</b>`
        + (acres ? `<br>${acres}` : '')
        + `<br><span style="color:#f59e0b;font-size:10px;font-weight:bold;">UAS requires USFS permit</span>`
      );
      S.mapLayers.wilderness.addLayer(layer);
    });
  }

  // National Parks layer — dark brown/olive polygons
  if (S.mapLayers.national_parks) S.mapLayers.national_parks.clearLayers();
  else S.mapLayers.national_parks = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.national_parks && S.protectedAreas.nationalParks) {
    S.protectedAreas.nationalParks.forEach(f => {
      const p = f.properties || {};
      const layer = L.geoJSON(f, {
        style: { color: '#78350f', weight: 2, fillColor: '#78350f', fillOpacity: 0.15 },
      });
      layer.bindPopup(
        `<b style="color:#78350f">${p.PARKNAME || 'National Park'}</b>`
        + (p.UNIT_TYPE ? `<br>Type: ${p.UNIT_TYPE}` : '')
        + `<br><span style="color:#f59e0b;font-size:10px;font-weight:bold;">UAS requires NPS authorization per 36 CFR 1.5</span>`
      );
      S.mapLayers.national_parks.addLayer(layer);
    });
  }
}

// ============================================================
// API: OVERPASS (OSM) — Wire & Cable Hazards (FREE, no key)
// ============================================================
async function fetchWireHazards(bounds) {
  trackFetchStart('Wire Hazards');
  setStatus('wireStatus', 'loading', 'Fetching...');
  Object.keys(WIRE_CATEGORIES).forEach(k => {
    const lid = 'wire_' + k;
    if (S.mapLayers[lid]) { S.mapLayers[lid].clearLayers(); }
    else { S.mapLayers[lid] = L.layerGroup().addTo(S.map); }
  });

  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const pad = 0.015;
  const bbox = `${sw.lat - pad},${sw.lng - pad},${ne.lat + pad},${ne.lng + pad}`;

  const query = `[out:json][timeout:60];(`
    + `way["power"="line"](${bbox});`
    + `way["power"="minor_line"](${bbox});`
    + `way["power"="cable"](${bbox});`
    + `way["communication"="line"](${bbox});`
    + `way["telecom"="line"](${bbox});`
    + `way["telephone"="line"](${bbox});`
    + `way["aerialway"](${bbox});`
    + `node["man_made"="mast"](${bbox});`
    + `node["man_made"="communications_tower"](${bbox});`
    + `node["man_made"="tower"](${bbox});`
    + `node["tower:type"="communication"](${bbox});`
    + `node["man_made"="chimney"](${bbox});`
    + `node["man_made"="lighthouse"](${bbox});`
    + `node["man_made"="water_tower"](${bbox});`
    + `node["man_made"="wind_turbine"](${bbox});`
    + `node["man_made"="antenna"](${bbox});`
    + `);out body;>;out skel qt;`;

  try {
    // Try multiple Overpass API mirrors in case primary is overloaded
    const overpassServers = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];
    let data = null;
    for (const server of overpassServers) {
      try {
        const res = await fetch(server, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        break; // success — stop trying mirrors
      } catch (e) {
        console.warn(`Overpass mirror ${server} failed:`, e.message);
        if (server === overpassServers[overpassServers.length - 1]) throw e; // last one, rethrow
      }
    }
    const elements = data.elements || [];

    const nodes = {};
    elements.forEach(el => {
      if (el.type === 'node') nodes[el.id] = [el.lat, el.lon];
    });

    const counts = {};
    elements.forEach(el => {
      if (el.type !== 'way') return;
      const tags = el.tags || {};
      let cat = null;
      if (tags.power === 'line') cat = 'power_line';
      else if (tags.power === 'minor_line') cat = 'power_minor_line';
      else if (tags.power === 'cable') cat = 'power_cable';
      else if (tags.communication === 'line' || tags.telecom === 'line' || tags.telephone === 'line') cat = 'telecom_line';
      else if (tags.aerialway) cat = 'aerialway';
      if (!cat) return;

      const coords = (el.nodes || []).map(nid => nodes[nid]).filter(Boolean);
      if (coords.length < 2) return;

      counts[cat] = (counts[cat] || 0) + 1;
      const info = WIRE_CATEGORIES[cat];
      const name = wireHazardName(tags, cat);

      const polyline = L.polyline(coords, { color: info.color, weight: info.weight, opacity: 0.8 })
        .bindPopup(`<b style="color:${info.color}">${info.label}</b><br>${name}<br><span style="font-size:10px;opacity:0.6">OSM Way ${el.id}</span>`);
      S.mapLayers['wire_' + cat].addLayer(polyline);
    });

    // Tower/structure node processing (comm towers, masts, chimneys, wind turbines, etc.)
    if (!S.mapLayers.cell_towers) S.mapLayers.cell_towers = L.layerGroup().addTo(S.map);
    else S.mapLayers.cell_towers.clearLayers();
    let towerCount = 0;
    const TOWER_TYPES = {
      'communications_tower': 'Comm Tower',
      'mast': 'Mast',
      'tower': 'Tower',
      'chimney': 'Chimney',
      'lighthouse': 'Lighthouse',
      'water_tower': 'Water Tower',
      'wind_turbine': 'Wind Turbine',
      'antenna': 'Antenna',
    };
    elements.forEach(el => {
      if (el.type !== 'node') return;
      const tags = el.tags || {};
      const mm = tags['man_made'];
      const isTower = TOWER_TYPES[mm] || tags['tower:type'] === 'communication';
      if (!isTower) return;
      towerCount++;

      const label = TOWER_TYPES[mm] || 'Comm Tower';
      const heightRaw = tags.height || tags['tower:height'];
      let heightFt = null;
      if (heightRaw) {
        const m = parseFloat(heightRaw);
        if (!isNaN(m)) heightFt = Math.round(m * 3.28084);
      }
      const heightLabel = heightFt ? heightFt + "'" : '';

      // FAA sectional-style tower icon: solid inverted triangle with dot on top
      const color = '#00CCFF';
      const sz = 28;
      const svgIcon = `<svg width="${sz}" height="${sz}" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">`
        + `<line x1="14" y1="4" x2="14" y2="22" stroke="${color}" stroke-width="1.5"/>`
        + `<circle cx="14" cy="4" r="2.5" fill="${color}"/>`
        + `<line x1="8" y1="12" x2="14" y2="8" stroke="${color}" stroke-width="1"/>`
        + `<line x1="20" y1="12" x2="14" y2="8" stroke="${color}" stroke-width="1"/>`
        + `<line x1="6" y1="18" x2="14" y2="13" stroke="${color}" stroke-width="1"/>`
        + `<line x1="22" y1="18" x2="14" y2="13" stroke="${color}" stroke-width="1"/>`
        + (heightLabel ? `<text x="14" y="27" text-anchor="middle" fill="${color}" font-family="sans-serif" font-size="7" font-weight="bold">${heightLabel}</text>` : '')
        + `</svg>`;

      const icon = L.divIcon({ html: svgIcon, className: '', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
      const popupParts = [`<b style="color:${color}">${label}</b>`];
      if (tags.name) popupParts.push(tags.name);
      if (heightFt) popupParts.push(`Height: ${heightFt} ft (${heightRaw}m)`);
      else if (heightRaw) popupParts.push(`Height: ${heightRaw}`);
      if (tags.operator) popupParts.push(`Operator: ${tags.operator}`);
      popupParts.push(`<span style="font-size:10px;opacity:0.6">OSM Node ${el.id}</span>`);

      L.marker([el.lat, el.lon], { icon })
        .bindPopup(popupParts.join('<br>'))
        .addTo(S.mapLayers.cell_towers);
    });
    S.towerCount = towerCount;

    S.wireHazardCounts = counts;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    updateWireDisplay(counts, towerCount);
    buildLayerControl();

    // Cache overpass data
    if (typeof cacheApiResponse === 'function') {
      const cLat = (sw.lat + ne.lat) / 2;
      const cLng = (sw.lng + ne.lng) / 2;
      cacheApiResponse('overpass', areaKey(cLat, cLng), data);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    setStatus('wireStatus', 'live', `${total + towerCount} FEATURES`);
    clearDataSourceError('Wire Hazards');
  } catch (err) {
    console.error('Wire hazard fetch error:', err);
    recordDataSourceError('Wire Hazards', err);
    // Try cached overpass data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cLat = (sw.lat + ne.lat) / 2;
        const cLng = (sw.lng + ne.lng) / 2;
        const k = typeof areaKey === 'function' ? areaKey(cLat, cLng) : `${cLat.toFixed(3)}_${cLng.toFixed(3)}`;
        const cached = await getCachedApiResponse('overpass', k);
        if (cached && cached.data && cached.data.elements) {
          const elements = cached.data.elements;
          const nodes = {};
          elements.forEach(el => { if (el.type === 'node') nodes[el.id] = [el.lat, el.lon]; });
          const counts = {};
          elements.forEach(el => {
            if (el.type !== 'way') return;
            const tags = el.tags || {};
            let cat = null;
            if (tags.power === 'line') cat = 'power_line';
            else if (tags.power === 'minor_line') cat = 'power_minor_line';
            else if (tags.power === 'cable') cat = 'power_cable';
            else if (tags.communication === 'line' || tags.telecom === 'line' || tags.telephone === 'line') cat = 'telecom_line';
            else if (tags.aerialway) cat = 'aerialway';
            if (cat) counts[cat] = (counts[cat] || 0) + 1;
          });
          S.wireHazardCounts = counts;
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          updateWireDisplay(counts, 0);
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('wireStatus', badge, `${total} FEAT ${label}`);
        } else {
          setStatus('wireStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Wire hazards cache fallback failed:', cacheErr);
        setStatus('wireStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('wireStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Wire Hazards');
  }
}

function updateWireDisplay(counts, towerCount) {
  const powerCount = (counts.power_line || 0) + (counts.power_minor_line || 0) + (counts.power_cable || 0);
  const telecomCount = counts.telecom_line || 0;
  const aerialCount = counts.aerialway || 0;
  const towers = towerCount || 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (total > 0 || towers > 0) {
    setText('terrPower', `${powerCount} lines mapped \u2014 see map`);
    setColor('terrPower', powerCount > 0 ? 'amber' : 'green');
    setText('terrTowers', `${towers} towers, ${telecomCount} telecom, ${aerialCount} aerialway`);
    setColor('terrTowers', (towers + telecomCount + aerialCount) > 0 ? 'amber' : 'green');
  } else {
    setText('terrPower', 'None mapped (verify imagery)');
    setColor('terrPower', 'amber');
    setText('terrTowers', 'None mapped');
  }
}

// ============================================================
// API: RAINVIEWER Weather Radar Animation
// ============================================================
async function fetchRadar() {
  trackFetchStart('Radar');
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Clean up old radar layers
    if (S.radarAnim && S.radarAnim.layers) {
      S.radarAnim.layers.forEach(l => { if (S.map.hasLayer(l)) S.map.removeLayer(l); });
    }
    if (S.radarAnim && S.radarAnim.interval) clearInterval(S.radarAnim.interval);

    const frames = (data.radar && data.radar.past) ? data.radar.past : [];
    if (frames.length === 0) return;

    const layers = frames.map(frame =>
      L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0, maxNativeZoom: 7, maxZoom: 18, zIndex: 500,
      })
    );

    S.radarAnim = { playing: false, index: layers.length - 1, layers: layers, interval: null, frames: frames };

    // Show most recent frame at 0.5 opacity
    const last = layers[layers.length - 1];
    last.setOpacity(0.5);
    last.addTo(S.map);

    // Show radar controls
    const controls = document.getElementById('radarControls');
    if (controls) controls.style.display = 'flex';
    updateRadarTime();
    clearDataSourceError('Radar');

    buildLayerControl();
  } catch (err) {
    console.error('Radar fetch error:', err);
    recordDataSourceError('Radar', err);
  } finally {
    trackFetchEnd('Radar');
  }
}

function radarToggle() {
  if (!S.radarAnim || !S.radarAnim.layers || S.radarAnim.layers.length === 0) return;
  if (S.radarAnim.playing) {
    clearInterval(S.radarAnim.interval);
    S.radarAnim.interval = null;
    S.radarAnim.playing = false;
    const btn = document.getElementById('radarPlayBtn');
    if (btn) btn.innerHTML = '&#9654;';
  } else {
    S.radarAnim.playing = true;
    const btn = document.getElementById('radarPlayBtn');
    if (btn) btn.innerHTML = '&#9646;&#9646;';
    S.radarAnim.interval = setInterval(() => radarStep(1), 800);
  }
}

function radarStep(dir) {
  if (!S.radarAnim || !S.radarAnim.layers || S.radarAnim.layers.length === 0) return;
  const layers = S.radarAnim.layers;
  const oldIdx = S.radarAnim.index;

  // Hide current frame
  if (S.map.hasLayer(layers[oldIdx])) layers[oldIdx].setOpacity(0);

  // Calculate new index
  let newIdx = oldIdx + dir;
  if (newIdx >= layers.length) newIdx = 0;
  if (newIdx < 0) newIdx = layers.length - 1;
  S.radarAnim.index = newIdx;

  // Show new frame
  if (!S.map.hasLayer(layers[newIdx])) layers[newIdx].addTo(S.map);
  layers[newIdx].setOpacity(0.5);
  updateRadarTime();
}

function updateRadarTime() {
  const el = document.getElementById('radarTime');
  if (!el || !S.radarAnim || !S.radarAnim.frames) { if (el) el.textContent = '--'; return; }
  const frame = S.radarAnim.frames[S.radarAnim.index];
  if (frame && frame.time) {
    const d = new Date(frame.time * 1000);
    el.textContent = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  } else {
    el.textContent = '--';
  }
}

// ============================================================
// FORECAST TIMEBAR + WIND/SUN ARROWS
// ============================================================

// Show the timebar when hourly data is available
function initTimeBar() {
  const bar = document.getElementById('timeBar');
  if (!bar || !S.wx?.hourly?.time?.length || !S.areaCenter) return;
  bar.style.display = 'flex';

  const times = S.wx.hourly.time;
  const n = Math.min(times.length, 24);

  // Build hour labels
  const labelsEl = document.getElementById('tbLabels');
  if (labelsEl) {
    let lhtml = '';
    for (let i = 0; i < n; i += 3) {
      const dt = new Date(times[i]);
      lhtml += `<span>${dt.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: 'America/Los_Angeles' }).replace(' ', '')}</span>`;
    }
    labelsEl.innerHTML = lhtml;
  }

  // Attach drag interaction
  const track = document.getElementById('tbTrack');
  if (track && !track._tbInit) {
    track._tbInit = true;
    const onMove = (ex) => {
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ex - rect.left) / rect.width));
      _updateTimeBar(frac);
    };
    track.addEventListener('mousedown', e => {
      e.preventDefault();
      onMove(e.clientX);
      const mm = ev => onMove(ev.clientX);
      const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
    track.addEventListener('touchstart', e => {
      e.preventDefault();
      onMove(e.touches[0].clientX);
      const tm = ev => onMove(ev.touches[0].clientX);
      const te = () => { document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', te); };
      document.addEventListener('touchmove', tm);
      document.addEventListener('touchend', te);
    });
  }

  // Set to "now" position
  _updateTimeBar(0);
}

function _updateTimeBar(frac) {
  const hourly = S.wx?.hourly;
  if (!hourly || !hourly.time?.length || !S.areaCenter) return;
  const n = Math.min(hourly.time.length, 24);
  const idx = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));

  // Update scrubber position
  const pct = (idx / (n - 1)) * 100;
  const fill = document.getElementById('tbFill');
  const thumb = document.getElementById('tbThumb');
  if (fill) fill.style.width = pct + '%';
  if (thumb) thumb.style.left = pct + '%';

  // Time readout
  const dt = new Date(hourly.time[idx]);
  const timeEl = document.getElementById('tbTime');
  if (timeEl) timeEl.textContent = idx === 0 ? 'NOW' : dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' });

  // Wind values
  const windSpd = hourly.wind_speed_10m?.[idx];
  const windDir = hourly.wind_direction_10m?.[idx];
  const windEl = document.getElementById('tbWind');
  if (windEl) windEl.textContent = windSpd != null ? `${Math.round(windSpd)}mph ${Math.round(windDir || 0)}°` : '--';

  // Sun position at this time
  const lat = S.areaCenter.lat, lng = S.areaCenter.lng;
  const sunPos = typeof calcSunPosition === 'function' ? calcSunPosition(lat, lng, dt) : null;
  const sunEl = document.getElementById('tbSun');
  const isDay = sunPos && sunPos.elevation > 0;
  if (sunEl) sunEl.textContent = isDay ? `Sun ${Math.round(sunPos.azimuth)}° ↑${sunPos.elevation.toFixed(0)}°` : 'Night';

  // Update map arrows
  _updateWindArrow(windDir, windSpd);
  _updateSunArrow(sunPos);
}

// --- Wind direction arrow (blue) on map ---
function _updateWindArrow(dir, speed) {
  if (!S.map || !S.areaCenter) return;

  if (dir == null || speed == null) {
    if (S._windArrow) { S.map.removeLayer(S._windArrow); S._windArrow = null; }
    return;
  }

  const len = Math.min(30, 14 + speed * 0.6); // arrow length scales with speed
  const svgHtml = `<svg width="60" height="60" viewBox="0 0 60 60" style="overflow:visible;">
    <defs><marker id="wah" markerWidth="6" markerHeight="5" refX="3" refY="2.5" orient="auto"><polygon points="0 0,6 2.5,0 5" fill="#3d8bfd"/></marker></defs>
    <line x1="30" y1="30" x2="30" y2="${30 - len}" stroke="#3d8bfd" stroke-width="2.5" marker-end="url(#wah)"
          transform="rotate(${dir}, 30, 30)"/>
    <circle cx="30" cy="30" r="3" fill="#3d8bfd" opacity="0.6"/>
  </svg>`;

  if (S._windArrow) {
    S._windArrow.setIcon(L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }));
    S._windArrow.setLatLng(S.areaCenter);
  } else {
    S._windArrow = L.marker(S.areaCenter, {
      icon: L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }),
      interactive: false, zIndexOffset: 900,
    }).addTo(S.map);
  }
}

// --- Sun direction arrow (yellow) on map ---
function _updateSunArrow(sunPos) {
  if (!S.map || !S.areaCenter) return;

  if (!sunPos || sunPos.elevation <= 0) {
    if (S._sunArrow) { S.map.removeLayer(S._sunArrow); S._sunArrow = null; }
    return;
  }

  const az = sunPos.azimuth;
  const len = 24;
  const svgHtml = `<svg width="60" height="60" viewBox="0 0 60 60" style="overflow:visible;">
    <defs><marker id="sah" markerWidth="6" markerHeight="5" refX="3" refY="2.5" orient="auto"><polygon points="0 0,6 2.5,0 5" fill="#f59e0b"/></marker></defs>
    <line x1="30" y1="30" x2="30" y2="${30 - len}" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4,2" marker-end="url(#sah)"
          transform="rotate(${az}, 30, 30)"/>
    <circle cx="30" cy="30" r="5" fill="none" stroke="#f59e0b" stroke-width="1.5" opacity="0.5"/>
  </svg>`;

  if (S._sunArrow) {
    S._sunArrow.setIcon(L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }));
    S._sunArrow.setLatLng(S.areaCenter);
  } else {
    S._sunArrow = L.marker(S.areaCenter, {
      icon: L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }),
      interactive: false, zIndexOffset: 899,
    }).addTo(S.map);
  }
}

function hideTimeBar() {
  const bar = document.getElementById('timeBar');
  if (bar) bar.style.display = 'none';
  if (S._windArrow) { S.map.removeLayer(S._windArrow); S._windArrow = null; }
  if (S._sunArrow) { S.map.removeLayer(S._sunArrow); S._sunArrow = null; }
}

// ============================================================
// TERRAIN FEATURES & EMERGENCY LZs
// ============================================================
function renderTerrainFeatures(features) {
  if (!features) return;
  const parts = [];
  if (features.hasRidges) parts.push('Ridges');
  if (features.hasCanyons) parts.push('Canyons');
  if (features.hasFunneling) parts.push('Wind funneling');
  if (features.features && features.features.length > 0) {
    features.features.forEach(f => { if (!parts.includes(f)) parts.push(f); });
  }
  // Update terrain tab if there are notable features
  if (parts.length > 0) {
    setText('terrClass', classifyTerrain(S.elev.center) + ' — ' + parts.join(', '));
  }
}

function renderLZMarkers(lzs) {
  // LZ analysis is based on coarse elevation grid (25 points) and cannot
  // reliably identify actual landing zones. Show a terrain suitability
  // assessment instead of precise map markers.

  // Clear any existing LZ markers
  if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
    if (S.mapLayers.emergency_lz) S.mapLayers.emergency_lz.clearLayers();
  }

  if (!lzs || lzs.length === 0) {
    setText('terrLZ', 'Terrain unsuitable \u2014 steep slopes throughout. Identify LZ on satellite imagery.');
    setColor('terrLZ', 'red');
    return;
  }

  S.lzs = lzs;
  const avgScore = lzs.reduce((sum, lz) => sum + lz.score, 0) / lzs.length;
  const bestScore = lzs[0]?.score || 0;
  const avgSlope = lzs.reduce((sum, lz) => sum + lz.slopeDeg, 0) / lzs.length;

  let assessment, level;
  if (bestScore > 0.8 && avgSlope < 5) {
    assessment = `Generally flat terrain (avg slope ${avgSlope.toFixed(1)}\u00b0) \u2014 multiple LZ options likely. Verify on satellite.`;
    level = 'green';
  } else if (bestScore > 0.6) {
    assessment = `Mixed terrain (avg slope ${avgSlope.toFixed(1)}\u00b0) \u2014 LZ possible in flatter areas. Check satellite imagery for clearings.`;
    level = 'amber';
  } else {
    assessment = `Steep/forested terrain (avg slope ${avgSlope.toFixed(1)}\u00b0) \u2014 LZ options limited. Use satellite to find clearings/roads.`;
    level = 'red';
  }

  setText('terrLZ', assessment);
  setColor('terrLZ', level);

  // No map markers — elevation grid is too coarse to pinpoint actual LZs.
  // User should toggle satellite layer and visually identify clearings.
  if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
    if (!S.mapLayers.emergency_lz) S.mapLayers.emergency_lz = L.layerGroup();
  }

  const count = lzs.length;
  let nearestDist = '--';
  if (S.areaCenter && count > 0) {
    const distances = lzs.map(lz => haversine(S.areaCenter.lat, S.areaCenter.lng, lz.lat, lz.lng));
    nearestDist = (Math.min(...distances) * 1000).toFixed(0);
    // Don't overwrite the assessment text above
    // setText('terrLZ', ...);
  } else {
    setText('terrLZ', `${count} LZ${count > 1 ? 's' : ''} found`);
  }
}

function generateAndRenderFlightPlan() {
  if (!S.areaBounds || !S.areaCenter) return;

  const patternType = document.getElementById('cfgSearchPattern')?.value || 'parallel';
  const trackSpacing = parseInt(document.getElementById('cfgTrackSpacing')?.value) || 100;
  const windDir = S.wx.wind_direction_10m ?? 0;

  if (typeof generateSearchPattern !== 'function') {
    setText('opsPlanDist', 'N/A');
    setText('opsPlanLegs', 'N/A');
    return;
  }

  const ne = S.areaBounds.getNorthEast();
  const sw = S.areaBounds.getSouthWest();
  const bounds = {
    north: ne.lat,
    south: sw.lat,
    east: ne.lng,
    west: sw.lng,
  };

  const result = generateSearchPattern(bounds, windDir, patternType, trackSpacing);

  // Render polyline on map (guard for test env without full Leaflet)
  if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
    if (S.mapLayers.flight_plan) {
      S.mapLayers.flight_plan.clearLayers();
    } else {
      S.mapLayers.flight_plan = L.layerGroup();
    }

    if (result.waypoints && result.waypoints.length > 1 && typeof L.polyline === 'function') {
      const polyline = L.polyline(result.waypoints, {
        color: '#06b6d4', // cyan
        weight: 2,
        opacity: 0.8,
        dashArray: '8,6',
      });
      S.mapLayers.flight_plan.addLayer(polyline);
      if (S.map) S.mapLayers.flight_plan.addTo(S.map);
    }
  }

  setText('opsPlanDist', `${result.estimatedDistanceKm} km`);
  setText('opsPlanLegs', `${result.legs}`);
  buildLayerControl();
}

// ============================================================
// DERIVED COMPUTATIONS
// ============================================================
function computeOpsData() {
  const temp = S.wx.temperature_2m ?? 65;
  const elev = S.elev.center ?? 1500;
  const maxWind = S.wind.maxWind ?? 5;
  const nomTime = parseInt(document.getElementById('cfgFlightTime').value) || 38;

  // Uses extracted core function
  const d = calcBatteryDerating(temp, elev, maxWind);
  const estTime = Math.round(nomTime * d.combined);
  const capacity = Math.round(d.combined * 100);

  setText('opsTempFactor', `${(d.tempFactor*100).toFixed(0)}%`);
  setColor('opsTempFactor', d.tempFactor > 0.9 ? 'green' : d.tempFactor > 0.8 ? 'amber' : 'red');
  setText('opsAltFactor', `${(d.altFactor*100).toFixed(0)}%`);
  setColor('opsAltFactor', d.altFactor > 0.9 ? 'green' : d.altFactor > 0.8 ? 'amber' : 'red');
  setText('opsWindFactor', `${(d.windFactor*100).toFixed(0)}%`);
  setColor('opsWindFactor', d.windFactor > 0.85 ? 'green' : d.windFactor > 0.7 ? 'amber' : 'red');
  setText('opsFlightTime', `~${estTime} min`);
  setColor('opsFlightTime', estTime > 28 ? 'green' : estTime > 20 ? 'amber' : 'red');
  setText('opsCapacity', `${capacity}% of nominal`);
  const bar = document.getElementById('opsCapBar');
  bar.style.width = `${capacity}%`;
  bar.style.background = capacity > 85 ? 'var(--accent-green)' : capacity > 70 ? 'var(--accent-amber)' : 'var(--accent-red)';

  const month = new Date().getMonth();
  const birdRisk = (month >= 2 && month <= 6) ? 'Spring/summer nesting \u2014 watch for raptors near ridges and water' :
                   (month >= 9 && month <= 11) ? 'Fall migration \u2014 moderate bird activity' : 'Winter \u2014 low bird activity';
  setText('opsBirds', birdRisk);

  // Battery swap recommendation
  if (typeof calcSwapRecommendation === 'function') {
    const cruiseSpeed = 20; // mph default for SAR ops
    const swap = calcSwapRecommendation(estTime, cruiseSpeed, S.lzs || []);
    setText('opsSwapTime', `~${Math.round(swap.swapTimeMin)} min`);
    setText('opsSwapRadius', `${swap.swapRadiusKm.toFixed(1)} km`);
    if (swap.nearestLZ) {
      setText('opsSwapLZ', `Score ${Math.round(swap.nearestLZ.score * 100)}% at (${swap.nearestLZ.lat.toFixed(4)}, ${swap.nearestLZ.lng.toFixed(4)})`);
    } else {
      setText('opsSwapLZ', 'No suitable LZ \u2014 plan manual recovery');
    }

    // Draw swap radius circle on map (guard for test env without full Leaflet)
    if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
      if (S.mapLayers.swap_radius) {
        S.mapLayers.swap_radius.clearLayers();
      } else {
        S.mapLayers.swap_radius = L.layerGroup();
      }
      if (S.areaCenter && swap.swapRadiusKm > 0 && typeof L.circle === 'function') {
        const circle = L.circle([S.areaCenter.lat, S.areaCenter.lng], {
          radius: swap.swapRadiusKm * 1000,
          color: '#a78bfa',
          weight: 1.5,
          fillOpacity: 0,
          dashArray: '4,8',
          opacity: 0.6,
        });
        circle.bindTooltip(`Swap radius: ${swap.swapRadiusKm.toFixed(1)} km`, { permanent: false, direction: 'top' });
        S.mapLayers.swap_radius.addLayer(circle);
        if (S.map && !S.map.hasLayer(S.mapLayers.swap_radius)) {
          S.mapLayers.swap_radius.addTo(S.map);
        }
      }
    }
  }
}

function computeAssessment() {
  const maxWindTol = parseInt(document.getElementById('cfgMaxWind').value) || 27;

  // Uses extracted core function with optional SOP thresholds
  const thresholds = S.activeProfile || (typeof DEFAULT_THRESHOLDS !== 'undefined' ? DEFAULT_THRESHOLDS : null);
  const result = assessRisk(S.wx, S.wind, S.elev, maxWindTol, thresholds);

  // Integrate NWS severe weather alerts into assessment
  if (S.nwsAlerts && S.nwsAlerts.length > 0) {
    const severeAlerts = S.nwsAlerts.filter(a => a.severity === 'Extreme' || a.severity === 'Severe');
    const moderateAlerts = S.nwsAlerts.filter(a => a.severity === 'Moderate');
    if (severeAlerts.length > 0) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push(`NWS: ${severeAlerts.map(a => a.event).join(', ')}`);
      result.text = result.issues.join(' \u2022 ');
    } else if (moderateAlerts.length > 0 && result.level === 'GO') {
      result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push(`NWS: ${moderateAlerts.map(a => a.event).join(', ')}`);
      result.text = result.cautions.join(' \u2022 ');
    }
  }

  // Integrate FAA airspace data into assessment
  if (S.faaAirspace) {
    // NO-GO: active TFR
    if (S.faaAirspace.tfrs && S.faaAirspace.tfrs.features && S.faaAirspace.tfrs.features.length > 0) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push('Active TFR: ' + S.faaAirspace.tfrs.features.map(f => f.properties.NAME || 'TFR').join(', '));
      result.text = result.issues.join(' \u2022 ');
    }
    // NO-GO: prohibited airspace
    if (S.faaAirspace.sua && S.faaAirspace.sua.features) {
      const prohibited = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('P'));
      if (prohibited.length > 0) {
        result.level = 'NO-GO';
        result.issues = result.issues || [];
        result.issues.push('Prohibited airspace: ' + prohibited.map(f => f.properties.NAME || 'P-area').join(', '));
        result.text = result.issues.join(' \u2022 ');
      }
    }
    // NO-GO: national security UAS restrictions
    if (S.faaAirspace.nsRestrictions && S.faaAirspace.nsRestrictions.features && S.faaAirspace.nsRestrictions.features.length > 0) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push('NS UAS restriction: ' + S.faaAirspace.nsRestrictions.features.map(f => f.properties.NAME || 'NS area').join(', '));
      result.text = result.issues.join(' \u2022 ');
    }
    // CAUTION: Class B/C/D without LAANC
    if (S.faaAirspace.classAirspace && S.faaAirspace.classAirspace.features) {
      const controlled = S.faaAirspace.classAirspace.features.filter(f => {
        const cls = (f.properties.CLASS || '').charAt(0);
        return cls === 'B' || cls === 'C' || cls === 'D';
      });
      if (controlled.length > 0) {
        const hasLaanc = S.faaAirspace.laanc && S.faaAirspace.laanc.features && S.faaAirspace.laanc.features.length > 0;
        if (!hasLaanc && result.level !== 'NO-GO') {
          if (result.level === 'GO') result.level = 'CAUTION';
          result.cautions = result.cautions || [];
          result.cautions.push('Controlled airspace without LAANC data');
          if (result.level === 'CAUTION' && result.issues.length === 0) {
            result.text = result.cautions.join(' \u2022 ');
          }
        }
      }
    }
    // CAUTION: MOA present
    if (S.faaAirspace.sua && S.faaAirspace.sua.features) {
      const moas = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('M'));
      if (moas.length > 0 && result.level !== 'NO-GO') {
        if (result.level === 'GO') result.level = 'CAUTION';
        result.cautions = result.cautions || [];
        result.cautions.push('MOA active \u2014 check with ATC');
        if (result.level === 'CAUTION' && result.issues.length === 0) {
          result.text = result.cautions.join(' \u2022 ');
        }
      }
    }
  }

  // Integrate Protected Areas into assessment
  if (S.protectedAreas) {
    if (S.protectedAreas.dams && S.protectedAreas.dams.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push('Dam nearby \u2014 UAS prohibited within 400ft per 49 USC \u00A7 46307');
      if (result.level === 'CAUTION' && (!result.issues || result.issues.length === 0)) {
        result.text = result.cautions.join(' \u2022 ');
      }
    }
    if (S.protectedAreas.wilderness && S.protectedAreas.wilderness.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push('Wilderness Area \u2014 UAS requires USFS permit');
      if (result.level === 'CAUTION' && (!result.issues || result.issues.length === 0)) {
        result.text = result.cautions.join(' \u2022 ');
      }
    }
    if (S.protectedAreas.nationalParks && S.protectedAreas.nationalParks.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push('National Park \u2014 UAS requires NPS authorization per 36 CFR 1.5');
      if (result.level === 'CAUTION' && (!result.issues || result.issues.length === 0)) {
        result.text = result.cautions.join(' \u2022 ');
      }
    }
  }

  // Append staleness warning if data is older than 30 minutes
  if (typeof _lastDataTimestamp !== 'undefined' && _lastDataTimestamp) {
    const dataAge = Date.now() - _lastDataTimestamp;
    if (dataAge > 30 * 60 * 1000) {
      const ageStr = typeof formatAge === 'function' ? formatAge(dataAge) : Math.round(dataAge / 60000) + 'm';
      result.text = (result.text ? result.text + ' | ' : '') + 'DATA STALE (' + ageStr + ' old) — refresh recommended';
    }
  }

  const badge = document.getElementById('assessBadge');
  badge.textContent = result.level;
  badge.className = 'assessment-badge ' + (result.level === 'GO' ? 'go' : result.level === 'CAUTION' ? 'caution' : 'nogo');
  document.getElementById('assessText').textContent = result.text;

  if (typeof logAudit === 'function') logAudit('assessment_computed', { level: result.level, text: result.text });
}

// ============================================================
// KML EXPORT
// ============================================================
function openExport() {
  if (!S.currentArea) return alert('Draw an operational area first.');
  document.getElementById('exportModal').classList.add('active');
}
function closeExport() { document.getElementById('exportModal').classList.remove('active'); }

function doExport() {
  const c = S.areaCenter;
  const now = new Date().toISOString();
  const ts = now.split('T')[0];
  let folders = '';

  if (document.getElementById('expOpsArea').checked) {
    folders += `<Folder><name>Operational Area</name><Placemark><name>${S.areaType} Search Area</name>
      <styleUrl>#opsArea</styleUrl><description>Center: ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}\nType: ${S.areaType}</description>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${getKMLCoords()}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark></Folder>`;
  }

  const sections = [
    { id: 'expWxData', name: 'Weather', fields: ['wxTemp','wxFeels','wxDew','wxHumidity','wxPressure','wxDensity','wxVis','wxCloud','wxCeiling','wxConditions','wxPrecip','wxLightning','wxUV','wxKp','wxIcing','wxFire','wxAQI'] },
    { id: 'expWindData', name: 'Wind Profile', fields: ['windMax','windGustMax','windDir','windImpact'] },
    { id: 'expAirspace', name: 'Airspace', fields: ['airClass','airLAANC','airLAANCAlt','airNearAirport','airNearDist'] },
    { id: 'expTerrain', name: 'Terrain', fields: ['terrMin','terrMax','terrRange','terrLaunch','terrClass','terrSlope','terrVeg','terrCell'] },
    { id: 'expAstro', name: 'Sun Moon Twilight', fields: ['astSunrise','astSunset','astTwilightAM','astTwilightPM','astSunAz','astSunEl','astMoonPhase','astMoonIllum','astDayWindow','astMagDec'] },
    { id: 'expOps', name: 'Operations', fields: ['opsTempFactor','opsAltFactor','opsWindFactor','opsFlightTime','opsCapacity'] },
  ];

  sections.forEach(s => {
    if (!document.getElementById(s.id)?.checked) return;
    const desc = s.fields.map(f => {
      const el = document.getElementById(f);
      const label = el?.closest('.data-cell')?.querySelector('.data-label')?.textContent || f;
      return `${label}: ${el?.textContent || '--'}`;
    }).join('\n');
    folders += `<Folder><name>${s.name}</name><Placemark><name>${s.name} \u2014 ${ts}</name>
      <Point><coordinates>${c.lng},${c.lat},0</coordinates></Point>
      <description><![CDATA[${desc}]]></description></Placemark></Folder>`;
  });

  const kml = `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <name>SAR Preflight Intel \u2014 ${ts}</name>
    <Style id="opsArea"><LineStyle><color>fffd8b3d</color><width>2</width></LineStyle><PolyStyle><color>20fd8b3d</color></PolyStyle></Style>
    ${folders}</Document></kml>`;

  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `SAR_Preflight_${ts}.kml`; a.click();
  URL.revokeObjectURL(url);
  closeExport();
  if (typeof logAudit === 'function') logAudit('kml_exported');
}

function getKMLCoords() {
  const coords = [];
  if (S.areaType === 'CIRCLE') {
    const c = S.areaCenter, r = S.currentArea.getRadius();
    for (let i = 0; i <= 36; i++) {
      const a = (i*10)*Math.PI/180;
      coords.push(`${(c.lng + (r/(111320*Math.cos(c.lat*Math.PI/180)))*Math.sin(a)).toFixed(6)},${(c.lat + (r/111320)*Math.cos(a)).toFixed(6)},0`);
    }
  } else {
    const ll = S.areaType === 'RECTANGLE'
      ? [S.areaBounds.getNorthWest(), S.areaBounds.getNorthEast(), S.areaBounds.getSouthEast(), S.areaBounds.getSouthWest()]
      : S.currentArea.getLatLngs()[0];
    ll.forEach(p => coords.push(`${p.lng.toFixed(6)},${p.lat.toFixed(6)},0`));
    coords.push(coords[0]);
  }
  return coords.join(' ');
}

// ============================================================
// TAB SCROLLING
// ============================================================
function scrollTabs(dir) {
  const nav = document.getElementById('tabNav');
  nav.scrollBy({ left: dir * 120, behavior: 'smooth' });
}
function updateScrollBtns() {
  const nav = document.getElementById('tabNav');
  document.getElementById('tabScrollLeft').classList.toggle('hidden', nav.scrollLeft < 5);
  document.getElementById('tabScrollRight').classList.toggle('hidden', nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 5);
}

// ============================================================
// UI CONTROLS
// ============================================================
function toggleHeaderMenu() {
  document.getElementById('headerActions')?.classList.toggle('open');
}
function toggleLayerControl() {
  const el = document.getElementById('layerControl');
  if (el) el.classList.toggle('collapsed');
}
function togglePanel() {
  S.panelOpen = !S.panelOpen;
  document.getElementById('sidePanel').classList.toggle('collapsed');
  document.getElementById('btnPanel').classList.toggle('active');
  // Close hamburger menu when toggling panel
  document.getElementById('headerActions')?.classList.remove('open');
  setTimeout(() => S.map.invalidateSize(), 350);
}
function switchTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById(`tab-${tab}`);
  if (panel) panel.style.display = '';
  if (!S.currentArea) document.getElementById('noAreaState').style.display = '';
  else document.getElementById('noAreaState').style.display = 'none';
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (btn) btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

function buildLayerControl() {
  const baseLayers = [
    { id: 'satellite', name: 'Satellite', color: '#3d8bfd' },
    { id: 'topo', name: 'Topographic', color: '#22c55e' },
    { id: 'sectional', name: 'FAA Sectional', color: '#f59e0b' },
  ];
  let html = baseLayers.map(l =>
    `<div class="layer-item${S.map.hasLayer(S.mapLayers[l.id]) ? ' active' : ''}" data-layer="${l.id}" onclick="toggleLayer('${l.id}',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:${l.color}"></div><span>${l.name}</span>
    </div>`
  ).join('');

  // Radar overlay
  if (S.radarAnim && S.radarAnim.layers && S.radarAnim.layers.length > 0) {
    html += `<h4 style="margin-top:10px">Radar</h4>`;
    const radarOn = S.radarAnim.layers.some(l => S.map.hasLayer(l) && l.options.opacity > 0);
    html += `<div class="layer-item${radarOn ? ' active' : ''}" data-layer="radar" onclick="toggleLayer('radar',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#22c55e"></div><span>Weather Radar</span>
    </div>`;
  }

  // Facilities section: airports + cell towers + emergency LZs
  const hasAirports = S.mapLayers.airports && S.mapLayers.airports.getLayers().length > 0;
  const hasTowers = S.mapLayers.cell_towers && S.mapLayers.cell_towers.getLayers().length > 0;
  const hasLZs = S.mapLayers.emergency_lz && S.mapLayers.emergency_lz.getLayers().length > 0;
  if (hasAirports || hasTowers || hasLZs) {
    html += `<h4 style="margin-top:10px">Facilities</h4>`;
    if (hasAirports) {
      const airportCount = S.mapLayers.airports.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.airports);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="airports" onclick="toggleLayer('airports',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#f59e0b"></div><span>Airports (${airportCount})</span>
      </div>`;
    }
    if (hasTowers) {
      const towerCount = S.mapLayers.cell_towers.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.cell_towers);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="cell_towers" onclick="toggleLayer('cell_towers',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#00CCFF"></div><span>Towers (${towerCount})</span>
      </div>`;
    }
    // LZ markers removed — elevation grid too coarse for reliable LZ placement.
    // Terrain tab shows suitability assessment instead.
  }

  // Ops overlays: swap radius, flight plan
  const hasSwap = S.mapLayers.swap_radius && S.mapLayers.swap_radius.getLayers().length > 0;
  const hasPlan = S.mapLayers.flight_plan && S.mapLayers.flight_plan.getLayers().length > 0;
  if (hasSwap || hasPlan) {
    html += `<h4 style="margin-top:10px">Operations</h4>`;
    if (hasSwap) {
      const on = S.map.hasLayer(S.mapLayers.swap_radius);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="swap_radius" onclick="toggleLayer('swap_radius',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#f59e0b"></div><span>Swap Radius</span>
      </div>`;
    }
    if (hasPlan) {
      const on = S.map.hasLayer(S.mapLayers.flight_plan);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="flight_plan" onclick="toggleLayer('flight_plan',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#06b6d4"></div><span>Flight Plan</span>
      </div>`;
    }
  }

  // NWS Alerts section
  if (S.nwsAlerts.length > 0 && S.mapLayers.nws_alerts) {
    html += `<h4 style="margin-top:10px">Alerts</h4>`;
    const on = S.map.hasLayer(S.mapLayers.nws_alerts);
    html += `<div class="layer-item${on ? ' active' : ''}" data-layer="nws_alerts" onclick="toggleLayer('nws_alerts',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>NWS Alerts (${S.nwsAlerts.length})</span>
    </div>`;
  }

  // FAA Airspace section
  const hasFAAclass = S.mapLayers.faa_class_airspace && S.mapLayers.faa_class_airspace.getLayers && S.mapLayers.faa_class_airspace.getLayers().length > 0;
  const hasFAAsua = S.mapLayers.faa_sua && S.mapLayers.faa_sua.getLayers && S.mapLayers.faa_sua.getLayers().length > 0;
  const hasFAAtfr = S.mapLayers.faa_tfr && S.mapLayers.faa_tfr.getLayers && S.mapLayers.faa_tfr.getLayers().length > 0;
  const hasFAAlaanc = S.mapLayers.faa_laanc && S.mapLayers.faa_laanc.getLayers && S.mapLayers.faa_laanc.getLayers().length > 0;
  if (hasFAAclass || hasFAAsua || hasFAAtfr || hasFAAlaanc) {
    html += `<h4 style="margin-top:10px">FAA Airspace</h4>`;
    if (hasFAAclass) {
      const on = S.map.hasLayer(S.mapLayers.faa_class_airspace);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_class_airspace" onclick="toggleLayer('faa_class_airspace',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#3d8bfd"></div><span>Class Airspace</span>
      </div>`;
    }
    if (hasFAAsua) {
      const on = S.map.hasLayer(S.mapLayers.faa_sua);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_sua" onclick="toggleLayer('faa_sua',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#f59e0b"></div><span>Special Use</span>
      </div>`;
    }
    if (hasFAAtfr) {
      const on = S.map.hasLayer(S.mapLayers.faa_tfr);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_tfr" onclick="toggleLayer('faa_tfr',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>TFRs</span>
      </div>`;
    }
    if (hasFAAlaanc) {
      const on = S.map.hasLayer(S.mapLayers.faa_laanc);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_laanc" onclick="toggleLayer('faa_laanc',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#22c55e"></div><span>LAANC Grid</span>
      </div>`;
    }
  }

  // Protected Areas section
  const hasDams = S.mapLayers.dams && S.mapLayers.dams.getLayers && S.mapLayers.dams.getLayers().length > 0;
  const hasWilderness = S.mapLayers.wilderness && S.mapLayers.wilderness.getLayers && S.mapLayers.wilderness.getLayers().length > 0;
  const hasNatlParks = S.mapLayers.national_parks && S.mapLayers.national_parks.getLayers && S.mapLayers.national_parks.getLayers().length > 0;
  if (hasDams || hasWilderness || hasNatlParks) {
    html += `<h4 style="margin-top:10px">Protected Areas</h4>`;
    if (hasDams) {
      const count = S.mapLayers.dams.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.dams);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="dams" onclick="toggleLayer('dams',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>Dams (${count})</span>
      </div>`;
    }
    if (hasWilderness) {
      const count = S.mapLayers.wilderness.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.wilderness);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="wilderness" onclick="toggleLayer('wilderness',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#166534"></div><span>Wilderness Areas (${count})</span>
      </div>`;
    }
    if (hasNatlParks) {
      const count = S.mapLayers.national_parks.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.national_parks);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="national_parks" onclick="toggleLayer('national_parks',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#78350f"></div><span>National Parks (${count})</span>
      </div>`;
    }
  }

  const totalWires = Object.values(S.wireHazardCounts).reduce((a, b) => a + b, 0);
  if (totalWires > 0) {
    html += `<h4 style="margin-top:10px">Wire Hazards</h4>`;
    Object.entries(WIRE_CATEGORIES).forEach(([k, info]) => {
      const count = S.wireHazardCounts[k] || 0;
      if (count === 0) return;
      const lid = 'wire_' + k;
      const on = S.map.hasLayer(S.mapLayers[lid]);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="${lid}" onclick="toggleLayer('${lid}',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:${info.color}"></div><span>${info.label} (${count})</span>
      </div>`;
    });
  }
  // Imported FAA charts section
  const chartIds = Object.keys(S.faaCharts || {});
  if (chartIds.length > 0) {
    html += '<h4 style="margin-top:10px">Imported Charts</h4>';
    for (const cid of chartIds) {
      const c = S.faaCharts[cid];
      const lid = 'chart_' + cid;
      const on = S.map.hasLayer(c.layer);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="${lid}" onclick="toggleLayer('${lid}',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#e879f9"></div><span>${c.chartName}</span>
      </div>`;
    }
  }

  document.getElementById('layerList').innerHTML = html;
}
function toggleLayer(id, el) {
  el.classList.toggle('active');
  const on = el.classList.contains('active');
  const overlayIds = ['satellite', 'topo', 'sectional'];
  if (overlayIds.includes(id)) {
    if (on) {
      S.mapLayers[id].addTo(S.map);
      // Turn off other base overlays (mutually exclusive)
      overlayIds.filter(x => x !== id).forEach(x => {
        if (S.map.hasLayer(S.mapLayers[x])) S.map.removeLayer(S.mapLayers[x]);
        document.querySelector(`[data-layer="${x}"]`)?.classList.remove('active');
      });
    } else {
      S.map.removeLayer(S.mapLayers[id]);
    }
  } else if (id === 'radar') {
    // Toggle radar: show/hide current frame
    if (S.radarAnim && S.radarAnim.layers) {
      const layer = S.radarAnim.layers[S.radarAnim.index];
      if (on) { if (!S.map.hasLayer(layer)) layer.addTo(S.map); layer.setOpacity(0.5); }
      else { if (S.map.hasLayer(layer)) layer.setOpacity(0); }
    }
  } else if ((id === 'airports' || id === 'nws_alerts' || id === 'cell_towers' || id === 'emergency_lz' || id === 'swap_radius' || id === 'flight_plan' || id === 'dams' || id === 'wilderness' || id === 'national_parks' || id.startsWith('wire_') || id.startsWith('faa_') || id.startsWith('chart_')) && S.mapLayers[id]) {
    if (on) S.map.addLayer(S.mapLayers[id]);
    else S.map.removeLayer(S.mapLayers[id]);
  }
}

function saveApiKey(svc) {
  const v = document.getElementById('apiFAA').value.trim();
  if (v) { try { localStorage.setItem('sar_api_'+svc, v); } catch(e){} S.apiKeys[svc] = v; }
}
function saveConfig() {
  const ac = document.getElementById('cfgAircraft').value;
  const maxWind = document.getElementById('cfgMaxWind')?.value;
  const times = { m4t:38, m30t:41, m300:55, m350:55, mavic3t:45, skydio_x10:40, custom:38 };
  if (times[ac]) document.getElementById('cfgFlightTime').value = times[ac];
  if (typeof saveAppState === 'function') saveAppState('cfgAircraft', ac);
  if (S.currentArea) { computeOpsData(); computeAssessment(); }
  if (typeof logAudit === 'function') logAudit('config_changed', { aircraft: ac, maxWind: maxWind });
}

function updateClock() {
  const now = new Date();
  const local = now.toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Los_Angeles' });
  const utc = now.toISOString().substr(11, 8);
  document.getElementById('clockDisplay').textContent = `${local} L / ${utc} Z`;
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', () => {
  if (typeof L === 'undefined') {
    console.error('Leaflet failed to load from CDN.');
    return;
  }
  startApp();
});
function startApp() {
  initMap();
  updateClock();
  setInterval(updateClock, 1000);
  const tabNav = document.getElementById('tabNav');
  tabNav.addEventListener('scroll', updateScrollBtns);
  setTimeout(updateScrollBtns, 100);
  window.addEventListener('resize', updateScrollBtns);

  // PWA: register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      // Listen for SW updates
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'activated' && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });
    }).catch(err => console.warn('SW registration failed:', err));

    // Listen for tile download progress from SW
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'TILE_PROGRESS') {
        const pct = Math.round((event.data.done / event.data.total) * 100);
        const bar = document.getElementById('tileProgressBar');
        const text = document.getElementById('tileProgressText');
        if (bar) bar.style.width = `${pct}%`;
        if (text) text.textContent = `Downloading tile ${event.data.done} of ${event.data.total} (${pct}%)`;
      }
      if (event.data?.type === 'TILE_DOWNLOAD_COMPLETE') {
        const text = document.getElementById('tileProgressText');
        if (text) text.textContent = `Download complete: ${event.data.total} tiles cached`;
        document.getElementById('btnDownloadTiles')?.removeAttribute('disabled');
        updateCacheStatus();
      }
      if (event.data?.type === 'TILE_CACHE_CLEARED') {
        updateCacheStatus();
      }
      if (event.data?.type === 'CACHE_SIZE') {
        const el = document.getElementById('cacheStatus');
        if (el && event.data.size) {
          const mb = (event.data.size.usage / 1048576).toFixed(1);
          el.textContent = `Using ${mb} MB`;
        }
      }
    });
  }

  // Connectivity monitoring
  if (typeof initConnectivity === 'function') initConnectivity();

  // Update cache status display
  updateCacheStatus();

  // Restore last config from IndexedDB
  restoreConfig();
  restoreFAACharts();

  // Populate training scenarios dropdown
  populateTrainingScenarios();

  // Update notification status display
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const el = document.getElementById('notifyStatus');
    if (el) el.textContent = 'Enabled';
  }
}

function showUpdateBanner() {
  const banner = document.getElementById('assessmentBanner');
  if (!banner) return;
  const div = document.createElement('div');
  div.style.cssText = 'padding:8px 16px;background:var(--bg-tertiary);border-bottom:1px solid var(--accent-cyan);font-family:var(--font-mono);font-size:11px;color:var(--accent-cyan);display:flex;align-items:center;gap:8px;';
  div.innerHTML = 'Update available <button class="btn btn-primary" style="padding:3px 10px;font-size:10px;" onclick="location.reload()">Reload</button>';
  banner.parentElement.insertBefore(div, banner);
}

function downloadTilesForView() {
  if (!navigator.serviceWorker?.controller) {
    const el = document.getElementById('tileProgressText');
    if (el) el.textContent = 'Service worker not active. Reload the page first.';
    return;
  }
  const bounds = S.map.getBounds();
  const zooms = (document.getElementById('cfgTileZooms')?.value || '10,11,12,13,14').split(',').map(Number);
  document.getElementById('btnDownloadTiles')?.setAttribute('disabled', 'true');
  document.getElementById('tileProgressText').textContent = 'Starting download...';
  navigator.serviceWorker.controller.postMessage({
    type: 'DOWNLOAD_TILES',
    bounds: {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    },
    zooms,
    providers: getSelectedTileProviders(),
  });
}

function getSelectedTileProviders() {
  const providers = ['carto']; // always include base map
  if (document.getElementById('cfgTileSat')?.checked) providers.push('satellite');
  if (document.getElementById('cfgTileTopo')?.checked) providers.push('topo');
  if (document.getElementById('cfgTileSectional')?.checked) providers.push('sectional');
  return providers;
}

function clearAllCaches() {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_TILE_CACHE' });
  }
  if (typeof clearApiCache === 'function') clearApiCache();
  const el = document.getElementById('cacheStatus');
  if (el) el.textContent = 'Caches cleared';
}

function updateCacheStatus() {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'GET_CACHE_SIZE' });
  }
}

function enableNotifications() {
  if (typeof requestNotificationPermission === 'function') {
    requestNotificationPermission().then(perm => {
      const el = document.getElementById('notifyStatus');
      if (el) el.textContent = perm === 'granted' ? 'Enabled' : 'Denied';
    });
  }
}

async function restoreConfig() {
  if (typeof getAppState !== 'function') return;
  const aircraft = await getAppState('cfgAircraft');
  if (aircraft) {
    const el = document.getElementById('cfgAircraft');
    if (el) { el.value = aircraft; saveConfig(); }
  }
  const rpic = await getAppState('cfgRPIC');
  if (rpic) {
    const el = document.getElementById('cfgRPIC');
    if (el) el.value = rpic;
  }
  const refreshInterval = await getAppState('refreshInterval');
  if (refreshInterval !== null && refreshInterval !== undefined) {
    const el = document.getElementById('cfgRefreshInterval');
    if (el) { el.value = refreshInterval; setAutoRefresh(); }
  }
  // Restore active SOP profile
  const profileName = await getAppState('activeProfile');
  if (profileName) loadSopProfile(profileName);
  // Populate SOP dropdown
  populateSopDropdown();
}

// ============================================================
// KML/KMZ IMPORT
// ============================================================
function importKML() {
  if (typeof logAudit === 'function') logAudit('kml_imported');
  const input = document.getElementById('kmlFileInput');
  if (input) { input.value = ''; input.click(); }
}

function handleKMLFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith('.kmz')) {
    // Try reading as text; KMZ is typically a ZIP binary
    const reader = new FileReader();
    reader.onload = function() {
      try {
        // If it parsed as valid XML text, treat it as KML
        const text = reader.result;
        if (text.indexOf('<kml') !== -1 || text.indexOf('<Placemark') !== -1) {
          parseKML(text);
        } else {
          alert('KMZ files (binary ZIP) are not supported. Please extract the .kml file from the KMZ archive and import that instead.');
        }
      } catch (e) {
        alert('KMZ files (binary ZIP) are not supported. Please extract the .kml file from the KMZ archive and import that instead.');
      }
    };
    reader.onerror = function() {
      alert('KMZ files (binary ZIP) are not supported. Please extract the .kml file from the KMZ archive and import that instead.');
    };
    reader.readAsText(file);
  } else {
    const reader = new FileReader();
    reader.onload = function() { parseKML(reader.result); };
    reader.readAsText(file);
  }
}

function parseKML(kmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(kmlText, 'text/xml');
  const KML_NS = 'http://www.opengis.net/kml/2.2';

  // Helper: find elements with namespace fallback
  function findElements(parent, tagName) {
    let els = parent.getElementsByTagNameNS(KML_NS, tagName);
    if (els.length === 0) els = parent.getElementsByTagName(tagName);
    return els;
  }

  // Extract coordinates text from a <coordinates> element
  function getCoordinatesText(parent) {
    const coords = findElements(parent, 'coordinates');
    return coords.length > 0 ? coords[0].textContent.trim() : '';
  }

  // Parse KML coordinate string: "lng,lat,alt lng,lat,alt ..."
  function parseCoordString(str) {
    return str.split(/\s+/).filter(Boolean).map(c => {
      const parts = c.split(',');
      return [parseFloat(parts[1]), parseFloat(parts[0])]; // [lat, lng]
    }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
  }

  let coords = [];
  let shapeType = 'polygon';

  // Try Polygon first
  const polygons = findElements(doc, 'Polygon');
  if (polygons.length > 0) {
    const outerBoundary = findElements(polygons[0], 'outerBoundaryIs');
    const parent = outerBoundary.length > 0 ? outerBoundary[0] : polygons[0];
    const coordText = getCoordinatesText(parent);
    coords = parseCoordString(coordText);
    shapeType = 'polygon';
  }

  // Try LineString if no polygon found
  if (coords.length === 0) {
    const lines = findElements(doc, 'LineString');
    if (lines.length > 0) {
      const coordText = getCoordinatesText(lines[0]);
      coords = parseCoordString(coordText);
      shapeType = 'polygon'; // treat linestring as polygon boundary
    }
  }

  // Try Point if nothing else
  if (coords.length === 0) {
    const points = findElements(doc, 'Point');
    if (points.length > 0) {
      const coordText = getCoordinatesText(points[0]);
      const parsed = parseCoordString(coordText);
      if (parsed.length > 0) {
        coords = parsed;
        shapeType = 'point';
      }
    }
  }

  if (coords.length === 0) {
    alert('No valid geometry found in KML file.');
    return;
  }

  // Clear existing drawn items
  S.drawnItems.clearLayers();

  let layer;
  if (shapeType === 'point') {
    // Create a circle with 2km radius around the point
    layer = L.circle(coords[0], {
      radius: 2000,
      color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4'
    });
    S.drawnItems.addLayer(layer);
    S.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
    processArea(layer, 'circle');
  } else {
    // Remove duplicate closing point if present
    if (coords.length > 2) {
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) coords.pop();
    }
    layer = L.polygon(coords, {
      color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4'
    });
    S.drawnItems.addLayer(layer);
    S.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
    processArea(layer, 'polygon');
  }
}

// ============================================================
// COPY BRIEFING TO CLIPBOARD
// ============================================================
function buildBriefingText() {
  const sections = [
    { name: 'WEATHER', fields: ['wxTemp','wxFeels','wxDew','wxHumidity','wxPressure','wxDensity','wxVis','wxCloud','wxCeiling','wxConditions','wxPrecip','wxLightning','wxUV','wxKp','wxIcing','wxFire','wxAQI'] },
    { name: 'WIND', fields: ['windMax','windGustMax','windDir','windImpact'] },
    { name: 'AIRSPACE', fields: ['airClass','airLAANC','airLAANCAlt','airNearAirport','airNearDist'] },
    { name: 'TERRAIN', fields: ['terrMin','terrMax','terrRange','terrLaunch','terrClass','terrSlope','terrPower','terrTowers','terrVeg','terrCell'] },
    { name: 'SUN/MOON', fields: ['astSunrise','astSunset','astTwilightAM','astTwilightPM','astSunAz','astSunEl','astMoonPhase','astMoonIllum','astDayWindow','astMagDec'] },
    { name: 'GNSS', fields: ['satKp','satAccuracy','satAssessment'] },
    { name: 'OPS', fields: ['opsTempFactor','opsAltFactor','opsWindFactor','opsFlightTime','opsCapacity'] },
  ];

  const lines = [];
  lines.push('=== SAR UAS PRE-FLIGHT BRIEFING ===');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Area info
  const center = document.getElementById('areaCenter')?.textContent || '--';
  const size = document.getElementById('areaSize')?.textContent || '--';
  const type = document.getElementById('areaType')?.textContent || '--';
  lines.push(`AREA: Center ${center} | Size ${size} | Type ${type}`);
  lines.push('');

  // Assessment
  const badge = document.getElementById('assessBadge')?.textContent || '--';
  const assessText = document.getElementById('assessText')?.textContent || '';
  lines.push(`ASSESSMENT: ${badge}`);
  if (assessText) lines.push(assessText);
  lines.push('');

  // Data sections
  sections.forEach(s => {
    lines.push(`--- ${s.name} ---`);
    s.fields.forEach(f => {
      const el = document.getElementById(f);
      if (!el) return;
      const label = el.closest('.data-cell')?.querySelector('.data-label')?.textContent || f;
      const value = el.textContent || '--';
      lines.push(`  ${label}: ${value}`);
    });
    lines.push('');
  });

  return lines.join('\n');
}

function copyBriefing() {
  if (!S.currentArea) return;
  if (typeof logAudit === 'function') logAudit('briefing_copied');
  const text = buildBriefingText();
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btnCopy');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'COPIED';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  }).catch(() => {
    // Fallback: select a hidden textarea
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch(e) { /* ignore */ }
    document.body.removeChild(ta);
  });
}

// ============================================================
// PDF BRIEFING REPORT
// ============================================================
function generatePDFBriefing() {
  if (!S.currentArea) return alert('Draw an operational area first.');
  if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
    return alert('jsPDF library not loaded. Check your internet connection.');
  }

  if (typeof logAudit === 'function') logAudit('pdf_exported');

  const btn = document.getElementById('btnPDF');
  if (btn) btn.textContent = 'GENERATING...';

  const rpic = document.getElementById('cfgRPIC')?.value || 'Not specified';
  const aircraft = document.getElementById('cfgAircraft')?.value?.toUpperCase() || '--';
  const assessBadge = document.getElementById('assessBadge')?.textContent || '--';
  const assessText = document.getElementById('assessText')?.textContent || '';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeLocal = now.toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Los_Angeles' });
  const timeUTC = now.toISOString().substr(11, 8);

  const briefingText = buildBriefingText();
  const sections = briefingText.split('\n\n');
  const badgeColor = assessBadge === 'GO' ? '#22c55e' : assessBadge === 'CAUTION' ? '#f59e0b' : '#ef4444';

  // Capture the map by compositing layers separately:
  // 1. html2canvas for tiles only (works correctly for <img> tiles)
  // 2. Native SVG→Image→Canvas for vector overlays (avoids html2canvas SVG transform bugs)
  // 3. Marker icons drawn from their screen positions
  const mapEl = document.getElementById('map');
  setTimeout(() => {
    _compositeMapCapture(mapEl).then(mapDataUrl => {
      S._lastMapImage = mapDataUrl;
      _buildAndExportPDF(mapDataUrl, briefingText, sections, badgeColor, rpic, aircraft, assessBadge, assessText, dateStr, timeLocal, timeUTC, btn, now);
    }).catch(err => {
      console.warn('Map capture failed, generating PDF without map:', err);
      _buildAndExportPDF(null, briefingText, sections, badgeColor, rpic, aircraft, assessBadge, assessText, dateStr, timeLocal, timeUTC, btn, now);
    });
  }, 300);
}

// Composite map capture: renders tiles via html2canvas, SVG overlays natively,
// and markers via screen position — avoids html2canvas SVG transform bugs entirely.
async function _compositeMapCapture(mapEl) {
  const mapRect = mapEl.getBoundingClientRect();
  const w = Math.round(mapRect.width);
  const h = Math.round(mapRect.height);
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Layer 1: Tiles via html2canvas (only the tile pane — html2canvas handles tiles correctly)
  try {
    const tileCanvas = await html2canvas(mapEl, {
      scale: scale,
      useCORS: true,
      allowTaint: true,
      logging: false,
      ignoreElements: (el) => {
        // Capture ONLY tiles — ignore overlays, markers, and UI controls
        return el.classList?.contains('leaflet-overlay-pane') ||
               el.classList?.contains('leaflet-marker-pane') ||
               el.classList?.contains('leaflet-tooltip-pane') ||
               el.classList?.contains('leaflet-popup-pane') ||
               el.classList?.contains('draw-toolbar') ||
               el.classList?.contains('map-info') ||
               el.classList?.contains('no-area-overlay') ||
               el.classList?.contains('layer-control') ||
               el.classList?.contains('radar-controls') ||
               el.classList?.contains('leaflet-control-zoom');
      },
    });
    ctx.drawImage(tileCanvas, 0, 0, w, h);
  } catch(e) {
    console.warn('Tile capture failed:', e);
    // Fill with dark background as fallback
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, w, h);
  }

  // Layer 2: SVG overlays rendered natively (power lines, circles, swap radius)
  const svgs = mapEl.querySelectorAll('.leaflet-overlay-pane svg');
  for (const svg of svgs) {
    try {
      const svgRect = svg.getBoundingClientRect();
      const clone = svg.cloneNode(true);
      clone.style.transform = 'none';
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const svgStr = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const x = svgRect.left - mapRect.left;
      const y = svgRect.top - mapRect.top;
      ctx.drawImage(img, x, y, svgRect.width, svgRect.height);
      URL.revokeObjectURL(url);
    } catch(e) {
      console.warn('SVG overlay capture failed:', e);
    }
  }

  // Layer 3: Marker icons (airports, cell towers, heliports)
  const markerPane = mapEl.querySelector('.leaflet-marker-pane');
  if (markerPane) {
    const markers = markerPane.querySelectorAll('.leaflet-marker-icon');
    for (const marker of markers) {
      const mRect = marker.getBoundingClientRect();
      const x = mRect.left - mapRect.left;
      const y = mRect.top - mapRect.top;
      const innerSvg = marker.querySelector('svg');
      if (innerSvg) {
        try {
          const clone = innerSvg.cloneNode(true);
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          const svgStr = new XMLSerializer().serializeToString(clone);
          const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = url;
          });
          ctx.drawImage(img, x, y, mRect.width, mRect.height);
          URL.revokeObjectURL(url);
        } catch(e) {}
      }
    }
  }

  return canvas.toDataURL('image/jpeg', 0.90);
}

function _buildAndExportPDF(mapDataUrl, briefingText, sections, badgeColor, rpic, aircraft, assessBadge, assessText, dateStr, timeLocal, timeUTC, btn, now) {
  const mapHtml = mapDataUrl
    ? `<div style="margin-bottom:12px;border:1px solid #ccc;"><img src="${mapDataUrl}" style="width:100%;display:block;" /></div>`
    : '';

  // Build an off-screen styled HTML div for rendering
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0;width:750px;padding:30px 40px;background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;';

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:15px;">
      <div>
        <h1 style="margin:0;font-size:20px;letter-spacing:2px;">SAR UAS PRE-FLIGHT BRIEFING</h1>
        <div style="font-size:11px;color:#555;margin-top:4px;">EDSAR UAS Team</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:18px;font-weight:bold;padding:4px 14px;border-radius:4px;background:${badgeColor};color:#fff;display:inline-block;">${assessBadge}</div>
      </div>
    </div>
    <table style="width:100%;font-size:11px;margin-bottom:12px;border-collapse:collapse;">
      <tr>
        <td style="padding:3px 0;"><b>Date:</b> ${dateStr}</td>
        <td style="padding:3px 0;"><b>Local:</b> ${timeLocal} PDT</td>
        <td style="padding:3px 0;"><b>UTC:</b> ${timeUTC}Z</td>
      </tr>
      <tr>
        <td style="padding:3px 0;"><b>RPIC:</b> ${rpic}</td>
        <td style="padding:3px 0;"><b>Aircraft:</b> ${aircraft}</td>
        <td style="padding:3px 0;"><b>Area:</b> ${document.getElementById('areaCenter')?.textContent || '--'}</td>
      </tr>
    </table>
    <div style="margin-bottom:12px;padding:8px;background:#f0f0f0;border-left:4px solid ${badgeColor};font-size:12px;">
      <b>Assessment: ${assessBadge}</b> \u2014 ${assessText}
    </div>
    ${mapHtml}
    ${sections.map(s => {
      const lines = s.split('\n');
      const title = lines[0];
      const body = lines.slice(1).join('<br>');
      return `<div style="margin-bottom:10px;"><div style="font-size:13px;font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;margin-bottom:4px;">${title}</div><div style="font-size:11px;color:#333;">${body}</div></div>`;
    }).join('')}
    <div style="margin-top:20px;border-top:2px solid #111;padding-top:10px;">
      <div style="font-size:11px;color:#555;margin-bottom:15px;">I have reviewed this pre-flight briefing and accept responsibility for the safe conduct of this UAS operation.</div>
      <table style="width:100%;font-size:11px;">
        <tr>
          <td style="width:50%;padding-top:30px;border-top:1px solid #333;">RPIC Signature</td>
          <td style="width:50%;padding-top:30px;border-top:1px solid #333;">Date / Time</td>
        </tr>
      </table>
    </div>
  `;

  document.body.appendChild(container);

  html2canvas(container, { scale: 2, useCORS: true }).then(canvas => {
    document.body.removeChild(container);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'letter');
    const pageWidth = 215.9; // letter width mm
    const pageHeight = 279.4; // letter height mm
    const margin = 10;
    const imgWidth = pageWidth - margin * 2;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    let yOffset = margin;
    let remainingHeight = imgHeight;
    const usableHeight = pageHeight - margin * 2;

    // First page
    pdf.addImage(imgData, 'JPEG', margin, yOffset, imgWidth, imgHeight);

    // Add more pages if content overflows
    remainingHeight -= usableHeight;
    while (remainingHeight > 0) {
      pdf.addPage();
      yOffset -= usableHeight;
      pdf.addImage(imgData, 'JPEG', margin, yOffset, imgWidth, imgHeight);
      remainingHeight -= usableHeight;
    }

    const ts = now.toISOString().split('T')[0];
    pdf.save(`SAR_Briefing_${ts}.pdf`);
    if (btn) btn.textContent = 'PDF';
  }).catch(err => {
    document.body.removeChild(container);
    console.error('PDF generation error:', err);
    if (btn) btn.textContent = 'PDF';
    alert('PDF generation failed: ' + err.message);
  });
}

// ============================================================
// EMAIL SHARE
// ============================================================
function shareBriefingEmail() {
  if (!S.currentArea) return alert('Draw an operational area first.');
  if (typeof logAudit === 'function') logAudit('email_shared');

  // Use cached map image from PDF, or capture fresh via composite method
  if (S._lastMapImage) {
    _openEmailBriefingWindow(S._lastMapImage);
  } else {
    const mapEl = document.getElementById('map');
    if (mapEl) {
      _compositeMapCapture(mapEl).then(dataUrl => {
        S._lastMapImage = dataUrl;
        _openEmailBriefingWindow(dataUrl);
      }).catch(() => _openEmailBriefingWindow(null));
    } else {
      _openEmailBriefingWindow(null);
    }
  }
}

function _openEmailBriefingWindow(mapDataUrl) {
  const assessBadge = document.getElementById('assessBadge')?.textContent || '--';
  const assessText = document.getElementById('assessText')?.textContent || '';
  const badgeColor = assessBadge === 'GO' ? '#22c55e' : assessBadge === 'CAUTION' ? '#f59e0b' : '#ef4444';
  const rpic = document.getElementById('cfgRPIC')?.value || 'Not specified';
  const aircraft = document.getElementById('cfgAircraft')?.value?.toUpperCase() || '--';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Los_Angeles' });
  const briefingText = buildBriefingText();
  const sections = briefingText.split('\n\n');
  const mapHtml = mapDataUrl ? `<img src="${mapDataUrl}" style="width:100%;max-width:700px;border:1px solid #ccc;margin:10px 0;" />` : '';

  const html = `<!DOCTYPE html><html><head><title>SAR Briefing - ${dateStr}</title>
    <style>body{font-family:Arial,sans-serif;max-width:750px;margin:20px auto;padding:0 20px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;letter-spacing:2px;margin:0}
    .badge{display:inline-block;padding:4px 14px;border-radius:4px;color:#fff;font-weight:bold;font-size:16px}
    .section{margin-bottom:12px}.section-title{font-size:14px;font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;margin-bottom:4px}
    .sig-line{border-top:1px solid #333;padding-top:25px;width:45%;display:inline-block;margin-right:5%}
    @media print{body{margin:0;font-size:11px}}</style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:15px;">
      <div><h1>SAR UAS PRE-FLIGHT BRIEFING</h1><div style="font-size:11px;color:#555;">EDSAR UAS Team</div></div>
      <div><span class="badge" style="background:${badgeColor}">${assessBadge}</span></div>
    </div>
    <table style="width:100%;font-size:12px;margin-bottom:10px;"><tr>
      <td><b>Date:</b> ${dateStr}</td><td><b>Local:</b> ${timeStr}</td><td><b>RPIC:</b> ${rpic}</td><td><b>Aircraft:</b> ${aircraft}</td>
    </tr></table>
    <div style="padding:8px;background:#f0f0f0;border-left:4px solid ${badgeColor};margin-bottom:12px;">
      <b>Assessment: ${assessBadge}</b> \u2014 ${assessText}
    </div>
    ${mapHtml}
    ${sections.map(s => { const lines = s.split('\n'); return `<div class="section"><div class="section-title">${lines[0]}</div><div>${lines.slice(1).join('<br>')}</div></div>`; }).join('')}
    <div style="margin-top:20px;border-top:2px solid #111;padding-top:10px;">
      <div style="font-size:11px;color:#555;margin-bottom:15px;">I have reviewed this pre-flight briefing and accept responsibility for the safe conduct of this UAS operation.</div>
      <span class="sig-line">RPIC Signature</span><span class="sig-line">Date / Time</span>
    </div>
    <div style="margin-top:20px;text-align:center;font-size:11px;color:#888;">
      <button onclick="window.print()" style="padding:8px 20px;font-size:13px;cursor:pointer;">Print / Save as PDF</button>
      &nbsp;&nbsp;
      <button onclick="navigator.clipboard.writeText(document.body.innerText).then(()=>alert('Copied!'))" style="padding:8px 20px;font-size:13px;cursor:pointer;">Copy Text</button>
    </div></body></html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  } else {
    alert('Pop-up blocked. Allow pop-ups and try again.');
  }
}

// ============================================================
// SARTOPO DEEP LINK
// ============================================================
function openInSARTopo() {
  if (!S.areaCenter) return alert('Draw an operational area first.');
  const lat = S.areaCenter.lat.toFixed(5);
  const lng = S.areaCenter.lng.toFixed(5);
  const zoom = S.map.getZoom();
  window.open(`https://sartopo.com/map.html#ll=${lat},${lng}&z=${zoom}`, '_blank');
}

// ============================================================
// FAA CHART IMPORT
// ============================================================
async function loadFAAChart(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const bar = document.getElementById('chartProgressBar');
  const text = document.getElementById('chartProgressText');

  if (typeof processVFRChart !== 'function') {
    if (text) text.textContent = 'Chart processing libraries not loaded. Check internet connection.';
    return;
  }

  try {
    const collarMargin = parseFloat(document.getElementById('chartCollarMargin')?.value || '3') / 100;
    const result = await processVFRChart(file, (msg, pct) => {
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = msg;
    }, { collarMargin });

    const chartId = result.chartId;

    // If re-importing same chart, remove old version first
    if (S.faaCharts[chartId]) {
      await removeChart(chartId);
    }

    // Create chart-specific tile layer
    const layer = new L.TileLayer.FAAChart({
      chartId: chartId,
      minNativeZoom: result.zoomRange[0],
      maxNativeZoom: result.zoomRange[1],
      minZoom: 4,
      maxZoom: 18,
      opacity: 0.85,
      attribution: 'FAA ' + result.chartName,
    });
    layer.addTo(S.map);

    // Register in multi-chart state
    S.faaCharts[chartId] = {
      chartId, chartName: result.chartName, layer,
      bounds: result.bounds, zoomRange: result.zoomRange,
    };
    S.mapLayers['chart_' + chartId] = layer;

    buildLayerControl();
    updateChartList();
    if (text) text.textContent = `${result.chartName}: ${result.tileCount} tiles cached (z=${result.zoomRange[0]}-${result.zoomRange[1]})`;
    if (typeof logAudit === 'function') logAudit('chart_imported', { name: result.chartName, tiles: result.tileCount });
    _saveFaaChartsState();
  } catch (err) {
    console.error('FAA chart import error:', err);
    if (text) text.textContent = 'Error: ' + err.message;
    if (bar) bar.style.width = '0';
  }
}

// Custom Leaflet TileLayer that reads tiles from the Cache API
if (typeof L !== 'undefined' && L.TileLayer && typeof L.TileLayer.extend === 'function') {
  L.TileLayer.FAAChart = L.TileLayer.extend({
    initialize: function(options) {
      L.TileLayer.prototype.initialize.call(this, '', options || {});
    },
    getTileUrl: function(coords) {
      const ns = this.options.chartId || 'default';
      return `https://local-tiles.sar-preflight/faa-sectional-${ns}/${coords.z}/${coords.x}/${coords.y}.png`;
    },
    createTile: function(coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      const url = this.getTileUrl(coords);

      caches.open('sar-tiles-v1').then(cache => {
        return cache.match(url);
      }).then(response => {
        if (response) {
          return response.blob();
        }
        return null;
      }).then(blob => {
        if (blob) {
          tile.src = URL.createObjectURL(blob);
          done(null, tile);
        } else {
          // No cached tile — return transparent
          tile.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
          done(null, tile);
        }
      }).catch(() => {
        done(new Error('Tile not found'), tile);
      });

      return tile;
    },
  });
}

// Persist multi-chart metadata to IndexedDB
function _saveFaaChartsState() {
  if (typeof saveAppState !== 'function') return;
  const data = Object.keys(S.faaCharts).map(id => ({
    chartId: id,
    chartName: S.faaCharts[id].chartName,
    bounds: S.faaCharts[id].bounds,
    zoomRange: S.faaCharts[id].zoomRange,
  }));
  saveAppState('faaCharts', data);
}

// Restore all FAA chart layers on startup
async function restoreFAACharts() {
  if (typeof getAppState !== 'function') return;
  if (!('caches' in window)) return;
  if (typeof L === 'undefined' || !L.TileLayer.FAAChart) return;

  // Load chart list (with backward-compat migration from single-chart format)
  let charts = await getAppState('faaCharts');
  if (!charts) {
    const old = await getAppState('faaChart');
    if (old) {
      const chartId = typeof sanitizeChartName === 'function' ? sanitizeChartName(old.name) : old.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().substring(0, 40);
      charts = [{ chartId, chartName: old.name, bounds: old.bounds, zoomRange: old.zoomRange }];
      saveAppState('faaCharts', charts);
    }
  }
  if (!charts || !charts.length) return;

  const cache = await caches.open('sar-tiles-v1');
  const keys = await cache.keys();

  for (const info of charts) {
    const prefix = 'local-tiles.sar-preflight/faa-sectional-' + info.chartId;
    const hasTiles = keys.some(r => r.url.includes(prefix));
    if (!hasTiles) continue;

    const layer = new L.TileLayer.FAAChart({
      chartId: info.chartId,
      minNativeZoom: info.zoomRange[0],
      maxNativeZoom: info.zoomRange[1],
      minZoom: 4,
      maxZoom: 18,
      opacity: 0.85,
      attribution: 'FAA ' + info.chartName,
    });
    S.faaCharts[info.chartId] = {
      chartId: info.chartId, chartName: info.chartName,
      layer, bounds: info.bounds, zoomRange: info.zoomRange,
    };
    S.mapLayers['chart_' + info.chartId] = layer;
  }

  updateChartList();
}

// Remove a single imported chart and its cached tiles
async function removeChart(chartId) {
  const entry = S.faaCharts[chartId];
  if (!entry) return;

  if (S.map && S.map.hasLayer(entry.layer)) S.map.removeLayer(entry.layer);
  delete S.faaCharts[chartId];
  delete S.mapLayers['chart_' + chartId];

  // Delete tiles from cache
  if ('caches' in window) {
    const cache = await caches.open('sar-tiles-v1');
    const keys = await cache.keys();
    const prefix = 'local-tiles.sar-preflight/faa-sectional-' + chartId;
    for (const req of keys) {
      if (req.url.includes(prefix)) await cache.delete(req);
    }
  }

  _saveFaaChartsState();
  updateChartList();
  buildLayerControl();
}

// Remove all imported charts
async function clearAllCharts() {
  const ids = Object.keys(S.faaCharts);
  for (const id of ids) {
    await removeChart(id);
  }
  const text = document.getElementById('chartProgressText');
  if (text) text.textContent = '';
}

// Render loaded chart list in the settings UI
function updateChartList() {
  const el = document.getElementById('chartList');
  if (!el) return;
  const ids = Object.keys(S.faaCharts);
  const btn = document.getElementById('btnClearCharts');
  if (ids.length === 0) {
    el.innerHTML = '';
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) btn.style.display = '';
  el.innerHTML = ids.map(id => {
    const c = S.faaCharts[id];
    return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text-secondary);padding:2px 0;">' +
      '<span>' + c.chartName + '</span>' +
      '<button class="btn btn-ghost" onclick="removeChart(\'' + id + '\')" style="padding:2px 6px;font-size:9px;">Remove</button>' +
      '</div>';
  }).join('');
}

// ============================================================
// AUTO-REFRESH
// ============================================================
function setAutoRefresh() {
  const el = document.getElementById('cfgRefreshInterval');
  const val = parseInt(el?.value) || 0;

  // Clear existing interval and countdown
  if (S.autoRefreshInterval) { clearInterval(S.autoRefreshInterval); S.autoRefreshInterval = null; }
  if (S._refreshCountdownInterval) { clearInterval(S._refreshCountdownInterval); S._refreshCountdownInterval = null; }
  S._nextRefreshTime = null;

  const countdownEl = document.getElementById('refreshCountdown');

  if (val > 0) {
    const ms = val * 60 * 1000;
    S._nextRefreshTime = Date.now() + ms;

    S.autoRefreshInterval = setInterval(() => {
      if (S.areaCenter) refreshData();
      S._nextRefreshTime = Date.now() + ms;
    }, ms);

    // Update countdown display every second
    S._refreshCountdownInterval = setInterval(() => {
      if (!S._nextRefreshTime) return;
      const remaining = Math.max(0, S._nextRefreshTime - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      if (countdownEl) {
        countdownEl.style.display = '';
        countdownEl.textContent = `NEXT: ${mins}m${secs < 10 ? '0' : ''}${secs}s`;
      }
    }, 1000);
  } else {
    if (countdownEl) { countdownEl.style.display = 'none'; countdownEl.textContent = ''; }
  }

  // Persist setting
  if (typeof saveAppState === 'function') saveAppState('refreshInterval', String(val));
}

// ============================================================
// SOP RISK PROFILES
// ============================================================
async function loadSopProfile(name) {
  if (!name) {
    S.activeProfile = null;
    updateSopThresholdFields();
    if (typeof saveAppState === 'function') saveAppState('activeProfile', '');
    if (S.currentArea) computeAssessment();
    if (typeof logAudit === 'function') logAudit('sop_profile_changed', { name: 'Default' });
    return;
  }
  if (typeof getSopProfile === 'function') {
    const profile = await getSopProfile(name);
    if (profile) {
      S.activeProfile = profile;
      updateSopThresholdFields();
      if (typeof saveAppState === 'function') saveAppState('activeProfile', name);
      if (S.currentArea) computeAssessment();
      if (typeof logAudit === 'function') logAudit('sop_profile_changed', { name: name });
    }
  }
}

async function saveSopProfileFromUI() {
  const name = document.getElementById('sopProfileName')?.value?.trim();
  if (!name) return alert('Enter a profile name.');
  const profile = {
    name: name,
    visNoGo: parseFloat(document.getElementById('sopVisNoGo')?.value) || 1,
    visCaution: parseFloat(document.getElementById('sopVisCaution')?.value) || 5,
    precipNoGo: parseFloat(document.getElementById('sopPrecipNoGo')?.value) || 60,
    precipCaution: parseFloat(document.getElementById('sopPrecipCaution')?.value) || 30,
    windCaution: parseFloat(document.getElementById('sopWindCaution')?.value) || 15,
    tempCaution: parseFloat(document.getElementById('sopTempCaution')?.value) || 35,
    elevCaution: parseFloat(document.getElementById('sopElevCaution')?.value) || 6000,
    wxCodeNoGo: parseFloat(document.getElementById('sopWxCodeNoGo')?.value) || 95,
  };
  if (typeof saveSopProfile === 'function') {
    await saveSopProfile(profile);
    await populateSopDropdown();
    const dd = document.getElementById('cfgSopProfile');
    if (dd) dd.value = name;
    S.activeProfile = profile;
    if (typeof saveAppState === 'function') saveAppState('activeProfile', name);
    if (S.currentArea) computeAssessment();
  }
}

async function deleteSopProfileFromUI() {
  const dd = document.getElementById('cfgSopProfile');
  const name = dd?.value;
  if (!name) return;
  if (!confirm(`Delete profile "${name}"?`)) return;
  if (typeof deleteSopProfile === 'function') {
    await deleteSopProfile(name);
    S.activeProfile = null;
    if (typeof saveAppState === 'function') saveAppState('activeProfile', '');
    await populateSopDropdown();
    updateSopThresholdFields();
    if (S.currentArea) computeAssessment();
  }
}

async function populateSopDropdown() {
  const dd = document.getElementById('cfgSopProfile');
  if (!dd) return;
  // Keep only the default option
  dd.innerHTML = '<option value="">Default</option>';
  if (typeof getAllSopProfiles === 'function') {
    const profiles = await getAllSopProfiles();
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      dd.appendChild(opt);
    });
  }
}

function updateSopThresholdFields() {
  const defaults = (typeof DEFAULT_THRESHOLDS !== 'undefined') ? DEFAULT_THRESHOLDS : {
    visNoGo: 1, visCaution: 5, precipNoGo: 60, precipCaution: 30,
    windCaution: 15, tempCaution: 35, elevCaution: 6000, wxCodeNoGo: 95,
  };
  const src = S.activeProfile || defaults;
  const setVal = (id, key) => { const el = document.getElementById(id); if (el && src[key] !== undefined) el.value = src[key]; };
  setVal('sopVisNoGo', 'visNoGo');
  setVal('sopVisCaution', 'visCaution');
  setVal('sopPrecipNoGo', 'precipNoGo');
  setVal('sopPrecipCaution', 'precipCaution');
  setVal('sopWindCaution', 'windCaution');
  setVal('sopTempCaution', 'tempCaution');
  setVal('sopElevCaution', 'elevCaution');
  setVal('sopWxCodeNoGo', 'wxCodeNoGo');
}

// ============================================================
// MISSION LOGGING
// ============================================================
async function logMission() {
  if (!S.currentArea) return alert('Draw an operational area first.');
  const notes = prompt('Mission notes (optional):') || '';
  const entry = {
    timestamp: Date.now(),
    rpic: document.getElementById('cfgRPIC')?.value || '',
    aircraft: document.getElementById('cfgAircraft')?.value || '',
    areaCenter: S.areaCenter ? { lat: S.areaCenter.lat, lng: S.areaCenter.lng } : null,
    areaType: S.areaType,
    assessment: {
      level: document.getElementById('assessBadge')?.textContent,
      text: document.getElementById('assessText')?.textContent,
    },
    wx: {
      temp: S.wx.temperature_2m,
      humidity: S.wx.relative_humidity_2m,
      pressure: S.wx.surface_pressure,
      visibility: S.wx.visibility,
      windSpeed: S.wind?.maxWind,
      windGust: S.wind?.maxGust,
      precip: S.wx.precipitation_probability,
      weatherCode: S.wx.weather_code,
    },
    elev: S.elev ? { center: S.elev.center, min: S.elev.min, max: S.elev.max, range: S.elev.range } : null,
    nwsAlerts: S.nwsAlerts?.length || 0,
    wireHazards: Object.values(S.wireHazardCounts || {}).reduce((a, b) => a + b, 0),
    sopProfile: S.activeProfile?.name || 'Default',
    notes: notes,
  };
  if (typeof saveMissionLog === 'function') {
    await saveMissionLog(entry);
    const btn = document.getElementById('btnLog');
    if (btn) { btn.textContent = 'LOGGED'; setTimeout(() => { btn.textContent = 'LOG'; }, 1500); }
    if (typeof logAudit === 'function') logAudit('mission_logged', { areaCenter: entry.areaCenter, assessment: entry.assessment.level });
  }
}

async function showMissionLogs() {
  if (typeof getMissionLogs !== 'function') return;
  const logs = await getMissionLogs();
  const list = document.getElementById('missionLogList');
  if (!list) return;
  if (!logs || logs.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">No mission logs recorded.</div>';
  } else {
    let html = '<table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;">';
    html += '<tr style="border-bottom:1px solid var(--border);color:var(--text-muted);font-size:9px;text-transform:uppercase;letter-spacing:1px;">' +
      '<th style="padding:6px;text-align:left;">Date</th><th style="padding:6px;text-align:left;">RPIC</th>' +
      '<th style="padding:6px;text-align:left;">Assessment</th><th style="padding:6px;text-align:left;">Location</th>' +
      '<th style="padding:6px;text-align:left;">Aircraft</th><th style="padding:6px;text-align:left;">Notes</th>' +
      '<th style="padding:6px;"></th></tr>';
    logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    logs.forEach(log => {
      const date = log.timestamp ? new Date(log.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';
      const loc = log.areaCenter ? `${log.areaCenter.lat.toFixed(3)}, ${log.areaCenter.lng.toFixed(3)}` : '--';
      const assessColor = log.assessment?.level === 'GO' ? 'var(--accent-green)' : log.assessment?.level === 'CAUTION' ? 'var(--accent-amber)' : 'var(--accent-red)';
      html += `<tr style="border-bottom:1px solid var(--border);">` +
        `<td style="padding:6px;color:var(--text-secondary);">${date}</td>` +
        `<td style="padding:6px;">${log.rpic || '--'}</td>` +
        `<td style="padding:6px;color:${assessColor};font-weight:600;">${log.assessment?.level || '--'}</td>` +
        `<td style="padding:6px;color:var(--text-secondary);">${loc}</td>` +
        `<td style="padding:6px;">${log.aircraft || '--'}</td>` +
        `<td style="padding:6px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(log.notes || '').replace(/"/g, '&quot;')}">${log.notes || '--'}</td>` +
        `<td style="padding:6px;"><button class="btn btn-ghost" style="padding:2px 6px;font-size:9px;color:var(--accent-red);" onclick="deleteMissionLogEntry(${log.id || log.timestamp})">DEL</button></td></tr>`;
    });
    html += '</table>';
    list.innerHTML = html;
  }
  document.getElementById('missionLogModal').classList.add('active');
}

function closeMissionLogModal() {
  document.getElementById('missionLogModal').classList.remove('active');
}

async function deleteMissionLogEntry(id) {
  if (!confirm('Delete this mission log entry?')) return;
  if (typeof deleteMissionLog === 'function') {
    await deleteMissionLog(id);
    await showMissionLogs();
  }
}

async function exportMissionLogsAsCSV() {
  if (typeof getMissionLogs !== 'function') return;
  const logs = await getMissionLogs();
  if (!logs || logs.length === 0) return alert('No logs to export.');
  const headers = ['Date', 'RPIC', 'Aircraft', 'Assessment', 'Lat', 'Lng', 'Area Type', 'Wind (mph)', 'Visibility', 'Temp (F)', 'SOP Profile', 'NWS Alerts', 'Wire Hazards', 'Notes'];
  const rows = logs.map(l => [
    l.timestamp ? new Date(l.timestamp).toISOString() : '',
    l.rpic || '', l.aircraft || '', l.assessment?.level || '',
    l.areaCenter?.lat?.toFixed(5) || '', l.areaCenter?.lng?.toFixed(5) || '',
    l.areaType || '', l.wx?.windSpeed || '', l.wx?.visibility || '',
    l.wx?.temp || '', l.sopProfile || '', l.nwsAlerts || 0, l.wireHazards || 0,
    (l.notes || '').replace(/"/g, '""'),
  ]);
  let csv = headers.join(',') + '\n';
  rows.forEach(r => { csv += r.map(v => `"${v}"`).join(',') + '\n'; });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `SAR_Mission_Logs_${new Date().toISOString().split('T')[0]}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// TRAINING MODE
// ============================================================
function enterTrainingMode(index) {
  if (typeof TRAINING_SCENARIOS === 'undefined' || !TRAINING_SCENARIOS) return;
  const scenario = TRAINING_SCENARIOS[index];
  if (!scenario) return;
  S._trainingMode = true;
  S.wx = { ...scenario.wx };
  S.wind = { ...scenario.wind };
  S.elev = { ...scenario.elev };
  // Set area center on map
  if (S.map) {
    S.areaCenter = { lat: scenario.center.lat, lng: scenario.center.lng };
    S.areaType = 'CIRCLE';
    S.currentArea = true; // Mark as having an area for assessment
    S.map.setView([scenario.center.lat, scenario.center.lng], 12);
    // Show panels
    document.getElementById('noAreaOverlay').style.display = 'none';
    document.getElementById('assessmentBanner').style.display = 'flex';
    document.getElementById('areaInfoBar').style.display = 'flex';
    document.getElementById('noAreaState').style.display = 'none';
    switchTab(S.activeTab);
    // Update area info
    setText('areaCenter', `${scenario.center.lat.toFixed(4)}, ${scenario.center.lng.toFixed(4)}`);
    setText('areaType', 'TRAINING');
    setText('areaSize', 'N/A');
    setText('areaPerimeter', 'N/A');
    setText('areaMaxDim', 'N/A');
  }
  // Render weather data to DOM
  if (scenario.wx) {
    const c = scenario.wx;
    setText('wxTemp', c.temperature_2m !== undefined ? `${Math.round(c.temperature_2m)}°F` : '--');
    setText('wxHumidity', c.relative_humidity_2m !== undefined ? `${Math.round(c.relative_humidity_2m)}%` : '--');
    const visMi = c.visibility !== undefined ? (c.visibility / 1609.34).toFixed(1) : '--';
    setText('wxVis', visMi !== '--' ? `${visMi} mi` : '--');
    setText('wxPrecip', c.precipitation_probability !== undefined ? `${c.precipitation_probability}%` : '--');
    setText('wxConditions', c.weather_code !== undefined && typeof wmoCodeToText === 'function' ? wmoCodeToText(c.weather_code) : '--');
  }
  // Render wind data
  if (scenario.wind) {
    setText('windMax', scenario.wind.maxWind !== undefined ? `${scenario.wind.maxWind} mph` : '--');
    setText('windGustMax', scenario.wind.maxGust !== undefined ? `${scenario.wind.maxGust} mph` : '--');
  }
  // Render elevation data
  if (scenario.elev) {
    setText('terrMin', scenario.elev.min !== undefined ? `${scenario.elev.min} ft` : '--');
    setText('terrMax', scenario.elev.max !== undefined ? `${scenario.elev.max} ft` : '--');
    setText('terrRange', scenario.elev.range !== undefined ? `${scenario.elev.range} ft` : '--');
  }
  computeOpsData();
  computeAssessment();
  // Show training banner
  const banner = document.getElementById('trainingBanner');
  if (banner) banner.style.display = 'flex';
  const nameEl = document.getElementById('trainingScenarioName');
  if (nameEl) nameEl.textContent = scenario.name || 'Scenario ' + (index + 1);
  if (typeof logAudit === 'function') logAudit('training_entered', { scenario: scenario.name });
}

function exitTrainingMode() {
  S._trainingMode = false;
  S.wx = {}; S.wind = {}; S.elev = {};
  S.currentArea = null; S.areaCenter = null;
  const banner = document.getElementById('trainingBanner');
  if (banner) banner.style.display = 'none';
  document.getElementById('noAreaOverlay').style.display = '';
  document.getElementById('assessmentBanner').style.display = 'none';
  document.getElementById('areaInfoBar').style.display = 'none';
  document.getElementById('noAreaState').style.display = '';
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  if (typeof logAudit === 'function') logAudit('training_exited');
}

function populateTrainingScenarios() {
  if (typeof TRAINING_SCENARIOS === 'undefined' || !TRAINING_SCENARIOS) return;
  const dd = document.getElementById('cfgTrainingScenario');
  if (!dd) return;
  dd.innerHTML = '';
  TRAINING_SCENARIOS.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = s.name || `Scenario ${i + 1}`;
    dd.appendChild(opt);
  });
}

// ============================================================
// AUDIT TRAIL UI
// ============================================================
async function showAuditTrail() {
  if (typeof getAuditTrail !== 'function') return;
  const trail = await getAuditTrail();
  const list = document.getElementById('auditTrailList');
  if (!list) return;
  if (!trail || trail.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">No audit trail entries.</div>';
  } else {
    let html = '<table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;">';
    html += '<tr style="border-bottom:1px solid var(--border);color:var(--text-muted);font-size:9px;text-transform:uppercase;letter-spacing:1px;">' +
      '<th style="padding:6px;text-align:left;">Time</th><th style="padding:6px;text-align:left;">Action</th>' +
      '<th style="padding:6px;text-align:left;">Details</th></tr>';
    const sorted = trail.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    sorted.forEach(entry => {
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
      const date = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const details = entry.details ? JSON.stringify(entry.details).substring(0, 80) : '';
      html += `<tr style="border-bottom:1px solid var(--border);">` +
        `<td style="padding:6px;color:var(--text-muted);white-space:nowrap;">${date} ${time}</td>` +
        `<td style="padding:6px;color:var(--accent-cyan);">${entry.action || '--'}</td>` +
        `<td style="padding:6px;color:var(--text-secondary);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${details.replace(/"/g, '&quot;')}">${details}</td></tr>`;
    });
    html += '</table>';
    list.innerHTML = html;
  }
  document.getElementById('auditTrailModal').classList.add('active');
}

function closeAuditTrailModal() {
  document.getElementById('auditTrailModal').classList.remove('active');
}

async function exportAuditTrailAsCSV() {
  if (typeof getAuditTrail !== 'function') return;
  const trail = await getAuditTrail();
  if (!trail || trail.length === 0) return alert('No audit trail to export.');
  const headers = ['Timestamp', 'Action', 'Details'];
  const rows = trail.map(e => [
    e.timestamp ? new Date(e.timestamp).toISOString() : '',
    e.action || '',
    e.details ? JSON.stringify(e.details).replace(/"/g, '""') : '',
  ]);
  let csv = headers.join(',') + '\n';
  rows.forEach(r => { csv += r.map(v => `"${v}"`).join(',') + '\n'; });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `SAR_Audit_Trail_${new Date().toISOString().split('T')[0]}.csv`; a.click();
  URL.revokeObjectURL(url);
}

async function clearAuditTrailUI() {
  if (!confirm('Clear entire audit trail? This cannot be undone.')) return;
  if (typeof clearAuditTrail === 'function') {
    await clearAuditTrail();
    alert('Audit trail cleared.');
  }
}

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    S, setText, setColor, setStatus, switchTab, togglePanel,
    buildLayerControl, toggleLayer, updateWireDisplay,
    computeAirspace, computeOpsData, computeAssessment,
    fetchWeather, fetchKpIndex, fetchElevation, fetchSunMoon,
    fetchNOTAMs, fetchWireHazards, processArea,
    fetchFAAairspace, renderFAAairspaceLayers, fetchProtectedAreas, renderProtectedAreaLayers,
    renderAirportMarkers, fetchNWSAlerts, renderNWSAlertCards, renderNWSAlertPolygons,
    renderForecastChart, fetchRadar,
    radarToggle, radarStep, updateRadarTime,
    openExport, closeExport, doExport, getKMLCoords,
    saveApiKey, saveConfig, updateClock, refreshData,
    initMap, startDraw, clearDrawBtns, clearArea, enterCoords,
    scrollTabs, updateScrollBtns,
    importKML, handleKMLFile, parseKML,
    copyBriefing, buildBriefingText,
    generatePDFBriefing, shareBriefingEmail, openInSARTopo,
    recordDataSourceError, clearDataSourceError, retryFailedSource, retryAllFailed, showDataSourceStatus,
    setAutoRefresh, loadFAAChart, removeChart, clearAllCharts, updateChartList, restoreFAACharts,
    initTimeBar, hideTimeBar,
    renderTerrainFeatures, renderLZMarkers, generateAndRenderFlightPlan,
    // Phase 6: SOP Profiles, Mission Logging, Training Mode, Audit Trail
    loadSopProfile, saveSopProfileFromUI, deleteSopProfileFromUI, populateSopDropdown, updateSopThresholdFields,
    logMission, showMissionLogs, closeMissionLogModal, deleteMissionLogEntry, exportMissionLogsAsCSV,
    enterTrainingMode, exitTrainingMode, populateTrainingScenarios,
    showAuditTrail, closeAuditTrailModal, exportAuditTrailAsCSV, clearAuditTrailUI,
  };
}
