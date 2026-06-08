const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Minimal Leaflet mock — circleMarker/layerGroup are what the obstacle layer uses
function mockLayerGroup() {
  const layers = [];
  return {
    _layers: layers,
    addTo() { return this; },
    clearLayers() { layers.length = 0; },
    addLayer(l) { layers.push(l); },
    getLayers() { return layers; },
  };
}
globalThis.L = {
  map: vi.fn(),
  tileLayer: vi.fn(),
  control: { zoom: vi.fn() },
  Draw: { Event: {} },
  FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => mockLayerGroup()),
  circleMarker: vi.fn(() => ({ bindPopup() { return this; } })),
};

const { S, updateObstacleDisplay, renderObstacleLayer, buildLayerControl } = require('../../sar-preflight.js');

const feat = (props, lng = -120.9, lat = 38.7) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props,
});

describe('updateObstacleDisplay', () => {
  beforeEach(() => {
    const el = document.createElement('div');
    el.id = 'terrObstacles';
    el.classList.add('data-value');
    document.body.appendChild(el);
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('shows the not-a-complete-inventory message and green when none found', () => {
    updateObstacleDisplay(summarizeObstacles([], 400));
    const el = document.getElementById('terrObstacles');
    expect(el.textContent).toMatch(/None in DOF/i);
    expect(el.textContent).toMatch(/not a complete/i);
    expect(el.classList.contains('green')).toBe(true);
  });

  it('reports count + tallest AGL and goes red for a tall obstacle', () => {
    const s = summarizeObstacles([feat({ AGL: 80 }), feat({ AGL: 260 })], 400);
    updateObstacleDisplay(s);
    const el = document.getElementById('terrObstacles');
    expect(el.textContent).toContain('2 obstacles');
    expect(el.textContent).toContain('tallest 260 ft AGL');
    expect(el.classList.contains('red')).toBe(true);
  });

  it('is amber for short-only obstacles and notes unverified count', () => {
    const s = summarizeObstacles([feat({ AGL: 90, Verified: 'U' }), feat({ AGL: 120 })], 400);
    updateObstacleDisplay(s);
    const el = document.getElementById('terrObstacles');
    expect(el.textContent).toContain('1 unverified');
    expect(el.classList.contains('amber')).toBe(true);
  });

  it('uses singular wording for a single obstacle', () => {
    updateObstacleDisplay(summarizeObstacles([feat({ AGL: 110 })], 400));
    expect(document.getElementById('terrObstacles').textContent).toContain('1 obstacle,');
  });
});

describe('renderObstacleLayer', () => {
  afterEach(() => { S.mapLayers = {}; S.faaObstacles = null; vi.clearAllMocks(); });

  it('creates a circleMarker per obstacle feature', () => {
    S.mapLayers = {};
    S.faaObstacles = { type: 'FeatureCollection', features: [
      feat({ Type_Code: 'TOWER', AGL: 230, AMSL: 700, Lighting: 'R', Verified: 'O', OAS_Number: '06-1' }),
      feat({ Type_Code: 'POLE', AGL: 40, Verified: 'U', OAS_Number: '06-2' }),
    ] };
    renderObstacleLayer();
    expect(L.circleMarker).toHaveBeenCalledTimes(2);
    expect(S.mapLayers.faa_obstacles.getLayers().length).toBe(2);
  });

  it('skips features without geometry coordinates', () => {
    S.mapLayers = {};
    S.faaObstacles = { features: [
      { type: 'Feature', geometry: null, properties: { AGL: 100 } },
      feat({ AGL: 120 }),
    ] };
    renderObstacleLayer();
    expect(S.mapLayers.faa_obstacles.getLayers().length).toBe(1);
  });

  it('clears prior markers on re-render', () => {
    S.mapLayers = {};
    S.faaObstacles = { features: [feat({ AGL: 100 })] };
    renderObstacleLayer();
    renderObstacleLayer();
    expect(S.mapLayers.faa_obstacles.getLayers().length).toBe(1);
  });
});

describe('buildLayerControl includes the FAA Obstacles section', () => {
  beforeEach(() => {
    const el = document.createElement('div');
    el.id = 'layerList';
    document.body.appendChild(el);
    S.map = { hasLayer: vi.fn(() => true) };
    S.mapLayers = { satellite: { options: { opacity: 0 } }, topo: { options: { opacity: 0 } } };
    S.wireHazardCounts = {};
    S.nwsAlerts = [];
    S.radarAnim = null;
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('renders the obstacle layer toggle with a count when obstacles exist', () => {
    S.mapLayers.faa_obstacles = { getLayers: vi.fn(() => [1, 2, 3]) };
    buildLayerControl();
    const html = document.getElementById('layerList').innerHTML;
    expect(html).toContain('FAA Obstacles (DOF)');
    expect(html).toContain('faa_obstacles');
    expect(html).toContain('Obstacles (3)');
  });

  it('omits the obstacle section when there are no obstacles', () => {
    S.mapLayers.faa_obstacles = { getLayers: vi.fn(() => []) };
    buildLayerControl();
    const html = document.getElementById('layerList').innerHTML;
    expect(html).not.toContain('FAA Obstacles (DOF)');
  });
});
