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
});
