const {
  RV_UB_RAIN, RV_UB_SNOW, RADAR_PALETTES, RADAR_PALETTE_DEFAULT, rainViewerTileUrl, normalizeRadarPalette,
  radarPaletteIsIdentity, rainViewerSourceRgba, decodeRainViewerColor, radarPaletteRgba, buildRadarRecolorLut,
  recolorRadarPixels, radarLegendGradient,
} = require('../../sar-preflight-core.js');

const hex = h => [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16));

// What a 2D canvas hands back from getImageData for a translucent pixel: the
// color is stored premultiplied by alpha and divided back out on read.
const premultRoundTrip = ([r, g, b, a]) => {
  const back = c => Math.min(255, Math.round(Math.round(c * a / 255) * 255 / a));
  return [back(r), back(g), back(b), a];
};

describe('RainViewer Universal Blue tables', () => {
  it('cover -10..95 dBZ for rain and snow', () => {
    expect(RV_UB_RAIN).toHaveLength(106);
    expect(RV_UB_SNOW).toHaveLength(106);
    [...RV_UB_RAIN, ...RV_UB_SNOW].forEach(h => expect(h).toMatch(/^[0-9a-f]{8}$/));
  });

  it('match the published CSV at known points', () => {
    expect(rainViewerSourceRgba('rain', 15)).toEqual(hex('88ddeeff')); // the blue light rain
    expect(rainViewerSourceRgba('snow', 15)).toEqual(hex('9fdfffff')); // …and near-identical snow
    expect(rainViewerSourceRgba('rain', 35)).toEqual(hex('ffee00ff'));
    expect(rainViewerSourceRgba('rain', -10)).toEqual(hex('63615914'));
    expect(rainViewerSourceRgba('snow', 95)).toEqual(hex('0000ffff'));
    expect(rainViewerSourceRgba('rain', -11)[3]).toBe(0);
    expect(rainViewerSourceRgba('rain', 96)[3]).toBe(0);
  });

  it('never use the same color for rain and snow', () => {
    const rain = new Set(RV_UB_RAIN.filter(h => !h.endsWith('00')));
    RV_UB_SNOW.filter(h => !h.endsWith('00')).forEach(h => expect(rain.has(h)).toBe(false));
  });
});

describe('rainViewerTileUrl', () => {
  it('asks for scheme 2 (the only one served) with smoothing and snow on', () => {
    expect(rainViewerTileUrl('/v2/radar/abc123'))
      .toBe('https://tilecache.rainviewer.com/v2/radar/abc123/256/{z}/{x}/{y}/2/1_1.png');
  });
});

describe('decodeRainViewerColor', () => {
  it('decodes every opaque and translucent table color exactly', () => {
    ['rain', 'snow'].forEach(kind => {
      for (let dbz = -10; dbz <= 95; dbz++) {
        const c = rainViewerSourceRgba(kind, dbz);
        if (c[3] === 0) continue;
        const d = decodeRainViewerColor(...c);
        expect(d && d.kind).toBe(kind);
        // Repeated colors (white 65-74 …) decode to the lowest dBZ of the run.
        expect(rainViewerSourceRgba(kind, d.dbz)).toEqual(c);
      }
    });
  });

  it('recovers translucent colors after a canvas premultiply round trip', () => {
    ['rain', 'snow'].forEach(kind => {
      for (let dbz = -10; dbz <= 14; dbz++) {
        const c = rainViewerSourceRgba(kind, dbz);
        if (c[3] === 0 || c[3] === 255) continue;
        const d = decodeRainViewerColor(...premultRoundTrip(c));
        expect(d, `${kind} ${dbz}`).toEqual({ kind, dbz });
      }
    });
  });

  it('rejects transparent pixels and colors that are not in the table', () => {
    expect(decodeRainViewerColor(0, 0, 0, 0)).toBeNull();
    expect(decodeRainViewerColor(1, 2, 3, 255)).toBeNull();
    expect(decodeRainViewerColor(0x88, 0xdd, 0xef, 255)).toBeNull(); // opaque: exact only
    expect(decodeRainViewerColor(10, 200, 10, 120)).toBeNull();
  });
});

describe('radar palettes', () => {
  it('default to classic and normalize unknown names', () => {
    expect(RADAR_PALETTE_DEFAULT).toBe('classic');
    expect(normalizeRadarPalette('bogus')).toBe('classic');
    expect(normalizeRadarPalette(null)).toBe('classic');
    expect(normalizeRadarPalette('served')).toBe('served');
    expect(normalizeRadarPalette('universal')).toBe('served'); // name used by 2026.11.20-a
    expect(normalizeRadarPalette('__proto__')).toBe('classic');
    Object.values(RADAR_PALETTES).forEach(p => expect(typeof p.label).toBe('string'));
  });

  it('served is drawn as served', () => {
    expect(radarPaletteIsIdentity('served')).toBe(true);
    expect(radarPaletteIsIdentity('classic')).toBe(false);
    expect(buildRadarRecolorLut('served')).toBeNull();
    for (let dbz = -10; dbz <= 95; dbz += 5) {
      expect(radarPaletteRgba('served', 'rain', dbz)).toEqual(rainViewerSourceRgba('rain', dbz));
    }
  });

  it('classic: light rain is green and snow is blue, so the two never look alike', () => {
    for (let dbz = 15; dbz <= 34; dbz++) {
      const [r, g, b, a] = radarPaletteRgba('classic', 'rain', dbz);
      expect(a).toBe(255);
      expect(g).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
    }
    for (let dbz = 10; dbz <= 60; dbz++) {
      const [r, g, b] = radarPaletteRgba('classic', 'snow', dbz);
      expect(b).toBeGreaterThanOrEqual(g);
      expect(b).toBeGreaterThan(r);
    }
  });

  it('classic: snow keeps RainViewer colors; heavier rain follows the NWS scale', () => {
    for (let dbz = -10; dbz <= 95; dbz++) {
      expect(radarPaletteRgba('classic', 'snow', dbz)).toEqual(rainViewerSourceRgba('snow', dbz));
    }
    expect(radarPaletteRgba('classic', 'rain', 35)).toEqual([255, 255, 0, 255]);
    expect(radarPaletteRgba('classic', 'rain', 50)).toEqual([255, 0, 0, 255]);
    expect(radarPaletteRgba('classic', 'rain', 65)).toEqual([255, 0, 255, 255]);
    expect(radarPaletteRgba('classic', 'rain', 80)).toEqual([255, 255, 255, 255]);
  });

  it('classic: faint returns keep RainViewer\'s fade-in transparency', () => {
    for (let dbz = -10; dbz < 15; dbz++) {
      expect(radarPaletteRgba('classic', 'rain', dbz)[3]).toBe(rainViewerSourceRgba('rain', dbz)[3]);
    }
  });
});

describe('recolorRadarPixels', () => {
  const px = (...cols) => new Uint8ClampedArray(cols.flat());

  it('repaints rain, leaves snow and transparent pixels as they are', () => {
    const rain15 = rainViewerSourceRgba('rain', 15);
    const snow15 = rainViewerSourceRgba('snow', 15);
    const data = px(rain15, snow15, [0, 0, 0, 0], rain15);
    const st = recolorRadarPixels(data, buildRadarRecolorLut('classic'));
    expect(st).toEqual({ colored: 3, unknown: 0, recolored: true });
    const green = radarPaletteRgba('classic', 'rain', 15);
    expect([...data.slice(0, 4)]).toEqual(green);
    expect([...data.slice(4, 8)]).toEqual(snow15);
    expect([...data.slice(8, 12)]).toEqual([0, 0, 0, 0]);
    expect([...data.slice(12, 16)]).toEqual(green);
  });

  it('handles translucent pixels read back from a canvas', () => {
    const c = premultRoundTrip(rainViewerSourceRgba('rain', 5));
    const data = px(c);
    expect(recolorRadarPixels(data, buildRadarRecolorLut('classic')).unknown).toBe(0);
    expect([...data]).toEqual(radarPaletteRgba('classic', 'rain', 5));
  });

  it('leaves a tile untouched when it is not RainViewer colors (palette changed upstream)', () => {
    const rain15 = rainViewerSourceRgba('rain', 15);
    const cols = [];
    for (let i = 0; i < 90; i++) cols.push(rain15);
    for (let i = 0; i < 10; i++) cols.push([10, 20, 30, 255]);
    const data = px(...cols);
    const before = [...data];
    const st = recolorRadarPixels(data, buildRadarRecolorLut('classic'));
    expect(st).toEqual({ colored: 100, unknown: 10, recolored: false });
    expect([...data]).toEqual(before);
  });

  it('is a no-op without a lookup table', () => {
    const data = px(rainViewerSourceRgba('rain', 20));
    expect(recolorRadarPixels(data, null).recolored).toBe(false);
    expect([...data]).toEqual(rainViewerSourceRgba('rain', 20));
  });
});

describe('radarLegendGradient', () => {
  it('builds a 13-stop light-to-heavy gradient in the palette colors', () => {
    const g = radarLegendGradient('classic', 'rain');
    expect(g.startsWith('linear-gradient(to right, ')).toBe(true);
    expect(g.match(/rgb\(/g)).toHaveLength(13);
    const [r, gg, b] = radarPaletteRgba('classic', 'rain', 15);
    expect(g).toContain(`rgb(${r},${gg},${b}) 0%`);
    expect(radarLegendGradient('served', 'rain')).toContain('rgb(136,221,238) 0%'); // #88ddee
  });
});
