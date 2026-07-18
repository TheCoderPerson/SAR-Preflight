const {
  computeShadowMask, shadowColorRamp, shadowMaskToRGBA, makeGrid,
} = require('../../sar-preflight-raster.js');

// Small square grid helper: n x n cells at 1 m resolution.
function grid1m(n) {
  return { rows: n, cols: n, resM: 1, lat0: 38.7, lng0: -120.9 };
}

const at = (mask, grid, row, col) => mask[row * grid.cols + col];

describe('computeShadowMask', () => {
  it('flat terrain in daylight → nothing shaded', () => {
    const g = grid1m(9);
    const dem = new Float32Array(81); // all zeros
    const mask = computeShadowMask(g, dem, 180, 45);
    expect(Array.from(mask).every(v => v === 0)).toBe(true);
  });

  it('sun at/below the horizon → every known cell fully shaded', () => {
    const g = grid1m(5);
    const dem = new Float32Array(25).fill(10);
    dem[7] = NaN;
    const mask = computeShadowMask(g, dem, 90, 0);
    for (let i = 0; i < 25; i++) {
      if (i === 7) expect(mask[i]).toBe(0); // unknown terrain stays transparent
      else expect(mask[i]).toBe(255);
    }
  });

  it('a spike with sun in the west casts a shadow eastward of ~h/tan(el)', () => {
    const g = grid1m(21);
    const dem = new Float32Array(21 * 21);
    dem[10 * 21 + 5] = 10; // 10 m spike at row 10, col 5
    const mask = computeShadowMask(g, dem, 270, 45); // sun due west, 45° up
    // tan(45°)=1 → shadow reaches ~10 cells east of the spike.
    expect(at(mask, g, 10, 6)).toBe(255);  // deep shadow right behind the spike
    expect(at(mask, g, 10, 10)).toBe(255);
    expect(at(mask, g, 10, 14)).toBeGreaterThan(0); // near the tip, still shaded
    expect(at(mask, g, 10, 17)).toBe(0); // beyond the shadow tip
    expect(at(mask, g, 10, 4)).toBe(0);  // sun side of the spike is lit
    expect(at(mask, g, 5, 5)).toBe(0);   // off the shadow line
  });

  it('shade depth fades toward the shadow tip (soft penumbra, no hard comb)', () => {
    const g = grid1m(21);
    const dem = new Float32Array(21 * 21);
    dem[10 * 21 + 5] = 10;
    const mask = computeShadowMask(g, dem, 270, 45);
    const nearTip = at(mask, g, 10, 14); // ~1 m below the shadow front
    expect(nearTip).toBeGreaterThan(0);
    expect(nearTip).toBeLessThan(255);
    expect(at(mask, g, 10, 10)).toBeGreaterThanOrEqual(nearTip); // deeper = darker
  });

  it('higher sun shortens the shadow', () => {
    const g = grid1m(21);
    const dem = new Float32Array(21 * 21);
    dem[10 * 21 + 5] = 10;
    const low = computeShadowMask(g, dem, 270, 30);
    const high = computeShadowMask(g, dem, 270, 70);
    const count = m => Array.from(m).filter(Boolean).length;
    expect(count(low)).toBeGreaterThan(count(high));
  });

  it('sun in the north casts the shadow southward (row index increases)', () => {
    const g = grid1m(15);
    const dem = new Float32Array(15 * 15);
    dem[3 * 15 + 7] = 5; // spike at row 3, col 7
    const mask = computeShadowMask(g, dem, 0, 45); // sun due north
    expect(at(mask, g, 5, 7)).toBeGreaterThan(0);  // south of the spike
    expect(at(mask, g, 2, 7)).toBe(0);  // north (sun) side lit
    expect(at(mask, g, 3, 8)).toBe(0);  // east of the spike lit
  });

  it('a slope facing away from the sun (steeper than the ray) is self-shaded', () => {
    // Terrain drops 1 m per cell going east; sun due west at 30° (ray descends
    // tan(30°)≈0.58 m per cell) → the whole east-facing downslope is shaded.
    const g = grid1m(11);
    const dem = new Float32Array(11 * 11);
    for (let r = 0; r < 11; r++) for (let c = 0; c < 11; c++) dem[r * 11 + c] = -c;
    const mask = computeShadowMask(g, dem, 270, 30);
    expect(at(mask, g, 5, 5)).toBeGreaterThan(0);
    expect(at(mask, g, 5, 10)).toBeGreaterThan(0);
    // Same slope with the sun steeper than the terrain (60°) → lit.
    const lit = computeShadowMask(g, dem, 270, 60);
    expect(at(lit, g, 5, 5)).toBe(0);
  });

  it('a smooth tilted plane gentler than the sun ray shows zero shade (no aliasing speckle)', () => {
    // Plane descending ESE with a north-south cross-slope, diagonal low sun.
    // Any nonzero cell here would be discretization speckle.
    const n = 64;
    const g = { rows: n, cols: n, resM: 8 };
    const dem = new Float32Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dem[r * n + c] = -0.08 * c * 8 + 0.2 * r * 8;
    const mask = computeShadowMask(g, dem, 290, 15);
    expect(Array.from(mask).every(v => v === 0)).toBe(true);
  });

  it('a wall shadow over cross-sloping terrain has one clean edge per row (striping regression)', () => {
    // Tall wall on the west edge, plane rising southward, low WNW sun — the
    // scenario that produced synchronized vertical stripes with nearest-cell
    // sampling. Each row must be a single shaded run: ≤2 lit/shade transitions.
    const n = 48;
    const g = { rows: n, cols: n, resM: 8 };
    const dem = new Float32Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dem[r * n + c] = 0.35 * r * 8;
    for (let r = 0; r < n; r++) dem[r * n] += 60;
    const mask = computeShadowMask(g, dem, 290, 15);
    for (let r = 0; r < n; r++) {
      let flips = 0;
      for (let c = 2; c < n; c++) {
        if ((mask[r * n + c] > 0) !== (mask[r * n + c - 1] > 0)) flips++;
      }
      expect(flips).toBeLessThanOrEqual(2);
    }
  });

  it('NaN cells neither shade others nor get shaded', () => {
    const g = grid1m(11);
    const dem = new Float32Array(11 * 11);
    dem[5 * 11 + 2] = NaN; // hole west of everything
    const mask = computeShadowMask(g, dem, 270, 45);
    expect(at(mask, g, 5, 2)).toBe(0);
    expect(at(mask, g, 5, 3)).toBe(0); // hole cast no shadow
  });

  it('shadow front carries across a NaN gap', () => {
    const g = grid1m(21);
    const dem = new Float32Array(21 * 21);
    dem[10 * 21 + 5] = 10;   // spike
    dem[10 * 21 + 7] = NaN;  // gap inside the shadow
    const mask = computeShadowMask(g, dem, 270, 45);
    expect(at(mask, g, 10, 7)).toBe(0); // unknown → transparent
    expect(at(mask, g, 10, 8)).toBeGreaterThan(0); // still shaded past the gap
  });

  it('diagonal sun (az 315) shades the diagonal down-light cell', () => {
    const g = grid1m(15);
    const dem = new Float32Array(15 * 15);
    dem[7 * 15 + 7] = 8; // spike at center
    const mask = computeShadowMask(g, dem, 315, 40); // sun in the NW
    // Shadow extends toward the SE (row+, col+).
    expect(at(mask, g, 9, 9)).toBeGreaterThan(0);
    expect(at(mask, g, 5, 5)).toBe(0); // NW (sun) side lit
  });

  it('works with a makeGrid-produced grid', () => {
    const g = makeGrid(38.7, -120.9, 100, 10);
    const dem = new Float32Array(g.rows * g.cols);
    const mid = Math.floor(g.rows / 2) * g.cols + Math.floor(g.cols / 2);
    dem[mid] = 50;
    const mask = computeShadowMask(g, dem, 270, 20);
    expect(mask.length).toBe(g.rows * g.cols);
    expect(Array.from(mask).some(Boolean)).toBe(true);
  });

  it('null dem → all zeros', () => {
    const g = grid1m(3);
    const mask = computeShadowMask(g, null, 180, 45);
    expect(Array.from(mask).every(v => v === 0)).toBe(true);
  });
});

describe('shadowColorRamp / shadowMaskToRGBA', () => {
  it('alpha tracks shade depth; unshaded is transparent', () => {
    expect(shadowColorRamp(255)[3]).toBe(255);
    expect(shadowColorRamp(128)[3]).toBe(128);
    expect(shadowColorRamp(0)).toEqual([0, 0, 0, 0]);
  });

  it('paints RGBA per cell with graded alpha', () => {
    const g = grid1m(2);
    const rgba = shadowMaskToRGBA(g, Uint8Array.from([255, 0, 0, 128]));
    expect(rgba.length).toBe(16);
    expect(rgba[3]).toBe(255);   // cell 0 fully shaded
    expect(rgba[7]).toBe(0);     // cell 1 transparent
    expect(rgba[15]).toBe(128);  // cell 3 half shade
  });
});
