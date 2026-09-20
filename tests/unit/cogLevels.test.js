// COG level selection + cloud mask for the CHMv2 canopy tiles (pure helpers).
//
// A CHMv2 tile's IFDs are INTERLEAVED: [data 32768, MASK 32768, data 16384 …
// 512, mask 16384 … 512] (verified on tile 0230102111). The old "walk the
// IFDs by index until the window fits" would have read a 1-bit cloud mask as
// canopy heights on any view that did not fit the full-res level.
const { cogPickLevel, cogMaskLevelFor, applyCloudMask } = require('../../sar-preflight-raster.js');

const d = (w) => ({ width: w, height: w, mask: false });
const m = (w) => ({ width: w, height: w, mask: true });
const V2 = [d(32768), m(32768), d(16384), d(8192), d(4096), d(2048), d(1024), d(512),
            m(16384), m(8192), m(4096), m(2048), m(1024), m(512)];
const V1 = [d(65536)]; // the old stripped tile: one IFD, no overviews, no mask

// A z10 tile is ~39.1 km across; the AOI window as a fraction of the tile.
const TILE_M = 39136;
const frac = (aoiM) => aoiM / TILE_M;
const MAX_PX = 1024;

describe('cogPickLevel', () => {
  it('reads full resolution when the AOI window fits', () => {
    expect(cogPickLevel(V2, frac(500), frac(500), MAX_PX)).toBe(0);
  });

  it('skips the full-res MASK and takes the first data overview that fits (2.2 km view)', () => {
    // 32768 × 0.056 = 1842 px > 1024 → index 1 is the mask (same size) → 16384 → 921 px
    const i = cogPickLevel(V2, frac(2200), frac(2200), MAX_PX);
    expect(i).toBe(2);
    expect(V2[i].mask).toBe(false);
  });

  it('picks the 2048 level for a 12 km view', () => {
    expect(cogPickLevel(V2, frac(12000), frac(12000), MAX_PX)).toBe(5);
  });

  it('never returns a mask level across the whole range of window sizes', () => {
    for (let aoi = 100; aoi <= 2 * TILE_M; aoi += 250) {
      const i = cogPickLevel(V2, frac(aoi), frac(aoi), MAX_PX);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(V2[i].mask).toBe(false);
    }
  });

  it('uses the larger of the two window fractions', () => {
    expect(cogPickLevel(V2, frac(500), frac(2200), MAX_PX)).toBe(2);
  });

  it('falls back to the coarsest data level when nothing fits (whole-tile window at a small cap)', () => {
    expect(cogPickLevel(V2, 1, 1, 100)).toBe(7);
  });

  it('a v1-style single-IFD tile always returns 0 (fits or not)', () => {
    expect(cogPickLevel(V1, frac(500), frac(500), MAX_PX)).toBe(0);
    expect(cogPickLevel(V1, 1, 1, MAX_PX)).toBe(0);
  });

  it('returns -1 when there is no data level at all', () => {
    expect(cogPickLevel([m(512)], 0.1, 0.1, MAX_PX)).toBe(-1);
    expect(cogPickLevel([], 0.1, 0.1, MAX_PX)).toBe(-1);
  });
});

describe('cogMaskLevelFor', () => {
  it('finds the mask with the same dimensions as the chosen data level', () => {
    expect(cogMaskLevelFor(V2, 0)).toBe(1);
    expect(cogMaskLevelFor(V2, 2)).toBe(8);
    expect(cogMaskLevelFor(V2, 7)).toBe(13);
  });
  it('is -1 for a tile without masks or an invalid index', () => {
    expect(cogMaskLevelFor(V1, 0)).toBe(-1);
    expect(cogMaskLevelFor(V2, 99)).toBe(-1);
    expect(cogMaskLevelFor(V2, -1)).toBe(-1);
  });
});

describe('applyCloudMask', () => {
  it('turns mask==0 cells into NaN and reports the count', () => {
    const data = new Float32Array([1, 2, 3, 4]);
    const n = applyCloudMask(data, new Uint8Array([1, 0, 1, 0]));
    expect(n).toBe(2);
    expect(data[0]).toBe(1);
    expect(Number.isNaN(data[1])).toBe(true);
    expect(data[2]).toBe(3);
    expect(Number.isNaN(data[3])).toBe(true);
  });
  it('leaves data alone with an all-clear mask or no mask', () => {
    const data = new Float32Array([1, 2]);
    expect(applyCloudMask(data, new Uint8Array([1, 255]))).toBe(0);
    expect(applyCloudMask(data, null)).toBe(0);
    expect(Array.from(data)).toEqual([1, 2]);
  });
  it('only touches the overlapping length when the mask is shorter', () => {
    const data = new Float32Array([5, 6, 7]);
    expect(applyCloudMask(data, new Uint8Array([0]))).toBe(1);
    expect(Number.isNaN(data[0])).toBe(true);
    expect(data[2]).toBe(7);
  });
});
