// Canopy edit ops — pure functions (sar-preflight-raster.js).
// Edits are stored as geographic operations (delete polygons + paint strokes)
// and must replay identically onto ANY grid (overlay, viewshed, export).
const {
  makeGrid, gridColToLng, gridRowToLat, latLngToCell,
  CANOPY_PAINT_DEFAULT_M, canopyAvgHeight, canopyStampBrush, canopyDiffToSparse,
  canopyApplyStroke, canopyApplyDelete, canopyRevertDiff, canopyOpBBox, canopyApplyOps,
} = require('../../sar-preflight-raster.js');
const { pointInPolygon } = require('../../sar-preflight-core.js');

// 50×50 grid, 10 m cells, centered on El Dorado County.
const mkGrid = () => makeGrid(38.7, -120.99, 250, 10);

describe('canopyAvgHeight', () => {
  it('averages only finite positive cells', () => {
    const { avgM, count } = canopyAvgHeight(new Float32Array([NaN, 0, 10, 20, -5]));
    expect(count).toBe(2);
    expect(avgM).toBeCloseTo(15, 6);
  });
  it('falls back to the default paint height when there are no trees', () => {
    const { avgM, count } = canopyAvgHeight(new Float32Array(9));
    expect(count).toBe(0);
    expect(avgM).toBe(CANOPY_PAINT_DEFAULT_M);
  });
});

describe('canopyStampBrush', () => {
  it('paints exactly the cells whose centers fall within the radius', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols);
    const lat = gridRowToLat(grid, 25), lng = gridColToLng(grid, 25);
    canopyStampBrush(grid, flat, lat, lng, 25, 12, null);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const dy = (gridRowToLat(grid, r) - lat) * grid.mPerDegLat;
        const dx = (gridColToLng(grid, c) - lng) * grid.mPerDegLng;
        const inside = dx * dx + dy * dy <= 25 * 25;
        expect(flat[r * grid.cols + c]).toBe(inside ? 12 : 0);
      }
    }
  });

  it('paints at least the containing cell when the radius is smaller than a cell', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols);
    const lat = gridRowToLat(grid, 10), lng = gridColToLng(grid, 40);
    const n = canopyStampBrush(grid, flat, lat, lng, 1, 8, null);
    expect(n).toBe(1);
    expect(flat[10 * grid.cols + 40]).toBe(8);
  });

  it('paints nothing when the point is outside the grid', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols);
    const n = canopyStampBrush(grid, flat, 40.0, -119.0, 10, 8, null);
    expect(n).toBe(0);
    expect(flat.every(v => v === 0)).toBe(true);
  });

  it('records first-touch old values into the diff (re-stamps keep the original)', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols).fill(3);
    const lat = gridRowToLat(grid, 25), lng = gridColToLng(grid, 25);
    const diff = new Map();
    canopyStampBrush(grid, flat, lat, lng, 15, 10, diff);
    canopyStampBrush(grid, flat, lat, lng, 15, 20, diff); // overwrite same cells
    const { col, row } = latLngToCell(grid, lat, lng);
    const idx = row * grid.cols + col;
    expect(flat[idx]).toBe(20);
    expect(diff.get(idx)).toBe(3); // pre-STROKE value, not the intermediate 10
  });
});

describe('canopyApplyStroke', () => {
  it('leaves no gaps between widely spaced points (segment interpolation)', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols);
    const lat = gridRowToLat(grid, 25);
    // Two points 300 m apart along one row, brush radius 8 m (< cell size)
    const pts = [[lat, gridColToLng(grid, 10)], [lat, gridColToLng(grid, 40)]];
    canopyApplyStroke(grid, flat, pts, 8, 14);
    for (let c = 10; c <= 40; c++) expect(flat[25 * grid.cols + c]).toBe(14);
  });

  it('returns a sparse diff that reverts the whole stroke', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols).fill(5);
    const before = flat.slice();
    const lat = gridRowToLat(grid, 25);
    const diff = canopyApplyStroke(grid, flat, [[lat, gridColToLng(grid, 5)], [lat, gridColToLng(grid, 45)]], 20, 12);
    expect(diff.indices.length).toBeGreaterThan(0);
    canopyRevertDiff(flat, diff);
    expect(Array.from(flat)).toEqual(Array.from(before));
  });
});

describe('canopyApplyDelete', () => {
  // Polygon covering roughly the NW quadrant of the grid.
  const quadPoly = (grid) => {
    const midLat = (grid.north + grid.south) / 2, midLng = (grid.west + grid.east) / 2;
    return [[grid.north + 0.001, grid.west - 0.001], [grid.north + 0.001, midLng],
            [midLat, midLng], [midLat, grid.west - 0.001]];
  };

  it('zeroes tree cells inside the polygon and leaves the outside untouched', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols).fill(17);
    const poly = quadPoly(grid);
    const diff = canopyApplyDelete(grid, flat, poly, pointInPolygon);
    let zeroed = 0;
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const inside = pointInPolygon(gridRowToLat(grid, r), gridColToLng(grid, c), poly);
        expect(flat[r * grid.cols + c]).toBe(inside ? 0 : 17);
        if (inside) zeroed++;
      }
    }
    expect(zeroed).toBeGreaterThan(0);
    expect(diff.indices.length).toBe(zeroed);
  });

  it('only records previously-nonzero cells and reverts exactly', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols); // mostly empty
    flat[0] = 9; // one tree in the NW corner (inside the quadrant polygon)
    const before = flat.slice();
    const diff = canopyApplyDelete(grid, flat, quadPoly(grid), pointInPolygon);
    expect(diff.indices.length).toBe(1);
    expect(diff.indices[0]).toBe(0);
    expect(diff.oldValues[0]).toBe(9);
    canopyRevertDiff(flat, diff);
    expect(Array.from(flat)).toEqual(Array.from(before));
  });
});

describe('canopyOpBBox', () => {
  it('is the polygon bbox for delete ops', () => {
    const bb = canopyOpBBox({ t: 'del', poly: [[38.1, -121.0], [38.2, -120.9], [38.15, -120.95]] });
    expect(bb).toEqual({ west: -121.0, south: 38.1, east: -120.9, north: 38.2 });
  });
  it('inflates paint strokes by the brush radius', () => {
    const bb = canopyOpBBox({ t: 'paint', pts: [[38.7, -120.99]], rM: 111.32 });
    expect(bb.north - 38.7).toBeCloseTo(0.001, 6);
    expect(38.7 - bb.south).toBeCloseTo(0.001, 6);
    expect(bb.east).toBeGreaterThan(-120.99);
    expect(bb.west).toBeLessThan(-120.99);
  });
  it('returns null for empty/malformed ops', () => {
    expect(canopyOpBBox(null)).toBe(null);
    expect(canopyOpBBox({ t: 'del', poly: [] })).toBe(null);
    expect(canopyOpBBox({ t: 'paint' })).toBe(null);
  });
});

describe('canopyApplyOps — cross-grid replay', () => {
  it('applies the same geographic edit on grids of different resolution', () => {
    const overlayGrid = makeGrid(38.7, -120.99, 250, 10); // 50×50 @ 10 m
    const viewshedGrid = makeGrid(38.7005, -120.9895, 150, 3); // offset, 3 m cells
    const targetLat = 38.7, targetLng = -120.99;
    const d = 0.0005; // ~55 m half-width delete box around the target
    const ops = [{ t: 'del', poly: [[targetLat + d, targetLng - d], [targetLat + d, targetLng + d], [targetLat - d, targetLng + d], [targetLat - d, targetLng - d]] }];
    for (const grid of [overlayGrid, viewshedGrid]) {
      const flat = new Float32Array(grid.rows * grid.cols).fill(20);
      const n = canopyApplyOps(grid, flat, ops, pointInPolygon);
      expect(n).toBe(1);
      const { col, row } = latLngToCell(grid, targetLat, targetLng);
      expect(flat[row * grid.cols + col]).toBe(0); // tree at the target is gone
      expect(flat[0]).toBe(20); // far corner untouched
    }
  });

  it('skips ops whose bbox does not intersect the grid', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols).fill(20);
    const ops = [
      { t: 'del', poly: [[40.0, -119.0], [40.1, -119.0], [40.05, -118.9]] }, // far away
      { t: 'paint', pts: [[45.0, -100.0]], rM: 10, hM: 5 },
    ];
    expect(canopyApplyOps(grid, flat, ops, pointInPolygon)).toBe(0);
    expect(flat.every(v => v === 20)).toBe(true);
  });

  it('replays in order — a later paint restores trees a delete removed', () => {
    const grid = mkGrid();
    const flat = new Float32Array(grid.rows * grid.cols).fill(20);
    const lat = gridRowToLat(grid, 25), lng = gridColToLng(grid, 25);
    const d = 0.0004;
    const poly = [[lat + d, lng - d], [lat + d, lng + d], [lat - d, lng + d], [lat - d, lng - d]];
    const n = canopyApplyOps(grid, flat, [
      { t: 'del', poly },
      { t: 'paint', pts: [[lat, lng]], rM: 12, hM: 7 },
    ], pointInPolygon);
    expect(n).toBe(2);
    expect(flat[25 * grid.cols + 25]).toBe(7); // painted back over the deletion
  });
});

describe('canopyDiffToSparse', () => {
  it('converts a Map diff into aligned typed arrays', () => {
    const sparse = canopyDiffToSparse(new Map([[3, 1.5], [7, 0]]));
    expect(Array.from(sparse.indices)).toEqual([3, 7]);
    expect(Array.from(sparse.oldValues)).toEqual([1.5, 0]);
  });
  it('handles null/empty input', () => {
    expect(canopyDiffToSparse(null).indices.length).toBe(0);
  });
});
