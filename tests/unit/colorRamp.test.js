const {
  canopyColorRamp, viewshedColorRamp, canopyGridToRGBA, viewshedMaskToRGBA,
} = require('../../sar-preflight-raster.js');

describe('canopyColorRamp', () => {
  it('renders zero / no-data height as fully transparent', () => {
    expect(canopyColorRamp(0)[3]).toBe(0);
    expect(canopyColorRamp(NaN)[3]).toBe(0);
    expect(canopyColorRamp(-5)[3]).toBe(0);
  });
  it('renders positive height as opaque', () => {
    expect(canopyColorRamp(10)[3]).toBe(255);
  });
  it('darkens (lower green channel toward deep green) as height increases', () => {
    const low = canopyColorRamp(2);
    const high = canopyColorRamp(28);
    // red channel falls from tan(237) toward green(13)
    expect(high[0]).toBeLessThan(low[0]);
  });
  it('clamps above 30 m', () => {
    expect(canopyColorRamp(30)).toEqual(canopyColorRamp(100));
  });
});

describe('viewshedColorRamp', () => {
  it('visible to one observer → opaque accent green', () => {
    expect(viewshedColorRamp(1)).toEqual([34, 197, 94, 255]);
  });
  it('not visible → transparent', () => {
    expect(viewshedColorRamp(0)[3]).toBe(0);
  });
  it('overlap steps to darker greens (2 observers, then 3+)', () => {
    const one = viewshedColorRamp(1), two = viewshedColorRamp(2), three = viewshedColorRamp(3);
    expect(two[3]).toBe(255);
    expect(two[1]).toBeLessThan(one[1]);   // darker than single coverage
    expect(three[1]).toBeLessThan(two[1]); // darker still
    expect(viewshedColorRamp(7)).toEqual(three); // clamps at the 3+ tier
  });
  it('bit 128 (selected observer sees the cell) → red tiers', () => {
    expect(viewshedColorRamp(128 | 1)).toEqual([239, 68, 68, 255]); // selected only (red-500)
    expect(viewshedColorRamp(128 | 2)).toEqual([220, 38, 38, 255]); // + 1 other (red-600)
    expect(viewshedColorRamp(128 | 3)).toEqual([185, 28, 28, 255]); // + 2 others (red-700)
    expect(viewshedColorRamp(128 | 7)).toEqual([185, 28, 28, 255]); // clamps at the 2+-others tier
    expect(viewshedColorRamp(128)).toEqual([239, 68, 68, 255]);     // defensive: flag with count 0
  });
});

describe('grid → RGBA buffers', () => {
  const grid = { rows: 2, cols: 2 };
  it('canopyGridToRGBA produces 4 bytes per cell', () => {
    const rgba = canopyGridToRGBA(grid, new Float32Array([0, 5, 10, 0]));
    expect(rgba).toHaveLength(16);
    expect(rgba[3]).toBe(0);     // first cell (height 0) transparent
    expect(rgba[7]).toBe(255);   // second cell (height 5) opaque
  });
  it('viewshedMaskToRGBA maps the mask to alpha', () => {
    const rgba = viewshedMaskToRGBA(grid, new Uint8Array([1, 0, 0, 1]));
    expect(rgba[3]).toBe(255);   // visible
    expect(rgba[7]).toBe(0);     // hidden
  });
  it('viewshedMaskToRGBA renders selected-observer cells red', () => {
    const rgba = viewshedMaskToRGBA(grid, new Uint8Array([128 | 1, 1, 0, 0]));
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([239, 68, 68, 255]); // red-500
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([34, 197, 94, 255]); // green-500
  });
});
