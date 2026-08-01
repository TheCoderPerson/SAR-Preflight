// Canopy VEG tool — imagery sampling, preview, and the apply/cancel gates.
// Leaflet, canvas, fetch and createImageBitmap are all mocked; the
// classification math itself is covered in tests/unit/canopyVeg.test.js.
//
// The assertions that matter most here are the ones about what does NOT
// happen: the preview must never mutate the working raster, CUT must not
// proceed past a declined confirm, and a failed imagery fetch must produce
// zero ops rather than an empty-but-committed edit.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);
const { VEG_DEL_MIN_FRAC } = raster;

// Colour every mocked tile pixel returns. Swapped per test.
const CONIFER = [60, 80, 45];
const DRY_GRASS = [210, 180, 120];
let TILE_RGB = CONIFER;

// Real orthoimagery is never flat: tree crowns at sub-metre GSD carry strong
// brightness structure, which is exactly what the ADD texture gate looks for.
// A uniform fixture would score as a lawn and be rejected, so vary BRIGHTNESS
// deterministically while leaving chromaticity (and therefore the greenness
// score) untouched.
const fakeCtx = () => ({
  putImageData() {}, clearRect() {}, drawImage() {},
  getImageData: (x, y, w, h) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const j = (((i * 2654435761) >>> 0) % 61) - 30;
      data[i * 4] = TILE_RGB[0] + j; data[i * 4 + 1] = TILE_RGB[1] + j;
      data[i * 4 + 2] = TILE_RGB[2] + j; data[i * 4 + 3] = 255;
    }
    return { data, width: w, height: h };
  },
  imageSmoothingEnabled: false,
});

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
  }
});

class MockDrawPolygon {
  constructor(map, opts) { MockDrawPolygon.instances.push(this); this.opts = opts; this.enabled = false; }
  enable() { this.enabled = true; }
  disable() { this.enabled = false; }
}
MockDrawPolygon.instances = [];
const layerStub = () => ({
  addTo() { return this; }, setUrl() {}, setBounds() {}, setOpacity() {},
  _bounds: { getNorthEast: () => ({}), getSouthWest: () => ({}) },
});
globalThis.L = {
  Draw: { Polygon: MockDrawPolygon },
  imageOverlay: () => layerStub(),
  latLngBounds: () => ({ getNorthEast: () => ({}), getSouthWest: () => ({}) }),
  layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }),
  Browser: { mobile: false },
  DomEvent: { stopPropagation() {} },
};

const {
  S, startCanopyEdit, exitCanopyEdit, setCanopyEditSubMode,
  onCanopyEditPolygon, canopyEditUndo, _uiYield,
  startCanopyVegSample, setCanopyVegDirection, setCanopyVegHeight,
  setCanopyVegSensitivity, canopyVegApply, canopyVegCancel,
} = require('../../sar-preflight.js');

const toggler = () => {
  const enabled = { v: true };
  return { enable() { enabled.v = true; }, disable() { enabled.v = false; }, enabled: () => enabled.v };
};

function makeMap(containerEl) {
  return {
    _onMap: new Set(),
    hasLayer(l) { return this._onMap.has(l); },
    addLayer(l) { this._onMap.add(l); },
    removeLayer(l) { this._onMap.delete(l); },
    closePopup() {}, on() {}, off() {},
    getContainer: () => containerEl,
    getZoom: () => 18,
    latLngToContainerPoint: () => ({ x: 0, y: 0 }),
    mouseEventToLatLng: e => ({ lat: e._lat, lng: e._lng }),
    dragging: toggler(), touchZoom: toggler(), doubleClickZoom: toggler(),
    getCenter: () => ({ lat: 38.7, lng: -120.99 }),
  };
}
const baseLayer = () => {
  const l = {};
  l.addTo = map => { map._onMap.add(l); return l; };
  return l;
};

const BAR_HTML = `
  <div class="map-container"><div id="mapEl"></div>
  <div id="canopyEditBar" style="display:none;">
    <span id="canopyEditMsg"></span>
    <button id="ceBtnPan"></button><button id="ceBtnBrush"></button>
    <button id="ceBtnPoly"></button><button id="ceBtnVeg"></button>
    <div id="ceBrushSizes"><button id="ceSizeS"></button><button id="ceSizeM"></button><button id="ceSizeL"></button></div>
    <div id="cePolyActions"></div>
    <div id="ceVegPanel" style="display:none;">
      <button id="ceVegDirAdd"></button><button id="ceVegDirCut"></button>
      <input id="ceVegHeight" type="number">
      <input id="ceVegSens" type="range" min="0" max="100" value="50">
      <span id="ceVegSensVal"></span>
      <button id="ceVegSmooth"></button>
      <button id="ceVegApply"></button>
    </div>
    <span id="ceVegStats"></span>
    <button id="ceBtnUndo"></button><button id="ceBtnSave"></button>
  </div></div>
  <span id="canopyStatus"></span><input id="canopyOpacity" value="0.6">
  <div id="layerList"></div><span id="canopyOpacityVal"></span>`;

// A canopy raster that is mostly EMPTY, so "fill gaps" has something to fill,
// with one measured tall tree to prove it is preserved.
function setupEditableState() {
  document.body.innerHTML = BAR_HTML;
  const containerEl = document.getElementById('mapEl');
  S.map = makeMap(containerEl);
  S.mapLayers = { satellite: baseLayer(), topo: baseLayer(), sectional: baseLayer(), canopy: layerStub() };
  S._overlayWanted = { canopy: true };
  const grid = makeGrid(38.7, -120.99, 250, 10);
  const canopyFlat = new Float32Array(grid.rows * grid.cols);
  canopyFlat[0] = 30;                       // NW corner: a measured 30 m tree
  S.canopy = { grid, source: 'Meta 1 m', canopyFlat };
  S._canopyEditing = false;
  S.canopyEdit = null;
  return { grid, containerEl };
}

// A ring covering the whole loaded grid.
function fullRing(grid) {
  const b = grid.bounds;
  return [[b.north, b.west], [b.north, b.east], [b.south, b.east], [b.south, b.west]];
}

let fetchCalls = [];
function mockImagery({ fail = false } = {}) {
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (fail) throw new TypeError('Failed to fetch');
    return { ok: true, type: 'basic', blob: async () => ({ size: 1 }) };
  };
  globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
}

beforeEach(() => {
  TILE_RGB = CONIFER;
  mockImagery();
  MockDrawPolygon.instances.length = 0;
});

afterEach(() => {
  if (S._canopyEditing) exitCanopyEdit(true);
  delete globalThis.fetch;
  delete globalThis.createImageBitmap;
  delete globalThis.confirm;
  delete globalThis.cacheRaster;
  delete globalThis.getCachedRaster;
  document.body.innerHTML = '';
});

async function enterVegPreview(ring) {
  const { grid } = setupEditableState();
  await startCanopyEdit();
  setCanopyEditSubMode('vegPolygon');
  await startCanopyVegSample(ring || fullRing(grid));
  return grid;
}

// Shared by VEG imagery sampling and the viewshed LOS kernel. rAF does not
// fire in a hidden tab, so a bare `await new Promise(requestAnimationFrame)`
// wedges the whole run forever with its progress readout frozen mid-count.
describe('_uiYield', () => {
  it('resolves even when rAF never fires (hidden tab)', async () => {
    const saved = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;      // registers, never calls back
    try {
      await expect(_uiYield()).resolves.toBeUndefined();
    } finally {
      globalThis.requestAnimationFrame = saved;
    }
  });

  // Measured in a real background tab: rAF never fires AND Chrome clamps the
  // fallback timer to ~1 s, so a yield cost 868 ms instead of 32 ms. Over a
  // 64-tile sample that is a minute of waiting to keep a UI responsive that
  // nobody is looking at.
  it('does not wait at all while the tab is hidden', async () => {
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    const savedRaf = globalThis.requestAnimationFrame;
    const savedTimeout = globalThis.setTimeout;
    globalThis.requestAnimationFrame = () => { throw new Error('must not schedule rAF when hidden'); };
    globalThis.setTimeout = () => { throw new Error('must not schedule a timer when hidden'); };
    try {
      await expect(_uiYield()).resolves.toBeUndefined();
    } finally {
      globalThis.requestAnimationFrame = savedRaf;
      globalThis.setTimeout = savedTimeout;
      delete document.hidden;
      if (hidden) Object.defineProperty(Document.prototype, 'hidden', hidden);
    }
  });

  it('resolves once, not twice, when both rAF and the timer fire', async () => {
    let calls = 0;
    const saved = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = cb => { cb(); return 0; };
    try {
      await _uiYield().then(() => { calls++; });
      await new Promise(r => setTimeout(r, 50));     // let the losing timer land
      expect(calls).toBe(1);
    } finally {
      globalThis.requestAnimationFrame = saved;
    }
  });
});

describe('VEG sub-mode', () => {
  it('arms a green draw polygon and does not show the brush sizes', async () => {
    setupEditableState();
    await startCanopyEdit();
    setCanopyEditSubMode('vegPolygon');
    const handler = MockDrawPolygon.instances[MockDrawPolygon.instances.length - 1];
    expect(handler.enabled).toBe(true);
    expect(handler.opts.shapeOptions.color).toBe('#22c55e');   // not the amber delete polygon
    expect(document.getElementById('ceBrushSizes').style.display).toBe('none');
    expect(document.getElementById('ceBtnVeg').classList.contains('active')).toBe(true);
  });

  it('routes a completed polygon to the VEG flow, not the delete flow', async () => {
    const { grid } = setupEditableState();
    await startCanopyEdit();
    setCanopyEditSubMode('vegPolygon');
    const ring = fullRing(grid);
    const layer = {
      setStyle() {}, addTo() { return this; },
      editing: { enable() {}, disable() {} },
      getLatLngs: () => [ring.map(p => ({ lat: p[0], lng: p[1] }))],
    };
    onCanopyEditPolygon(layer);
    expect(S.canopyEdit.polyLayer).toBe(layer);
    expect(document.getElementById('cePolyActions').style.display).toBe('none');
  });
});

describe('sampling and preview', () => {
  it('builds a preview without touching the working raster', async () => {
    const grid = await enterVegPreview();
    const ce = S.canopyEdit;
    expect(ce.subMode).toBe('vegPreview');
    expect(ce.veg.planes).toBeTruthy();
    expect(ce.veg.result.cells).toBeGreaterThan(0);
    expect(document.getElementById('ceVegPanel').style.display).toBe('flex');
    expect(document.getElementById('ceVegStats').textContent).toMatch(/ADD .*ha/);
    // Nothing committed: the raster is still the pristine copy.
    expect(ce.workFlat[0]).toBe(30);
    expect(ce.workFlat[grid.cols * 5 + 5]).toBe(0);
    expect(ce.sessionOps.length).toBe(0);
  });

  it('creates a preview canvas separate from the canopy edit canvas', async () => {
    await enterVegPreview();
    const el = document.getElementById('mapEl');
    expect(el.querySelector('#canopyEditCanvas')).toBeTruthy();
    expect(el.querySelector('#canopyVegCanvas')).toBeTruthy();
    // The preview must not inherit the canopy opacity slider (0.6 here), or it
    // becomes illegible whenever canopy is turned down.
    expect(el.querySelector('#canopyVegCanvas').style.opacity).not.toBe('0.6');
  });

  it('re-thresholds on the slider with no further imagery requests', async () => {
    await enterVegPreview();
    const before = fetchCalls.length;
    const workBefore = Array.from(S.canopyEdit.workFlat);
    setCanopyVegSensitivity(90);
    expect(fetchCalls.length).toBe(before);
    expect(S.canopyEdit.veg.sens).toBe(90);
    expect(document.getElementById('ceVegSensVal').textContent).toBe('90');
    expect(Array.from(S.canopyEdit.workFlat)).toEqual(workBefore);
  });

  // The plain URL is the only one that can hit the SW tile cache and work
  // offline, so it must always be tried first; ?sarcors=1 is the online-only
  // escape hatch for installs still holding legacy OPAQUE tile entries.
  it('tries the plain tile URL first and falls back to the cors retry per tile', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      fetchCalls.push(u);
      if (!u.includes('sarcors=1')) throw new TypeError('Failed to fetch');   // as an opaque hit does
      return { ok: true, type: 'basic', blob: async () => ({ size: 1 }) };
    };
    await enterVegPreview();
    const plain = fetchCalls.filter(u => !u.includes('sarcors=1'));
    const retries = fetchCalls.filter(u => u.includes('sarcors=1'));
    expect(plain.length).toBeGreaterThan(0);
    expect(retries.length).toBe(plain.length);
    // Every retry is the same tile as a plain request that came before it.
    for (const r of retries) {
      const base = r.split('?')[0];
      expect(fetchCalls.indexOf(base)).toBeGreaterThanOrEqual(0);
      expect(fetchCalls.indexOf(base)).toBeLessThan(fetchCalls.indexOf(r));
    }
    // And the fallback actually produced a usable preview.
    expect(S.canopyEdit.veg.result.cells).toBeGreaterThan(0);
  });

  // requestAnimationFrame does not fire while a tab is hidden. Sampling yields
  // a frame between tiles, so without a timer fallback, backgrounding the tab
  // mid-sample (trivial on a phone) wedges the run forever on a
  // "SAMPLING n/n TILES..." that never completes and cannot be undone.
  it('completes even when the tab is hidden and rAF never fires', async () => {
    const savedRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;      // registers, never calls back
    try {
      const grid = await enterVegPreview();
      expect(S.canopyEdit.veg.stage).toBe('preview');
      expect(S.canopyEdit.veg.result.cells).toBeGreaterThan(0);
      expect(grid).toBeTruthy();
    } finally {
      globalThis.requestAnimationFrame = savedRaf;
    }
  });

  it('reports unreadable imagery and pushes zero ops rather than an empty edit', async () => {
    mockImagery({ fail: true });
    const { grid } = setupEditableState();
    await startCanopyEdit();
    setCanopyEditSubMode('vegPolygon');
    await startCanopyVegSample(fullRing(grid));
    expect(S.canopyEdit.veg).toBeNull();
    expect(S.canopyEdit.sessionOps.length).toBe(0);
    expect(document.getElementById('canopyEditMsg').textContent).toMatch(/NOT READABLE|NO IMAGERY/);
  });
});

describe('APPLY', () => {
  it('fills gaps at the entered height and never lowers a measured one', async () => {
    const grid = await enterVegPreview();
    setCanopyVegHeight(40);                     // 40 ft ~ 12.2 m, well under the 30 m tree
    canopyVegApply();
    const ce = S.canopyEdit;
    expect(ce.workFlat[0]).toBe(30);            // measured height survives
    expect(ce.workFlat[grid.cols * 5 + 5]).toBeCloseTo(ftToM(40), 2);
    expect(ce.sessionOps.length).toBe(1);
    expect(ce.sessionOps[0].t).toBe('mask');
    expect(ce.sessionOps[0].mode).toBe('add');
    expect(ce.sessionOps[0].hMode).toBe('fill');
    expect(ce.subMode).toBe('pan');
    expect(ce.veg).toBeNull();
  });

  it('undo restores the raster byte-for-byte', async () => {
    await enterVegPreview();
    const before = Array.from(S.canopyEdit.workFlat);
    setCanopyVegHeight(40);
    canopyVegApply();
    expect(Array.from(S.canopyEdit.workFlat)).not.toEqual(before);
    canopyEditUndo();
    expect(Array.from(S.canopyEdit.workFlat)).toEqual(before);
    expect(S.canopyEdit.sessionOps.length).toBe(0);
  });

  // Most detected cells in dense forest already hold trees, so the message has
  // to lead with what actually MOVED on the raster; leading with the detected
  // area would report 23 ha when 64 cells changed.
  it('reports what changed on the raster, then the detected area', async () => {
    await enterVegPreview();
    canopyVegApply();
    const msg = document.getElementById('canopyEditMsg').textContent;
    expect(msg).toMatch(/^Filled [\d,]+ cells \/ [\d.]+ ha at \d+ ft — [\d.]+ ha detected/);
  });
});

describe('CUT', () => {
  // Deleting canopy makes the viewshed predict MORE visibility, so it is the
  // one direction that must not proceed on a single tap.
  it('does nothing when the confirm is declined', async () => {
    TILE_RGB = DRY_GRASS;
    const grid = await enterVegPreview();
    S.canopyEdit.workFlat.fill(15);
    const before = Array.from(S.canopyEdit.workFlat);
    setCanopyVegDirection('del');
    let asked = false;
    globalThis.confirm = () => { asked = true; return false; };
    canopyVegApply();
    expect(asked).toBe(true);
    expect(Array.from(S.canopyEdit.workFlat)).toEqual(before);
    expect(S.canopyEdit.sessionOps.length).toBe(0);
    expect(S.canopyEdit.veg).toBeTruthy();      // preview survives a declined confirm
    expect(grid).toBeTruthy();
  });

  it('clears canopy once confirmed', async () => {
    TILE_RGB = DRY_GRASS;
    await enterVegPreview();
    S.canopyEdit.workFlat.fill(15);
    setCanopyVegDirection('del');
    globalThis.confirm = () => true;
    canopyVegApply();
    expect(S.canopyEdit.sessionOps.length).toBe(1);
    expect(S.canopyEdit.sessionOps[0].mode).toBe('del');
    expect(S.canopyEdit.sessionOps[0].minFrac).toBe(VEG_DEL_MIN_FRAC);
    expect(S.canopyEdit.workFlat[S.canopy.grid.cols * 5 + 5]).toBe(0);
  });

  // The slider moves the greenness threshold, so mapping both directions the
  // same way made dragging to max PROTECT more and cut less — the opposite of
  // what the control reads as. It must be monotone in "do more of this".
  it('higher sensitivity cuts MORE, not less', async () => {
    TILE_RGB = DRY_GRASS;
    await enterVegPreview();
    setCanopyVegDirection('del');
    setCanopyVegSensitivity(0);
    const low = S.canopyEdit.veg.result.cells;
    setCanopyVegSensitivity(100);
    const high = S.canopyEdit.veg.result.cells;
    expect(high).toBeGreaterThanOrEqual(low);
    // ...and ADD stays monotone in the same direction.
    setCanopyVegDirection('add');
    setCanopyVegSensitivity(0);
    const addLow = S.canopyEdit.veg.result.cells;
    setCanopyVegSensitivity(100);
    expect(S.canopyEdit.veg.result.cells).toBeGreaterThanOrEqual(addLow);
  });

  it('never selects a cell it could not judge', async () => {
    TILE_RGB = [10, 12, 9];                     // everything in deep shadow
    await enterVegPreview();
    setCanopyVegDirection('del');
    expect(S.canopyEdit.veg.result.cells).toBe(0);
    expect(S.canopyEdit.veg.result.unknownCells).toBeGreaterThan(0);
    expect(document.getElementById('ceVegApply').disabled).toBe(true);
  });
});

describe('CANCEL and exit', () => {
  it('cancel discards the preview and changes nothing', async () => {
    await enterVegPreview();
    const before = Array.from(S.canopyEdit.workFlat);
    canopyVegCancel();
    expect(S.canopyEdit.veg).toBeNull();
    expect(S.canopyEdit.polyLayer).toBeNull();
    expect(S.canopyEdit.sessionOps.length).toBe(0);
    expect(Array.from(S.canopyEdit.workFlat)).toEqual(before);
    expect(document.getElementById('ceVegPanel').style.display).toBe('none');
  });

  it('switching to another sub-mode discards the preview', async () => {
    await enterVegPreview();
    setCanopyEditSubMode('brush');
    expect(S.canopyEdit.veg).toBeNull();
  });

  it('exiting edit mode removes BOTH canvases', async () => {
    await enterVegPreview();
    const el = document.getElementById('mapEl');
    exitCanopyEdit(true);
    expect(el.querySelector('#canopyEditCanvas')).toBeNull();
    expect(el.querySelector('#canopyVegCanvas')).toBeNull();
  });
});
