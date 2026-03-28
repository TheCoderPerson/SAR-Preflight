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

function calcMoonPhase() {
  const now = new Date();
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

// --- Default Risk Thresholds ---

const DEFAULT_THRESHOLDS = {
  visNoGo: 1,           // statute miles — below this = NO-GO
  visCaution: 5,        // statute miles — below this = CAUTION
  precipNoGo: 60,       // percent — above this = NO-GO
  precipCaution: 30,    // percent — above this = CAUTION
  windCaution: 15,      // mph — above this (but below maxWindTol) = CAUTION
  tempCaution: 35,      // °F — below this = CAUTION
  elevCaution: 6000,    // feet — above this = CAUTION
  weatherCodeNoGo: 95,  // WMO code — at or above = NO-GO (thunderstorm)
  name: 'Default',
};

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

// --- Risk Assessment ---

function assessRisk(wx, wind, elev, maxWindTol, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  const maxWind = wind.maxWind ?? 0;
  const maxGust = wind.maxGust ?? 0;
  const vis = wx.visibility ? wx.visibility / 1609.34 : 99;
  const temp = wx.temperature_2m ?? 65;
  const precip = wx.precipitation_probability ?? 0;
  const weatherCode = wx.weather_code ?? 0;
  const centerElev = elev.center ?? 0;

  const issues = [];
  if (maxWind > maxWindTol || maxGust > maxWindTol + 5) { issues.push(`Wind ${maxWind}/${maxGust}g exceeds limits`); }
  if (vis < t.visNoGo) { issues.push(`Visibility ${vis.toFixed(1)} mi`); }
  if (precip > t.precipNoGo) { issues.push(`Precip ${precip}%`); }
  if (weatherCode >= t.weatherCodeNoGo) { issues.push('Thunderstorm activity'); }

  const cautions = [];
  if (maxWind > t.windCaution && maxWind <= maxWindTol) { cautions.push('Elevated winds'); }
  if (vis >= t.visNoGo && vis < t.visCaution) { cautions.push('Reduced visibility'); }
  if (precip > t.precipCaution && precip <= t.precipNoGo) { cautions.push(`Precip ${precip}%`); }
  if (temp < t.tempCaution) { cautions.push('Cold — battery impact'); }
  if (centerElev > t.elevCaution) { cautions.push('High elevation'); }

  let level = 'GO', text = 'All conditions nominal for UAS operations';
  if (issues.length > 0) { level = 'NO-GO'; text = issues.join(' • '); }
  else if (cautions.length > 0) { level = 'CAUTION'; text = cautions.join(' • '); }

  return { level, text, issues, cautions };
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

// --- Search Pattern Generation ---

function generateSearchPattern(bounds, windDirDeg, patternType, trackSpacingM) {
  const waypoints = [];
  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;

  // Approximate meters per degree at this latitude
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(centerLat * Math.PI / 180);

  const heightM = (bounds.north - bounds.south) * mPerDegLat;
  const widthM  = (bounds.east - bounds.west) * mPerDegLng;

  if (patternType === 'parallel') {
    // Tracks perpendicular to wind direction
    // Wind from windDirDeg means tracks should run perpendicular
    const trackDirRad = ((windDirDeg + 90) % 360) * Math.PI / 180;

    // Project bounds into rotated coordinate system
    // For simplicity, generate tracks in the bounding box, oriented perpendicular to wind
    const numTracks = Math.max(1, Math.floor(Math.max(heightM, widthM) / trackSpacingM) + 1);
    const crossDirRad = windDirDeg * Math.PI / 180; // cross-track direction = wind direction

    // Track length: diagonal of search area to ensure coverage
    const trackLengthM = Math.sqrt(heightM * heightM + widthM * widthM);
    const halfTrackDeg_lat = (trackLengthM / 2) * Math.cos(trackDirRad) / mPerDegLat;
    const halfTrackDeg_lng = (trackLengthM / 2) * Math.sin(trackDirRad) / mPerDegLng;

    // Offset between tracks
    const spacingDeg_lat = trackSpacingM * Math.cos(crossDirRad) / mPerDegLat;
    const spacingDeg_lng = trackSpacingM * Math.sin(crossDirRad) / mPerDegLng;

    // Start from center offset by half the total width
    const startLat = centerLat - (numTracks / 2) * spacingDeg_lat;
    const startLng = centerLng - (numTracks / 2) * spacingDeg_lng;

    for (let t = 0; t < numTracks; t++) {
      const baseLat = startLat + t * spacingDeg_lat;
      const baseLng = startLng + t * spacingDeg_lng;

      if (t % 2 === 0) {
        waypoints.push([baseLat - halfTrackDeg_lat, baseLng - halfTrackDeg_lng]);
        waypoints.push([baseLat + halfTrackDeg_lat, baseLng + halfTrackDeg_lng]);
      } else {
        waypoints.push([baseLat + halfTrackDeg_lat, baseLng + halfTrackDeg_lng]);
        waypoints.push([baseLat - halfTrackDeg_lat, baseLng - halfTrackDeg_lng]);
      }
    }

    // Estimate total distance
    let totalDistKm = 0;
    for (let i = 1; i < waypoints.length; i++) {
      totalDistKm += haversine(waypoints[i - 1][0], waypoints[i - 1][1], waypoints[i][0], waypoints[i][1]);
    }

    return { waypoints, estimatedDistanceKm: Math.round(totalDistKm * 100) / 100, legs: numTracks };
  }

  if (patternType === 'expanding_square') {
    // Spiral outward from center in growing squares
    waypoints.push([centerLat, centerLng]);
    let legNum = 1;
    let currentLat = centerLat;
    let currentLng = centerLng;
    const spacingDegLat = trackSpacingM / mPerDegLat;
    const spacingDegLng = trackSpacingM / mPerDegLng;

    // Directions: N, E, S, W — each pair of legs increases by 1 spacing
    const moves = [
      [spacingDegLat, 0],   // N
      [0, spacingDegLng],   // E
      [-spacingDegLat, 0],  // S
      [0, -spacingDegLng],  // W
    ];

    let stepSize = 1;
    let legs = 0;
    const maxLegs = Math.ceil(Math.max(heightM, widthM) / trackSpacingM) * 4;

    for (let i = 0; legs < maxLegs && legs < 200; i++) {
      const dir = moves[i % 4];
      for (let s = 0; s < stepSize; s++) {
        currentLat += dir[0];
        currentLng += dir[1];
        waypoints.push([currentLat, currentLng]);
      }
      legs++;
      // Increase step size every 2 turns
      if (i % 2 === 1) stepSize++;
    }

    let totalDistKm = 0;
    for (let i = 1; i < waypoints.length; i++) {
      totalDistKm += haversine(waypoints[i - 1][0], waypoints[i - 1][1], waypoints[i][0], waypoints[i][1]);
    }

    return { waypoints, estimatedDistanceKm: Math.round(totalDistKm * 100) / 100, legs };
  }

  if (patternType === 'sector') {
    // Pie-slice sectors from center
    const numSectors = 8;
    const radiusM = Math.sqrt(heightM * heightM + widthM * widthM) / 2;
    const radiusDegLat = radiusM / mPerDegLat;
    const radiusDegLng = radiusM / mPerDegLng;

    let legs = 0;
    for (let i = 0; i < numSectors; i++) {
      const angleDeg = (windDirDeg + i * (360 / numSectors)) % 360;
      const angleRad = angleDeg * Math.PI / 180;

      // Go out from center
      waypoints.push([centerLat, centerLng]);
      const endLat = centerLat + radiusDegLat * Math.cos(angleRad);
      const endLng = centerLng + radiusDegLng * Math.sin(angleRad);
      waypoints.push([endLat, endLng]);
      legs++;
    }
    // Return to center
    waypoints.push([centerLat, centerLng]);

    let totalDistKm = 0;
    for (let i = 1; i < waypoints.length; i++) {
      totalDistKm += haversine(waypoints[i - 1][0], waypoints[i - 1][1], waypoints[i][0], waypoints[i][1]);
    }

    return { waypoints, estimatedDistanceKm: Math.round(totalDistKm * 100) / 100, legs };
  }

  // Unknown pattern type — return empty
  return { waypoints: [], estimatedDistanceKm: 0, legs: 0 };
}

// --- Training Scenarios ---

const TRAINING_SCENARIOS = [
  {
    name: 'High Wind SAR',
    description: 'Gusty conditions in foothill terrain with elevated winds at altitude. Tests wind tolerance decisions.',
    center: { lat: 38.8916, lng: -120.8624 },
    wx: {
      temperature_2m: 72, relative_humidity_2m: 35, dew_point_2m: 44,
      apparent_temperature: 70, surface_pressure: 1012,
      cloud_cover: 25, visibility: 16000, wind_speed_10m: 22,
      wind_direction_10m: 270, wind_gusts_10m: 35,
      precipitation_probability: 5, weather_code: 2, uv_index: 6, is_day: 1,
    },
    wind: {
      profile: [
        { alt: 'Ground (10m)', speed: 22, gust: 35, dir: 270 },
        { alt: '100 ft AGL', speed: 25, gust: 38, dir: 275 },
        { alt: '200 ft AGL', speed: 27, gust: 40, dir: 278 },
        { alt: '300 ft AGL', speed: 30, gust: 42, dir: 280 },
        { alt: '400 ft AGL', speed: 32, gust: 45, dir: 282 },
      ],
      maxWind: 32, maxGust: 45,
    },
    elev: { center: 2600, min: 2200, max: 3100, range: 900 },
    astro: { sunrise: '06:15 AM', sunset: '07:45 PM', twilightAM: '05:48 AM', twilightPM: '08:12 PM' },
  },
  {
    name: 'Winter Storm - Mountain',
    description: 'Low visibility, icing risk, high elevation, active precipitation. Should be NO-GO.',
    center: { lat: 38.9396, lng: -119.9772 },
    wx: {
      temperature_2m: 28, relative_humidity_2m: 92, dew_point_2m: 26,
      apparent_temperature: 18, surface_pressure: 840,
      cloud_cover: 100, visibility: 800, wind_speed_10m: 15,
      wind_direction_10m: 180, wind_gusts_10m: 28,
      precipitation_probability: 85, weather_code: 73, uv_index: 0.5, is_day: 1,
    },
    wind: {
      profile: [
        { alt: 'Ground (10m)', speed: 15, gust: 28, dir: 180 },
        { alt: '100 ft AGL', speed: 18, gust: 30, dir: 185 },
        { alt: '200 ft AGL', speed: 20, gust: 32, dir: 190 },
        { alt: '300 ft AGL', speed: 22, gust: 35, dir: 195 },
        { alt: '400 ft AGL', speed: 25, gust: 38, dir: 200 },
      ],
      maxWind: 25, maxGust: 38,
    },
    elev: { center: 6260, min: 6200, max: 6400, range: 200 },
    astro: { sunrise: '07:00 AM', sunset: '04:55 PM', twilightAM: '06:32 AM', twilightPM: '05:23 PM' },
  },
  {
    name: 'Perfect Conditions',
    description: 'Ideal flying weather with light winds and clear skies. Should be GO.',
    center: { lat: 38.58, lng: -121.49 },
    wx: {
      temperature_2m: 75, relative_humidity_2m: 40, dew_point_2m: 50,
      apparent_temperature: 74, surface_pressure: 1018,
      cloud_cover: 10, visibility: 32000, wind_speed_10m: 5,
      wind_direction_10m: 315, wind_gusts_10m: 8,
      precipitation_probability: 0, weather_code: 0, uv_index: 8, is_day: 1,
    },
    wind: {
      profile: [
        { alt: 'Ground (10m)', speed: 5, gust: 8, dir: 315 },
        { alt: '100 ft AGL', speed: 6, gust: 9, dir: 318 },
        { alt: '200 ft AGL', speed: 7, gust: 10, dir: 320 },
        { alt: '300 ft AGL', speed: 8, gust: 11, dir: 322 },
        { alt: '400 ft AGL', speed: 9, gust: 12, dir: 325 },
      ],
      maxWind: 9, maxGust: 12,
    },
    elev: { center: 30, min: 15, max: 50, range: 35 },
    astro: { sunrise: '06:30 AM', sunset: '07:30 PM', twilightAM: '06:03 AM', twilightPM: '07:57 PM' },
  },
  {
    name: 'Wildfire Smoke - High AQI',
    description: 'Poor AQI from nearby wildfire, reduced visibility, moderate winds. Tests CAUTION thresholds.',
    center: { lat: 38.7296, lng: -120.7985 },
    wx: {
      temperature_2m: 95, relative_humidity_2m: 15, dew_point_2m: 38,
      apparent_temperature: 93, surface_pressure: 1005,
      cloud_cover: 60, visibility: 4800, wind_speed_10m: 12,
      wind_direction_10m: 225, wind_gusts_10m: 20,
      precipitation_probability: 0, weather_code: 0, uv_index: 5, is_day: 1,
    },
    wind: {
      profile: [
        { alt: 'Ground (10m)', speed: 12, gust: 20, dir: 225 },
        { alt: '100 ft AGL', speed: 14, gust: 22, dir: 228 },
        { alt: '200 ft AGL', speed: 16, gust: 24, dir: 230 },
        { alt: '300 ft AGL', speed: 18, gust: 26, dir: 232 },
        { alt: '400 ft AGL', speed: 20, gust: 28, dir: 235 },
      ],
      maxWind: 20, maxGust: 28,
    },
    elev: { center: 1860, min: 1600, max: 2200, range: 600 },
    astro: { sunrise: '06:00 AM', sunset: '08:15 PM', twilightAM: '05:32 AM', twilightPM: '08:43 PM' },
  },
];

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WIRE_CATEGORIES, lerp, degToCompass, haversine, wmoCodeToText,
    calcSunPosition, calcMoonPhase, wireHazardName,
    calcDensityAltitude, calcBatteryDerating, assessRisk,
    DEFAULT_THRESHOLDS, TRAINING_SCENARIOS,
    classifyTerrain, estimateVegetation, estimateCellCoverage,
    filterAirportsByDistance, classifyAirspace,
    calcGustFactor, calcWindShear,
    generateElevationGrid, calcSlopeFromGrid, calcAspect,
    detectTerrainFeatures, scoreLZFitness, findEmergencyLZs,
    assessTerrainTurbulence, analyzeGPSMasking,
    calcSwapRecommendation, generateSearchPattern,
  };
}
