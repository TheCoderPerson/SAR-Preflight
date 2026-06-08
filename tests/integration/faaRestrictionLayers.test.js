const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Leaflet mock with a layerGroup + geoJSON sufficient for renderFAAairspaceLayers.
const layerGroupMock = () => ({
  _layers: [],
  addLayer(x) { this._layers.push(x); },
  clearLayers() { this._layers = []; },
  getLayers() { return this._layers; },
  addTo() { return this; },
});
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  geoJSON: () => ({ bindPopup() { return this; } }),
};

const { S, renderFAAairspaceLayers } = require('../../sar-preflight.js');

function polyFeature(props) {
  return {
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [[[-121, 38.6], [-120.9, 38.6], [-120.9, 38.7], [-121, 38.6]]] },
  };
}

describe('renderFAAairspaceLayers — National Security + Prohibited', () => {
  beforeEach(() => {
    // Start each test with the relevant layer groups absent so they are created.
    delete S.mapLayers.faa_ns_restrictions;
    delete S.mapLayers.faa_prohibited;
  });

  it('renders National Security restrictions into faa_ns_restrictions', () => {
    S.faaAirspace = {
      nsRestrictions: {
        type: 'FeatureCollection',
        features: [
          polyFeature({ Facility: 'Folsom Dam', Reason: 'National Defense Airspace', POC: 'Tim Lawson', Floor: 'SFC', Ceiling: '400 AGL' }),
        ],
      },
    };
    renderFAAairspaceLayers();
    expect(S.mapLayers.faa_ns_restrictions).toBeTruthy();
    expect(S.mapLayers.faa_ns_restrictions.getLayers().length).toBe(1);
  });

  it('renders Prohibited Areas into faa_prohibited', () => {
    S.faaAirspace = {
      prohibited: {
        type: 'FeatureCollection',
        features: [polyFeature({ NAME: 'P-56A' }), polyFeature({ NAME: 'P-56B' })],
      },
    };
    renderFAAairspaceLayers();
    expect(S.mapLayers.faa_prohibited).toBeTruthy();
    expect(S.mapLayers.faa_prohibited.getLayers().length).toBe(2);
  });

  it('creates empty layer groups when no restriction features are present', () => {
    S.faaAirspace = { classAirspace: { features: [] } };
    renderFAAairspaceLayers();
    expect(S.mapLayers.faa_ns_restrictions.getLayers().length).toBe(0);
    expect(S.mapLayers.faa_prohibited.getLayers().length).toBe(0);
  });
});
