const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

const markerStub = () => ({ on() { return this; }, addTo() { return this; }, bindPopup() { return this; }, getLatLng() { return { lat: 0, lng: 0 }; } });
globalThis.L = {
  marker: () => markerStub(),
  layerGroup: () => ({ _l: [], addLayer(x) { this._l.push(x); }, removeLayer() {}, clearLayers() { this._l = []; }, getLayers() { return this._l; }, addTo() { return this; } }),
  DomEvent: { stopPropagation() {} },
};

const { S, _aggFeatureClick } = require('../../sar-preflight.js');

describe('viewshed observer placement (multi-observer)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="viewshedStatus"></span><div id="vsResult"></div><div id="vsProgressBar"></div>
      <input id="vsAgl" value="200"><input id="vsVlos" value="2500"><div id="layerList"></div><div id="vsObserverList"></div>`;
    S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, getContainer: () => ({ style: {} }), latLngToLayerPoint: () => ({ x: 0, y: 0 }) };
    S.mapLayers = {};
    S.viewsheds = [];
    S.activeViewshedId = null;
    S._viewshedRunningId = null;
    S._viewshedPicking = false;
    localStorage.removeItem('sar_canopy_proxy');
  });
  afterEach(() => { document.body.innerHTML = ''; S.viewsheds = []; S.activeViewshedId = null; S._viewshedPicking = false; });

  it('adds an observer record and makes it active when picking', () => {
    S._viewshedPicking = true;
    _aggFeatureClick({ latlng: { lat: 39.30, lng: -120.10 }, originalEvent: {} });
    expect(S.viewsheds.length).toBe(1);
    expect(S.viewsheds[0].observer).toEqual({ lat: 39.30, lng: -120.10 });
    expect(S.activeViewshedId).toBe(S.viewsheds[0].id);
    expect(S._viewshedPicking).toBe(false); // pick mode ends after placing
  });

  it('a second pick adds a second record and switches the active one', () => {
    S._viewshedPicking = true;
    _aggFeatureClick({ latlng: { lat: 39.30, lng: -120.10 }, originalEvent: {} });
    const first = S.viewsheds[0].id;
    S._viewshedPicking = true;
    _aggFeatureClick({ latlng: { lat: 39.31, lng: -120.11 }, originalEvent: {} });
    expect(S.viewsheds.length).toBe(2);
    expect(S.activeViewshedId).toBe(S.viewsheds[1].id);
    expect(S.activeViewshedId).not.toBe(first);
  });

  it('does not add an observer on a normal feature click (not picking)', () => {
    S._viewshedPicking = false;
    _aggFeatureClick({ latlng: { lat: 39.30, lng: -120.10 }, originalEvent: {} });
    expect(S.viewsheds.length).toBe(0);
  });
});
