const {
  filterAirportsByDistance, classifyAirspace, haversine,
} = require('../../sar-preflight-core.js');

// Inline test airports (replaces removed AIRPORTS_CA static dataset)
const TEST_AIRPORTS = [
  { icao: 'KSMF', name: 'Sacramento International', type: 'large_airport', lat: 38.6954, lng: -121.5908, elevation_ft: 27, municipality: 'Sacramento' },
  { icao: 'KSAC', name: 'Sacramento Executive', type: 'medium_airport', lat: 38.5125, lng: -121.4935, elevation_ft: 24, municipality: 'Sacramento' },
  { icao: 'KMCC', name: 'McClellan Airfield', type: 'medium_airport', lat: 38.6676, lng: -121.4008, elevation_ft: 77, municipality: 'McClellan' },
  { icao: 'KPVF', name: 'Placerville Airport', type: 'small_airport', lat: 38.7243, lng: -120.7533, elevation_ft: 2585, municipality: 'Placerville' },
  { icao: 'KTRK', name: 'Truckee-Tahoe Airport', type: 'small_airport', lat: 39.3200, lng: -120.1396, elevation_ft: 5900, municipality: 'Truckee' },
  { icao: 'CA23', name: 'UC Davis Medical Center Heliport', type: 'heliport', lat: 38.5530, lng: -121.4560, elevation_ft: 50, municipality: 'Sacramento' },
  { icao: 'CA68', name: 'Marshall Medical Center Heliport', type: 'heliport', lat: 38.7340, lng: -120.7890, elevation_ft: 1860, municipality: 'Placerville' },
];

describe('filterAirportsByDistance()', () => {
  const sacLat = 38.58;
  const sacLng = -121.49;

  it('returns airports within the given radius', () => {
    const nearby = filterAirportsByDistance(TEST_AIRPORTS, sacLat, sacLng, 30);
    nearby.forEach(a => {
      expect(a.distKm).toBeLessThanOrEqual(30);
    });
  });

  it('excludes airports outside the given radius', () => {
    const nearby = filterAirportsByDistance(TEST_AIRPORTS, sacLat, sacLng, 10);
    const icaos = nearby.map(a => a.icao);
    expect(icaos).not.toContain('KTRK');
  });

  it('results are sorted by distance ascending', () => {
    const nearby = filterAirportsByDistance(TEST_AIRPORTS, sacLat, sacLng, 100);
    for (let i = 1; i < nearby.length; i++) {
      expect(nearby[i].distKm).toBeGreaterThanOrEqual(nearby[i - 1].distKm);
    }
  });

  it('each result has a distKm property', () => {
    const nearby = filterAirportsByDistance(TEST_AIRPORTS, sacLat, sacLng, 50);
    nearby.forEach(a => {
      expect(typeof a.distKm).toBe('number');
      expect(a.distKm).toBeGreaterThanOrEqual(0);
    });
  });

  it('returns empty array when no airports in range', () => {
    const result = filterAirportsByDistance(TEST_AIRPORTS, 30.0, -140.0, 10);
    expect(result).toEqual([]);
  });

  it('returns KSAC as nearest to Sacramento center', () => {
    const nearby = filterAirportsByDistance(TEST_AIRPORTS, sacLat, sacLng, 50);
    expect(nearby.length).toBeGreaterThan(0);
    const ksac = nearby.find(a => a.icao === 'KSAC');
    expect(ksac).toBeDefined();
    expect(ksac.distKm).toBeLessThan(10);
  });

  it('55 km radius from Placerville includes KPVF', () => {
    const nearby = filterAirportsByDistance(TEST_AIRPORTS, 38.73, -120.80, 55);
    const icaos = nearby.map(a => a.icao);
    expect(icaos).toContain('KPVF');
  });

  it('does not modify the original array', () => {
    const originalLength = TEST_AIRPORTS.length;
    filterAirportsByDistance(TEST_AIRPORTS, sacLat, sacLng, 50);
    expect(TEST_AIRPORTS.length).toBe(originalLength);
    expect(TEST_AIRPORTS[0].distKm).toBeUndefined();
  });

  it('distKm matches haversine calculation', () => {
    const nearby = filterAirportsByDistance(TEST_AIRPORTS, sacLat, sacLng, 100);
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
      const result = classifyAirspace(largeAirport, 12);
      expect(result.class).toBe('B-shelf');
      expect(result.controlled).toBe(true);
    });

    it('returns Class C outer ring between 10 and 20 nm', () => {
      const result = classifyAirspace(largeAirport, 25);
      expect(result.class).toBe('C-outer');
      expect(result.controlled).toBe(true);
    });

    it('returns Class G beyond 20 nm', () => {
      const result = classifyAirspace(largeAirport, 45);
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
      const result = classifyAirspace(large, 9.0);
      expect(result.class).toBe('B');
      expect(result.controlled).toBe(true);
    });
  });
});
