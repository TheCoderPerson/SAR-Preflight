// Radar recolor glue: the Config palette setting, the canvas tile layer that
// repaints RainViewer tiles in 2D, and the sarradar:// protocol for 3D.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Leaflet stand-in: TileLayer.extend returns a constructor carrying the
// overridden methods, so createTile can be driven directly.
const plainLayers = [];
function makeL({ withTileLayer }) {
  const L = {
    tileLayer: vi.fn((url, opts) => {
      const l = { _url: url, options: Object.assign({}, opts), plain: true };
      plainLayers.push(l);
      return l;
    }),
    layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {}, getLayers: () => [] }),
  };
  if (withTileLayer) {
    L.TileLayer = {
      extend(proto) {
        function Cls(url, opts) { this._url = url; this.options = Object.assign({}, opts); }
        Object.assign(Cls.prototype, proto, {
          getTileSize: () => ({ x: 2, y: 1 }),
          getTileUrl(c) { return this._url.replace('{z}', c.z).replace('{x}', c.x).replace('{y}', c.y); },
          redraw: vi.fn(),
          setOpacity(v) { this.options.opacity = v; return this; },
          addTo(m) { m.addLayer(this); return this; },
        });
        return Cls;
      },
    };
  }
  return L;
}
globalThis.L = makeL({ withTileLayer: true });

const app = require('../../sar-preflight.js');
const {
  S, getRadarPalette, setRadarPalette, _makeRadarTileLayer, _radar3dUrl, updateRadarLegend, RADAR_PALETTE_KEY,
} = app;

// Fake <img>: records instances; tests fire onload/onerror by hand.
const images = [];
class FakeImage { constructor() { images.push(this); this.crossOrigin = null; } }

// Fake 2D context over a 2×1 tile: pixel 0 = RainViewer light rain, pixel 1 = light snow.
let ctxLog;
function fakeContext() {
  const rain = rainViewerSourceRgba('rain', 15);
  const snow = rainViewerSourceRgba('snow', 15);
  return {
    drawImage: vi.fn(img => ctxLog.push(['draw', img])),
    getImageData: vi.fn(() => {
      if (ctxLog.tainted) throw new Error('SecurityError');
      return { data: new Uint8ClampedArray([...rain, ...snow]) };
    }),
    putImageData: vi.fn(img => ctxLog.push(['put', [...img.data]])),
  };
}

beforeEach(() => {
  try { localStorage.clear(); } catch (_) {}
  images.length = 0;
  plainLayers.length = 0;
  ctxLog = [];
  globalThis.Image = FakeImage;
  HTMLCanvasElement.prototype.getContext = function () { return this._ctx || (this._ctx = fakeContext()); };
  document.body.innerHTML = `
    <select id="cfgRadarPalette"><option value="classic">c</option><option value="universal">u</option></select>
    <span id="radarLegend"><span data-kind="rain"></span><span data-kind="snow"></span></span>`;
  S.radarAnim = null;
  S.is3D = false;
});

describe('radar palette setting', () => {
  it('defaults to classic and falls back to it for a junk stored value', () => {
    expect(getRadarPalette()).toBe('classic');
    localStorage.setItem(RADAR_PALETTE_KEY, 'neon');
    expect(getRadarPalette()).toBe('classic');
  });

  it('setRadarPalette persists, syncs the select, repaints the legend and redraws every frame', () => {
    const frames = [_makeRadarTileLayer('https://t/{z}/{x}/{y}.png', {}), _makeRadarTileLayer('https://t/{z}/{x}/{y}.png', {})];
    S.radarAnim = { layers: frames, index: 1, frames: [] };
    setRadarPalette('universal');
    expect(localStorage.getItem(RADAR_PALETTE_KEY)).toBe('universal');
    expect(getRadarPalette()).toBe('universal');
    expect(document.getElementById('cfgRadarPalette').value).toBe('universal');
    frames.forEach(f => expect(f.redraw).toHaveBeenCalled());
    // jsdom drops gradients it can't parse, so compare against the source.
    expect(document.querySelector('[data-kind="rain"]').style.background).not.toBe('');
  });

  it('updateRadarLegend tolerates a page without the legend', () => {
    document.body.innerHTML = '';
    expect(() => updateRadarLegend()).not.toThrow();
  });
});

describe('2D radar tile layer', () => {
  const tile = () => {
    const layer = _makeRadarTileLayer('https://tilecache.rainviewer.com/v2/radar/x/256/{z}/{x}/{y}/2/1_1.png', { opacity: 0 });
    const done = vi.fn();
    const canvas = layer.createTile({ z: 7, x: 20, y: 48 }, done);
    return { layer, done, canvas };
  };

  it('loads the tile with CORS and repaints rain green, leaving snow blue', () => {
    const { done, canvas } = tile();
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.complete).toBe(false);
    expect(images).toHaveLength(1);
    expect(images[0].crossOrigin).toBe('anonymous');
    expect(images[0].src).toBe('https://tilecache.rainviewer.com/v2/radar/x/256/7/20/48/2/1_1.png');
    images[0].onload();
    const put = ctxLog.find(e => e[0] === 'put');
    expect(put).toBeTruthy();
    expect(put[1].slice(0, 4)).toEqual(radarPaletteRgba('classic', 'rain', 15));
    expect(put[1].slice(4, 8)).toEqual(rainViewerSourceRgba('snow', 15));
    expect(done).toHaveBeenCalledWith(null, canvas);
    expect(canvas.complete).toBe(true);
  });

  it('draws the tile as served under the universal palette', () => {
    localStorage.setItem(RADAR_PALETTE_KEY, 'universal');
    const { done, canvas } = tile();
    images[0].onload();
    expect(ctxLog.some(e => e[0] === 'draw')).toBe(true);
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(done).toHaveBeenCalledWith(null, canvas);
  });

  it('shows the tile unrecolored when its pixels cannot be read', () => {
    ctxLog.tainted = true;
    const { done, canvas } = tile();
    images[0].onload();
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(done).toHaveBeenCalledWith(null, canvas);
  });

  it('retries without CORS when the CORS load fails, then reports a hard failure', () => {
    const { done, canvas } = tile();
    images[0].onerror();
    expect(images).toHaveLength(2);
    expect(images[1].crossOrigin).toBeNull();
    expect(images[1].src).toBe(images[0].src);
    images[1].onload();
    expect(ctxLog.some(e => e[0] === 'draw')).toBe(true);
    expect(ctxLog.some(e => e[0] === 'put')).toBe(false);
    expect(done).toHaveBeenCalledWith(null, canvas);

    const t2 = tile();
    images[2].onerror();
    images[3].onerror();
    expect(t2.done).toHaveBeenCalledWith(expect.any(Error), t2.canvas);
  });
});

describe('3D radar URL', () => {
  const url = 'https://tilecache.rainviewer.com/v2/radar/x/256/{z}/{x}/{y}/2/1_1.png';
  afterEach(() => { delete globalThis.maplibregl; delete globalThis.createImageBitmap; });

  it('stays a plain https URL when MapLibre is not loaded or the palette is as served', () => {
    expect(_radar3dUrl(url)).toBe(url);
    globalThis.maplibregl = { addProtocol: vi.fn() };
    globalThis.createImageBitmap = vi.fn();
    localStorage.setItem(RADAR_PALETTE_KEY, 'universal');
    expect(_radar3dUrl(url)).toBe(url);
    expect(maplibregl.addProtocol).not.toHaveBeenCalled();
    expect(_radar3dUrl(null)).toBeNull();
  });

  it('routes through the sarradar protocol (registered once) for a repainted palette', async () => {
    globalThis.maplibregl = { addProtocol: vi.fn() };
    globalThis.createImageBitmap = vi.fn();
    expect(_radar3dUrl(url)).toBe('sarradar://classic/tilecache.rainviewer.com/v2/radar/x/256/{z}/{x}/{y}/2/1_1.png');
    expect(_radar3dUrl(url)).toMatch(/^sarradar:\/\/classic\//);
    expect(maplibregl.addProtocol).toHaveBeenCalledTimes(1);
    const [name, handler] = maplibregl.addProtocol.mock.calls[0];
    expect(name).toBe('sarradar');

    // As-served palette in the URL: the tile bytes pass straight through.
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({ arrayBuffer: async () => bytes }) }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const res = await handler({ url: 'sarradar://universal/tilecache.rainviewer.com/v2/radar/x/256/7/20/48/2/1_1.png' }, new AbortController());
      expect(fetchMock.mock.calls[0][0]).toBe('https://tilecache.rainviewer.com/v2/radar/x/256/7/20/48/2/1_1.png');
      expect(res.data).toBe(bytes);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      await expect(handler({ url: 'sarradar://classic/tilecache.rainviewer.com/a.png' }, new AbortController())).rejects.toThrow('HTTP 404');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('fetchRadar', () => {
  it('requests scheme-2 tiles for every frame and shows the newest', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ radar: { past: [{ time: 1, path: '/v2/radar/aaa' }, { time: 2, path: '/v2/radar/bbb' }] } }),
    }));
    document.body.insertAdjacentHTML('beforeend',
      '<div id="radarControls" style="display:none"><span id="radarTime"></span></div><div id="layerList"></div>');
    const added = [];
    S.map = { hasLayer: () => false, removeLayer() {}, addLayer(l) { added.push(l); } };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await app.fetchRadar();
    } finally {
      globalThis.fetch = realFetch;
    }
    const errors = errSpy.mock.calls.slice();
    errSpy.mockRestore();
    expect(errors.map(e => String(e[1] && e[1].stack).slice(0, 300))).toEqual([]);
    expect(S.radarAnim.layers.map(l => l._url)).toEqual([
      'https://tilecache.rainviewer.com/v2/radar/aaa/256/{z}/{x}/{y}/2/1_1.png',
      'https://tilecache.rainviewer.com/v2/radar/bbb/256/{z}/{x}/{y}/2/1_1.png',
    ]);
    expect(S.radarAnim.index).toBe(1);
    expect(added).toEqual([S.radarAnim.layers[1]]);
    expect(S.radarAnim.layers[1].options.opacity).toBe(0.5);
    expect(document.getElementById('radarControls').style.display).toBe('flex');
    S.map = null;
  });
});
