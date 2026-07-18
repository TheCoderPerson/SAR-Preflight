const {
  buildingHeightM, parseOverpassBuildings, earClipTriangulate, buildingMeshLocal, clampBBoxSpan,
  resolveBuildings3dMode,
} = require('../../sar-preflight-core.js');

describe('resolveBuildings3dMode(setting, constrained)', () => {
  it('explicit settings win regardless of device', () => {
    expect(resolveBuildings3dMode('prisms', true)).toBe('prisms');
    expect(resolveBuildings3dMode('flat', false)).toBe('flat');
  });

  it('auto picks flat on constrained devices, prisms otherwise', () => {
    expect(resolveBuildings3dMode('auto', true)).toBe('flat');
    expect(resolveBuildings3dMode('auto', false)).toBe('prisms');
  });

  it('unknown/missing settings behave like auto', () => {
    expect(resolveBuildings3dMode(null, true)).toBe('flat');
    expect(resolveBuildings3dMode('bogus', false)).toBe('prisms');
  });
});

describe('clampBBoxSpan(south, west, north, east, maxSpanDeg)', () => {
  it('small bbox passes through', () => {
    const bb = clampBBoxSpan(38.7, -120.8, 38.75, -120.75, 0.15);
    expect(bb.south).toBeCloseTo(38.7, 10);
    expect(bb.west).toBeCloseTo(-120.8, 10);
    expect(bb.north).toBeCloseTo(38.75, 10);
    expect(bb.east).toBeCloseTo(-120.75, 10);
  });

  it('oversized bbox is clamped about its center', () => {
    // the zoomed-out-view case actually observed: ~0.8 x 1.8 deg
    const bb = clampBBoxSpan(38.292, -121.880, 39.076, -120.100, 0.15);
    expect(bb.north - bb.south).toBeCloseTo(0.15, 10);
    expect(bb.east - bb.west).toBeCloseTo(0.15, 10);
    expect((bb.south + bb.north) / 2).toBeCloseTo((38.292 + 39.076) / 2, 10);
    expect((bb.west + bb.east) / 2).toBeCloseTo((-121.880 + -120.100) / 2, 10);
  });

  it('default max span is 0.15 deg', () => {
    const bb = clampBBoxSpan(38, -121, 39, -120);
    expect(bb.north - bb.south).toBeCloseTo(0.15, 10);
  });
});

describe('buildingHeightM(tags)', () => {
  it('explicit height tag wins (meters)', () => {
    expect(buildingHeightM({ height: '12', 'building:levels': '5' })).toBe(12);
  });

  it('unit-suffixed height parses correctly', () => {
    expect(buildingHeightM({ height: '30 ft' })).toBeCloseTo(9.144, 3);
  });

  it('falls back to building:levels x 3m', () => {
    expect(buildingHeightM({ 'building:levels': '2' })).toBe(6);
  });

  it('defaults to 5m with no tags', () => {
    expect(buildingHeightM({})).toBe(5);
    expect(buildingHeightM(null)).toBe(5);
  });

  it('garbage levels -> default', () => {
    expect(buildingHeightM({ 'building:levels': 'many' })).toBe(5);
    expect(buildingHeightM({ 'building:levels': '0' })).toBe(5);
  });
});

describe('parseOverpassBuildings(data, cap)', () => {
  const node = (id, lon, lat) => ({ type: 'node', id, lon, lat });
  const data = {
    elements: [
      node(1, -121.0, 38.0), node(2, -120.99, 38.0), node(3, -120.99, 38.01), node(4, -121.0, 38.01),
      { type: 'way', id: 100, nodes: [1, 2, 3, 4, 1], tags: { building: 'house', name: 'Cabin', height: '7' } },
      { type: 'way', id: 101, nodes: [1, 2, 1], tags: { building: 'yes' } }, // degenerate
      { type: 'way', id: 102, nodes: [1, 2, 3], tags: {} }, // not a building
      { type: 'way', id: 103, nodes: [1, 2, 3, 4], tags: { building: 'yes' } }, // unclosed ok
    ],
  };

  it('resolves nodes and strips the closing point', () => {
    const out = parseOverpassBuildings(data);
    const b = out.find(x => x.id === 100);
    expect(b.footprint).toEqual([[-121.0, 38.0], [-120.99, 38.0], [-120.99, 38.01], [-121.0, 38.01]]);
    expect(b.heightM).toBe(7);
    expect(b.est).toBe(false);
    expect(b.name).toBe('Cabin');
    expect(b.type).toBe('house');
  });

  it('drops degenerate ways and non-buildings', () => {
    const ids = parseOverpassBuildings(data).map(b => b.id);
    expect(ids).not.toContain(101);
    expect(ids).not.toContain(102);
    expect(ids).toContain(103);
  });

  it('unclosed way footprint is kept as-is', () => {
    const b = parseOverpassBuildings(data).find(x => x.id === 103);
    expect(b.footprint.length).toBe(4);
    expect(b.est).toBe(true);
    expect(b.type).toBeNull();
  });

  it('cap bounds the output', () => {
    expect(parseOverpassBuildings(data, 1).length).toBe(1);
  });

  it('empty/garbage -> empty', () => {
    expect(parseOverpassBuildings(null)).toEqual([]);
    expect(parseOverpassBuildings({})).toEqual([]);
  });
});

// Triangle area helper for validating triangulations.
const triArea = (a, b, c) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
const totalArea = (ring, tris) =>
  tris.reduce((s, t) => s + triArea(ring[t[0]], ring[t[1]], ring[t[2]]), 0);

describe('earClipTriangulate(ring)', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('square -> 2 triangles covering the full area', () => {
    const tris = earClipTriangulate(square);
    expect(tris.length).toBe(2);
    expect(totalArea(square, tris)).toBeCloseTo(100, 6);
  });

  it('reversed (CW) winding still covers the full area', () => {
    const cw = square.slice().reverse();
    const tris = earClipTriangulate(cw);
    expect(tris.length).toBe(2);
    expect(totalArea(cw, tris)).toBeCloseTo(100, 6);
  });

  it('concave L-shape -> n-2 triangles covering exactly the L area', () => {
    // 10x10 square minus 5x5 notch = 75 area, 6 vertices
    const L = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
    const tris = earClipTriangulate(L);
    expect(tris.length).toBe(4);
    expect(totalArea(L, tris)).toBeCloseTo(75, 6);
  });

  it('triangle passes through', () => {
    expect(earClipTriangulate([[0, 0], [1, 0], [0, 1]])).toEqual([[0, 1, 2]]);
  });

  it('collinear point does not break coverage', () => {
    const ring = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]];
    const tris = earClipTriangulate(ring);
    expect(totalArea(ring, tris)).toBeCloseTo(100, 6);
  });

  it('degenerate input -> empty', () => {
    expect(earClipTriangulate([[0, 0], [1, 1]])).toEqual([]);
  });
});

describe('buildingMeshLocal(footprint, heightM)', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('n-gon -> n*6 wall verts + (n-2)*3 roof verts', () => {
    const verts = buildingMeshLocal(square, 8);
    expect(verts.length).toBe(4 * 6 + 2 * 3);
  });

  it('roof verts are top-flagged with up normals; wall normals horizontal + unit', () => {
    const verts = buildingMeshLocal(square, 8);
    const roof = verts.slice(4 * 6);
    roof.forEach(v => { expect(v.top).toBe(true); expect(v.normal).toEqual([0, 0, 1]); });
    const walls = verts.slice(0, 4 * 6);
    walls.forEach(v => {
      expect(v.normal[2]).toBe(0);
      expect(Math.hypot(v.normal[0], v.normal[1])).toBeCloseTo(1, 6);
    });
  });

  it('CCW square wall normals point outward (S, E, N, W)', () => {
    // square is CCW in x=lng, y=lat: (0,0)->(10,0)->(10,10)->(0,10)
    const verts = buildingMeshLocal(square, 8);
    const wallNormal = i => verts[i * 6].normal; // first vert of each wall quad
    expect(wallNormal(0)[0]).toBeCloseTo(0, 6);  expect(wallNormal(0)[1]).toBeCloseTo(-1, 6); // south
    expect(wallNormal(1)[0]).toBeCloseTo(1, 6);  expect(wallNormal(1)[1]).toBeCloseTo(0, 6);  // east
    expect(wallNormal(2)[0]).toBeCloseTo(0, 6);  expect(wallNormal(2)[1]).toBeCloseTo(1, 6);  // north
    expect(wallNormal(3)[0]).toBeCloseTo(-1, 6); expect(wallNormal(3)[1]).toBeCloseTo(0, 6);  // west
  });

  it('CW winding still produces outward normals', () => {
    const cw = square.slice().reverse(); // (0,10)->(10,10)->(10,0)->(0,0)
    const verts = buildingMeshLocal(cw, 8);
    const normals = [0, 1, 2, 3].map(i => verts[i * 6].normal.map(x => Math.round(x) || 0));
    expect(normals).toContainEqual([0, -1, 0]);
    expect(normals).toContainEqual([0, 1, 0]);
    expect(normals).toContainEqual([1, 0, 0]);
    expect(normals).toContainEqual([-1, 0, 0]);
  });

  it('wall quads span base and top', () => {
    const verts = buildingMeshLocal(square, 8);
    const firstWall = verts.slice(0, 6);
    expect(firstWall.filter(v => v.top).length).toBe(3);
    expect(firstWall.filter(v => !v.top).length).toBe(3);
  });

  it('zero height or degenerate footprint -> empty', () => {
    expect(buildingMeshLocal(square, 0)).toEqual([]);
    expect(buildingMeshLocal([[0, 0], [1, 1]], 5)).toEqual([]);
  });
});
