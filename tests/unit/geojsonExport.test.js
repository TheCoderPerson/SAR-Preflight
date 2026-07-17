const {
  kmlColorToRgba, caltopoStyleProps, KML_ICON_BASE,
  geojsonFolderFeature, geojsonMarkerFeature, geojsonShapeFeature,
  geojsonLineGeometry, geojsonPolygonGeometry, geojsonFeatureCollection,
} = require('../../sar-preflight-core.js');

describe('kmlColorToRgba (AABBGGRR -> #rrggbb + opacity)', () => {
  it('converts an opaque line color', () => {
    // fffd8b3d -> AA=ff BB=fd GG=8b RR=3d -> #3d8bfd, opacity 1 (matches CalTopo export)
    expect(kmlColorToRgba('fffd8b3d')).toEqual({ hex: '#3d8bfd', opacity: 1 });
  });
  it('converts a translucent fill color and reproduces CalTopo fill-opacity', () => {
    const r = kmlColorToRgba('20fd8b3d'); // AA=0x20=32 -> 32/255
    expect(r.hex).toBe('#3d8bfd');
    expect(r.opacity).toBeCloseTo(0.1254902, 6);
  });
  it('handles the heliport purple', () => {
    expect(kmlColorToRgba('fffa8ba7')).toEqual({ hex: '#a78bfa', opacity: 1 });
  });
});

describe('caltopoStyleProps', () => {
  it('gives a filled shape style stroke + fill, no marker-symbol', () => {
    const p = caltopoStyleProps('opsArea');
    expect(p.stroke).toBe('#3d8bfd');
    expect(p['stroke-width']).toBe(2);
    expect(p['stroke-opacity']).toBe(1);
    expect(p.fill).toBe('#3d8bfd');
    expect(p['fill-opacity']).toBeCloseTo(0.1254902, 6);
    expect(p['marker-symbol']).toBeUndefined();
  });
  it('gives a marker style stroke + icon href, no fill', () => {
    const p = caltopoStyleProps('heliport');
    expect(p.stroke).toBe('#a78bfa');
    expect(p['marker-symbol']).toBe(KML_ICON_BASE + 'heliport.png');
    expect(p.fill).toBeUndefined();
  });
  it('falls back to the generic style for an unknown id', () => {
    expect(caltopoStyleProps('nope').stroke).toBe(caltopoStyleProps('generic').stroke);
  });
  it('derives the trail line style (pink, no fill, no marker)', () => {
    const p = caltopoStyleProps('trail');
    expect(p.stroke).toBe('#f472b6');
    expect(p['stroke-width']).toBe(2);
    expect(p.fill).toBeUndefined();
    expect(p['marker-symbol']).toBeUndefined();
  });
});

describe('geojson feature builders', () => {
  it('builds a folder feature', () => {
    const f = geojsonFolderFeature('fid', 'NOTAM');
    expect(f).toMatchObject({ type: 'Feature', id: 'fid', geometry: null });
    expect(f.properties).toMatchObject({ title: 'NOTAM', class: 'Folder', visible: true, labelVisible: true });
  });
  it('builds a marker feature bound to its folder', () => {
    const f = geojsonMarkerFeature('id1', 'fid', { name: 'Tower', description: 'note', lat: 38.7, lng: -120.9, styleId: 'obstacle' });
    expect(f.geometry).toEqual({ type: 'Point', coordinates: [-120.9, 38.7, 0, 0] });
    expect(f.properties.class).toBe('Marker');
    expect(f.properties.title).toBe('Tower');
    expect(f.properties.description).toBe('note');
    expect(f.properties.folderId).toBe('fid');
    expect(f.properties['marker-symbol']).toContain('caution.png');
  });
  it('rejects a marker with no valid coordinates', () => {
    expect(geojsonMarkerFeature('id', 'fid', { name: 'x', lat: NaN, lng: 1 })).toBeNull();
  });
  it('builds a shape feature and drops empty geometry', () => {
    const geom = geojsonLineGeometry([[38.7, -120.9], [38.71, -120.91]]);
    const f = geojsonShapeFeature('id', 'fid', { name: 'Wire', styleId: 'wire', geometry: geom });
    expect(f.properties.class).toBe('Shape');
    expect(f.geometry.type).toBe('LineString');
    expect(geojsonShapeFeature('id', 'fid', { name: 'x', styleId: 'wire', geometry: { type: 'LineString', coordinates: [] } })).toBeNull();
  });
});

describe('geometry conversion ([lat,lng] -> GeoJSON [lng,lat])', () => {
  it('flips line coordinates', () => {
    expect(geojsonLineGeometry([[38.7, -120.9], [38.8, -120.8]]))
      .toEqual({ type: 'LineString', coordinates: [[-120.9, 38.7], [-120.8, 38.8]] });
  });
  it('flips and auto-closes a polygon ring', () => {
    const g = geojsonPolygonGeometry([[[38.6, -121.0], [38.6, -120.9], [38.7, -120.9]]]);
    expect(g.type).toBe('Polygon');
    const ring = g.coordinates[0];
    expect(ring[0]).toEqual([-121.0, 38.6]);
    expect(ring[ring.length - 1]).toEqual(ring[0]); // closed
    expect(ring.length).toBe(4);
  });
  it('drops degenerate rings (fewer than 4 closed points)', () => {
    expect(geojsonPolygonGeometry([[[38.6, -121.0], [38.6, -120.9]]]).coordinates.length).toBe(0);
  });
});

describe('geojsonFeatureCollection', () => {
  it('wraps features and filters nulls', () => {
    const fc = geojsonFeatureCollection([geojsonFolderFeature('a', 'A'), null]);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.length).toBe(1);
  });
});
