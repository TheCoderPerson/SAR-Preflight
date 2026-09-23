// Magnetic declination from the World Magnetic Model WMM2025, checked against
// NOAA/NCEI's official WMM2025_TestValues (tests/fixtures/wmm2025-test-values.txt,
// shipped in WMM2025COF.zip). The panel previously used a linear CONUS fit that
// read California as 9.7° W; the model (and BGS) give ~12.6° E.
const fs = require('fs');
const path = require('path');
const { wmmMagneticField, magneticDeclination, formatDeclination, decimalYear } = require('../../sar-preflight-core.js');

const rows = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'wmm2025-test-values.txt'), 'utf8')
  .split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/).map(Number));

describe('wmmMagneticField — official WMM2025 test values', () => {
  it('has the full NOAA table', () => { expect(rows.length).toBe(100); });
  it.each(rows.map(r => [r[0], r[1], r[2], r[3], r]))('%s  alt %s km  (%s, %s)', (year, alt, lat, lon, r) => {
    const f = wmmMagneticField(lat, lon, alt, year);
    expect(Math.abs(f.declination - r[4])).toBeLessThanOrEqual(0.006); // table is rounded to 0.01°
    expect(Math.abs(f.inclination - r[5])).toBeLessThanOrEqual(0.006);
    expect(Math.abs(f.X - r[7])).toBeLessThan(1);   // nT
    expect(Math.abs(f.Y - r[8])).toBeLessThan(1);
    expect(Math.abs(f.Z - r[9])).toBeLessThan(1);
  });
});

describe('declination readout', () => {
  const t = Date.parse('2026-09-22T12:00:00Z');
  it('California (38, −121) ≈ 12.647° E — east is positive', () => {
    expect(magneticDeclination(38, -121, t)).toBeCloseTo(12.647, 2);
    expect(formatDeclination(magneticDeclination(38, -121, t))).toBe('12.6° E');
  });
  it('east of the agonic line reads West', () => {
    expect(formatDeclination(magneticDeclination(40.7, -74.0, t))).toMatch(/° W$/); // New York
  });
  it('flags dates outside the model span', () => {
    expect(wmmMagneticField(38, -121, 0, 2031.2).outOfRange).toBe(true);
    expect(wmmMagneticField(38, -121, 0, 2026.7).outOfRange).toBe(false);
  });
  it('decimalYear', () => {
    expect(decimalYear(Date.UTC(2026, 0, 1))).toBe(2026);
    expect(decimalYear(Date.UTC(2026, 6, 2, 12))).toBeCloseTo(2026.5, 2);
  });
});
