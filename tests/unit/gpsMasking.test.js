const {
  analyzeGPSMasking, assessTerrainTurbulence, calcAspect, generateElevationGrid, haversine,
} = require('../../sar-preflight-core.js');

// ============================================================
// analyzeGPSMasking
// ============================================================

describe('analyzeGPSMasking(centerElevFt, elevPoints, gridSize, flightAltAGL, observer)', () => {
  // Fixtures come from generateElevationGrid (row-major from the SW corner:
  // row 0 is SOUTH) with each sample's elevation derived from its lat/lng, so
  // neither orientation nor spacing is assumed.
  const C = { lat: 38, lng: -121 };
  function geoPoints(halfDeg, elevFn) {
    const ne = { lat: C.lat + halfDeg, lng: C.lng + halfDeg }, sw = { lat: C.lat - halfDeg, lng: C.lng - halfDeg };
    return generateElevationGrid(C.lat, C.lng, ne, sw, 5)
      .map(p => ({ lat: p.latitude, lng: p.longitude, elevFt: elevFn(p.latitude, p.longitude) }));
  }
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const distFt = (lat, lng) => haversine(C.lat, C.lng, lat, lng) * 3280.84;
  const tanD = d => Math.tan(d * Math.PI / 180);

  describe('flat terrain', () => {
    it('reports no masking for flat terrain', () => {
      const result = analyzeGPSMasking(3000, geoPoints(0.01, () => 3000), 5, 400, C);
      expect(result.maskedDirections).toHaveLength(0);
      expect(result.skyVisibilityPct).toBe(100);
      expect(result.description.toLowerCase()).toContain('good');
    });
  });

  describe('units: rise and run are both feet (B04)', () => {
    it('review fixture: 600 ft higher terrain ~5–11 km away is < 1° → nothing masked', () => {
      const pts = geoPoints(0.1, (lat, lng) => (near(lat, C.lat) && near(lng, C.lng)) ? 1000 : 1600);
      const result = analyzeGPSMasking(1000, pts, 5, 400, C);
      expect(result.maskedDirections).toEqual([]);
      expect(result.skyVisibilityPct).toBe(100);
    });

    it('a single northern sample just below 15° is clear; just above masks N only', () => {
      const northLat = C.lat + 0.01;
      const d = distFt(northLat, C.lng);
      const flightElev = 3000 + 400;
      const withPeak = deg => geoPoints(0.01, (lat, lng) => (near(lat, northLat) && near(lng, C.lng)) ? flightElev + tanD(deg) * d : 3000);
      expect(analyzeGPSMasking(3000, withPeak(14), 5, 400, C).maskedDirections).toEqual([]);
      expect(analyzeGPSMasking(3000, withPeak(16), 5, 400, C).maskedDirections).toEqual(['N']);
    });

    it('rectangular spacing: an eastern sample uses its own (shorter) E-W distance', () => {
      const eastLng = C.lng + 0.01;              // ~2,880 ft at 38°N, vs ~3,650 ft for 0.01° of latitude
      const d = distFt(C.lat, eastLng);
      const withPeak = deg => geoPoints(0.01, (lat, lng) => (near(lat, C.lat) && near(lng, eastLng)) ? 3400 + tanD(deg) * d : 3000);
      expect(analyzeGPSMasking(3000, withPeak(14), 5, 400, C).maskedDirections).toEqual([]);
      expect(analyzeGPSMasking(3000, withPeak(16), 5, 400, C).maskedDirections).toEqual(['E']);
    });

    it('the same elevations mask a tight grid but not one ten times wider', () => {
      const canyon = (lat, lng) => (near(lat, C.lat) && near(lng, C.lng)) ? 2000 : 4000;
      expect(analyzeGPSMasking(2000, geoPoints(0.01, canyon), 5, 200, C).maskedDirections).toHaveLength(8);
      expect(analyzeGPSMasking(2000, geoPoints(0.1, canyon), 5, 200, C).maskedDirections).toEqual([]);
    });
  });

  describe('orientation follows geography (B05)', () => {
    it('review fixture: a high SOUTHERN row masks the south, never the north', () => {
      const pts = geoPoints(0.01, lat => lat < C.lat - 0.009 ? 4000 : 1000);
      expect(analyzeGPSMasking(1000, pts, 5, 100, C).maskedDirections).toEqual(['SE', 'S', 'SW']);
    });

    it('a high NORTHERN row masks the north', () => {
      const pts = geoPoints(0.01, lat => lat > C.lat + 0.009 ? 4000 : 1000);
      expect(analyzeGPSMasking(1000, pts, 5, 100, C).maskedDirections).toEqual(['N', 'NE', 'NW']);
    });

    it('a high EASTERN column masks the east; a high WESTERN column the west', () => {
      const east = geoPoints(0.01, (lat, lng) => lng > C.lng + 0.009 ? 4000 : 1000);
      expect(analyzeGPSMasking(1000, east, 5, 100, C).maskedDirections).toEqual(['NE', 'E', 'SE']);
      const west = geoPoints(0.01, (lat, lng) => lng < C.lng - 0.009 ? 4000 : 1000);
      expect(analyzeGPSMasking(1000, west, 5, 100, C).maskedDirections).toEqual(['SW', 'W', 'NW']);
    });

    it('a high SW corner masks SW only', () => {
      const pts = geoPoints(0.01, (lat, lng) => (lat < C.lat - 0.009 && lng < C.lng - 0.009) ? 4000 : 1000);
      expect(analyzeGPSMasking(1000, pts, 5, 100, C).maskedDirections).toEqual(['SW']);
    });
  });

  describe('flight altitude effect', () => {
    it('higher flight altitude reduces masking', () => {
      const pts = geoPoints(0.01, (lat, lng) => (near(lat, C.lat) && near(lng, C.lng)) ? 3000 : 4200);
      const lowFlight = analyzeGPSMasking(3000, pts, 5, 100, C);
      const highFlight = analyzeGPSMasking(3000, pts, 5, 1200, C);
      expect(lowFlight.maskedDirections.length).toBeGreaterThan(0);
      expect(highFlight.maskedDirections.length).toBeLessThan(lowFlight.maskedDirections.length);
    });
  });

  describe('return structure', () => {
    it('returns correct properties', () => {
      const result = analyzeGPSMasking(3000, geoPoints(0.01, () => 3000), 5, 400, C);
      expect(Array.isArray(result.maskedDirections)).toBe(true);
      expect(typeof result.skyVisibilityPct).toBe('number');
      expect(typeof result.description).toBe('string');
    });

    it('skyVisibilityPct = (8 - masked) / 8 * 100', () => {
      const pts = geoPoints(0.01, lat => lat < C.lat - 0.009 ? 4000 : 1000);
      const result = analyzeGPSMasking(1000, pts, 5, 100, C);
      expect(result.skyVisibilityPct).toBe(Math.round((8 - 3) / 8 * 100));
      expect(result.description.toLowerCase()).toContain('mask');
    });
  });

  describe('edge cases', () => {
    it('returns 100% visibility for null / empty elevPoints', () => {
      expect(analyzeGPSMasking(3000, null, 5, 400).skyVisibilityPct).toBe(100);
      expect(analyzeGPSMasking(3000, [], 5, 400).maskedDirections).toHaveLength(0);
    });

    it('samples without coordinates cannot be ranged — never treated as grid-cell distances', () => {
      const pts = Array.from({ length: 25 }, () => ({ elevFt: 9000 }));
      const result = analyzeGPSMasking(1000, pts, 5, 100);
      expect(result.maskedDirections).toEqual([]);
      expect(result.description).toMatch(/No terrain geometry/);
    });

    it('without an observer the bbox-centre sample is the observer', () => {
      const pts = geoPoints(0.01, lat => lat < C.lat - 0.009 ? 4000 : 1000);
      expect(analyzeGPSMasking(1000, pts, 5, 100).maskedDirections).toEqual(['SE', 'S', 'SW']);
    });
  });
});

// ============================================================
// assessTerrainTurbulence
// ============================================================

describe('assessTerrainTurbulence(elevationsFt, gridSize, rangeFt, windDirDeg, windSpeedMph)', () => {
  describe('flat terrain with light wind', () => {
    it('returns low risk for flat terrain and light winds', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 0, 180, 5);
      expect(result.risk).toBe('low');
      expect(result.level).toBe('green');
    });
  });

  describe('zero wind', () => {
    it('returns low risk with calm winds regardless of terrain', () => {
      const mountainous = [
        8000, 7000, 6000, 7000, 8000,
        7000, 5000, 4000, 5000, 7000,
        6000, 4000, 3000, 4000, 6000,
        7000, 5000, 4000, 5000, 7000,
        8000, 7000, 6000, 7000, 8000,
      ];
      const result = assessTerrainTurbulence(mountainous, 5, 5000, 270, 0);
      expect(result.risk).toBe('low');
      expect(result.level).toBe('green');
      expect(result.factors.some(f => f.toLowerCase().includes('calm'))).toBe(true);
    });
  });

  describe('mountainous terrain with strong winds', () => {
    it('returns high risk for ridgeline with strong perpendicular wind', () => {
      // Ridge running N-S (center column high)
      const ridge = [
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
      ];
      const rangeFt = 3000;
      // Wind from west (270 deg) perpendicular to N-S ridge
      const result = assessTerrainTurbulence(ridge, 5, rangeFt, 270, 30);
      expect(['moderate', 'high']).toContain(result.risk);
      expect(['amber', 'red']).toContain(result.level);
    });

    it('returns higher risk for strong winds vs moderate winds', () => {
      const terrain = [
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
      ];
      const rangeFt = 2000;
      const moderate = assessTerrainTurbulence(terrain, 5, rangeFt, 180, 12);
      const strong = assessTerrainTurbulence(terrain, 5, rangeFt, 180, 30);
      const riskOrder = { 'low': 0, 'moderate': 1, 'high': 2 };
      expect(riskOrder[strong.risk]).toBeGreaterThanOrEqual(riskOrder[moderate.risk]);
    });
  });

  describe('canyon with aligned wind', () => {
    it('detects funneling/canyon effects with wind', () => {
      const canyon = [
        5000, 5000, 5000, 5000, 5000,
        5000, 3000, 2000, 3000, 5000,
        5000, 2000, 1000, 2000, 5000,
        5000, 3000, 2000, 3000, 5000,
        5000, 5000, 5000, 5000, 5000,
      ];
      const rangeFt = 4000;
      const result = assessTerrainTurbulence(canyon, 5, rangeFt, 180, 20);
      expect(result.factors.length).toBeGreaterThan(0);
      expect(['moderate', 'high']).toContain(result.risk);
    });
  });

  describe('wind direction effects', () => {
    it('wind perpendicular to ridge is more turbulent than parallel', () => {
      // Ridge: center row is high, edges are low — ridge runs E-W
      const ridge = [
        2000, 2000, 2000, 2000, 2000,
        3000, 3000, 3000, 3000, 3000,
        5000, 5000, 5000, 5000, 5000,
        3000, 3000, 3000, 3000, 3000,
        2000, 2000, 2000, 2000, 2000,
      ];
      const rangeFt = 3000;
      // Wind from north (0 deg) = perpendicular to E-W ridge
      const perpendicular = assessTerrainTurbulence(ridge, 5, rangeFt, 0, 20);
      // Wind from east (90 deg) = parallel to E-W ridge
      const parallel = assessTerrainTurbulence(ridge, 5, rangeFt, 90, 20);
      const riskOrder = { 'low': 0, 'moderate': 1, 'high': 2 };
      expect(riskOrder[perpendicular.risk]).toBeGreaterThanOrEqual(riskOrder[parallel.risk]);
    });
  });

  describe('return structure', () => {
    it('returns risk, factors, and level', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 0, 180, 10);
      expect(result).toHaveProperty('risk');
      expect(result).toHaveProperty('factors');
      expect(result).toHaveProperty('level');
      expect(['low', 'moderate', 'high']).toContain(result.risk);
      expect(['green', 'amber', 'red']).toContain(result.level);
      expect(Array.isArray(result.factors)).toBe(true);
    });

    it('factors array is never empty', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 0, 180, 5);
      expect(result.factors.length).toBeGreaterThan(0);
    });
  });

  describe('high terrain range', () => {
    it('flags high terrain relief', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 1500, 180, 15);
      expect(result.factors.some(f => f.toLowerCase().includes('relief'))).toBe(true);
    });

    it('flags moderate terrain relief', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 700, 180, 15);
      expect(result.factors.some(f => f.toLowerCase().includes('relief'))).toBe(true);
    });
  });
});
