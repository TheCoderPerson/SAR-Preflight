const {
  summarizeObstacles, obstacleHazardLevel, obstacleMarkerColor,
  obstacleLabel, obstacleLighting,
} = require('../../sar-preflight-core.js');

// Helper: wrap raw DOF property objects as GeoJSON features
const feat = (props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-120.9, 38.7] }, properties: props });

describe('summarizeObstacles', () => {
  it('returns an empty summary for no features', () => {
    const s = summarizeObstacles([], 400);
    expect(s.total).toBe(0);
    expect(s.maxAgl).toBe(0);
    expect(s.tallCount).toBe(0);
    expect(s.unverified).toBe(0);
  });

  it('handles null/undefined input without throwing', () => {
    expect(summarizeObstacles(null).total).toBe(0);
    expect(summarizeObstacles(undefined).total).toBe(0);
  });

  it('accepts GeoJSON features and raw property objects equivalently', () => {
    const props = { Type_Code: 'TOWER', AGL: 150, AMSL: 600, Verified: 'O', Lighting: 'R' };
    const a = summarizeObstacles([feat(props)], 400);
    const b = summarizeObstacles([props], 400);
    expect(a).toEqual(b);
    expect(a.total).toBe(1);
  });

  it('tracks the tallest obstacle AGL/AMSL and its type', () => {
    const s = summarizeObstacles([
      feat({ Type_Code: 'POLE', AGL: 80, AMSL: 500 }),
      feat({ Type_Code: 'T-L TOWER', AGL: 230, AMSL: 700 }),
      feat({ Type_Code: 'TOWER', AGL: 150, AMSL: 650 }),
    ], 400);
    expect(s.total).toBe(3);
    expect(s.maxAgl).toBe(230);
    expect(s.maxAmsl).toBe(700);
    expect(s.tallestType).toBe('T-L TOWER');
  });

  it('counts obstacles >= 200 ft AGL as tall', () => {
    const s = summarizeObstacles([
      feat({ AGL: 199 }), feat({ AGL: 200 }), feat({ AGL: 405 }),
    ], 400);
    expect(s.tallCount).toBe(2);
  });

  it('counts unverified records (Verified = U)', () => {
    const s = summarizeObstacles([
      feat({ AGL: 100, Verified: 'O' }),
      feat({ AGL: 120, Verified: 'U' }),
      feat({ AGL: 90, Verified: 'u' }),
    ], 400);
    expect(s.unverified).toBe(2);
  });

  it('counts unlit obstacles (lighting None/Unknown/blank)', () => {
    const s = summarizeObstacles([
      feat({ AGL: 100, Lighting: 'R' }),
      feat({ AGL: 100, Lighting: 'N' }),
      feat({ AGL: 100, Lighting: 'U' }),
      feat({ AGL: 100, Lighting: '' }),
      feat({ AGL: 100 }),
    ], 400);
    expect(s.unlit).toBe(4);
  });

  it('builds a type breakdown keyed by upper-case type code', () => {
    const s = summarizeObstacles([
      feat({ Type_Code: 'tower', AGL: 100 }),
      feat({ Type_Code: 'TOWER', AGL: 110 }),
      feat({ Type_Code: 'POLE', AGL: 40 }),
    ], 400);
    expect(s.byType.TOWER).toBe(2);
    expect(s.byType.POLE).toBe(1);
  });

  it('defaults the ceiling to 400 when not supplied or invalid', () => {
    expect(summarizeObstacles([], 0).ceiling).toBe(400);
    expect(summarizeObstacles([]).ceiling).toBe(400);
    expect(summarizeObstacles([], 250).ceiling).toBe(250);
  });

  it('ignores non-numeric heights without corrupting the max', () => {
    const s = summarizeObstacles([
      feat({ AGL: 'n/a' }), feat({ AGL: 175 }),
    ], 400);
    expect(s.maxAgl).toBe(175);
  });
});

describe('obstacleHazardLevel', () => {
  it('is green when there are no obstacles', () => {
    expect(obstacleHazardLevel(summarizeObstacles([], 400))).toBe('green');
    expect(obstacleHazardLevel(null)).toBe('green');
  });

  it('is amber when only short (<200 ft) obstacles are present', () => {
    const s = summarizeObstacles([feat({ AGL: 80 }), feat({ AGL: 150 })], 400);
    expect(obstacleHazardLevel(s)).toBe('amber');
  });

  it('is red when any tall (>=200 ft) obstacle is present', () => {
    const s = summarizeObstacles([feat({ AGL: 80 }), feat({ AGL: 260 })], 400);
    expect(obstacleHazardLevel(s)).toBe('red');
  });
});

describe('obstacleMarkerColor', () => {
  it('is gray for unknown / non-positive height', () => {
    expect(obstacleMarkerColor(0)).toBe('#9ca3af');
    expect(obstacleMarkerColor('x')).toBe('#9ca3af');
    expect(obstacleMarkerColor(undefined)).toBe('#9ca3af');
  });
  it('is yellow below 100 ft, amber 100-199, red >=200', () => {
    expect(obstacleMarkerColor(50)).toBe('#facc15');
    expect(obstacleMarkerColor(150)).toBe('#f59e0b');
    expect(obstacleMarkerColor(200)).toBe('#ef4444');
    expect(obstacleMarkerColor(450)).toBe('#ef4444');
  });
});

describe('obstacleLabel', () => {
  it('title-cases the all-caps DOF type code', () => {
    expect(obstacleLabel({ Type_Code: 'T-L TOWER' })).toBe('T-L Tower');
    expect(obstacleLabel({ Type_Code: 'SOLAR PANELS' })).toBe('Solar Panels');
  });
  it('falls back to "Obstacle" when no type is present', () => {
    expect(obstacleLabel({})).toBe('Obstacle');
    expect(obstacleLabel(null)).toBe('Obstacle');
  });
});

describe('obstacleLighting', () => {
  it('decodes known DOF lighting codes', () => {
    expect(obstacleLighting('R')).toBe('Red');
    expect(obstacleLighting('n')).toBe('None');
    expect(obstacleLighting('C')).toBe('Dual med catenary');
  });
  it('returns Unknown for blank or unrecognized codes', () => {
    expect(obstacleLighting('')).toBe('Unknown');
    expect(obstacleLighting('Z')).toBe('Unknown');
    expect(obstacleLighting(null)).toBe('Unknown');
  });
});
