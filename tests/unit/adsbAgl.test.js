const { parseAdsbAircraft } = require('../../sar-preflight-core.js');

// Two aircraft at the same barometric altitude but over very different terrain.
const AC = [
  { hex: 'a1', flight: 'VALLEY  ', lat: 38.50, lon: -121.00, alt_baro: 5000 },
  { hex: 'a2', flight: 'RIDGE   ', lat: 38.90, lon: -120.20, alt_baro: 5000 },
];

describe('parseAdsbAircraft AGL', () => {
  it('uses a fixed elevation (legacy single-point behaviour) when given a number', () => {
    const out = parseAdsbAircraft(AC, 38.7, -120.6, 1000);
    expect(out.every(a => a.agl === 4000)).toBe(true);   // 5000 - 1000
    expect(out.every(a => a.groundElevFt === 1000)).toBe(true);
  });

  it('computes per-aircraft AGL from a terrain function (ground under the plane)', () => {
    // Valley floor ~100 ft; ridge ~4000 ft.
    const groundFn = (lat, lng) => (lat < 38.7 ? 100 : 4000);
    const out = parseAdsbAircraft(AC, 38.7, -120.6, groundFn);
    const valley = out.find(a => a.hex === 'a1');
    const ridge = out.find(a => a.hex === 'a2');
    expect(valley.groundElevFt).toBe(100);
    expect(valley.agl).toBe(4900);     // 5000 - 100
    expect(ridge.groundElevFt).toBe(4000);
    expect(ridge.agl).toBe(1000);      // 5000 - 4000  (same MSL, far lower AGL)
  });

  it('never returns negative AGL and treats a missing terrain value as 0 ft ground', () => {
    const groundFn = () => null;       // DEM has no data
    const out = parseAdsbAircraft(
      [{ hex: 'b1', lat: 38.5, lon: -121.0, alt_baro: -200 }], 38.5, -121.0, groundFn);
    expect(out[0].groundElevFt).toBe(0);
    expect(out[0].agl).toBe(0);        // clamped, not negative
  });

  it("keeps MSL (alt_baro) untouched while AGL is terrain-relative", () => {
    const groundFn = () => 3000;
    const out = parseAdsbAircraft(AC, 38.7, -120.6, groundFn);
    expect(out.every(a => a.alt_baro === 5000)).toBe(true);  // MSL unchanged
    expect(out.every(a => a.agl === 2000)).toBe(true);       // AGL terrain-relative
  });
});
