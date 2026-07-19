// Canopy edit mode — enter/exit state machine, sub-modes, brush strokes,
// polygon delete, undo stack, save. Leaflet + canvas are mocked (jsdom has no
// 2D canvas); the pure edit math itself is covered in tests/unit/canopyEdit.test.js.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// --- Canvas 2D stub (jsdom's getContext returns null) ---
const fakeCtx = () => ({
  putImageData() {}, clearRect() {}, drawImage() {},
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  imageSmoothingEnabled: false,
});
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
  }
});

// --- Leaflet mock ---
class MockDrawPolygon {
  constructor() { MockDrawPolygon.instances.push(this); this.enabled = false; }
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
  latLngBounds: (a, b) => ({ getNorthEast: () => ({}), getSouthWest: () => ({}) }),
  layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }),
  Browser: { mobile: false },
  DomEvent: { stopPropagation() {} },
};

const {
  S, startCanopyEdit, exitCanopyEdit, setCanopyEditSubMode, setCanopyBrushSize,
  onCanopyEditPolygon, canopyEditDelete, canopyEditCancelPoly, canopyEditUndo,
  canopyEditSave, _canopyEditPushOp, CANOPY_EDIT_BRUSH_SIZES,
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
    closePopup() {},
    on() {}, off() {},
    getContainer: () => containerEl,
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
    <button id="ceBtnPan"></button><button id="ceBtnBrush"></button><button id="ceBtnPoly"></button>
    <div id="ceBrushSizes"><button id="ceSizeS"></button><button id="ceSizeM"></button><button id="ceSizeL"></button></div>
    <div id="cePolyActions"></div>
    <button id="ceBtnUndo"></button><button id="ceBtnSave"></button>
  </div></div>
  <span id="canopyStatus"></span><input id="canopyOpacity" value="0.6">
  <input type="checkbox" id="canopyToggle"><div id="layerList"></div>
  <span id="canopyOpacityVal"></span>`;

function setupEditableState() {
  document.body.innerHTML = BAR_HTML;
  const containerEl = document.getElementById('mapEl');
  S.map = makeMap(containerEl);
  S.mapLayers = { satellite: baseLayer(), topo: baseLayer(), sectional: baseLayer(), canopy: layerStub() };
  S._overlayWanted = { canopy: true };
  const grid = makeGrid(38.7, -120.99, 250, 10);
  const canopyFlat = new Float32Array(grid.rows * grid.cols).fill(15);
  S.canopy = { grid, source: 'Meta 1 m', canopyFlat };
  S._canopyEditing = false;
  S.canopyEdit = null;
  return { grid, containerEl };
}

afterEach(async () => {
  if (S._canopyEditing) exitCanopyEdit(true);
  delete globalThis.cacheRaster;
  delete globalThis.getCachedRaster;
  document.body.innerHTML = '';
});

describe('enter / exit canopy edit mode', () => {
  it('entering swaps to the satellite base, detaches the canopy overlay, and shows the bar', async () => {
    const { containerEl } = setupEditableState();
    S.mapLayers.topo.addTo(S.map); // user was on topo
    S.map._onMap.add(S.mapLayers.canopy);
    await startCanopyEdit();
    expect(S._canopyEditing).toBe(true);
    expect(S.map.hasLayer(S.mapLayers.satellite)).toBe(true);
    expect(S.map.hasLayer(S.mapLayers.topo)).toBe(false);
    expect(S.map.hasLayer(S.mapLayers.canopy)).toBe(false);
    expect(S._overlayWanted.canopy).toBe(false);
    expect(S.canopyEdit.prevBase).toBe('topo');
    expect(S.canopyEdit.subMode).toBe('pan');
    expect(document.getElementById('canopyEditBar').style.display).toBe('flex');
    expect(containerEl.querySelector('#canopyEditCanvas')).toBeTruthy();
    // work raster is a COPY — mutating it must not touch app state
    S.canopyEdit.workFlat[0] = 99;
    expect(S.canopy.canopyFlat[0]).toBe(15);
  });

  it('exiting restores the previous base, the canopy overlay, and clears state', async () => {
    const { containerEl } = setupEditableState();
    S.mapLayers.topo.addTo(S.map);
    await startCanopyEdit();
    exitCanopyEdit();
    expect(S._canopyEditing).toBe(false);
    expect(S.canopyEdit).toBe(null);
    expect(S.map.hasLayer(S.mapLayers.topo)).toBe(true);
    expect(S.map.hasLayer(S.mapLayers.satellite)).toBe(false);
    expect(S._overlayWanted.canopy).toBe(true);
    expect(document.getElementById('canopyEditBar').style.display).toBe('none');
    expect(containerEl.querySelector('#canopyEditCanvas')).toBe(null);
  });

  it('refuses to enter without canopy data', async () => {
    setupEditableState();
    S.canopy = {};
    globalThis.alert = () => {};
    await startCanopyEdit();
    expect(S._canopyEditing).toBe(false);
    delete globalThis.alert;
  });
});

describe('sub-modes', () => {
  it('brush disables map dragging + zoom gestures; pan re-enables them', async () => {
    const { containerEl } = setupEditableState();
    await startCanopyEdit();
    setCanopyEditSubMode('brush');
    expect(S.map.dragging.enabled()).toBe(false);
    expect(S.map.touchZoom.enabled()).toBe(false);
    expect(containerEl.style.touchAction).toBe('none');
    setCanopyEditSubMode('pan');
    expect(S.map.dragging.enabled()).toBe(true);
    expect(containerEl.style.touchAction).toBe('');
  });

  it('polygon sub-mode arms an L.Draw.Polygon handler', async () => {
    setupEditableState();
    await startCanopyEdit();
    MockDrawPolygon.instances = [];
    setCanopyEditSubMode('polygon');
    expect(MockDrawPolygon.instances.length).toBe(1);
    expect(MockDrawPolygon.instances[0].enabled).toBe(true);
    setCanopyEditSubMode('pan');
    expect(MockDrawPolygon.instances[0].enabled).toBe(false);
  });

  it('brush size presets update the radius', async () => {
    setupEditableState();
    await startCanopyEdit();
    expect(S.canopyEdit.brushRadiusM).toBe(CANOPY_EDIT_BRUSH_SIZES.M);
    setCanopyBrushSize(CANOPY_EDIT_BRUSH_SIZES.L);
    expect(S.canopyEdit.brushRadiusM).toBe(CANOPY_EDIT_BRUSH_SIZES.L);
  });
});

describe('brush strokes', () => {
  const fakeEv = (lat, lng) => ({ preventDefault() {}, stopPropagation() {}, pointerId: 1, isPrimary: true, _lat: lat, _lng: lng });

  it('down-move-up paints cells at the average height and records one op + one undo entry', async () => {
    const { grid } = setupEditableState();
    await startCanopyEdit();
    setCanopyEditSubMode('brush');
    const ce = S.canopyEdit;
    // paint over an area we first cleared so avg height (15) is visible
    ce.workFlat.fill(0);
    ce.avgM = 15;
    const lat = 38.7;
    ce._onDown(fakeEv(lat, -120.9905));
    ce._onMove(fakeEv(lat, -120.9895));
    ce._onUp(fakeEv(lat, -120.9895));
    const { col, row } = latLngToCell(grid, lat, -120.99); // midpoint of the stroke
    expect(ce.workFlat[row * grid.cols + col]).toBe(15);
    expect(ce.sessionOps.length).toBe(1);
    expect(ce.sessionOps[0].t).toBe('paint');
    expect(ce.sessionOps[0].hM).toBe(15);
    expect(ce.undoStack.length).toBe(1);
  });

  it('ignores pointers outside the brush sub-mode', async () => {
    setupEditableState();
    await startCanopyEdit(); // pan
    const ce = S.canopyEdit;
    ce._onDown(fakeEv(38.7, -120.99));
    expect(ce._stroke).toBe(null);
    expect(ce.sessionOps.length).toBe(0);
  });
});

describe('polygon delete / cancel', () => {
  const ringLayer = (ring) => ({
    setStyle() {}, addTo() { return this; },
    editing: { enable() {}, disable() {} },
    getLatLngs: () => [ring.map(([lat, lng]) => ({ lat, lng }))],
  });

  it('DELETE zeroes trees inside the polygon and records an undoable op', async () => {
    const { grid } = setupEditableState();
    await startCanopyEdit();
    const d = 0.0005;
    const ring = [[38.7 + d, -120.99 - d], [38.7 + d, -120.99 + d], [38.7 - d, -120.99 + d], [38.7 - d, -120.99 - d]];
    onCanopyEditPolygon(ringLayer(ring));
    expect(S.canopyEdit.subMode).toBe('polygonEdit');
    canopyEditDelete();
    const ce = S.canopyEdit;
    const { col, row } = latLngToCell(grid, 38.7, -120.99);
    expect(ce.workFlat[row * grid.cols + col]).toBe(0);
    expect(ce.workFlat[0]).toBe(15); // far corner untouched
    expect(ce.sessionOps.length).toBe(1);
    expect(ce.sessionOps[0].t).toBe('del');
    expect(ce.subMode).toBe('pan');
    canopyEditUndo();
    expect(ce.workFlat[row * grid.cols + col]).toBe(15);
    expect(ce.sessionOps.length).toBe(0);
  });

  it('CANCEL discards the polygon without touching the raster', async () => {
    setupEditableState();
    await startCanopyEdit();
    const ring = [[38.71, -121.0], [38.71, -120.98], [38.69, -120.98]];
    onCanopyEditPolygon(ringLayer(ring));
    canopyEditCancelPoly();
    const ce = S.canopyEdit;
    expect(ce.polyLayer).toBe(null);
    expect(ce.subMode).toBe('pan');
    expect(ce.sessionOps.length).toBe(0);
    expect(ce.workFlat.every(v => v === 15)).toBe(true);
  });
});

describe('undo stack', () => {
  it('caps at 20 entries while keeping all session ops for save', async () => {
    setupEditableState();
    await startCanopyEdit();
    for (let i = 0; i < 25; i++) {
      _canopyEditPushOp({ t: 'paint', pts: [[38.7, -120.99]], rM: 5, hM: 10 },
        { indices: new Uint32Array([i]), oldValues: new Float32Array([0]) });
    }
    expect(S.canopyEdit.undoStack.length).toBe(20);
    expect(S.canopyEdit.sessionOps.length).toBe(25);
  });
});

describe('save', () => {
  it('appends session ops to the stored log and adopts the edited raster', async () => {
    setupEditableState();
    await startCanopyEdit();
    const priorOp = { t: 'del', poly: [[1, 1], [1, 2], [2, 2]] };
    let saved = null;
    globalThis.getCachedRaster = async () => ({ data: { ops: [priorOp] } });
    globalThis.cacheRaster = async (kind, key, payload) => { saved = { kind, key, payload }; };
    const beforeCanopy = S.canopy;
    const ce = S.canopyEdit;
    ce.workFlat[0] = 0;
    _canopyEditPushOp({ t: 'del', poly: [[38.71, -121.0], [38.71, -120.98], [38.69, -120.98]] },
      { indices: new Uint32Array([0]), oldValues: new Float32Array([15]) });
    await canopyEditSave();
    expect(saved.kind).toBe('canopyedit');
    expect(saved.key).toBe('global');
    expect(saved.payload.ops.length).toBe(2);
    expect(saved.payload.ops[0]).toBe(priorOp); // append, not replace
    expect(S.canopy).not.toBe(beforeCanopy);    // new identity → 3D cache invalidates
    expect(S.canopy.source).toContain('(edited)');
    expect(S.canopy.canopyFlat[0]).toBe(0);
    expect(ce.sessionOps.length).toBe(0);
    expect(ce.undoStack.length).toBe(0);
    expect(S._canopyEditing).toBe(true); // save stays in edit mode
  });

  it('unsaved edits prompt a confirm on exit; declining stays in edit mode', async () => {
    setupEditableState();
    await startCanopyEdit();
    _canopyEditPushOp({ t: 'paint', pts: [[38.7, -120.99]], rM: 5, hM: 10 },
      { indices: new Uint32Array([0]), oldValues: new Float32Array([15]) });
    let asked = 0;
    globalThis.confirm = () => { asked++; return false; };
    exitCanopyEdit();
    expect(asked).toBe(1);
    expect(S._canopyEditing).toBe(true);
    globalThis.confirm = () => true;
    exitCanopyEdit();
    expect(S._canopyEditing).toBe(false);
    delete globalThis.confirm;
  });
});
