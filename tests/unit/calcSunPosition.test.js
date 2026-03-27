const { calcSunPosition } = require('../../sar-preflight-core.js');

describe('calcSunPosition(lat, lng)', () => {
  beforeEach(() => {
    // 2026-03-25T12:00:00-07:00 (noon PDT) = 2026-03-25T19:00:00Z
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T19:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an object with elevation and azimuth', () => {
    const pos = calcSunPosition(38.685, -120.99);
    expect(pos).toHaveProperty('elevation');
    expect(pos).toHaveProperty('azimuth');
  });

  it('elevation is between 40 and 65 degrees at midday near equinox', () => {
    const pos = calcSunPosition(38.685, -120.99);
    expect(pos.elevation).toBeGreaterThan(40);
    expect(pos.elevation).toBeLessThan(65);
  });

  it('azimuth is between 0 and 360', () => {
    const pos = calcSunPosition(38.685, -120.99);
    expect(pos.azimuth).toBeGreaterThanOrEqual(0);
    expect(pos.azimuth).toBeLessThanOrEqual(360);
  });

  it('elevation and azimuth are numbers (not NaN)', () => {
    const pos = calcSunPosition(38.685, -120.99);
    expect(Number.isNaN(pos.elevation)).toBe(false);
    expect(Number.isNaN(pos.azimuth)).toBe(false);
  });

  it('sun should be roughly in the southern sky at noon (azimuth near 180)', () => {
    const pos = calcSunPosition(38.685, -120.99);
    // At noon PDT in northern hemisphere near equinox, azimuth should be roughly south
    expect(pos.azimuth).toBeGreaterThan(140);
    expect(pos.azimuth).toBeLessThan(230);
  });

  it('elevation differs by latitude', () => {
    const tropical = calcSunPosition(10, -120.99);
    const temperate = calcSunPosition(50, -120.99);
    // Closer to equator should have higher elevation near equinox
    expect(tropical.elevation).toBeGreaterThan(temperate.elevation);
  });

  it('handles equator', () => {
    const pos = calcSunPosition(0, 0);
    expect(typeof pos.elevation).toBe('number');
    expect(typeof pos.azimuth).toBe('number');
  });

  it('handles north pole', () => {
    const pos = calcSunPosition(90, 0);
    expect(typeof pos.elevation).toBe('number');
    expect(typeof pos.azimuth).toBe('number');
  });

  it('handles south pole', () => {
    const pos = calcSunPosition(-90, 0);
    expect(typeof pos.elevation).toBe('number');
    expect(typeof pos.azimuth).toBe('number');
  });

  it('handles negative longitude', () => {
    const pos = calcSunPosition(38.685, -120.99);
    expect(typeof pos.elevation).toBe('number');
    expect(typeof pos.azimuth).toBe('number');
  });
});
