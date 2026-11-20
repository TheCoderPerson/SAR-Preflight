const fs = require('fs');
const path = require('path');
const {
  NWS_RADAR_REGIONS, nwsRadarRegionFor, nwsRadarCapabilitiesUrl, nwsRadarGetMapUrl, parseWmsTimeDimension,
  selectNwsRadarFrames, tileBbox3857, nwsTypeBufferPx, NWS_PTYPE_COLORS, decodeNwsPrecipType,
  NWS_BREF_RAMP, NWS_DBZ_HIGH, decodeNwsReflectivity, recolorNwsPixels, nwsReflectivityRgb,
  radarPaletteRgba, radarLegendGradient, build3dStyle,
} = require('../../sar-preflight-core.js');

// Real GetCapabilities of the NWS GeoServer's CONUS radar workspace (2026-11-20).
const CAPS = fs.readFileSync(path.join(__dirname, '../fixtures/nws-radar-conus-capabilities.xml'), 'utf8');

const hexRgb = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
const rampColor = dbz => hexRgb(NWS_BREF_RAMP[Math.round((dbz + 27.4) / 0.2)]);

describe('nwsRadarRegionFor', () => {
  it('picks the NWS region covering a point', () => {
    expect(nwsRadarRegionFor(38.73, -120.8)).toBe('conus');   // Placerville
    expect(nwsRadarRegionFor(24.55, -81.8)).toBe('conus');    // Key West: CONUS wins the Gulf overlap
    expect(nwsRadarRegionFor(18.2, -66.5)).toBe('carib');     // Puerto Rico
    expect(nwsRadarRegionFor(61.2, -149.9)).toBe('alaska');   // Anchorage
    expect(nwsRadarRegionFor(21.3, -157.86)).toBe('hawaii');  // Honolulu
    expect(nwsRadarRegionFor(13.44, 144.79)).toBe('guam');
  });

  it('returns null outside NWS coverage (→ RainViewer)', () => {
    expect(nwsRadarRegionFor(48.85, 2.35)).toBeNull();        // Paris
    expect(nwsRadarRegionFor(-33.9, 151.2)).toBeNull();       // Sydney
    expect(nwsRadarRegionFor(NaN, -120)).toBeNull();
    expect(nwsRadarRegionFor(undefined, undefined)).toBeNull();
  });

  it('lists every region the NWS GeoServer serves radar for', () => {
    expect(NWS_RADAR_REGIONS.map(r => r.id)).toEqual(['conus', 'alaska', 'hawaii', 'carib', 'guam']);
  });
});

describe('NWS radar URLs', () => {
  it('builds the GetCapabilities and GetMap URLs', () => {
    expect(nwsRadarCapabilitiesUrl('conus'))
      .toBe('https://opengeo.ncep.noaa.gov/geoserver/conus/ows?service=WMS&version=1.3.0&request=GetCapabilities');
    const u = nwsRadarGetMapUrl('conus', 'bref_qcd', '2026-11-20T15:39:55.000Z', [-1, -2, 3.25, 4], 256, 256);
    expect(u.startsWith('https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows?service=WMS&version=1.1.1&request=GetMap')).toBe(true);
    expect(u).toContain('&layers=conus_bref_qcd&');
    expect(u).toContain('&srs=EPSG:3857&');
    expect(u).toContain('&bbox=-1.0,-2.0,3.3,4.0&width=256&height=256');
    expect(u).toContain('&transparent=true');
    expect(u.endsWith('&time=2026-11-20T15%3A39%3A55.000Z')).toBe(true);
  });

  it('passes a template bbox through untouched (MapLibre fills {bbox-epsg-3857})', () => {
    expect(nwsRadarGetMapUrl('alaska', 'pcpn_typ', 't', '{bbox-epsg-3857}', 256, 256))
      .toContain('/alaska/alaska_pcpn_typ/ows?') ;
    expect(nwsRadarGetMapUrl('conus', 'bref_qcd', 't', '{bbox-epsg-3857}', 256, 256)).toContain('&bbox={bbox-epsg-3857}&');
  });
});

describe('parseWmsTimeDimension', () => {
  it('reads each layer\'s own time list from real capabilities', () => {
    const bref = parseWmsTimeDimension(CAPS, 'conus_bref_qcd');
    const types = parseWmsTimeDimension(CAPS, 'conus_pcpn_typ');
    expect(bref.length).toBe(60);
    expect(types.length).toBe(60);
    expect(bref[bref.length - 1]).toBe('2026-11-20T15:46:04.000Z');
    expect(types[types.length - 1]).toBe('2026-11-20T15:46:00.000Z');
    expect(bref).not.toEqual(parseWmsTimeDimension(CAPS, 'conus_cref_qcd')); // not the neighbour's list
  });

  it('returns [] for a missing layer or a non-string', () => {
    expect(parseWmsTimeDimension(CAPS, 'conus_nope')).toEqual([]);
    expect(parseWmsTimeDimension(null, 'conus_bref_qcd')).toEqual([]);
    expect(parseWmsTimeDimension('<Layer><Name>x</Name></Layer>', 'x')).toEqual([]);
  });
});

describe('selectNwsRadarFrames', () => {
  const iso = s => new Date(s * 1000).toISOString();
  const T0 = Date.parse('2026-11-20T14:00:00Z') / 1000;

  it('takes the newest image and one per 10 min back over 2 h, paired with precip type', () => {
    const bref = [], types = [];
    for (let m = 0; m <= 130; m += 2) { bref.push(iso(T0 + m * 60 - 5)); types.push(iso(T0 + m * 60)); }
    const f = selectNwsRadarFrames(bref, types);
    expect(f).toHaveLength(13);
    expect(f[12].brefTime).toBe(bref[bref.length - 1]);                 // newest last
    for (let i = 1; i < f.length; i++) expect(f[i].time - f[i - 1].time).toBe(600);
    f.forEach(fr => expect(Math.abs(Date.parse(fr.typeTime) / 1000 - fr.time)).toBeLessThanOrEqual(180));
  });

  it('works from the real capabilities', () => {
    const f = selectNwsRadarFrames(parseWmsTimeDimension(CAPS, 'conus_bref_qcd'), parseWmsTimeDimension(CAPS, 'conus_pcpn_typ'));
    expect(f.length).toBeGreaterThanOrEqual(12);
    expect(f[f.length - 1]).toEqual({ time: Date.parse('2026-11-20T15:46:04Z') / 1000, brefTime: '2026-11-20T15:46:04.000Z', typeTime: '2026-11-20T15:46:00.000Z' });
  });

  it('leaves typeTime null when no precip-type image is close in time, and skips gaps', () => {
    const f = selectNwsRadarFrames([iso(T0), iso(T0 + 3600)], [iso(T0 + 3600 - 30)]);
    expect(f).toEqual([
      { time: T0, brefTime: iso(T0), typeTime: null },
      { time: T0 + 3600, brefTime: iso(T0 + 3600), typeTime: iso(T0 + 3570) },
    ]);
  });

  it('returns [] without reflectivity times', () => {
    expect(selectNwsRadarFrames([], ['2026-11-20T00:00:00Z'])).toEqual([]);
    expect(selectNwsRadarFrames(['junk'], [])).toEqual([]);
  });
});

describe('tile geometry', () => {
  it('tileBbox3857 matches the Web Mercator tile grid', () => {
    expect(tileBbox3857(0, 0, 0).map(Math.round)).toEqual([-20037508, -20037508, 20037508, 20037508]);
    const b = tileBbox3857(7, 20, 48);
    expect(b[0]).toBeCloseTo(-13775786.99, 1);
    expect(b[3]).toBeCloseTo(5009377.09, 1);
    expect(b[2] - b[0]).toBeCloseTo(b[3] - b[1], 6);
  });

  it('nwsTypeBufferPx covers ~5 km of ground, capped', () => {
    expect(nwsTypeBufferPx(9, 194, 256)).toBe(22);   // ~240 m pixels at 39°N
    expect(nwsTypeBufferPx(5, 12, 256)).toBe(2);
    expect(nwsTypeBufferPx(14, 6240, 256)).toBe(32); // capped
    expect(nwsTypeBufferPx(0, 0, 256)).toBe(1);
  });
});

describe('decodeNwsPrecipType', () => {
  it('maps the seven MRMS legend colors and nothing else', () => {
    Object.entries(NWS_PTYPE_COLORS).forEach(([h, code]) => expect(decodeNwsPrecipType(...hexRgb(h), 255)).toBe(code));
    expect(decodeNwsPrecipType(0xc8, 0xc8, 0xc8, 255)).toBe('S');
    expect(decodeNwsPrecipType(0xc8, 0xc8, 0xc9, 255)).toBeNull();
    expect(decodeNwsPrecipType(0xc8, 0xc8, 0xc8, 0)).toBeNull();
    expect(Object.values(NWS_PTYPE_COLORS)).not.toContain('FZRA');
  });
});

describe('decodeNwsReflectivity', () => {
  it('decodes the NWS scale to dBZ up to ~37 dBZ', () => {
    expect(NWS_BREF_RAMP).toHaveLength(321);
    expect(decodeNwsReflectivity(0x15, 0xd6, 0x22, 255)).toBe(22);     // map pixel, matched by hand
    expect(decodeNwsReflectivity(0xce, 0xc8, 0x02, 255)).toBeCloseTo(36.6, 1);
    [-20, -5, 0, 10, 20, 30].forEach(d => expect(decodeNwsReflectivity(...rampColor(d), 255)).toBeCloseTo(d, 1));
  });

  it('classes the warm and magenta end as high, and anything else as unknown', () => {
    ['ffe200', 'ff9f00', 'ff1200', 'd00000', 'e374fc', 'a700f9', 'fdf6ff'].forEach(h =>
      expect(decodeNwsReflectivity(...hexRgb(h), 255)).toBe(NWS_DBZ_HIGH));
    expect(decodeNwsReflectivity(0x12, 0x34, 0x56, 255)).toBeNaN();
    expect(decodeNwsReflectivity(1, 2, 3, 0)).toBeNull();
  });
});

describe('recolorNwsPixels', () => {
  // A w×1 reflectivity strip and its precip-type image with a `buf` margin.
  const strip = cols => new Uint8ClampedArray(cols.flatMap(c => (c ? [...c, 255] : [0, 0, 0, 0])));
  const typeImg = (w, buf, typesAt) => {
    const pw = w + 2 * buf, ph = 1 + 2 * buf, d = new Uint8ClampedArray(pw * ph * 4);
    typesAt.forEach(([x, h]) => { const i = ((buf) * pw + (x + buf)) * 4; d.set([...hexRgb(h), 255], i); });
    return d;
  };
  const px = (d, i) => [...d.slice(i * 4, i * 4 + 4)];

  it('paints rain green, snow blue, keeps warm rain colors, darkens high snow', () => {
    const bref = strip([rampColor(20), rampColor(20), hexRgb('ff9f00'), hexRgb('ff9f00')]);
    const ty = typeImg(4, 0, [[0, '0450a4'], [1, 'c8c8c8'], [2, '0450a4'], [3, 'c8c8c8']]);
    const st = recolorNwsPixels(bref, 4, 1, ty, 0, 'classic');
    expect(st).toEqual({ colored: 4, unknown: 0, recolored: true, typeUnknown: 0 });
    expect(px(bref, 0)).toEqual(radarPaletteRgba('classic', 'rain', 20));
    expect(px(bref, 1)).toEqual(radarPaletteRgba('classic', 'snow', 20));
    expect(px(bref, 2)).toEqual([0xff, 0x9f, 0x00, 255]);
    expect(px(bref, 3)).toEqual(radarPaletteRgba('classic', 'snow', 45));
  });

  it('gives untyped echoes the nearest type within the margin; drops weak isolated ones', () => {
    // x0 snow-typed; x1,x2 untyped next to it; x5 untyped strong; x6 untyped weak — buf 2
    const bref = strip([rampColor(15), rampColor(15), rampColor(15), null, null, rampColor(25), rampColor(8)]);
    const ty = typeImg(7, 2, [[0, 'c8c8c8']]);
    recolorNwsPixels(bref, 7, 1, ty, 2, 'classic');
    expect(px(bref, 1)).toEqual(radarPaletteRgba('classic', 'snow', 15));
    expect(px(bref, 2)).toEqual(radarPaletteRgba('classic', 'snow', 15));
    expect(px(bref, 5)).toEqual(radarPaletteRgba('classic', 'rain', 25)); // too far: strong → rain
    expect(px(bref, 6)).toEqual([0, 0, 0, 0]);                           // too far and weak → dropped
  });

  it('uses the type from the margin across a tile edge', () => {
    const bref = strip([rampColor(18)]);
    const ty = typeImg(1, 3, []);
    ty.set([...hexRgb('c8c8c8'), 255], (3 * 7 + 0) * 4); // left margin, same row
    recolorNwsPixels(bref, 1, 1, ty, 3, 'classic');
    expect(px(bref, 0)).toEqual(radarPaletteRgba('classic', 'snow', 18));
  });

  it('leaves the tile as served for foreign colors, foreign types, the served palette or bad sizes', () => {
    const colors = Array.from({ length: 20 }, () => [0x12, 0x34, 0x56]);
    const bref = strip(colors); const before = [...bref];
    expect(recolorNwsPixels(bref, 20, 1, typeImg(20, 0, []), 0, 'classic').recolored).toBe(false);
    expect([...bref]).toEqual(before);

    const b2 = strip([rampColor(20)]); const b2before = [...b2];
    expect(recolorNwsPixels(b2, 1, 1, typeImg(1, 0, [[0, '123456']]), 0, 'classic')).toMatchObject({ recolored: false, typeUnknown: 1 });
    expect([...b2]).toEqual(b2before);
    expect(recolorNwsPixels(b2, 1, 1, typeImg(1, 0, [[0, '0450a4']]), 0, 'served').recolored).toBe(false);
    expect(recolorNwsPixels(b2, 1, 1, new Uint8ClampedArray(8), 0, 'classic').recolored).toBe(false);
    expect(recolorNwsPixels(b2, 1, 1, null, 0, 'classic').recolored).toBe(false);
  });
});

describe('legend and 3D', () => {
  it('NWS as served shows NWS colors; the classic legend is the same for both sources', () => {
    expect(radarLegendGradient('classic', 'rain', 'nws')).toBe(radarLegendGradient('classic', 'rain', 'rainviewer'));
    const c = nwsReflectivityRgb(15);
    expect(radarLegendGradient('served', 'rain', 'nws')).toContain(`rgb(${c[0]},${c[1]},${c[2]}) 0%`);
    expect(nwsReflectivityRgb(50)).toEqual(hexRgb('f90101'));
    expect(nwsReflectivityRgb(70)).toEqual(hexRgb('a700f9'));
  });

  it('build3dStyle takes the radar max zoom from the source (default z7)', () => {
    expect(build3dStyle({ radarUrl: 'https://x/{z}/{x}/{y}.png' }).sources.radar.maxzoom).toBe(7);
    expect(build3dStyle({ radarUrl: 'sarradar://classic/nws/a/b/c/{z}/{x}/{y}', radarMaxZoom: 9 }).sources.radar.maxzoom).toBe(9);
  });
});
