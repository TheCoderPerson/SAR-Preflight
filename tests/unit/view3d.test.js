const {
  TERRAIN_DEM_URL, leafletToMaplibreCamera, maplibreToLeafletCamera, build3dStyle,
  leafletStyleTo3d, latlngsToMultiPolygon, latlngsToMultiLine, dashArrayTo3d, vector3dSourceAndLayers,
} = require('../../sar-preflight-core.js');

// ============================================================
// 2D <-> 3D camera conversion
// ============================================================

describe('leafletToMaplibreCamera / maplibreToLeafletCamera', () => {
  it('offsets zoom by one (256px vs 512px tile basis) and swaps to [lng,lat]', () => {
    const cam = leafletToMaplibreCamera(38.685, -120.99, 11);
    expect(cam.center).toEqual([-120.99, 38.685]);
    expect(cam.zoom).toBe(10);
  });

  it('never returns a negative MapLibre zoom', () => {
    expect(leafletToMaplibreCamera(0, 0, 0).zoom).toBe(0);
  });

  it('round-trips through both conversions', () => {
    const ml = leafletToMaplibreCamera(38.5, -120.5, 13);
    const lf = maplibreToLeafletCamera(ml.center[0], ml.center[1], ml.zoom);
    expect(lf.lat).toBe(38.5);
    expect(lf.lng).toBe(-120.5);
    expect(lf.zoom).toBe(13);
  });
});

// ============================================================
// build3dStyle
// ============================================================

describe('build3dStyle', () => {
  it('always includes terrain from the Terrarium DEM source', () => {
    const style = build3dStyle({});
    expect(style.version).toBe(8);
    expect(style.sources.dem.type).toBe('raster-dem');
    expect(style.sources.dem.encoding).toBe('terrarium');
    expect(style.sources.dem.tiles).toEqual([TERRAIN_DEM_URL]);
    expect(style.terrain.source).toBe('dem');
    expect(style.terrain.exaggeration).toBe(1);
  });

  it('applies the requested exaggeration', () => {
    expect(build3dStyle({ exaggeration: 1.15 }).terrain.exaggeration).toBe(1.15);
  });

  it('uses the dark CARTO basemap by default and light when themed', () => {
    const dark = build3dStyle({});
    expect(dark.sources.basemap.tiles[0]).toContain('dark_all');
    const light = build3dStyle({ theme: 'light' });
    expect(light.sources.basemap.tiles[0]).toContain('light_all');
  });

  it('includes only the active base overlay', () => {
    const sat = build3dStyle({ base: 'satellite' });
    expect(sat.sources.satellite).toBeDefined();
    expect(sat.sources.topo).toBeUndefined();
    expect(sat.layers.some(l => l.id === 'satellite')).toBe(true);

    const none = build3dStyle({});
    expect(none.sources.satellite).toBeUndefined();
    expect(none.sources.sectional).toBeUndefined();
  });

  it('wires the sectional base to the supplied edition URL with native z12', () => {
    const url = 'https://tiles.example/VFR_Sectional/MapServer/tile/{z}/{y}/{x}';
    const style = build3dStyle({ base: 'sectional', sectionalUrl: url });
    expect(style.sources.sectional.tiles).toEqual([url]);
    expect(style.sources.sectional.maxzoom).toBe(12);
  });

  it('omits the sectional layer when no URL is available', () => {
    const style = build3dStyle({ base: 'sectional' });
    expect(style.sources.sectional).toBeUndefined();
  });

  it('mirrors slope/parcels/streets overlay toggles', () => {
    const style = build3dStyle({ overlays: { slope: true, parcels: true, streets: true } });
    expect(style.layers.find(l => l.id === 'slope').paint['raster-opacity']).toBe(0.6);
    expect(style.layers.find(l => l.id === 'parcels').paint['raster-opacity']).toBe(0.85);
    expect(style.sources.streets_roads).toBeDefined();
    expect(style.sources.streets_places).toBeDefined();
    const off = build3dStyle({});
    expect(off.sources.slope).toBeUndefined();
    expect(off.sources.streets_roads).toBeUndefined();
  });

  it('drapes canopy/viewshed data-URL rasters as image sources with WGS84 corners', () => {
    const bounds = { west: -121.0, south: 38.6, east: -120.9, north: 38.7 };
    const style = build3dStyle({
      rasters: [{ id: 'viewshed', url: 'data:image/png;base64,AAA', bounds, opacity: 0.55 }],
    });
    const src = style.sources.img_viewshed;
    expect(src.type).toBe('image');
    expect(src.coordinates).toEqual([
      [-121.0, 38.7], [-120.9, 38.7], [-120.9, 38.6], [-121.0, 38.6],
    ]);
    const layer = style.layers.find(l => l.id === 'img_viewshed');
    expect(layer.paint['raster-opacity']).toBe(0.55);
  });

  it('skips malformed raster records and defaults opacity', () => {
    const style = build3dStyle({
      rasters: [
        { id: 'canopy', url: 'data:image/png;base64,AAA', bounds: { west: 0, south: 0, east: 1, north: 1 } },
        { id: 'broken' }, null,
      ],
    });
    expect(style.layers.find(l => l.id === 'img_canopy').paint['raster-opacity']).toBe(0.7);
    expect(style.sources.img_broken).toBeUndefined();
  });

  it('keeps the background layer first so terrain has a floor color', () => {
    const style = build3dStyle({ base: 'satellite', overlays: { slope: true } });
    expect(style.layers[0].type).toBe('background');
    expect(style.layers[1].id).toBe('basemap');
  });
});

// ============================================================
// Vector mirroring (Phase 2)
// ============================================================

describe('leafletStyleTo3d', () => {
  it('applies Leaflet path defaults', () => {
    expect(leafletStyleTo3d({})).toEqual({
      stroke: '#3388ff', strokeWidth: 3, strokeOpacity: 1, fill: '#3388ff', fillOpacity: 0.2,
    });
  });

  it('fill falls back to stroke color, zero values survive', () => {
    const s = leafletStyleTo3d({ color: '#ef4444', weight: 0, opacity: 0.5, fillOpacity: 0 });
    expect(s.fill).toBe('#ef4444');
    expect(s.strokeWidth).toBe(0);
    expect(s.fillOpacity).toBe(0);
  });
});

describe('latlngsToMultiPolygon / latlngsToMultiLine', () => {
  const p = (lat, lng) => ({ lat, lng });

  it('closes a bare ring into [lng,lat] MultiPolygon coords', () => {
    const mp = latlngsToMultiPolygon([p(38, -121), p(38, -120), p(39, -120)]);
    expect(mp).toEqual([[[[-121, 38], [-120, 38], [-120, 39], [-121, 38]]]]);
  });

  it('preserves holes as additional rings of the same polygon', () => {
    const outer = [p(0, 0), p(0, 10), p(10, 10), p(10, 0)];
    const hole = [p(2, 2), p(2, 4), p(4, 4), p(4, 2)];
    const mp = latlngsToMultiPolygon([outer, hole]);
    expect(mp.length).toBe(1);
    expect(mp[0].length).toBe(2);
  });

  it('handles Leaflet multi-polygon nesting', () => {
    const a = [[p(0, 0), p(0, 1), p(1, 1)]];
    const b = [[p(5, 5), p(5, 6), p(6, 6)]];
    const mp = latlngsToMultiPolygon([a, b]);
    expect(mp.length).toBe(2);
  });

  it('flattens polyline nesting into MultiLineString segments', () => {
    expect(latlngsToMultiLine([p(1, 2), p(3, 4)])).toEqual([[[2, 1], [4, 3]]]);
    expect(latlngsToMultiLine([[p(1, 2), p(3, 4)], [p(5, 6), p(7, 8)]]).length).toBe(2);
    expect(latlngsToMultiLine([])).toEqual([]);
  });
});

describe('dashArrayTo3d', () => {
  it('converts px dashes to line-width multiples', () => {
    expect(dashArrayTo3d('6,4', 2)).toEqual([3, 2]);
    expect(dashArrayTo3d('6 4', 3)).toEqual([2, 4 / 3]);
  });
  it('rejects unusable input', () => {
    expect(dashArrayTo3d(null, 2)).toBeNull();
    expect(dashArrayTo3d('abc', 2)).toBeNull();
  });
});

describe('vector3dSourceAndLayers', () => {
  const polyFeat = {
    kind: 'polygon',
    multiPolygon: [[[[-121, 38], [-120, 38], [-120, 39], [-121, 38]]]],
    style: { stroke: '#ef4444', strokeWidth: 2, strokeOpacity: 0.9, fill: '#ef4444', fillOpacity: 0.15 },
    popupHtml: '<b>TFR</b>', label: 'TFR', pri: 0,
  };
  const pointFeat = { kind: 'point', point: [-120.5, 38.5], radius: 5, style: {}, popupHtml: 'apt', label: 'Airport', pri: 3 };
  const lineFeat = { kind: 'line', multiLine: [[[-121, 38], [-120, 39]]], style: {}, popupHtml: 'wire', label: 'Wire', pri: 5, dashArray: '6,3' };

  it('returns null for an empty group', () => {
    expect(vector3dSourceAndLayers({ id: 'x', features: [] })).toBeNull();
    expect(vector3dSourceAndLayers({ id: 'x', features: [{ kind: 'line', multiLine: [] }] })).toBeNull();
  });

  it('emits only the style layers matching the geometry kinds present', () => {
    const lineOnly = vector3dSourceAndLayers({ id: 'wires', features: [lineFeat] });
    expect(lineOnly.layers.map(l => l.type)).toEqual(['line']);
    const all = vector3dSourceAndLayers({ id: 'mix', features: [polyFeat, pointFeat, lineFeat] });
    expect(all.layers.map(l => l.type)).toEqual(['fill', 'line', 'circle']);
    expect(all.srcId).toBe('vec_mix');
    expect(all.source.data.features.length).toBe(3);
  });

  it('carries popup/label/pri and style props on feature properties', () => {
    const built = vector3dSourceAndLayers({ id: 'tfr', features: [polyFeat] });
    const props = built.source.data.features[0].properties;
    expect(props.popupHtml).toBe('<b>TFR</b>');
    expect(props.pri).toBe(0);
    expect(props.stroke).toBe('#ef4444');
    expect(props.fillOpacity).toBe(0.15);
    expect(built.layers[0].paint['fill-color']).toEqual(['get', 'fill']);
  });

  it('applies the group dash pattern to the line layer', () => {
    const built = vector3dSourceAndLayers({ id: 'w', features: [lineFeat] });
    expect(built.layers[0].paint['line-dasharray']).toEqual([2, 1]);
  });
});

describe('build3dStyle with vectors', () => {
  it('draws vector groups above rasters, most important (lowest pri) last', () => {
    const mk = (id, pri) => ({
      id, pri,
      features: [{ kind: 'point', point: [0, 0], style: {}, popupHtml: 'x', label: id, pri }],
    });
    const style = build3dStyle({
      base: 'satellite',
      rasters: [{ id: 'viewshed', url: 'data:x', bounds: { west: 0, south: 0, east: 1, north: 1 } }],
      vectors: [mk('faa_tfr', 0), mk('trails', 7)],
    });
    const ids = style.layers.map(l => l.id);
    expect(ids.indexOf('vec_trails_pt')).toBeGreaterThan(ids.indexOf('img_viewshed'));
    expect(ids.indexOf('vec_faa_tfr_pt')).toBeGreaterThan(ids.indexOf('vec_trails_pt'));
    expect(style.sources.vec_faa_tfr.type).toBe('geojson');
  });

  it('skips empty vector groups without breaking the style', () => {
    const style = build3dStyle({ vectors: [{ id: 'empty', pri: 1, features: [] }] });
    expect(style.sources.vec_empty).toBeUndefined();
  });
});
