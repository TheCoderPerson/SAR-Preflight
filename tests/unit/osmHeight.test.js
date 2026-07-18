const { parseHeightToMeters, osmTowerHeightFt } = require('../../sar-preflight-core.js');

describe('parseHeightToMeters(raw)', () => {
  it('bare number string is meters', () => {
    expect(parseHeightToMeters('50')).toBe(50);
  });

  it('decimal meters', () => {
    expect(parseHeightToMeters('12.5')).toBe(12.5);
  });

  it('numeric input is meters', () => {
    expect(parseHeightToMeters(30)).toBe(30);
  });

  it('"50 m" and "50m" are meters', () => {
    expect(parseHeightToMeters('50 m')).toBe(50);
    expect(parseHeightToMeters('50m')).toBe(50);
  });

  it('"164 ft" converts to meters', () => {
    expect(parseHeightToMeters('164 ft')).toBeCloseTo(49.99, 1);
  });

  it('"164ft" without space converts', () => {
    expect(parseHeightToMeters('164ft')).toBeCloseTo(49.99, 1);
  });

  it('"164 feet" converts', () => {
    expect(parseHeightToMeters('164 feet')).toBeCloseTo(49.99, 1);
  });

  it("apostrophe feet: \"164'\"", () => {
    expect(parseHeightToMeters("164'")).toBeCloseTo(49.99, 1);
  });

  it('"metres"/"meters" spelled out', () => {
    expect(parseHeightToMeters('20 metres')).toBe(20);
    expect(parseHeightToMeters('20 meters')).toBe(20);
  });

  it('zero -> null (treated as unknown)', () => {
    expect(parseHeightToMeters('0')).toBeNull();
    expect(parseHeightToMeters(0)).toBeNull();
  });

  it('negative -> null', () => {
    expect(parseHeightToMeters('-5')).toBeNull();
    expect(parseHeightToMeters(-5)).toBeNull();
  });

  it('missing/empty -> null', () => {
    expect(parseHeightToMeters(null)).toBeNull();
    expect(parseHeightToMeters(undefined)).toBeNull();
    expect(parseHeightToMeters('')).toBeNull();
    expect(parseHeightToMeters('   ')).toBeNull();
  });

  it('garbage -> null', () => {
    expect(parseHeightToMeters('tall')).toBeNull();
    expect(parseHeightToMeters('approx')).toBeNull();
  });

  it('unknown unit -> null (not silently meters)', () => {
    expect(parseHeightToMeters('50 yd')).toBeNull();
    expect(parseHeightToMeters('50 km')).toBeNull();
  });

  it('NaN/Infinity -> null', () => {
    expect(parseHeightToMeters(NaN)).toBeNull();
    expect(parseHeightToMeters(Infinity)).toBeNull();
  });
});

describe('osmTowerHeightFt(tags)', () => {
  it('height tag in meters -> feet', () => {
    expect(osmTowerHeightFt({ height: '50' })).toEqual({ heightFt: 164, raw: '50' });
  });

  it('height tag already in feet is NOT rescaled', () => {
    // regression: "150 ft" was previously parseFloat'd then multiplied by 3.28
    expect(osmTowerHeightFt({ height: '150 ft' })).toEqual({ heightFt: 150, raw: '150 ft' });
  });

  it('falls back to tower:height', () => {
    expect(osmTowerHeightFt({ 'tower:height': '30' })).toEqual({ heightFt: 98, raw: '30' });
  });

  it('falls back to est_height', () => {
    expect(osmTowerHeightFt({ est_height: '25' })).toEqual({ heightFt: 82, raw: '25' });
  });

  it('height wins over tower:height and est_height', () => {
    const r = osmTowerHeightFt({ height: '10', 'tower:height': '20', est_height: '30' });
    expect(r.heightFt).toBe(33);
  });

  it('unparseable height falls through to next tag', () => {
    const r = osmTowerHeightFt({ height: 'tall', 'tower:height': '20' });
    expect(r.heightFt).toBe(66);
  });

  it('no height tags -> null', () => {
    expect(osmTowerHeightFt({ name: 'KXYZ tower' })).toBeNull();
    expect(osmTowerHeightFt({})).toBeNull();
    expect(osmTowerHeightFt(null)).toBeNull();
  });

  it('height=0 -> null', () => {
    expect(osmTowerHeightFt({ height: '0' })).toBeNull();
  });
});
