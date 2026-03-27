const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Minimal Leaflet mock
globalThis.L = {
  map: vi.fn(),
  tileLayer: vi.fn(),
  control: { zoom: vi.fn() },
  Draw: { Event: {} },
  FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({
    addTo: vi.fn(function() { return this; }),
    clearLayers: vi.fn(),
    addLayer: vi.fn(),
    getLayers: vi.fn(() => []),
  })),
};

const { updateWireDisplay, S, clearArea, buildLayerControl } = require('../../sar-preflight.js');

describe('updateWireDisplay with tower count', () => {
  beforeEach(() => {
    // Create DOM elements
    ['terrPower', 'terrTowers'].forEach(id => {
      const el = document.createElement('div');
      el.id = id;
      el.classList.add('data-value');
      document.body.appendChild(el);
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('displays tower count in terrTowers', () => {
    const counts = { power_line: 5, telecom_line: 2, aerialway: 1 };
    updateWireDisplay(counts, 8);
    const el = document.getElementById('terrTowers');
    expect(el.textContent).toContain('8 towers');
    expect(el.textContent).toContain('2 telecom');
    expect(el.textContent).toContain('1 aerialway');
  });

  it('displays 0 towers when none found', () => {
    const counts = { power_line: 3 };
    updateWireDisplay(counts, 0);
    const el = document.getElementById('terrTowers');
    expect(el.textContent).toContain('0 towers');
  });

  it('shows towers even when wire counts are 0', () => {
    const counts = {};
    updateWireDisplay(counts, 5);
    const el = document.getElementById('terrTowers');
    expect(el.textContent).toContain('5 towers');
  });

  it('shows "None mapped" when both wires and towers are 0', () => {
    updateWireDisplay({}, 0);
    const el = document.getElementById('terrTowers');
    expect(el.textContent).toBe('None mapped');
  });

  it('defaults towerCount to 0 when not provided', () => {
    updateWireDisplay({ power_line: 2 });
    const el = document.getElementById('terrTowers');
    expect(el.textContent).toContain('0 towers');
  });

  it('sets amber color when towers present', () => {
    updateWireDisplay({}, 3);
    const el = document.getElementById('terrTowers');
    expect(el.classList.contains('amber')).toBe(true);
  });

  it('sets green color when no towers or telecom/aerialway', () => {
    updateWireDisplay({ power_line: 1 }, 0);
    const el = document.getElementById('terrTowers');
    expect(el.classList.contains('green')).toBe(true);
  });
});

describe('clearArea cleans up Phase 2 layers', () => {
  let mockMap;

  beforeEach(() => {
    // Create all DOM elements needed by clearArea
    ['noAreaOverlay', 'layerControl', 'assessmentBanner', 'areaInfoBar', 'noAreaState',
     'alertSection', 'forecastSection', 'radarControls'].forEach(id => {
      const el = document.createElement('div');
      el.id = id;
      el.style.display = 'none';
      document.body.appendChild(el);
    });

    // Create mock tab panels
    const panel = document.createElement('div');
    panel.classList.add('tab-panel');
    document.body.appendChild(panel);

    mockMap = {
      hasLayer: vi.fn(() => true),
      removeLayer: vi.fn(),
      addLayer: vi.fn(),
    };

    S.map = mockMap;
    S.drawnItems = { clearLayers: vi.fn() };
    S.currentArea = {};
    S.areaCenter = {};
    S.wireHazardCounts = { power_line: 3 };
    S.towerCount = 5;

    // Set up mock layer groups
    const mockLayerGroup = { clearLayers: vi.fn() };
    S.mapLayers = {
      airports: { clearLayers: vi.fn() },
      nws_alerts: { clearLayers: vi.fn() },
      cell_towers: { clearLayers: vi.fn() },
      hifld_power: { clearLayers: vi.fn() },
    };

    S.nwsAlerts = [{ id: 'test' }];
  });

  afterEach(() => {
    document.body.innerHTML = '';
    S.radarAnim = null;
  });

  it('clears cell_towers layer', () => {
    clearArea();
    expect(S.mapLayers.cell_towers.clearLayers).toHaveBeenCalled();
  });

  it('stops radar animation and clears layers', () => {
    const mockLayer = {
      options: { opacity: 0.5 },
      setOpacity: vi.fn(),
    };
    S.radarAnim = {
      playing: true,
      interval: setInterval(() => {}, 1000),
      layers: [mockLayer],
      frames: [],
    };

    clearArea();
    expect(S.radarAnim).toBeNull();
  });

  it('hides radar controls', () => {
    const controls = document.getElementById('radarControls');
    controls.style.display = 'flex';
    clearArea();
    expect(controls.style.display).toBe('none');
  });

  it('hides forecast section', () => {
    const section = document.getElementById('forecastSection');
    section.style.display = '';
    clearArea();
    expect(section.style.display).toBe('none');
  });

  it('resets towerCount to 0', () => {
    clearArea();
    expect(S.towerCount).toBe(0);
  });

  it('resets wireHazardCounts', () => {
    clearArea();
    expect(S.wireHazardCounts).toEqual({});
  });
});

describe('buildLayerControl includes Phase 2 layers', () => {
  beforeEach(() => {
    const el = document.createElement('div');
    el.id = 'layerList';
    document.body.appendChild(el);

    S.map = {
      hasLayer: vi.fn(() => true),
    };
    S.mapLayers = {
      satellite: { options: { opacity: 0 } },
      topo: { options: { opacity: 0 } },
    };
    S.wireHazardCounts = {};
    S.nwsAlerts = [];
  });

  afterEach(() => {
    document.body.innerHTML = '';
    S.radarAnim = null;
  });

  it('renders cell towers in facilities section', () => {
    S.mapLayers.cell_towers = {
      getLayers: vi.fn(() => [1, 2, 3]),
    };
    buildLayerControl();
    const html = document.getElementById('layerList').innerHTML;
    expect(html).toContain('Towers');
    expect(html).toContain('Facilities');
    expect(html).toContain('cell_towers');
  });

  it('renders radar entry when radar frames exist', () => {
    S.radarAnim = {
      layers: [{ options: { opacity: 0.5 } }],
    };
    S.map.hasLayer = vi.fn(() => true);
    buildLayerControl();
    const html = document.getElementById('layerList').innerHTML;
    expect(html).toContain('Weather Radar');
    expect(html).toContain('radar');
  });

  it('does not render radar entry when no radar data', () => {
    S.radarAnim = null;
    buildLayerControl();
    const html = document.getElementById('layerList').innerHTML;
    expect(html).not.toContain('Weather Radar');
  });
});
