const {
  makeGrid, decimateCanopyMesh, canopyMeshIndexed, canopyColorRamp, MAX_GRID, normalFromSlopes,
} = require('../../sar-preflight-raster.js');

describe('normalFromSlopes(dzdx, dzdy)', () => {
  it('flat -> straight up', () => {
    const n = normalFromSlopes(0, 0);
    expect(n[0]).toBeCloseTo(0, 10);
    expect(n[1]).toBeCloseTo(0, 10);
    expect(n[2]).toBeCloseTo(1, 10);
  });

  it('45-degree eastward rise -> normal tilts west', () => {
    const n = normalFromSlopes(1, 0);
    expect(n[0]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('always unit length', () => {
    const n = normalFromSlopes(0.7, -1.3);
    expect(Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)).toBeCloseTo(1, 6);
  });
});

// Small real grid: 8x8 cells over ~800m.
const grid = makeGrid(38.7, -120.9, 400, 100);

const flatCanopy = h => new Float32Array(grid.rows * grid.cols).fill(h);

describe('decimateCanopyMesh(grid, canopyFlat, maxDim)', () => {
  it('grid smaller than maxDim passes through at full resolution', () => {
    const mesh = decimateCanopyMesh(grid, flatCanopy(10), MAX_GRID);
    expect(mesh.rows).toBe(grid.rows);
    expect(mesh.cols).toBe(grid.cols);
    expect(Array.from(mesh.canopy)).toEqual(Array.from(flatCanopy(10)));
  });

  it('larger grid decimates to maxDim', () => {
    const big = makeGrid(38.7, -120.9, 5000, 10); // 512x512 (MAX_GRID cap)
    const canopy = new Float32Array(big.rows * big.cols).fill(5);
    const mesh = decimateCanopyMesh(big, canopy, 128);
    expect(mesh.rows).toBe(128);
    expect(mesh.cols).toBe(128);
  });

  it('decimation MAX-POOLS: a lone tall tree in a block survives', () => {
    const big = makeGrid(38.7, -120.9, 5000, 10);
    const canopy = new Float32Array(big.rows * big.cols); // all clear
    canopy[10 * big.cols + 10] = 42; // one 42m tree
    const mesh = decimateCanopyMesh(big, canopy, 128);
    let max = 0;
    for (let i = 0; i < mesh.canopy.length; i++) max = Math.max(max, mesh.canopy[i]);
    expect(max).toBe(42);
  });

  it('vertex lats descend (row 0 = north) and lngs ascend', () => {
    const mesh = decimateCanopyMesh(grid, flatCanopy(10), MAX_GRID);
    expect(mesh.lats[0]).toBeGreaterThan(mesh.lats[mesh.rows - 1]);
    expect(mesh.lngs[0]).toBeLessThan(mesh.lngs[mesh.cols - 1]);
    expect(mesh.lats[0]).toBeLessThanOrEqual(grid.north);
    expect(mesh.lngs[0]).toBeGreaterThanOrEqual(grid.west);
  });

  it('NaN / negative canopy becomes 0', () => {
    const c = flatCanopy(10);
    c[0] = NaN; c[1] = -3;
    const mesh = decimateCanopyMesh(grid, c, MAX_GRID);
    expect(mesh.canopy[0]).toBe(0);
    expect(mesh.canopy[1]).toBe(0);
  });
});

describe('canopyMeshIndexed(mesh)', () => {
  it('full canopy -> shared vertices + 2 indexed triangles per quad', () => {
    const mesh = decimateCanopyMesh(grid, flatCanopy(10), MAX_GRID);
    const im = canopyMeshIndexed(mesh);
    expect(im.vRow.length).toBe(mesh.rows * mesh.cols); // every grid point shared, once
    expect(im.indices.length).toBe((mesh.rows - 1) * (mesh.cols - 1) * 6);
  });

  it('indices reference registered vertices only', () => {
    const mesh = decimateCanopyMesh(grid, flatCanopy(10), MAX_GRID);
    const im = canopyMeshIndexed(mesh);
    for (const i of im.indices) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(im.vRow.length);
    }
  });

  it('quads emit when ANY corner has canopy; fully-clear regions emit none', () => {
    const c = flatCanopy(0);
    c[0] = 10; // single tree at the NW corner vertex
    const mesh = decimateCanopyMesh(grid, c, MAX_GRID);
    const im = canopyMeshIndexed(mesh);
    expect(im.indices.length).toBe(6); // only the one corner quad
  });

  it('all-zero canopy -> empty mesh', () => {
    const mesh = decimateCanopyMesh(grid, flatCanopy(0), MAX_GRID);
    const im = canopyMeshIndexed(mesh);
    expect(im.indices.length).toBe(0);
    expect(im.vRow.length).toBe(0);
  });

  it('zero-canopy edge vertices fade: alpha 0, non-black tint', () => {
    const c = flatCanopy(0);
    c[0] = 10;
    const mesh = decimateCanopyMesh(grid, c, MAX_GRID);
    const im = canopyMeshIndexed(mesh);
    const zeroIdx = [];
    for (let i = 0; i < im.vCanopy.length; i++) if (im.vCanopy[i] === 0) zeroIdx.push(i);
    expect(zeroIdx.length).toBe(3); // the other three corners of the lone quad
    zeroIdx.forEach(i => {
      expect(im.vColor[i * 4 + 3]).toBe(0);
      expect(im.vColor[i * 4]).toBeGreaterThan(0); // tinted, not black
    });
  });

  it('vertex colors are the 2D ramp normalized to 0..1', () => {
    const mesh = decimateCanopyMesh(grid, flatCanopy(15), MAX_GRID);
    const im = canopyMeshIndexed(mesh);
    const ramp = canopyColorRamp(15);
    expect(im.vColor[0]).toBeCloseTo(ramp[0] / 255, 6);
    expect(im.vColor[1]).toBeCloseTo(ramp[1] / 255, 6);
    expect(im.vColor[2]).toBeCloseTo(ramp[2] / 255, 6);
    expect(im.vColor[3]).toBe(1);
    expect(im.vCanopy[0]).toBe(15);
  });

  it('opts.minH culls near-ground scrub: quads need a corner above the threshold', () => {
    const c = flatCanopy(0);
    c[0] = 1.5; // scrub below the 2m threshold
    c[3 * grid.cols + 3] = 10; // a real tree
    const mesh = decimateCanopyMesh(grid, c, MAX_GRID);
    const im = canopyMeshIndexed(mesh, { minH: 2 });
    // Only the 4 quads around the 10m tree vertex emit; the 1.5m scrub is culled.
    expect(im.indices.length).toBe(4 * 6);
    const unfiltered = canopyMeshIndexed(mesh);
    expect(unfiltered.indices.length).toBe(5 * 6); // scrub corner quad included without minH
  });

  it('opts.color -> single uniform opaque color for every vertex (incl. edges)', () => {
    const c = flatCanopy(0);
    c[0] = 10; // one tree -> quad with three zero-canopy edge verts
    const mesh = decimateCanopyMesh(grid, c, MAX_GRID);
    const im = canopyMeshIndexed(mesh, { color: [0.1, 0.5, 0.2] });
    expect(im.vRow.length).toBe(4);
    for (let i = 0; i < im.vRow.length; i++) {
      expect(im.vColor[i * 4]).toBeCloseTo(0.1, 6);
      expect(im.vColor[i * 4 + 1]).toBeCloseTo(0.5, 6);
      expect(im.vColor[i * 4 + 2]).toBeCloseTo(0.2, 6);
      expect(im.vColor[i * 4 + 3]).toBe(1); // fully opaque, even at zero-canopy edges
    }
  });

  it('full-res 512 grid stays within budget: <=262k verts, <=522k tris', () => {
    const big = makeGrid(38.7, -120.9, 5000, 10); // 512x512
    const canopy = new Float32Array(big.rows * big.cols).fill(5);
    const mesh = decimateCanopyMesh(big, canopy, MAX_GRID);
    const im = canopyMeshIndexed(mesh);
    expect(im.vRow.length).toBeLessThanOrEqual(512 * 512);
    expect(im.indices.length / 3).toBeLessThanOrEqual(511 * 511 * 2);
  });
});
