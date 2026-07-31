// The Vegetation Height and Sun Shadow overlays are toggled from the Map Layers
// panel (their Terrain-tab checkboxes are gone). That means their rows must be
// listed even when the overlay is OFF — checking a row is what LOADS the raster,
// so a row gated on "already displayed" would be unreachable.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = {
  map: vi.fn(),
  tileLayer: vi.fn(),
  control: { zoom: vi.fn() },
  Draw: { Event: {} },
  FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({
    addTo: vi.fn(function () { return this; }),
    clearLayers: vi.fn(),
    addLayer: vi.fn(),
    getLayers: vi.fn(() => []),
  })),
};

const app = require('../../sar-preflight.js');
const { S, buildLayerControl, setLayerVisible } = app;

// hasLayer answers true only for the layers named in `on`.
function mapWith(on = []) {
  const set = new Set(on);
  return { hasLayer: layer => set.has(layer && layer.__id) };
}
const raster = id => ({ __id: id, options: { opacity: 0.6 }, setOpacity: vi.fn() });

function reset() {
  S.layerSections = new Set();
  S.plansMode = false;
  S._plansForced = null;
  S._overlayWanted = {};
  S._canopyEditing = false;
  S.is3D = false;
  S.mapLayers = {
    satellite: { __id: 'satellite', options: {} },
    topo: { __id: 'topo', options: {} },
    sectional: { __id: 'sectional', options: {} },
  };
  S.radarAnim = null;
  S.wireHazardCounts = {};
  S.utilityWireCounts = {};
  S.nwsAlerts = [];
  S.faaCharts = {};
  S.viewsheds = [];
  S.map = mapWith();
  document.body.innerHTML = '<div id="layerList"></div>';
}

const rowFor = id => document.querySelector(`#layerList [data-layer="${id}"]`);

describe('Analysis section rows', () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  it('lists Vegetation Height and Sun Shadow even with no overlay loaded at all', () => {
    buildLayerControl();
    expect(rowFor('canopy')).toBeTruthy();
    expect(rowFor('shadow')).toBeTruthy();
    expect(document.querySelector('#layerList [data-section="analysis"]')).toBeTruthy();
  });

  it('renders them UNCHECKED when the overlay is not on the map', () => {
    S.mapLayers.canopy = raster('canopy');
    S.mapLayers.shadow = raster('shadow');
    S.map = mapWith([]); // loaded but hidden
    buildLayerControl();
    expect(rowFor('canopy').classList.contains('active')).toBe(false);
    expect(rowFor('shadow').classList.contains('active')).toBe(false);
  });

  it('renders them checked once the overlay is draped', () => {
    S.mapLayers.canopy = raster('canopy');
    S.mapLayers.shadow = raster('shadow');
    S.map = mapWith(['canopy', 'shadow']);
    buildLayerControl();
    expect(rowFor('canopy').classList.contains('active')).toBe(true);
    expect(rowFor('shadow').classList.contains('active')).toBe(true);
  });

  it('shows the inline opacity slider only while the overlay is on', () => {
    S.mapLayers.canopy = raster('canopy');
    S.mapLayers.shadow = raster('shadow');
    S.map = mapWith(['canopy']);
    buildLayerControl();
    expect(document.getElementById('lcCanopyOpacity')).toBeTruthy();
    expect(document.getElementById('lcShadowOpacity')).toBeNull();
  });

  it('keeps the row after the overlay is switched off (the old gate deleted it)', () => {
    S.mapLayers.canopy = raster('canopy');
    S.map = mapWith(['canopy']);
    buildLayerControl();
    expect(rowFor('canopy').classList.contains('active')).toBe(true);
    S.map = mapWith([]); // user unchecked it
    buildLayerControl();
    expect(rowFor('canopy')).toBeTruthy();
    expect(rowFor('canopy').classList.contains('active')).toBe(false);
  });

  it('lists Viewshed only once a mask has been rendered', () => {
    buildLayerControl();
    expect(rowFor('viewshed')).toBeNull();
    S.mapLayers.viewshed = raster('viewshed');
    S.map = mapWith(['viewshed']);
    buildLayerControl();
    expect(rowFor('viewshed')).toBeTruthy();
  });

  it('lists Observers only once observers exist', () => {
    buildLayerControl();
    expect(rowFor('observers')).toBeNull();
    S.mapLayers.observers = { __id: 'observers', getLayers: () => [1] };
    S.viewsheds = [{ id: 'a' }, { id: 'b' }];
    S.map = mapWith(['observers']);
    buildLayerControl();
    expect(rowFor('observers').textContent).toContain('Observers (2)');
  });
});

describe('setLayerVisible routing for canopy / shadow', () => {
  // Fake map that records add/remove and reports a centre inside the cached grid.
  function trackingMap(on = []) {
    const set = new Set(on);
    return {
      hasLayer: l => set.has(l && l.__id),
      addLayer: vi.fn(l => set.add(l && l.__id)),
      removeLayer: vi.fn(l => set.delete(l && l.__id)),
      getCenter: () => ({ lat: 0, lng: 0 }),
    };
  }
  const coveringGrid = { bounds: { north: 1, south: -1, east: 1, west: -1 } };

  beforeEach(reset);

  it('checking the canopy row re-drapes the cached raster and marks it wanted', () => {
    S.mapLayers.canopy = raster('canopy');
    S.canopy = { grid: coveringGrid, canopyFlat: new Float32Array(1), source: 'cached' };
    S.map = trackingMap([]);
    setLayerVisible('canopy', true);
    expect(S.map.addLayer).toHaveBeenCalledWith(S.mapLayers.canopy);
    expect(S._overlayWanted.canopy).toBe(true);
  });

  it('unchecking the shadow row detaches it and clears the zoom-cap wanted flag', () => {
    S.mapLayers.shadow = raster('shadow');
    S._overlayWanted = { shadow: true };
    S.map = trackingMap(['shadow']);
    setLayerVisible('shadow', false);
    expect(S.map.removeLayer).toHaveBeenCalledWith(S.mapLayers.shadow);
    expect(S._overlayWanted.shadow).toBe(false);
  });

  it('unchecking canopy leaves the row present but unchecked', () => {
    S.mapLayers.canopy = raster('canopy');
    S._overlayWanted = { canopy: true };
    S.map = trackingMap(['canopy']);
    setLayerVisible('canopy', false);
    expect(rowFor('canopy')).toBeTruthy();
    expect(rowFor('canopy').classList.contains('active')).toBe(false);
  });
});

describe('opacity slider sync', () => {
  beforeEach(() => {
    reset();
    document.body.innerHTML += `
      <input type="range" id="canopyOpacity" min="0" max="1" step="0.05" value="0.6">
      <span id="canopyOpacityVal"></span>
      <input type="range" id="lcCanopyOpacity" min="0" max="1" step="0.05" value="0.6">
      <input type="range" id="shadowOpacity" min="0" max="1" step="0.05" value="0.45">
      <span id="shadowOpacityVal"></span>
      <input type="range" id="lcShadowOpacity" min="0" max="1" step="0.05" value="0.45">`;
  });

  it('moving the layer-panel slider moves the Terrain-tab one', () => {
    S.mapLayers.canopy = raster('canopy');
    app.setCanopyOpacity('0.25');
    expect(document.getElementById('canopyOpacity').value).toBe('0.25');
    expect(document.getElementById('canopyOpacityVal').textContent).toBe('25%');
  });

  it('and vice versa, for the shadow pair', () => {
    S.mapLayers.shadow = raster('shadow');
    app.setShadowOpacity('0.8');
    expect(document.getElementById('lcShadowOpacity').value).toBe('0.8');
    expect(document.getElementById('shadowOpacityVal').textContent).toBe('80%');
  });

  it('does not throw when only one of the pair is on screen', () => {
    document.getElementById('lcCanopyOpacity').remove();
    expect(() => app.setCanopyOpacity('0.5')).not.toThrow();
    expect(document.getElementById('canopyOpacity').value).toBe('0.5');
  });
});
