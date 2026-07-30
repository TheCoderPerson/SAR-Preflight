// Collapsible layer-control categories: every generated section is wrapped in a
// tappable <h4 data-section> + a body div, and the collapsed set lives on S so it
// survives the ~50 buildLayerControl() rebuilds a session performs.
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

const {
  S, buildLayerControl, toggleLayerSection, _sectionOpen, _sectionClose,
  restoreLayerUiState, _persistLayerUiState,
} = require('../../sar-preflight.js');

// A layer group holding `n` fake features.
const grp = (n = 1) => ({ getLayers: () => new Array(n).fill(0), options: {} });

function resetState({ onMap = true } = {}) {
  S.layerSections = new Set();
  S.plansMode = false;
  S._plansForced = null;
  S.map = { hasLayer: vi.fn(() => onMap) };
  S.mapLayers = {
    satellite: { options: {} }, topo: { options: {} }, sectional: { options: {} },
    airports: grp(3), cell_towers: grp(2), hms_smoke: grp(1), swap_radius: grp(1),
    adsb_aircraft: grp(4), adsb_trails: grp(4),
  };
  S.radarAnim = { layers: [{ options: { opacity: 0.5 } }], index: 0, frames: [] };
  S.wireHazardCounts = {};
  S.utilityWireCounts = {};
  S.nwsAlerts = [];
  S.faaCharts = {};
  S.viewsheds = [];
  document.body.innerHTML = '<div id="layerList"></div>';
  try { localStorage.removeItem('sar_layer_ui'); } catch (_) {}
}

describe('_sectionOpen / _sectionClose', () => {
  beforeEach(() => resetState());

  it('emits a tappable header plus an opening body div', () => {
    const html = _sectionOpen('facilities', 'Facilities');
    expect(html).toContain('data-section="facilities"');
    expect(html).toContain('onclick="toggleLayerSection(\'facilities\')"');
    expect(html).toContain('data-section-body="facilities"');
    expect(html).toContain('>Facilities</h4>');
    expect(html).not.toContain('collapsed');
  });

  it('marks BOTH the header and the body collapsed when the key is in S.layerSections', () => {
    S.layerSections.add('facilities');
    const html = _sectionOpen('facilities', 'Facilities');
    expect(html).toContain('class="layer-section collapsed"');
    expect(html).toContain('class="layer-section-body collapsed"');
  });

  it('_sectionClose closes the body div', () => {
    expect(_sectionClose()).toBe('</div>');
  });
});

describe('buildLayerControl section wrapping', () => {
  beforeEach(() => resetState());

  it('wraps every category it emits, with balanced open/close markers', () => {
    buildLayerControl();
    const html = document.getElementById('layerList').innerHTML;
    for (const key of ['radar', 'facilities', 'traffic', 'operations', 'smoke', 'analysis']) {
      expect(html).toContain(`data-section="${key}"`);
      expect(html).toContain(`data-section-body="${key}"`);
    }
    // The browser repairs unbalanced markup, so count against the parsed DOM.
    const list = document.getElementById('layerList');
    expect(list.querySelectorAll('h4[data-section]').length)
      .toBe(list.querySelectorAll('div[data-section-body]').length);
  });

  it('keeps the base-layer rows outside any collapsible section', () => {
    buildLayerControl();
    const row = document.querySelector('#layerList [data-layer="satellite"]');
    expect(row).toBeTruthy();
    expect(row.closest('[data-section-body]')).toBeNull();
  });

  it('a section collapsed before the rebuild comes back collapsed', () => {
    S.layerSections.add('facilities');
    buildLayerControl();
    const body = document.querySelector('#layerList [data-section-body="facilities"]');
    expect(body.classList.contains('collapsed')).toBe(true);
    // …and an unrelated one is untouched
    expect(document.querySelector('#layerList [data-section-body="traffic"]').classList.contains('collapsed')).toBe(false);
  });

  it('collapsing hides the rows but keeps them in the DOM (state, not data, changes)', () => {
    buildLayerControl();
    const before = document.querySelectorAll('#layerList [data-layer]').length;
    toggleLayerSection('facilities');
    expect(document.querySelectorAll('#layerList [data-layer]').length).toBe(before);
  });
});

describe('toggleLayerSection', () => {
  beforeEach(() => resetState());

  it('flips the classes in place — no rebuild, so no layer re-render', () => {
    buildLayerControl();
    const listBefore = document.getElementById('layerList');
    toggleLayerSection('traffic');
    expect(S.layerSections.has('traffic')).toBe(true);
    expect(document.querySelector('[data-section="traffic"]').classList.contains('collapsed')).toBe(true);
    expect(document.querySelector('[data-section-body="traffic"]').classList.contains('collapsed')).toBe(true);
    // Same node object — the panel was not re-emitted.
    expect(document.getElementById('layerList')).toBe(listBefore);
  });

  it('toggles back off', () => {
    buildLayerControl();
    toggleLayerSection('traffic');
    toggleLayerSection('traffic');
    expect(S.layerSections.has('traffic')).toBe(false);
    expect(document.querySelector('[data-section-body="traffic"]').classList.contains('collapsed')).toBe(false);
  });

  it('tolerates a key with no rendered section', () => {
    buildLayerControl();
    expect(() => toggleLayerSection('winter')).not.toThrow();
    expect(S.layerSections.has('winter')).toBe(true);
  });
});

describe('layer-control UI state persistence', () => {
  beforeEach(() => resetState());

  it('round-trips collapsed sections through localStorage', () => {
    S.layerSections = new Set(['facilities', 'smoke']);
    _persistLayerUiState();
    S.layerSections = new Set();
    restoreLayerUiState();
    expect([...S.layerSections].sort()).toEqual(['facilities', 'smoke']);
  });

  it('restores nothing when the key is absent', () => {
    restoreLayerUiState();
    expect(S.layerSections.size).toBe(0);
    expect(S.plansMode).toBe(false);
  });

  it('survives a corrupt entry rather than throwing at startup', () => {
    localStorage.setItem('sar_layer_ui', '{not json');
    expect(() => restoreLayerUiState()).not.toThrow();
    expect(S.layerSections.size).toBe(0);
  });
});
