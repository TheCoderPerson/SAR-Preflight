const {
  calcSunPosition, calcMoonPosition, calcMoonPhase, lightVecENU, lightForTime, hillshadeParams,
} = require('../../sar-preflight-core.js');

const LAT = 38.685, LNG = -120.99; // default map center (El Dorado County)

const unitLen = v => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

describe('calcMoonPosition(lat, lng, date)', () => {
  it('returns azimuth 0..360 and elevation -90..90', () => {
    for (let h = 0; h < 24; h += 3) {
      const p = calcMoonPosition(LAT, LNG, new Date(Date.UTC(2026, 6, 18, h)));
      expect(p.azimuth).toBeGreaterThanOrEqual(0);
      expect(p.azimuth).toBeLessThan(360);
      expect(p.elevation).toBeGreaterThanOrEqual(-90);
      expect(p.elevation).toBeLessThanOrEqual(90);
    }
  });

  it('moon rises and sets over a day (elevation crosses the horizon)', () => {
    let above = false, below = false;
    for (let h = 0; h < 25; h++) {
      const p = calcMoonPosition(LAT, LNG, new Date(Date.UTC(2026, 6, 18, h)));
      if (p.elevation > 5) above = true;
      if (p.elevation < -5) below = true;
    }
    expect(above).toBe(true);
    expect(below).toBe(true);
  });

  it('near full moon, the moon is roughly opposite the sun', () => {
    // Scan a lunation for the fullest phase, then compare positions.
    let best = null;
    for (let d = 0; d < 30; d++) {
      const date = new Date(Date.UTC(2026, 6, 1 + d, 6));
      const phase = calcMoonPhase(date).phase;
      const dist = Math.abs(phase - 0.5);
      if (!best || dist < best.dist) best = { date, dist };
    }
    const sun = calcSunPosition(LAT, LNG, best.date);
    const moon = calcMoonPosition(LAT, LNG, best.date);
    // Antipodal within the moon's orbital tilt + daily phase-sample
    // granularity + series truncation.
    expect(Math.abs(sun.elevation + moon.elevation)).toBeLessThan(35);
    const azDiff = Math.abs(((sun.azimuth - moon.azimuth + 540) % 360) - 180);
    expect(azDiff).toBeLessThan(45);
  });
});

describe('lightVecENU(azimuth, elevation)', () => {
  it('north horizon -> +Y', () => {
    const v = lightVecENU(0, 0);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(1, 6);
    expect(v[2]).toBeCloseTo(0, 6);
  });

  it('east horizon -> +X', () => {
    const v = lightVecENU(90, 0);
    expect(v[0]).toBeCloseTo(1, 6);
    expect(v[1]).toBeCloseTo(0, 6);
  });

  it('zenith -> +Z', () => {
    expect(lightVecENU(180, 90)[2]).toBeCloseTo(1, 6);
  });

  it('always unit length', () => {
    expect(unitLen(lightVecENU(123, 45))).toBeCloseTo(1, 6);
  });
});

describe('lightForTime(lat, lng, date)', () => {
  it('local summer noon -> sun light from high in the sky', () => {
    const noon = new Date(Date.UTC(2026, 6, 18, 20)); // 13:00 PDT
    const l = lightForTime(LAT, LNG, noon);
    expect(l.source).toBe('sun');
    expect(l.dir[2]).toBeGreaterThan(0.5);
    expect(unitLen(l.dir)).toBeCloseTo(1, 6);
  });

  it('source always matches sun elevation; params stay in sane ranges', () => {
    for (let h = 0; h < 24; h++) {
      const date = new Date(Date.UTC(2026, 6, 18, h));
      const l = lightForTime(LAT, LNG, date);
      expect(['sun', 'moon', 'ambient']).toContain(l.source);
      const sunUp = calcSunPosition(LAT, LNG, date).elevation > 0;
      expect(l.source === 'sun').toBe(sunUp);
      expect(unitLen(l.dir)).toBeCloseTo(1, 6);
      expect(l.dir[2]).toBeGreaterThanOrEqual(0); // light never comes from underground
      expect(l.diffuse).toBeGreaterThan(0);
      expect(l.diffuse).toBeLessThanOrEqual(0.6);
      expect(l.ambient).toBeGreaterThanOrEqual(0.35);
      expect(l.ambient).toBeLessThanOrEqual(0.45);
    }
  });

  it('moonlight is dimmer than sunlight', () => {
    let moonDiffuse = null;
    for (let h = 0; h < 24; h++) {
      const l = lightForTime(LAT, LNG, new Date(Date.UTC(2026, 6, 18, h)));
      if (l.source === 'moon') moonDiffuse = l.diffuse;
    }
    if (moonDiffuse != null) expect(moonDiffuse).toBeLessThan(0.6);
  });
});

describe('hillshadeParams(light)', () => {
  it('recovers the light azimuth from the ENU direction', () => {
    const hs = hillshadeParams({ source: 'sun', dir: lightVecENU(247, 30) });
    expect(hs.azimuth).toBeCloseTo(247, 3);
  });

  it('overhead sun shades subtly, horizon sun shades strongly', () => {
    const noon = hillshadeParams({ source: 'sun', dir: lightVecENU(180, 90) });
    const sunset = hillshadeParams({ source: 'sun', dir: lightVecENU(285, 2) });
    expect(noon.exaggeration).toBeCloseTo(0.25, 2);
    expect(sunset.exaggeration).toBeGreaterThan(0.7);
  });

  it('moonlight shades at reduced strength vs the same-elevation sun', () => {
    const sun = hillshadeParams({ source: 'sun', dir: lightVecENU(180, 30) });
    const moon = hillshadeParams({ source: 'moon', dir: lightVecENU(180, 30) });
    expect(moon.exaggeration).toBeLessThan(sun.exaggeration);
  });

  it('ambient / missing light -> faint default-direction relief', () => {
    expect(hillshadeParams({ source: 'ambient', dir: [0, 0, 1] })).toEqual({ azimuth: 335, exaggeration: 0.15 });
    expect(hillshadeParams(null)).toEqual({ azimuth: 335, exaggeration: 0.15 });
  });
});
