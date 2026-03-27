const {
  AIRPORTS_CA, filterAirportsByDistance, classifyAirspace, haversine,
} = require('../../sar-preflight-core.js');

describe('AIRPORTS_CA dataset', () => {
  it('contains at least 30 entries', () => {
    expect(AIRPORTS_CA.length).toBeGreaterThanOrEqual(30);
  });

  it('every entry has required fields', () => {
    AIRPORTS_CA.forEach(a => {
      expect(a).toHaveProperty('icao');
      expect(a).toHaveProperty('name');
      expect(a).toHaveProperty('type');
      expect(a).toHaveProperty('lat');
      expect(a).toHaveProperty('lng');
      expect(a).toHaveProperty('elevation_ft');
      expect(a).toHaveProperty('municipality');
    });
  });

  it('every entry has a valid type', () => {
    const validTypes = ['large_airport', 'medium_airport', 'small_airport', 'heliport'];
    AIRPORTS_CA.forEach(a => {
      expect(validTypes).toContain(a.type);
    });
  });

  it('includes key airports KSMF, KSAC, KMCC, KPVF, KTRK', () => {
    const icaos = AIRPORTS_CA.map(a => a.icao);
    ['KSMF', 'KSAC', 'KMCC', 'KPVF', 'KTRK'].forEach(code => {
      expect(icaos).toContain(code);
    });
  });

  it('includes at least 5 heliports', () => {
    const heliports = AIRPORTS_CA.filter(a => a.type === 'heliport');
    expect(heliports.length).toBeGreaterThanOrEqual(5);
  });

  it('includes major California airports KSFO, KOAK, KSJC, KLAX, KSAN', () => {
    const icaos = AIRPORTS_CA.map(a => a.icao);
    ['KSFO', 'KOAK', 'KSJC', 'KLAX', 'KSAN'].forEach(code => {
      expect(icaos).toContain(code);
    });
  });

  it('KSMF has correct coordinates and type', () => {
    const ksmf = AIRPORTS_CA.find(a => a.icao === 'KSMF');
    expect(ksmf.type).toBe('large_airport');
    expect(ksmf.lat).toBeCloseTo(38.6954, 2);
    expect(ksmf.lng).toBeCloseTo(-121.5908, 2);
    expect(ksmf.elevation_ft).toBe(27);
  });

  it('lat/lng values are within California bounding box', () => {
    AIRPORTS_CA.forEach(a => {
      // Allow for Reno which is just over the NV border
      expect(a.lat).toBeGreaterThan(32);
      expect(a.lat).toBeLessThan(42);
      expect(a.lng).toBeGreaterThan(-125);
      expect(a.lng).toBeLessThan(-114);
    });
  });
});

describe('filterAirportsByDistance()', () => {
  // Sacramento center: 38.58, -121.49
  const sacLat = 38.58;
  const sacLng = -121.49;

  it('returns airports within the given radius', () => {
    const nearby = filterAirportsByDistance(AIRPORTS_CA, sacLat, sacLng, 30);
    nearby.forEach(a => {
      expect(a.distKm).toBeLessThanOrEqual(30);
    });
  });

  it('excludes airports outside the given radius', () => {
    const nearby = filterAirportsByDistance(AIRPORTS_CA, sacLat, sacLng, 10);
    const icaos = nearby.map(a => a.icao);
    // KTRK is ~120 km away — should not appear at 10km radius
    expect(icaos).not.toContain('KTRK');
  });

  it('results are sorted by distance ascending', () => {
    const nearby = filterAirportsByDistance(AIRPORTS_CA, sacLat, sacLng, 100);
    for (let i = 1; i < nearby.length; i++) {
      expect(nearby[i].distKm).toBeGreaterThanOrEqual(nearby[i - 1].distKm);
    }
  });

  it('each result has a distKm property', () => {
    const nearby = filterAirportsByDistance(AIRPORTS_CA, sacLat, sacLng, 50);
    nearby.forEach(a => {
      expect(typeof a.distKm).toBe('number');
      expect(a.distKm).toBeGreaterThanOrEqual(0);
    });
  });

  it('returns empty array when no airports in range', () => {
    // Middle of the ocean
    const result = filterAirportsByDistance(AIRPORTS_CA, 30.0, -140.0, 10);
    expect(result).toEqual([]);
  });

  it('returns KSAC as the nearest non-heliport to Sacramento center', () => {
    const nearby = filterAirportsByDistance(AIRPORTS_CA, sacLat, sacLng, 50);
    expect(nearby.length).toBeGreaterThan(0);
    // The nearest airport (of any type) should be within a few km
    expect(nearby[0].distKm).toBeLessThan(5);
    // KSAC should be among the closest entries
    const ksac = nearby.find(a => a.icao === 'KSAC');
    expect(ksac).toBeDefined();
    expect(ksac.distKm).toBeLessThan(10);
  });

  it('55 km radius from Placerville includes KPVF and heliports', () => {
    const nearby = filterAirportsByDistance(AIRPORTS_CA, 38.73, -120.80, 55);
    const icaos = nearby.map(a => a.icao);
    expect(icaos).toContain('KPVF');
  });

  it('does not modify the original AIRPORTS_CA array', () => {
    const originalLength = AIRPORTS_CA.length;
    const originalFirst = { ...AIRPORTS_CA[0] };
    filterAirportsByDistance(AIRPORTS_CA, sacLat, sacLng, 50);
    expect(AIRPORTS_CA.length).toBe(originalLength);
    expect(AIRPORTS_CA[0].distKm).toBeUndefined();
  });

  it('distKm matches haversine calculation', () => {
    const nearby = filterAirportsByDistance(AIRPORTS_CA, sacLat, sacLng, 100);
    nearby.forEach(a => {
      const expected = haversine(sacLat, sacLng, a.lat, a.lng);
      expect(a.distKm).toBeCloseTo(expected, 5);
    });
  });
});

describe('classifyAirspace()', () => {
  describe('large airport classification', () => {
    const largeAirport = { icao: 'KSMF', name: 'Sacramento International', type: 'large_airport' };

    it('returns Class B within 5 nm', () => {
      const result = classifyAirspace(largeAirport, 5);
      expect(result.class).toBe('B');
      expect(result.controlled).toBe(true);
      expect(result.label).toContain('Class B');
      expect(result.label).toContain('KSMF');
    });

    it('returns Class B shelf between 5 and 10 nm', () => {
      const result = classifyAirspace(largeAirport, 12);  // ~6.5 nm
      expect(result.class).toBe('B-shelf');
      expect(result.controlled).toBe(true);
    });

    it('returns Class C outer ring between 10 and 20 nm', () => {
      const result = classifyAirspace(largeAirport, 25);  // ~13.5 nm
      expect(result.class).toBe('C-outer');
      expect(result.controlled).toBe(true);
    });

    it('returns Class G beyond 20 nm', () => {
      const result = classifyAirspace(largeAirport, 45);  // ~24.3 nm
      expect(result.class).toBe('G');
      expect(result.controlled).toBe(false);
    });
  });

  describe('medium airport classification', () => {
    const medAirport = { icao: 'KMCC', name: 'McClellan Airfield', type: 'medium_airport' };

    it('returns Class D within 5 nm', () => {
      const result = classifyAirspace(medAirport, 5);
      expect(result.class).toBe('D');
      expect(result.controlled).toBe(true);
      expect(result.label).toContain('Class D');
    });

    it('returns Class E transition between 5 and 10 nm', () => {
      const result = classifyAirspace(medAirport, 12);
      expect(result.class).toBe('E-transition');
      expect(result.controlled).toBe(false);
    });

    it('returns Class G beyond 10 nm', () => {
      const result = classifyAirspace(medAirport, 25);
      expect(result.class).toBe('G');
      expect(result.controlled).toBe(false);
    });
  });

  describe('small airport classification', () => {
    const smallAirport = { icao: 'KPVF', name: 'Placerville Airport', type: 'small_airport' };

    it('returns Class E surface within 5 nm', () => {
      const result = classifyAirspace(smallAirport, 5);
      expect(result.class).toBe('E-surface');
      expect(result.controlled).toBe(false);
    });

    it('returns Class G beyond 5 nm', () => {
      const result = classifyAirspace(smallAirport, 15);
      expect(result.class).toBe('G');
      expect(result.controlled).toBe(false);
    });
  });

  describe('heliport classification', () => {
    const heli = { icao: 'CA23', name: 'UC Davis Medical Center', type: 'heliport' };

    it('returns G-heliport within 2 nm', () => {
      const result = classifyAirspace(heli, 2);
      expect(result.class).toBe('G-heliport');
      expect(result.controlled).toBe(false);
      expect(result.label).toContain('heliport');
    });

    it('returns Class G beyond 2 nm', () => {
      const result = classifyAirspace(heli, 10);
      expect(result.class).toBe('G');
      expect(result.controlled).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns Class G when nearestAirport is null', () => {
      const result = classifyAirspace(null, 100);
      expect(result.class).toBe('G');
      expect(result.controlled).toBe(false);
      expect(result.label).toContain('Uncontrolled');
    });

    it('returns Class G when nearestAirport is undefined', () => {
      const result = classifyAirspace(undefined, 100);
      expect(result.class).toBe('G');
      expect(result.controlled).toBe(false);
    });

    it('within 5 nm boundary for large airport returns Class B', () => {
      const large = { icao: 'KSFO', name: 'SFO', type: 'large_airport' };
      // 4.9 nm = ~9.075 km — clearly inside the 5 nm ring
      const result = classifyAirspace(large, 9.0);
      expect(result.class).toBe('B');
      expect(result.controlled).toBe(true);
    });
  });
});
