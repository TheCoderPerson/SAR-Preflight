const {
  TRAIL_HIGHWAY_TYPES, buildTrailsOverpassQuery, parseOverpassTrails, trailTypeLabel,
  KML_STYLE_DEFS, kmlStyles,
} = require('../../sar-preflight-core.js');
const fixture = require('../fixtures/overpass-trails-response.json');

describe('buildTrailsOverpassQuery(bbox)', () => {
  const q = buildTrailsOverpassQuery('38.5,-121.0,38.8,-120.5');

  it('queries ways only, with all five trail highway types', () => {
    expect(q).toContain('way[');
    for (const t of ['path', 'footway', 'track', 'bridleway', 'cycleway']) {
      expect(q).toContain(t);
    }
    expect(TRAIL_HIGHWAY_TYPES).toHaveLength(5);
  });

  it('requires a name tag and embeds the bbox', () => {
    expect(q).toContain('["name"]');
    expect(q).toContain('(38.5,-121.0,38.8,-120.5)');
  });

  it('uses out geom so way geometry comes back inline', () => {
    expect(q).toContain('out geom');
    expect(q).toContain('[out:json]');
  });
});

describe('parseOverpassTrails(data)', () => {
  const trails = parseOverpassTrails(fixture);

  it('keeps only named trail-type ways with usable geometry', () => {
    // Fixture: named path + named track survive; unnamed path, residential
    // road, single-point footway, and stray node are dropped.
    expect(trails).toHaveLength(2);
    expect(trails.map(t => t.name)).toEqual(['Caples Creek Trail', 'Barrett Lake Jeep Trail']);
  });

  it('emits [lat,lng] coordinate pairs', () => {
    expect(trails[0].coords).toEqual([
      [38.700, -120.600],
      [38.701, -120.599],
      [38.702, -120.598],
    ]);
  });

  it('passes through type, surface, and sac_scale tags', () => {
    expect(trails[0].type).toBe('path');
    expect(trails[0].sacScale).toBe('mountain_hiking');
    expect(trails[0].surface).toBeNull();
    expect(trails[1].type).toBe('track');
    expect(trails[1].surface).toBe('dirt');
    expect(trails[1].sacScale).toBeNull();
  });

  it('carries the OSM way id', () => {
    expect(trails[0].id).toBe(111111);
  });

  it('tolerates empty/missing input', () => {
    expect(parseOverpassTrails(null)).toEqual([]);
    expect(parseOverpassTrails({})).toEqual([]);
    expect(parseOverpassTrails({ elements: [] })).toEqual([]);
  });
});

describe('trailTypeLabel(type)', () => {
  it('maps known highway types to readable labels', () => {
    expect(trailTypeLabel('path')).toBe('Trail (path)');
    expect(trailTypeLabel('footway')).toBe('Footpath');
    expect(trailTypeLabel('track')).toBe('Track / 4WD');
    expect(trailTypeLabel('bridleway')).toBe('Bridleway');
    expect(trailTypeLabel('cycleway')).toBe('Cycleway');
  });

  it('falls back to "Trail" for unknown types', () => {
    expect(trailTypeLabel('via_ferrata')).toBe('Trail');
    expect(trailTypeLabel('')).toBe('Trail');
  });
});

describe('trail KML export style', () => {
  it('defines a trail style (pink #f472b6 in AABBGGRR) that kmlStyles() emits', () => {
    expect(KML_STYLE_DEFS.trail).toEqual({ color: 'ffb672f4', width: 2 });
    expect(kmlStyles()).toContain('<Style id="trail">');
  });
});
