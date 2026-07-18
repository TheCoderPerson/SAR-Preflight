const {
  TERRAIN_DEM_URL, leafletToMaplibreCamera, maplibreToLeafletCamera, build3dStyle,
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
