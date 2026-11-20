// Weather radar glue: the Config source + palette settings, the canvas tile
// layer that renders RainViewer and NWS tiles in 2D, the sarradar:// protocol
// for 3D, and fetchRadar's NWS-first / RainViewer-fallback choice.
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Leaflet stand-in: TileLayer.extend returns a constructor carrying the
// overridden methods, so createTile can be driven directly.
function makeL() {
  return {
    tileLayer: vi.fn((url, opts) => ({ _url: url, options: Object.assign({}, opts), plain: true })),
    layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {}, getLayers: () => [] }),
    TileLayer: {
      extend(proto) {
        function Cls(url, opts) { this._url = url; this.options = Object.assign({}, opts); }
        Object.assign(Cls.prototype, proto, {
          getTileSize: () => ({ x: 2, y: 1 }),
          redraw: vi.fn(),
          setOpacity(v) { this.options.opacity = v; return this; },
          addTo(m) { m.addLayer(this); return this; },
        });
        return Cls;
      },
    },
  };
}
globalThis.L = makeL();

const app = require('../../sar-preflight.js');
const {
  S, getRadarPalette, setRadarPalette, _makeRadarTileLayer, _radar3dSource, _parseRadar3dUrl, _radarFrameKey,
  updateRadarLegend, RADAR_PALETTE_KEY, RADAR_SOURCE_KEY, getRadarSourceSetting, setRadarSource,
  _noteRadarTile, NWS_TILE_FAIL_LIMIT,
} = app;

const flush = () => new Promise(r => setTimeout(r, 0));
const hexRgb = h => [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
const nwsRamp = dbz => [...hexRgb(NWS_BREF_RAMP[Math.round((dbz + 27.4) / 0.2)]), 255];

// Fake <img>: records instances; tests fire onload/onerror by hand.
const images = [];
class FakeImage { constructor() { images.push(this); this.crossOrigin = null; } }

// Fake 2D contexts. The tile canvas is 2×1; anything else is the NWS
// precip-type canvas (tile + margin). pixels() supplies what getImageData reads.
let ctxLog, pixels;
function fakeContext(canvas) {
  return {
    drawImage: vi.fn(img => ctxLog.push(['draw', img.src])),
    getImageData: vi.fn((x, y, w, h) => {
      if (ctxLog.tainted) throw new Error('SecurityError');
      return { data: new Uint8ClampedArray(pixels(w, h)) };
    }),
    putImageData: vi.fn(img => ctxLog.push(['put', [...img.data]])),
  };
}
const rvPixels = (w, h) => [...rainViewerSourceRgba('rain', 15), ...rainViewerSourceRgba('snow', 15)];

const RV_FRAME = { source: 'rainviewer', time: 100, path: '/v2/radar/x' };
const NWS_FRAME = { source: 'nws', time: 200, region: 'conus', brefTime: '2026-11-20T15:39:55.000Z', typeTime: '2026-11-20T15:40:00.000Z' };

beforeEach(() => {
  try { localStorage.clear(); } catch (_) {}
  images.length = 0;
  ctxLog = [];
  pixels = rvPixels;
  globalThis.Image = FakeImage;
  HTMLCanvasElement.prototype.getContext = function () { return this._ctx || (this._ctx = fakeContext(this)); };
  HTMLCanvasElement.prototype.toBlob = function (cb) { cb({ arrayBuffer: async () => new Uint8Array([7]).buffer }); };
  document.body.innerHTML = `
    <select id="cfgRadarPalette"><option value="classic">c</option><option value="served">s</option></select>
    <select id="cfgRadarSource"><option value="auto">a</option><option value="rainviewer">r</option></select>
    <div id="radarControls" style="display:none"><span id="radarTime"></span><span id="radarSource"></span></div>
    <span id="radarLegend"><span data-label="rain">RAIN</span><span data-kind="rain"></span>
      <span data-label="snow">SNOW</span><span data-kind="snow"></span></span>
    <div id="layerList"></div>`;
  S.radarAnim = null;
  S.is3D = false;
  S.areaCenter = null;
  S._nwsRadarDownUntil = 0;
  S._nwsTileFails = 0;
});

describe('radar settings', () => {
  it('palette defaults to classic; junk falls back; the old "universal" name means as served', () => {
    expect(getRadarPalette()).toBe('classic');
    localStorage.setItem(RADAR_PALETTE_KEY, 'neon');
    expect(getRadarPalette()).toBe('classic');
    localStorage.setItem(RADAR_PALETTE_KEY, 'universal');
    expect(getRadarPalette()).toBe('served');
  });

  it('setRadarPalette persists, syncs the select, repaints the legend and redraws every frame', () => {
    const layers = [_makeRadarTileLayer(RV_FRAME, {}), _makeRadarTileLayer(RV_FRAME, {})];
    S.radarAnim = { layers, index: 1, frames: [RV_FRAME, RV_FRAME], source: 'rainviewer' };
    setRadarPalette('served');
    expect(localStorage.getItem(RADAR_PALETTE_KEY)).toBe('served');
    expect(document.getElementById('cfgRadarPalette').value).toBe('served');
    layers.forEach(l => expect(l.redraw).toHaveBeenCalled());
    expect(document.querySelector('[data-kind="rain"]').style.background).not.toBe('');
  });

  it('legend: NWS as served has no rain/snow split, so it shows one RADAR bar', () => {
    S.radarAnim = { layers: [], frames: [], source: 'nws' };
    localStorage.setItem(RADAR_PALETTE_KEY, 'served');
    updateRadarLegend();
    expect(document.querySelector('[data-label="rain"]').textContent).toBe('RADAR');
    expect(document.querySelector('[data-kind="snow"]').style.display).toBe('none');
    localStorage.setItem(RADAR_PALETTE_KEY, 'classic');
    updateRadarLegend();
    expect(document.querySelector('[data-label="rain"]').textContent).toBe('RAIN');
    expect(document.querySelector('[data-kind="snow"]').style.display).toBe('');
    document.body.innerHTML = '';
    expect(() => updateRadarLegend()).not.toThrow();
  });

  it('source defaults to auto; only "rainviewer" is kept', () => {
    expect(getRadarSourceSetting()).toBe('auto');
    localStorage.setItem(RADAR_SOURCE_KEY, 'nws');
    expect(getRadarSourceSetting()).toBe('auto');
    localStorage.setItem(RADAR_SOURCE_KEY, 'rainviewer');
    expect(getRadarSourceSetting()).toBe('rainviewer');
  });
});

describe('2D RainViewer tiles', () => {
  const tile = () => {
    const layer = _makeRadarTileLayer(RV_FRAME, { opacity: 0 });
    const done = vi.fn();
    const canvas = layer.createTile({ z: 7, x: 20, y: 48 }, done);
    return { layer, done, canvas };
  };

  it('uses the scheme-2 template and RainViewer\'s z7 limit', () => {
    const l = _makeRadarTileLayer(RV_FRAME, { opacity: 0 });
    expect(l._url).toBe('https://tilecache.rainviewer.com/v2/radar/x/256/{z}/{x}/{y}/2/1_1.png');
    expect(l.options.maxNativeZoom).toBe(7);
    expect(l.options.radarFrame).toBe(RV_FRAME);
  });

  it('loads with CORS and repaints rain green, leaving snow blue', async () => {
    const { done, canvas } = tile();
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.complete).toBe(false);
    expect(images[0].crossOrigin).toBe('anonymous');
    expect(images[0].src).toBe('https://tilecache.rainviewer.com/v2/radar/x/256/7/20/48/2/1_1.png');
    images[0].onload(); await flush();
    const put = ctxLog.find(e => e[0] === 'put');
    expect(put[1].slice(0, 4)).toEqual(radarPaletteRgba('classic', 'rain', 15));
    expect(put[1].slice(4, 8)).toEqual(rainViewerSourceRgba('snow', 15));
    expect(done).toHaveBeenCalledWith(null, canvas);
    expect(canvas.complete).toBe(true);
  });

  it('draws as served under the served palette, or when pixels are unreadable', async () => {
    localStorage.setItem(RADAR_PALETTE_KEY, 'served');
    let t = tile(); images[0].onload(); await flush();
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(t.done).toHaveBeenCalledWith(null, t.canvas);

    localStorage.clear(); ctxLog = []; ctxLog.tainted = true;
    t = tile(); images[1].onload(); await flush();
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(t.done).toHaveBeenCalledWith(null, t.canvas);
  });

  it('retries without CORS, then reports a hard failure', async () => {
    const { done, canvas } = tile();
    images[0].onerror(); await flush();
    expect(images[1].crossOrigin).toBeNull();
    expect(images[1].src).toBe(images[0].src);
    images[1].onload(); await flush();
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(done).toHaveBeenCalledWith(null, canvas);

    const t2 = tile();
    images[2].onerror(); await flush();
    images[3].onerror(); await flush();
    expect(t2.done).toHaveBeenCalledWith(expect.any(Error), t2.canvas);
  });
});

describe('2D NWS tiles', () => {
  // 2×1 tile at z9; the precip-type canvas adds a 1 px margin (4×3).
  const nwsPixels = (w, h) => {
    if (w === 2 && h === 1) return [...nwsRamp(20), ...nwsRamp(20)];
    const d = new Array(w * h * 4).fill(0);
    d.splice((1 * w + 1) * 4, 4, ...hexRgb('0450a4'), 255);  // warm stratiform rain over pixel 0
    d.splice((1 * w + 2) * 4, 4, ...hexRgb('c8c8c8'), 255);  // snow over pixel 1
    return d;
  };
  const tile = () => {
    const layer = _makeRadarTileLayer(NWS_FRAME, { opacity: 0 });
    const done = vi.fn();
    const canvas = layer.createTile({ z: 9, x: 84, y: 194 }, done);
    return { layer, done, canvas };
  };

  it('requests reflectivity plus a precip-type image with a margin, at z9 max', () => {
    pixels = nwsPixels;
    const { layer } = tile();
    expect(layer.options.maxNativeZoom).toBe(9);
    expect(images).toHaveLength(2);
    const type = images.find(i => i.src.includes('conus_pcpn_typ'));
    const bref = images.find(i => i.src.includes('conus_bref_qcd'));
    expect(type.src).toContain('&width=4&height=3');
    expect(type.src).toContain('&time=2026-11-20T15%3A40%3A00.000Z');
    expect(bref.src).toContain('&width=2&height=1');
    expect(bref.src).toContain('&time=2026-11-20T15%3A39%3A55.000Z');
    expect(bref.crossOrigin).toBe('anonymous');
    expect(type.crossOrigin).toBe('anonymous');
  });

  it('repaints rain green and snow blue from NWS precip type', async () => {
    pixels = nwsPixels;
    const { done, canvas } = tile();
    images.forEach(i => i.onload()); await flush(); await flush();
    const put = ctxLog.find(e => e[0] === 'put');
    expect(put[1].slice(0, 4)).toEqual(radarPaletteRgba('classic', 'rain', 20));
    expect(put[1].slice(4, 8)).toEqual(radarPaletteRgba('classic', 'snow', 20));
    expect(done).toHaveBeenCalledWith(null, canvas);
  });

  it('as served: only reflectivity is fetched and drawn untouched', async () => {
    pixels = nwsPixels;
    localStorage.setItem(RADAR_PALETTE_KEY, 'served');
    const { done, canvas } = tile();
    expect(images).toHaveLength(1);
    expect(images[0].src).toContain('conus_bref_qcd');
    images[0].onload(); await flush();
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(done).toHaveBeenCalledWith(null, canvas);
  });

  it('a missing precip-type image leaves the tile as served rather than guessing rain', async () => {
    pixels = nwsPixels;
    const { done, canvas } = tile();
    images.find(i => i.src.includes('pcpn_typ')).onerror();
    images.find(i => i.src.includes('bref_qcd')).onload();
    await flush(); await flush();
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(done).toHaveBeenCalledWith(null, canvas);
  });

  it(`after ${6} failed NWS tiles in a row, NWS is treated as down and the radar reloads`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ radar: { past: [{ time: 1, path: '/v2/radar/a' }] } }) }));
    S.map = { hasLayer: () => false, removeLayer() {}, addLayer() {}, getCenter: () => ({ lat: 38.7, lng: -120.8 }) };
    S.radarAnim = { layers: [], frames: [NWS_FRAME], index: 0, source: 'nws' };
    try {
      expect(NWS_TILE_FAIL_LIMIT).toBe(6);
      for (let i = 0; i < 5; i++) _noteRadarTile(NWS_FRAME, false);
      _noteRadarTile(NWS_FRAME, true);                       // a success resets the run
      for (let i = 0; i < 5; i++) _noteRadarTile(NWS_FRAME, false);
      expect(S._nwsRadarDownUntil).toBe(0);
      _noteRadarTile(RV_FRAME, false);                       // RainViewer failures don't count
      _noteRadarTile(NWS_FRAME, false);
      expect(S._nwsRadarDownUntil).toBeGreaterThan(Date.now());
      await flush(); await flush();
      expect(S.radarAnim.source).toBe('rainviewer');
      expect(S.radarAnim.fallback).toBe('NWS radar tiles were failing');
      expect(globalThis.fetch.mock.calls.map(c => String(c[0]))).not.toContain(nwsRadarCapabilitiesUrl('conus'));
    } finally { globalThis.fetch = realFetch; S.map = null; }
  });
});

describe('3D radar source', () => {
  afterEach(() => { delete globalThis.maplibregl; });
  const layer = f => ({ options: { radarFrame: f } });

  it('without the protocol or with the served palette: plain URLs at the source\'s max zoom', () => {
    expect(_radar3dSource(layer(RV_FRAME))).toEqual({ url: rainViewerTileUrl('/v2/radar/x'), maxzoom: 7 });
    const nws = _radar3dSource(layer(NWS_FRAME));
    expect(nws.maxzoom).toBe(9);
    expect(nws.url).toContain('/conus/conus_bref_qcd/ows?');
    expect(nws.url).toContain('&bbox={bbox-epsg-3857}&');
    globalThis.maplibregl = { addProtocol: vi.fn() };
    localStorage.setItem(RADAR_PALETTE_KEY, 'served');
    expect(_radar3dSource(layer(NWS_FRAME)).url).toContain('&bbox={bbox-epsg-3857}&');
    expect(maplibregl.addProtocol).not.toHaveBeenCalled();
    expect(_radar3dSource({ options: {} })).toBeNull();
  });

  it('repainted palettes go through sarradar://, whose URLs round-trip to the frame', async () => {
    globalThis.maplibregl = { addProtocol: vi.fn() };
    const rv = _radar3dSource(layer(RV_FRAME)).url;
    const nws = _radar3dSource(layer(NWS_FRAME)).url;
    expect(rv).toBe('sarradar://classic/rv/%2Fv2%2Fradar%2Fx/{z}/{x}/{y}');
    expect(nws).toBe('sarradar://classic/nws/conus/2026-11-20T15%3A39%3A55.000Z/2026-11-20T15%3A40%3A00.000Z/{z}/{x}/{y}');
    expect(maplibregl.addProtocol).toHaveBeenCalledTimes(1);

    const t = _parseRadar3dUrl(nws.replace('{z}/{x}/{y}', '9/84/194'));
    expect(t).toEqual({ palette: 'classic', z: 9, x: 84, y: 194,
      frame: { source: 'nws', region: 'conus', brefTime: NWS_FRAME.brefTime, typeTime: NWS_FRAME.typeTime } });
    expect(_parseRadar3dUrl(rv.replace('{z}/{x}/{y}', '7/20/48')).frame).toEqual({ source: 'rainviewer', path: '/v2/radar/x' });
    expect(_parseRadar3dUrl('sarradar://classic/nws/conus/a/-/1/2/3').frame.typeTime).toBeNull();
    expect(_parseRadar3dUrl('https://example.com/1/2/3')).toBeNull();
    expect(_parseRadar3dUrl('sarradar://classic/nws/conus/a/1/2/3')).toBeNull();
    expect(_radarFrameKey(Object.assign({}, NWS_FRAME, { typeTime: null }))).toMatch(/\/-$/);

    // The protocol renders the tile like the 2D layer and returns PNG bytes.
    const [name, handler] = maplibregl.addProtocol.mock.calls[0];
    expect(name).toBe('sarradar');
    const p = handler({ url: rv.replace('{z}/{x}/{y}', '7/20/48') });
    await flush();
    expect(images[0].src).toBe('https://tilecache.rainviewer.com/v2/radar/x/256/7/20/48/2/1_1.png');
    images[0].onload();
    const res = await p;
    expect(new Uint8Array(res.data)).toEqual(new Uint8Array([7]));
    await expect(handler({ url: 'sarradar://nope' })).rejects.toThrow('bad radar url');
  });
});

describe('fetchRadar: NWS first, RainViewer fallback', () => {
  const CAPS = fs.readFileSync(path.join(__dirname, '../fixtures/nws-radar-conus-capabilities.xml'), 'utf8');
  const NEWEST = Date.parse('2026-11-20T15:46:04Z');
  const RV_JSON = { radar: { past: [{ time: 1, path: '/v2/radar/aaa' }, { time: 2, path: '/v2/radar/bbb' }] } };
  let realFetch, added, errSpy;

  const mockFetch = ({ caps = 'ok' } = {}) => vi.fn(async url => {
    if (String(url).includes('opengeo.ncep.noaa.gov')) {
      if (caps === 'fail') throw new TypeError('Failed to fetch');
      return { ok: true, text: async () => CAPS };
    }
    return { ok: true, json: async () => RV_JSON };
  });
  const setMap = (lat, lng) => {
    S.map = { hasLayer: l => added.includes(l), removeLayer(l) { added = added.filter(x => x !== l); }, addLayer(l) { added.push(l); }, getCenter: () => ({ lat, lng }) };
  };

  beforeEach(() => {
    realFetch = globalThis.fetch;
    added = [];
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NEWEST + 4 * 60 * 1000);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    S.map = null;
  });

  it('inside NWS coverage: NWS frames 10 min apart, newest shown, tagged NWS', async () => {
    globalThis.fetch = mockFetch(); setMap(38.73, -120.8);
    await app.fetchRadar();
    const a = S.radarAnim;
    expect(a.source).toBe('nws');
    expect(a.fallback).toBeNull();
    expect(a.frames.length).toBeGreaterThanOrEqual(12);
    expect(a.frames[a.frames.length - 1]).toMatchObject({ source: 'nws', region: 'conus', brefTime: '2026-11-20T15:46:04.000Z', typeTime: '2026-11-20T15:46:00.000Z' });
    expect(added).toEqual([a.layers[a.index]]);
    expect(a.layers[a.index].options.opacity).toBe(0.5);
    expect(document.getElementById('radarSource').textContent).toBe('NWS');
    expect(document.getElementById('radarControls').style.display).toBe('flex');
    expect(globalThis.fetch.mock.calls.map(c => String(c[0])).some(u => u.includes('rainviewer'))).toBe(false);
  });

  it('the operational area wins over the map center', async () => {
    globalThis.fetch = mockFetch(); setMap(48.85, 2.35);
    S.areaCenter = { lat: 38.73, lng: -120.8 };
    await app.fetchRadar();
    expect(S.radarAnim.source).toBe('nws');
  });

  it('NWS unreachable: RainViewer, with an amber tag saying why', async () => {
    globalThis.fetch = mockFetch({ caps: 'fail' }); setMap(38.73, -120.8);
    await app.fetchRadar();
    expect(S.radarAnim.source).toBe('rainviewer');
    expect(S.radarAnim.fallback).toBe('NWS radar unavailable (Failed to fetch)');
    expect(S.radarAnim.layers.map(l => l._url)).toEqual([rainViewerTileUrl('/v2/radar/aaa'), rainViewerTileUrl('/v2/radar/bbb')]);
    const tag = document.getElementById('radarSource');
    expect(tag.textContent).toBe('RAINVIEWER');
    expect(tag.classList.contains('fallback')).toBe(true);
    expect(tag.title).toContain('NWS radar unavailable');
  });

  it('NWS data too old: treated as down', async () => {
    globalThis.fetch = mockFetch(); setMap(38.73, -120.8);
    vi.setSystemTime(NEWEST + 45 * 60 * 1000);
    await app.fetchRadar();
    expect(S.radarAnim.source).toBe('rainviewer');
    expect(S.radarAnim.fallback).toBe('NWS radar unavailable (newest image is 45 min old)');
  });

  it('outside coverage, or set to RainViewer only: RainViewer without asking NWS', async () => {
    globalThis.fetch = mockFetch(); setMap(48.85, 2.35);
    await app.fetchRadar();
    expect(S.radarAnim.source).toBe('rainviewer');
    expect(S.radarAnim.fallback).toBe('outside NWS radar coverage');
    expect(document.getElementById('radarSource').classList.contains('fallback')).toBe(false);

    setMap(38.73, -120.8);
    localStorage.setItem(RADAR_SOURCE_KEY, 'rainviewer');
    globalThis.fetch = mockFetch();
    await app.fetchRadar();
    expect(S.radarAnim.source).toBe('rainviewer');
    expect(S.radarAnim.fallback).toBeNull();
    expect(globalThis.fetch.mock.calls.map(c => String(c[0])).some(u => u.includes('opengeo'))).toBe(false);
  });

  it('no center at all: RainViewer', async () => {
    globalThis.fetch = mockFetch();
    S.map = { hasLayer: () => false, removeLayer() {}, addLayer(l) { added.push(l); } };
    await app.fetchRadar();
    expect(S.radarAnim.source).toBe('rainviewer');
  });

  it('background refresh: nothing newer → map untouched; newer → rebuilt, and a hidden radar stays hidden', async () => {
    globalThis.fetch = mockFetch(); setMap(38.73, -120.8);
    await app.fetchRadar();
    const first = S.radarAnim;
    await app._radarBackgroundRefresh();
    expect(S.radarAnim).toBe(first);

    // The user hides the radar; a newer frame then arrives.
    first.layers[first.index].options.opacity = 0;
    const newer = CAPS.replace(/2026-11-20T15:46:04\.000Z/g, '2026-11-20T15:48:04.000Z');
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => newer }));
    await app._radarBackgroundRefresh();
    expect(S.radarAnim).not.toBe(first);
    expect(S.radarAnim.frames[S.radarAnim.frames.length - 1].brefTime).toBe('2026-11-20T15:48:04.000Z');
    expect(S.radarAnim.layers.some(l => added.includes(l))).toBe(false);
  });

  it('background refresh is skipped while playing or viewing an older frame', async () => {
    globalThis.fetch = mockFetch(); setMap(38.73, -120.8);
    await app.fetchRadar();
    globalThis.fetch = vi.fn();
    S.radarAnim.index = 0;
    await app._radarBackgroundRefresh();
    S.radarAnim.index = S.radarAnim.layers.length - 1; S.radarAnim.playing = true;
    await app._radarBackgroundRefresh();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    S.radarAnim.playing = false;
  });

  it('setRadarSource persists, syncs the select and reloads the radar', async () => {
    globalThis.fetch = mockFetch(); setMap(38.73, -120.8);
    await app.fetchRadar();
    expect(S.radarAnim.source).toBe('nws');
    await setRadarSource('rainviewer');
    expect(localStorage.getItem(RADAR_SOURCE_KEY)).toBe('rainviewer');
    expect(document.getElementById('cfgRadarSource').value).toBe('rainviewer');
    expect(S.radarAnim.source).toBe('rainviewer');
    await setRadarSource('auto');
    expect(S.radarAnim.source).toBe('nws');
  });
});
