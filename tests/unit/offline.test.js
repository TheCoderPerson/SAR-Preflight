const { areaKey, classifyStaleness, formatAge, ENDPOINT_TTL } = require('../../sar-preflight-offline.js');

describe('areaKey(lat, lng)', () => {
  it('rounds to 3 decimal places', () => {
    expect(areaKey(38.6854, -120.9901)).toBe('38.685_-120.990');
  });

  it('handles exact values', () => {
    expect(areaKey(38.0, -121.0)).toBe('38.000_-121.000');
  });

  it('handles negative latitudes', () => {
    expect(areaKey(-33.8688, 151.2093)).toBe('-33.869_151.209');
  });

  it('rounds correctly at boundary (0.0006)', () => {
    expect(areaKey(38.6856, -120.99)).toBe('38.686_-120.990');
  });

  it('nearby points within ~111m produce same key', () => {
    expect(areaKey(38.6851, -120.9902)).toBe(areaKey(38.6854, -120.9899));
  });
});

describe('classifyStaleness(ageMs, ttlMs)', () => {
  const ttl = 30 * 60 * 1000; // 30 min

  it('fresh when age is within TTL', () => {
    expect(classifyStaleness(0, ttl)).toBe('fresh');
    expect(classifyStaleness(ttl - 1, ttl)).toBe('fresh');
    expect(classifyStaleness(ttl, ttl)).toBe('fresh');
  });

  it('stale when age is 1x-4x TTL', () => {
    expect(classifyStaleness(ttl + 1, ttl)).toBe('stale');
    expect(classifyStaleness(ttl * 2, ttl)).toBe('stale');
    expect(classifyStaleness(ttl * 4, ttl)).toBe('stale');
  });

  it('expired when age exceeds 4x TTL', () => {
    expect(classifyStaleness(ttl * 4 + 1, ttl)).toBe('expired');
    expect(classifyStaleness(ttl * 10, ttl)).toBe('expired');
  });

  it('works with different TTL values', () => {
    const shortTtl = 5 * 60 * 1000; // 5 min
    expect(classifyStaleness(4 * 60 * 1000, shortTtl)).toBe('fresh');
    expect(classifyStaleness(6 * 60 * 1000, shortTtl)).toBe('stale');
    expect(classifyStaleness(25 * 60 * 1000, shortTtl)).toBe('expired');
  });

  it('handles zero age', () => {
    expect(classifyStaleness(0, ttl)).toBe('fresh');
  });
});

describe('formatAge(ms)', () => {
  it('formats under 1 minute', () => {
    expect(formatAge(0)).toBe('<1m');
    expect(formatAge(30000)).toBe('<1m');
    expect(formatAge(59999)).toBe('<1m');
  });

  it('formats minutes', () => {
    expect(formatAge(60000)).toBe('1m');
    expect(formatAge(5 * 60000)).toBe('5m');
    expect(formatAge(30 * 60000)).toBe('30m');
    expect(formatAge(59 * 60000)).toBe('59m');
  });

  it('formats hours', () => {
    expect(formatAge(3600000)).toBe('1h');
    expect(formatAge(2 * 3600000)).toBe('2h');
    expect(formatAge(23 * 3600000)).toBe('23h');
  });

  it('formats days', () => {
    expect(formatAge(86400000)).toBe('1d');
    expect(formatAge(7 * 86400000)).toBe('7d');
  });

  it('rounds correctly', () => {
    expect(formatAge(90 * 60000)).toBe('2h'); // 1.5h rounds to 2h
    expect(formatAge(45 * 60000)).toBe('45m');
  });
});

describe('ENDPOINT_TTL', () => {
  it('has TTLs for all endpoints', () => {
    const endpoints = ['weather', 'aqi', 'kp', 'elevation', 'sunrise', 'overpass', 'nws', 'radar_meta'];
    endpoints.forEach(ep => {
      expect(ENDPOINT_TTL[ep]).toBeGreaterThan(0);
    });
  });

  it('NWS has shortest TTL (safety-critical)', () => {
    expect(ENDPOINT_TTL.nws).toBeLessThanOrEqual(ENDPOINT_TTL.weather);
  });

  it('elevation has longest TTL (static data)', () => {
    expect(ENDPOINT_TTL.elevation).toBeGreaterThan(ENDPOINT_TTL.weather);
    expect(ENDPOINT_TTL.elevation).toBeGreaterThan(ENDPOINT_TTL.nws);
  });
});
