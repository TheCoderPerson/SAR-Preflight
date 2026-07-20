const {
  labelMaskComponents, traceLabelRings, simplifyRing, viewshedToPolygons,
  viewshedPolygonDescription, makeGrid,
  VIEWSHED_POLY_TOL_CELLS, VIEWSHED_POLY_MIN_BLOB_CELLS, VIEWSHED_POLY_MIN_HOLE_CELLS,
} = require('../../sar-preflight-raster.js');
const { kmlRingFromLatLng, kmlPolygonPlacemark, geojsonPolygonGeometry } = require('../../sar-preflight-core.js');

// Build a Uint8Array mask from an ASCII picture ('X' = visible).
function maskFromRows(rows) {
  const mask = new Uint8Array(rows.length * rows[0].length);
  rows.forEach((line, r) => {
    for (let c = 0; c < line.length; c++) if (line[c] === 'X') mask[r * line.length + c] = 1;
  });
  return mask;
}

// ============================================================
// labelMaskComponents
// ============================================================

describe('labelMaskComponents(mask, rows, cols)', () => {
  it('empty mask -> zero components', () => {
    const out = labelMaskComponents(new Uint8Array(16), 4, 4);
    expect(out.count).toBe(0);
    expect(Array.from(out.labels)).toEqual(new Array(16).fill(0));
  });

  it('labels one blob with its area', () => {
    const mask = maskFromRows(['....', '.XX.', '.XX.', '....']);
    const out = labelMaskComponents(mask, 4, 4);
    expect(out.count).toBe(1);
    expect(out.areas[1]).toBe(4);
    expect(out.labels[1 * 4 + 1]).toBe(1);
    expect(out.labels[2 * 4 + 2]).toBe(1);
    expect(out.labels[0]).toBe(0);
  });

  it('diagonal-only cells are separate components (4-connectivity)', () => {
    const mask = maskFromRows(['X..', '.X.', '...']);
    const out = labelMaskComponents(mask, 3, 3);
    expect(out.count).toBe(2);
    expect(out.areas[1]).toBe(1);
    expect(out.areas[2]).toBe(1);
  });

  it('treats any value >= 1 as visible (composite observer counts)', () => {
    const mask = new Uint8Array(9);
    mask[4] = 3;
    const out = labelMaskComponents(mask, 3, 3);
    expect(out.count).toBe(1);
    expect(out.areas[1]).toBe(1);
  });
});

// ============================================================
// traceLabelRings — [col,row] lattice vertices, outers negative shoelace
// ============================================================

describe('traceLabelRings(labels, rows, cols, label)', () => {
  it('single cell -> one outer ring of its 4 corners, areaCells 1 (pins the sign convention)', () => {
    const { labels } = labelMaskComponents(maskFromRows(['...', '.X.', '...']), 3, 3);
    const rings = traceLabelRings(labels, 3, 3, 1);
    expect(rings).toHaveLength(1);
    expect(rings[0].isOuter).toBe(true);
    expect(rings[0].areaCells).toBe(1);
    const verts = rings[0].ring.map(v => v.join(',')).sort();
    expect(verts).toEqual(['1,1', '1,2', '2,1', '2,2']);
  });

  it('solid 3x3 block -> outer ring reduced to 4 corner vertices (collinear merge)', () => {
    const { labels } = labelMaskComponents(
      maskFromRows(['.....', '.XXX.', '.XXX.', '.XXX.', '.....']), 5, 5);
    const rings = traceLabelRings(labels, 5, 5, 1);
    expect(rings).toHaveLength(1);
    expect(rings[0].ring).toHaveLength(4);
    expect(rings[0].areaCells).toBe(9);
    const verts = rings[0].ring.map(v => v.join(',')).sort();
    expect(verts).toEqual(['1,1', '1,4', '4,1', '4,4']);
  });

  it('hollow 3x3 -> outer (areaCells 9, hole area included) + hole ring (areaCells 1)', () => {
    const { labels } = labelMaskComponents(
      maskFromRows(['.....', '.XXX.', '.X.X.', '.XXX.', '.....']), 5, 5);
    const rings = traceLabelRings(labels, 5, 5, 1);
    expect(rings).toHaveLength(2);
    const outer = rings.find(r => r.isOuter), hole = rings.find(r => !r.isOuter);
    expect(outer.areaCells).toBe(9);
    expect(hole.areaCells).toBe(1);
  });

  it('diagonal-pinch component: rings close and signed areas reconcile to the cell count', () => {
    // All cells except (1,1) and (2,2): background touches the notch diagonally
    // through lattice vertex (2,2) — the two-outgoing-edges case.
    const { labels } = labelMaskComponents(maskFromRows(['XXX', 'X.X', 'XX.']), 3, 3);
    const rings = traceLabelRings(labels, 3, 3, 1);
    rings.forEach(r => expect(r.ring.length).toBeGreaterThanOrEqual(3));
    const net = rings.reduce((s, r) => s + (r.isOuter ? r.areaCells : -r.areaCells), 0);
    expect(net).toBe(7);
  });
});

// ============================================================
// simplifyRing — closed-ring Douglas-Peucker in cell space
// ============================================================

// 10-step staircase along the diagonal (0,0)->(10,10), closed via corner (0,10).
function staircaseRing() {
  const ring = [];
  for (let i = 0; i < 10; i++) ring.push([i, i], [i + 1, i]);
  ring.push([10, 10], [0, 10]);
  return ring;
}

describe('simplifyRing(ring, tol)', () => {
  it('keeps a plain square unchanged', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(simplifyRing(sq, VIEWSHED_POLY_TOL_CELLS)).toHaveLength(4);
  });

  it('collapses a staircase at the default tolerance (corners deviate ~0.7 cells)', () => {
    const out = simplifyRing(staircaseRing(), VIEWSHED_POLY_TOL_CELLS);
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('retains the staircase at a tight tolerance', () => {
    const out = simplifyRing(staircaseRing(), 0.1);
    expect(out.length).toBeGreaterThan(15);
  });

  it('degenerates to null (collinear ring; huge tolerance)', () => {
    expect(simplifyRing([[0, 0], [1, 0], [2, 0]], 1)).toBeNull();
    expect(simplifyRing([[0, 0], [10, 0], [10, 10], [0, 10]], 100)).toBeNull();
  });

  it('rejects rings with fewer than 3 vertices', () => {
    expect(simplifyRing([[0, 0], [1, 1]], 1)).toBeNull();
    expect(simplifyRing(null, 1)).toBeNull();
  });
});

// ============================================================
// viewshedToPolygons — mask -> low-poly [lat,lng] polygons
// ============================================================

describe('viewshedToPolygons(grid, mask, opts)', () => {
  const grid = makeGrid(38.7, -120.9, 100, 10); // 20x20 cells

  it('returns [] for null/empty inputs', () => {
    expect(viewshedToPolygons(null, new Uint8Array(4))).toEqual([]);
    expect(viewshedToPolygons(grid, null)).toEqual([]);
    expect(viewshedToPolygons(grid, new Uint8Array(grid.rows * grid.cols))).toEqual([]);
  });

  it('square blob -> one part with vertices on cell EDGES (not the +0.5 centres)', () => {
    const mask = new Uint8Array(grid.rows * grid.cols);
    for (let r = 2; r <= 5; r++) for (let c = 3; c <= 6; c++) mask[r * grid.cols + c] = 1;
    const parts = viewshedToPolygons(grid, mask, { minBlobCells: 1, minBlobFrac: 0 });
    expect(parts).toHaveLength(1);
    expect(parts[0].areaCells).toBe(16);
    expect(parts[0].areaM2).toBeCloseTo(16 * grid.resM * grid.resM, 6);
    const lngSpan = grid.east - grid.west, latSpan = grid.north - grid.south;
    const lngs = parts[0].rings[0].map(p => p[1]);
    const lats = parts[0].rings[0].map(p => p[0]);
    expect(Math.min(...lngs)).toBeCloseTo(grid.west + (3 / grid.cols) * lngSpan, 10);
    expect(Math.max(...lngs)).toBeCloseTo(grid.west + (7 / grid.cols) * lngSpan, 10);
    expect(Math.max(...lats)).toBeCloseTo(grid.north - (2 / grid.rows) * latSpan, 10);
    expect(Math.min(...lats)).toBeCloseTo(grid.north - (6 / grid.rows) * latSpan, 10);
  });

  it('large hole survives as an inner ring', () => {
    const mask = new Uint8Array(grid.rows * grid.cols);
    for (let r = 2; r <= 12; r++) for (let c = 2; c <= 12; c++) mask[r * grid.cols + c] = 1;
    for (let r = 5; r <= 9; r++) for (let c = 5; c <= 9; c++) mask[r * grid.cols + c] = 0; // 25-cell hole
    const parts = viewshedToPolygons(grid, mask, { minBlobCells: 1, minBlobFrac: 0 });
    expect(parts).toHaveLength(1);
    expect(parts[0].rings).toHaveLength(2);
    expect(parts[0].areaCells).toBe(121 - 25);
  });

  it('small hole is filled (below minHoleCells)', () => {
    const mask = new Uint8Array(grid.rows * grid.cols);
    for (let r = 2; r <= 12; r++) for (let c = 2; c <= 12; c++) mask[r * grid.cols + c] = 1;
    mask[7 * grid.cols + 7] = 0; // 1-cell hole < VIEWSHED_POLY_MIN_HOLE_CELLS
    const parts = viewshedToPolygons(grid, mask, { minBlobCells: 1, minBlobFrac: 0 });
    expect(parts).toHaveLength(1);
    expect(parts[0].rings).toHaveLength(1);
    expect(parts[0].areaCells).toBe(121); // filled hole counts as drawn area
  });

  it('small blobs are dropped by the absolute floor', () => {
    const mask = new Uint8Array(grid.rows * grid.cols);
    for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++) mask[r * grid.cols + c] = 1; // 16 cells
    mask[10 * grid.cols + 10] = 1; mask[10 * grid.cols + 11] = 1;                          // 2 cells
    const parts = viewshedToPolygons(grid, mask, { minBlobFrac: 0 });
    expect(VIEWSHED_POLY_MIN_BLOB_CELLS).toBeGreaterThan(2);
    expect(parts).toHaveLength(1);
    expect(parts[0].areaCells).toBe(16);
  });

  it('caps parts at maxBlobs, largest first', () => {
    const mask = new Uint8Array(grid.rows * grid.cols);
    for (let r = 1; r <= 4; r++) for (let c = 1; c <= 4; c++) mask[r * grid.cols + c] = 1;    // 16
    for (let r = 8; r <= 10; r++) for (let c = 8; c <= 10; c++) mask[r * grid.cols + c] = 1;  // 9
    for (let r = 15; r <= 16; r++) for (let c = 15; c <= 16; c++) mask[r * grid.cols + c] = 1; // 4
    const parts = viewshedToPolygons(grid, mask, { minBlobCells: 1, minBlobFrac: 0, maxBlobs: 2 });
    expect(parts).toHaveLength(2);
    expect(parts[0].areaCells).toBe(16);
    expect(parts[1].areaCells).toBe(9);
  });
});

// ============================================================
// viewshedPolygonDescription + export round-trip
// ============================================================

describe('viewshedPolygonDescription(rec, part)', () => {
  const rec = {
    name: 'Ridge Top', aglFt: 200, vlosFt: 2500, coverage: 0.42,
    demSource: 'USGS 3DEP', canopySource: 'Meta 1 m', computedAt: 1752969600000,
  };

  it('includes name, AGL/VLOS, coverage, sources, area, and the low-poly disclaimer', () => {
    const d = viewshedPolygonDescription(rec, { index: 1, count: 1, areaM2: 250000 });
    expect(d).toContain('Viewshed (vector): Ridge Top');
    expect(d).toContain('Drone AGL: 200 ft / VLOS range: 2500 ft');
    expect(d).toContain('42% of VLOS visible');
    expect(d).toContain('USGS 3DEP');
    expect(d).toContain('25.0 ha');
    expect(d).toContain('raster export is authoritative');
    expect(d).not.toContain('Part 1 of 1');
  });

  it('labels multi-part polygons and uses km2 for large areas', () => {
    const d = viewshedPolygonDescription(rec, { index: 2, count: 3, areaM2: 2500000 });
    expect(d).toContain('Part 2 of 3');
    expect(d).toContain('2.50 km2');
  });

  it('returns empty string without a record', () => {
    expect(viewshedPolygonDescription(null, {})).toBe('');
  });
});

describe('polygon parts flow through the existing KML/GeoJSON serializers', () => {
  const grid = makeGrid(38.7, -120.9, 100, 10);
  const mask = new Uint8Array(grid.rows * grid.cols);
  for (let r = 2; r <= 12; r++) for (let c = 2; c <= 12; c++) mask[r * grid.cols + c] = 1;
  for (let r = 5; r <= 9; r++) for (let c = 5; c <= 9; c++) mask[r * grid.cols + c] = 0;
  const part = viewshedToPolygons(grid, mask, { minBlobCells: 1, minBlobFrac: 0 })[0];

  it('KML: outer + hole become outerBoundaryIs + innerBoundaryIs', () => {
    const kml = kmlPolygonPlacemark({
      name: 'vs', styleUrl: 'viewshed', rings: part.rings.map(r => kmlRingFromLatLng(r)),
    });
    expect(kml.match(/<outerBoundaryIs>/g)).toHaveLength(1);
    expect(kml.match(/<innerBoundaryIs>/g)).toHaveLength(1);
  });

  it('GeoJSON: Polygon with two closed rings', () => {
    const geom = geojsonPolygonGeometry(part.rings);
    expect(geom.type).toBe('Polygon');
    expect(geom.coordinates).toHaveLength(2);
    geom.coordinates.forEach(ring => {
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      expect(ring.length).toBeGreaterThanOrEqual(4);
    });
  });
});
