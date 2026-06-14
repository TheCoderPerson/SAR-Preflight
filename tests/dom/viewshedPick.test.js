const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

const markerStub = () => ({ on() { return this; }, addTo() { return this; }, getLatLng() { return { lat: 0, lng: 0 }; } });
globalThis.L = {
  marker: () => markerStub(),
  layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }),
  DomEvent: { stopPropagation() {} },
};

const { S, _aggFeatureClick } = require('../../sar-preflight.js');

describe('viewshed observer placement over an interactive feature', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="viewshedStatus"></span><div id="vsResult"></div><div id="vsProgressBar"></div>
      <input id="vsAgl" value="200"><input id="vsVlos" value="2500"><div id="layerList"></div>`;
    S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, getContainer: () => ({ style: {} }), latLngToLayerPoint: () => ({ x: 0, y: 0 }) };
    S.mapLayers = {};
    S.viewshed = { marker: null, observer: null, grid: null, running: false };
    S._viewshedPicking = false;
    localStorage.removeItem('sar_canopy_proxy');
  });
  afterEach(() => { document.body.innerHTML = ''; S.viewshed = { marker: null, observer: null }; S._viewshedPicking = false; });

  it('places the observer when the click lands on a feature during pick mode', () => {
    S._viewshedPicking = true;
    _aggFeatureClick({ latlng: { lat: 39.30, lng: -120.10 }, originalEvent: {} });
    expect(S.viewshed.observer).toEqual({ lat: 39.30, lng: -120.10 });
    expect(S._viewshedPicking).toBe(false); // pick mode ends after placing
  });

  it('does not place an observer on a normal feature click (not picking)', () => {
    S._viewshedPicking = false;
    _aggFeatureClick({ latlng: { lat: 39.30, lng: -120.10 }, originalEvent: {} });
    expect(S.viewshed.observer).toBe(null);
  });
});
