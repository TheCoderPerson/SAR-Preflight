const {
  lngLatToTileXY, tileXYToQuadkey, quadkeyToTileXY, quadkeyBounds,
  metaQuadkeysForBBox, META_ZOOM,
} = require('../../sar-preflight-raster.js');

// ============================================================
// Bing quadkey round-trip + Meta tile coverage
// ============================================================

describe('tileXYToQuadkey / quadkeyToTileXY', () => {
  it('matches the canonical Bing example (3,5,3 → "213")', () => {
    expect(tileXYToQuadkey(3, 5, 3)).toBe('213');
  });

  it('round-trips x/y/z', () => {
    for (const [x, y, z] of [[0, 0, 1], [83, 196, 9], [511, 0, 9], [123, 456, 10]]) {
      const qk = tileXYToQuadkey(x, y, z);
      expect(qk).toHaveLength(z);
      expect(quadkeyToTileXY(qk)).toEqual({ x, y, z });
    }
  });
});

describe('Meta canopy quadkey for El Dorado County', () => {
  // Verified against the live Meta bucket: (-120.99, 38.685) is tile "023010211".
  it('computes the verified quadkey 023010211 at z9', () => {
    const { x, y } = lngLatToTileXY(-120.99, 38.685, META_ZOOM);
    expect(tileXYToQuadkey(x, y, META_ZOOM)).toBe('023010211');
  });

  it('quadkeyBounds contains the source point', () => {
    const b = quadkeyBounds('023010211');
    expect(b.west).toBeLessThanOrEqual(-120.99);
    expect(b.east).toBeGreaterThanOrEqual(-120.99);
    expect(b.south).toBeLessThanOrEqual(38.685);
    expect(b.north).toBeGreaterThanOrEqual(38.685);
  });

  it('metaQuadkeysForBBox covers the El Dorado point', () => {
    const qks = metaQuadkeysForBBox(-121.0, 38.6, -120.9, 38.7);
    expect(qks).toContain('023010211');
    qks.forEach(qk => expect(qk).toHaveLength(META_ZOOM));
  });

  it('returns the union of tiles spanning a wide bbox', () => {
    const qks = metaQuadkeysForBBox(-122.0, 38.0, -120.0, 39.0);
    expect(qks.length).toBeGreaterThan(1);
    expect(new Set(qks).size).toBe(qks.length); // no duplicates
  });
});
