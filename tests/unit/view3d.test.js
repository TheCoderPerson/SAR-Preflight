const {
  TERRAIN_DEM_URL, leafletToMaplibreCamera, maplibreToLeafletCamera, build3dStyle,
  leafletStyleTo3d, latlngsToMultiPolygon, latlngsToMultiLine, dashArrayTo3d, vector3dSourceAndLayers,
  cylRadiusForHeightM, aircraft3dRecords, hexToRgb01, collectVerticalSegments,
  OBSERVER_PITCH_MIN, OBSERVER_PITCH_MAX, OBSERVER_START_PITCH,
  wrapBearing, clampObserverPitch, applyLookDrag, wheelLook, observerEyeAltitudeM,
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

  it('always includes the sun/moon terrain hillshade on its own DEM source', () => {
    const style = build3dStyle({ lightAzimuth: 247.6, lightShade: 0.62 });
    expect(style.sources.demShade.type).toBe('raster-dem');
    const hs = style.layers.find(l => l.id === 'sunshade');
    expect(hs.type).toBe('hillshade');
    expect(hs.source).toBe('demShade');
    expect(hs.paint['hillshade-illumination-direction']).toBe(248);
    expect(hs.paint['hillshade-illumination-anchor']).toBe('map');
    expect(hs.paint['hillshade-exaggeration']).toBe(0.62);
    // Defaults when no light is supplied
    const def = build3dStyle({}).layers.find(l => l.id === 'sunshade');
    expect(def.paint['hillshade-illumination-direction']).toBe(335);
    expect(def.paint['hillshade-exaggeration']).toBe(0.4);
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

  it('mirrors slope/streets overlay toggles (vector parcels are not mirrored into 3D)', () => {
    const style = build3dStyle({ overlays: { slope: true, parcels: true, streets: true } });
    expect(style.layers.find(l => l.id === 'slope').paint['raster-opacity']).toBe(0.6);
    expect(style.layers.find(l => l.id === 'parcels')).toBeUndefined();
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

  it('adds a half-opacity radar layer above imagery when a frame URL is given', () => {
    const style = build3dStyle({ radarUrl: 'https://tilecache.rainviewer.com/x/256/{z}/{x}/{y}/6/1_1.png' });
    expect(style.sources.radar.maxzoom).toBe(7);
    const ids = style.layers.map(l => l.id);
    expect(ids.indexOf('radar')).toBeGreaterThan(ids.indexOf('basemap'));
    expect(style.layers.find(l => l.id === 'radar').paint['raster-opacity']).toBe(0.5);
    expect(build3dStyle({}).sources.radar).toBeUndefined();
  });
});

// ============================================================
// Phase 3: extruded cylinders + ADS-B aircraft
// ============================================================

describe('cylRadiusForHeightM', () => {
  it('scales with height between sane bounds', () => {
    expect(cylRadiusForHeightM(20)).toBe(8);      // short obstacle → floor
    expect(cylRadiusForHeightM(100)).toBe(15);    // 15% of height
    expect(cylRadiusForHeightM(1000)).toBe(40);   // capped
    expect(cylRadiusForHeightM(null)).toBe(8);
  });
});

describe('vertical segments (custom-layer verticals)', () => {
  const cyl = {
    kind: 'cylinder', lat: 38.7, lng: -120.8, radiusM: 10, baseM: 0, topM: 60,
    style: { fill: '#ef4444' }, popupHtml: 'obstacle', label: 'Obstacle', pri: 4,
  };
  const flat = {
    kind: 'polygon', multiPolygon: [[[[-121, 38], [-120, 38], [-120, 39], [-121, 38]]]],
    style: {}, popupHtml: 'area', label: 'Area', pri: 8,
  };

  it('keeps cylinders OUT of the geojson style (fill-extrusion is buggy on terrain)', () => {
    expect(vector3dSourceAndLayers({ id: 'obs', features: [cyl] })).toBeNull();
    const mixed = vector3dSourceAndLayers({ id: 'mix', features: [cyl, flat] });
    expect(mixed.source.data.features.length).toBe(1);
    expect(mixed.layers.some(l => l.type === 'fill-extrusion')).toBe(false);
  });

  it('turns narrow cylinders into vertical lines and wide ones into altitude crosses', () => {
    const segs = collectVerticalSegments([
      { id: 'obs', features: [cyl] },
      { id: 'adsb3d', features: aircraft3dRecords([{ lat: 38.9, lng: -120.5, aglM: 900, color: '#22c55e', popupHtml: 'x' }]) },
    ]);
    expect(segs.length).toBe(3);
    const [obst, drop, cross] = segs;
    expect(obst.type).toBe('line');
    expect(obst.toM).toBe(60);
    expect(obst.thin).toBe(false); // obstacles draw as thick quads
    expect(obst.color).toEqual(hexToRgb01('#ef4444'));
    expect(drop.type).toBe('line');
    expect(drop.fromM).toBe(0);
    expect(drop.toM).toBe(900);
    expect(drop.thin).toBe(true); // aircraft verticals stay 1px
    expect(cross.type).toBe('cross');
    expect(cross.atM).toBe(900);
    expect(cross.armM).toBe(50);
    expect(cross.thin).toBe(true);
  });

  it('skips heightless cylinders and non-cylinder records', () => {
    expect(collectVerticalSegments([{ id: 'x', features: [{ kind: 'cylinder', lat: 1, lng: 1, radiusM: 5, baseM: 0, topM: 0 }, flat, null] }])).toEqual([]);
    expect(collectVerticalSegments(null)).toEqual([]);
  });
});

describe('hexToRgb01', () => {
  it('parses hex colors to 0..1 rgb', () => {
    expect(hexToRgb01('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb01('00CCFF')).toEqual([0, 204 / 255, 1]);
    expect(hexToRgb01('junk').length).toBe(3);
  });
});

describe('aircraft3dRecords', () => {
  it('builds a drop line (ground→AGL) and a floating slab per aircraft', () => {
    const recs = aircraft3dRecords([{ lat: 38.7, lng: -120.8, aglM: 900, color: '#22c55e', popupHtml: '<b>N123</b>' }]);
    expect(recs.length).toBe(2);
    const [drop, slab] = recs;
    expect(drop.baseM).toBe(0);
    expect(drop.topM).toBe(900);
    expect(drop.radiusM).toBe(3);
    expect(slab.baseM).toBe(900);
    expect(slab.topM).toBe(925);
    expect(slab.radiusM).toBe(50);
    recs.forEach(r => {
      expect(r.kind).toBe('cylinder');
      expect(r.style.fill).toBe('#22c55e');
      expect(r.popupHtml).toBe('<b>N123</b>');
      expect(r.label).toBe('Aircraft');
    });
  });

  it('skips aircraft without a usable AGL', () => {
    expect(aircraft3dRecords([{ lat: 1, lng: 1, aglM: null }, { lat: 1, lng: 1, aglM: -50 }, null])).toEqual([]);
    expect(aircraft3dRecords(null)).toEqual([]);
  });
});

// ============================================================
// Observer perspective view — free-look math
// ============================================================

describe('wrapBearing', () => {
  it('normalizes to [-180, 180)', () => {
    expect(wrapBearing(190)).toBe(-170);
    expect(wrapBearing(-190)).toBe(170);
    expect(wrapBearing(360)).toBe(0);
    expect(wrapBearing(540)).toBe(-180);
    expect(wrapBearing(0)).toBe(0);
    expect(wrapBearing(-180)).toBe(-180);
    expect(wrapBearing(180)).toBe(-180);
  });

  it('treats non-numeric input as 0', () => {
    expect(wrapBearing(undefined)).toBe(0);
    expect(wrapBearing(NaN)).toBe(0);
  });
});

describe('clampObserverPitch', () => {
  it('clamps to the observer pitch range', () => {
    expect(clampObserverPitch(-20)).toBe(OBSERVER_PITCH_MIN);
    expect(clampObserverPitch(500)).toBe(OBSERVER_PITCH_MAX);
    expect(clampObserverPitch(90)).toBe(90);
  });

  it('falls back to the start pitch for non-finite input', () => {
    expect(clampObserverPitch(NaN)).toBe(OBSERVER_START_PITCH);
    expect(clampObserverPitch(undefined)).toBe(OBSERVER_START_PITCH);
  });
});

describe('applyLookDrag', () => {
  it('drags the world: drag right looks left, drag down looks up', () => {
    const r = applyLookDrag(88, 0, 40, 20);
    expect(r.bearing).toBe(-10);  // dx 40px * 0.25°/px, negated
    expect(r.pitch).toBe(93);     // dy 20px * 0.25°/px, added
  });

  it('clamps pitch and wraps bearing', () => {
    const r = applyLookDrag(108, 175, -40, 400);
    expect(r.pitch).toBe(OBSERVER_PITCH_MAX);
    expect(r.bearing).toBe(-175); // 175 + 10 wraps
  });

  it('honors a custom sensitivity', () => {
    expect(applyLookDrag(88, 0, 10, 0, 1).bearing).toBe(-10);
  });
});

describe('wheelLook', () => {
  it('scroll up looks up, horizontal wheel turns', () => {
    const r = wheelLook(88, 10, 50, -100);
    expect(r.pitch).toBe(100);   // -(-100) * 0.12
    expect(r.bearing).toBe(16);  // 10 + 50*0.12
  });

  it('clamps and wraps', () => {
    expect(wheelLook(88, 0, 0, -10000).pitch).toBe(OBSERVER_PITCH_MAX);
    expect(wheelLook(88, 179, 100, 0, 1).bearing).toBe(-81);
  });
});

describe('observerEyeAltitudeM', () => {
  it('adds the exaggerated eye height to the rendered ground', () => {
    expect(observerEyeAltitudeM(1000, 1.6764, 1.15)).toBeCloseTo(1001.928, 2);
  });

  it('treats missing ground as 0 and missing exaggeration as 1', () => {
    expect(observerEyeAltitudeM(NaN, 1.6764, 1.15)).toBeCloseTo(1.928, 2);
    expect(observerEyeAltitudeM(undefined, 2, undefined)).toBe(2);
  });
});

describe('vector3dSourceAndLayers featId passthrough', () => {
  it('carries featId into point feature properties when present', () => {
    const built = vector3dSourceAndLayers({
      id: 'observers',
      features: [{ kind: 'point', point: [-120.5, 38.5], style: {}, popupHtml: 'o', label: 'Observer', pri: 3, featId: 'vs_abc' }],
    });
    expect(built.source.data.features[0].properties.featId).toBe('vs_abc');
  });

  it('omits the featId key entirely when absent', () => {
    const built = vector3dSourceAndLayers({
      id: 'airports',
      features: [{ kind: 'point', point: [0, 0], style: {}, popupHtml: 'a', label: 'Airport', pri: 3 }],
    });
    expect('featId' in built.source.data.features[0].properties).toBe(false);
  });
});
