// PLANS mode: a sticky pre-mission declutter. It turns off and collapses the
// live-operational categories, and keeps doing so as data ARRIVES (fetchRadar
// re-adds its newest frame on every auto-refresh) — but only once per layer, so
// a deliberate re-check by the user survives.
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
  S, buildLayerControl, togglePlansMode, _applyPlansMode, _plansLayerExists,
  setLayerVisible, toggleLayer, PLANS_OFF_SECTIONS, PLANS_OFF_LAYERS, restoreLayerUiState,
  _plansSuppressed,
} = require('../../sar-preflight.js');

// Clicking a row in the rendered panel — the only path that counts as user intent.
function clickRow(id) {
  const el = document.querySelector(`#layerList [data-layer="${id}"]`);
  if (!el) throw new Error(`no rendered row for ${id}`);
  toggleLayer(id, el);
}

// A layer group of n features that tracks its own on-map state through the map stub.
const grp = (id, n = 1) => ({ __id: id, getLayers: () => new Array(n).fill(0), options: {} });

// fetchRadar drapes the newest frame on the map at 0.5 opacity; hiding it means
// setOpacity(0), which the real code only does for a frame the map actually has.
const radarFrame = () => ({
  __id: 'radar_frame',
  options: { opacity: 0.5 },
  setOpacity(o) { this.options.opacity = o; },
});
const freshRadarAnim = () => ({ layers: [radarFrame()], index: 0, frames: [], playing: false, interval: null });

function trackingMap(on = []) {
  const set = new Set(on);
  return {
    _on: set,
    hasLayer: l => set.has(l && l.__id),
    addLayer: l => set.add(l && l.__id),
    removeLayer: l => set.delete(l && l.__id),
  };
}

function reset({ withRadar = true } = {}) {
  S.layerSections = new Set();
  S.plansMode = false;
  S._plansUserOverride = null;
  S.is3D = false;
  S.mapLayers = {
    satellite: { __id: 'satellite', options: {} },
    topo: { __id: 'topo', options: {} },
    sectional: { __id: 'sectional', options: {} },
    adsb_aircraft: grp('adsb_aircraft', 4),
    adsb_trails: grp('adsb_trails', 4),
    swap_radius: grp('swap_radius', 1),
    hms_smoke: grp('hms_smoke', 2),
    airports: grp('airports', 3), // a keeper — must be untouched
  };
  S.radarAnim = withRadar ? freshRadarAnim() : null;
  S.wireHazardCounts = {};
  S.utilityWireCounts = {};
  S.nwsAlerts = [];
  S.faaCharts = {};
  S.viewsheds = [];
  S.map = trackingMap(['adsb_aircraft', 'adsb_trails', 'swap_radius', 'hms_smoke', 'airports', 'radar_frame']);
  document.body.innerHTML = `
    <div id="layerList"></div>
    <div id="headerActions"></div>
    <div id="radarControls" style="display:flex"></div>
    <button id="btnPlans"></button>`;
  try { localStorage.removeItem('sar_layer_ui'); } catch (_) {}
}

const isOn = id => S.map._on.has(id);
const radarOn = () => S.radarAnim.layers.some(l => l.options.opacity > 0);
const rowFor = id => document.querySelector(`#layerList [data-layer="${id}"]`);

describe('the two PLANS registries stay in step', () => {
  beforeEach(() => reset());

  it('every PLANS_OFF_LAYERS id is rendered inside a PLANS_OFF_SECTIONS body', () => {
    buildLayerControl();
    for (const id of PLANS_OFF_LAYERS) {
      const row = rowFor(id);
      expect(row, `no row rendered for ${id}`).toBeTruthy();
      const section = row.closest('[data-section-body]');
      expect(section, `${id} is not inside any section`).toBeTruthy();
      expect(PLANS_OFF_SECTIONS).toContain(section.getAttribute('data-section-body'));
    }
  });

  it('_plansLayerExists reads radar off S.radarAnim, not S.mapLayers', () => {
    expect(_plansLayerExists('radar')).toBe(true);
    S.radarAnim = null;
    expect(_plansLayerExists('radar')).toBe(false);
    expect(_plansLayerExists('adsb_aircraft')).toBe(true);
    expect(_plansLayerExists('nope')).toBe(false);
  });
});

describe('entering PLANS mode', () => {
  beforeEach(() => reset());

  it('turns off every operational layer and lights the button', () => {
    togglePlansMode();
    expect(S.plansMode).toBe(true);
    expect(document.getElementById('btnPlans').classList.contains('active')).toBe(true);
    expect(isOn('adsb_aircraft')).toBe(false);
    expect(isOn('adsb_trails')).toBe(false);
    expect(isOn('swap_radius')).toBe(false);
    expect(isOn('hms_smoke')).toBe(false);
    expect(radarOn()).toBe(false);
  });

  it('inherits radar teardown — the playback panel is hidden too', () => {
    togglePlansMode();
    expect(document.getElementById('radarControls').style.display).toBe('none');
  });

  it('collapses exactly the four operational sections', () => {
    togglePlansMode();
    expect([...S.layerSections].sort()).toEqual([...PLANS_OFF_SECTIONS].sort());
    for (const key of PLANS_OFF_SECTIONS) {
      const body = document.querySelector(`#layerList [data-section-body="${key}"]`);
      if (body) expect(body.classList.contains('collapsed')).toBe(true);
    }
  });

  it('leaves unrelated layers alone', () => {
    togglePlansMode();
    expect(isOn('airports')).toBe(true);
    expect(S.layerSections.has('facilities')).toBe(false);
  });

  it('closes the mobile hamburger menu, like the other header buttons', () => {
    document.getElementById('headerActions').classList.add('open');
    togglePlansMode();
    expect(document.getElementById('headerActions').classList.contains('open')).toBe(false);
  });
});

describe('PLANS mode is sticky across refreshes', () => {
  beforeEach(() => reset({ withRadar: false }));

  it('suppresses radar that only arrives AFTER the mode was entered', () => {
    togglePlansMode();
    // fetchRadar builds fresh frames and drapes the newest at 0.5 opacity.
    S.radarAnim = freshRadarAnim();
    S.map._on.add('radar_frame');
    buildLayerControl();
    expect(radarOn()).toBe(false);
  });

  it('re-suppresses radar on EVERY refresh — each fetch installs a brand-new frame', () => {
    reset();
    togglePlansMode();
    expect(radarOn()).toBe(false);
    for (let i = 0; i < 3; i++) {
      S.radarAnim = freshRadarAnim(); // a fresh auto-refresh cycle
      S.map._on.add('radar_frame');
      buildLayerControl();
      expect(radarOn(), `radar came back on refresh ${i + 1}`).toBe(false);
      expect(document.getElementById('radarControls').style.display).toBe('none');
    }
  });

  it('re-suppresses the swap radius that computeOpsData keeps re-attaching', () => {
    reset();
    togglePlansMode();
    expect(isOn('swap_radius')).toBe(false);
    S.map._on.add('swap_radius'); // computeOpsData re-adds it on the next recompute
    buildLayerControl();
    expect(isOn('swap_radius')).toBe(false);
  });

  it('_plansSuppressed lets computeOpsData skip the re-attach on a time-bar scrub', () => {
    reset();
    expect(_plansSuppressed('swap_radius')).toBe(false); // mode off
    togglePlansMode();
    expect(_plansSuppressed('swap_radius')).toBe(true);
    expect(_plansSuppressed('airports')).toBe(false);    // never in scope
    clickRow('swap_radius');
    expect(_plansSuppressed('swap_radius')).toBe(false); // user owns it now
  });

  it('does NOT fight the user: a re-check by CLICK survives later rebuilds', () => {
    reset();
    togglePlansMode();
    expect(isOn('hms_smoke')).toBe(false);
    clickRow('hms_smoke'); // the user expands SMOKE and ticks it
    expect(isOn('hms_smoke')).toBe(true);
    buildLayerControl();
    buildLayerControl();
    expect(isOn('hms_smoke')).toBe(true);
  });

  it('re-checking Aircraft covers its trails too (they are one toggle)', () => {
    reset();
    togglePlansMode();
    clickRow('adsb_aircraft');
    buildLayerControl();
    expect(isOn('adsb_aircraft')).toBe(true);
    expect(isOn('adsb_trails')).toBe(true);
  });

  it('un-checking a re-checked layer hands it back to the suppressor', () => {
    reset();
    togglePlansMode();
    clickRow('hms_smoke');
    buildLayerControl();
    clickRow('hms_smoke'); // user changes their mind
    expect(S._plansUserOverride.has('hms_smoke')).toBe(false);
    S.map._on.add('hms_smoke'); // something re-adds it
    buildLayerControl();
    expect(isOn('hms_smoke')).toBe(false);
  });

  it('is a no-op while the mode is off', () => {
    reset();
    _applyPlansMode();
    expect(isOn('adsb_aircraft')).toBe(true);
    expect(radarOn()).toBe(true);
  });

  it('never suppresses anything outside the four categories', () => {
    reset();
    togglePlansMode();
    for (let i = 0; i < 3; i++) buildLayerControl();
    expect(isOn('airports')).toBe(true);
  });
});

describe('exiting PLANS mode', () => {
  beforeEach(() => reset());

  it('unlights the button, re-expands the sections, and stops suppressing', () => {
    togglePlansMode();
    togglePlansMode();
    expect(S.plansMode).toBe(false);
    expect(document.getElementById('btnPlans').classList.contains('active')).toBe(false);
    for (const key of PLANS_OFF_SECTIONS) expect(S.layerSections.has(key)).toBe(false);
    // A layer switched back on now stays on, with no override bookkeeping needed.
    setLayerVisible('hms_smoke', true);
    buildLayerControl();
    buildLayerControl();
    expect(isOn('hms_smoke')).toBe(true);
    // …and radar arriving from a refresh is left alone too.
    S.radarAnim = freshRadarAnim();
    S.map._on.add('radar_frame');
    buildLayerControl();
    expect(radarOn()).toBe(true);
  });

  it('leaves the layers off — exiting is not an undo', () => {
    togglePlansMode();
    togglePlansMode();
    expect(isOn('adsb_aircraft')).toBe(false);
  });
});

describe('PLANS mode persistence', () => {
  beforeEach(() => reset());

  it('a reloaded PLANS session still suppresses newly-arriving layers', () => {
    togglePlansMode();
    // Simulate a reload: fresh state, same localStorage (reset() clears it).
    const saved = localStorage.getItem('sar_layer_ui');
    reset();
    localStorage.setItem('sar_layer_ui', saved);
    restoreLayerUiState();
    expect(S.plansMode).toBe(true);
    expect(document.getElementById('btnPlans').classList.contains('active')).toBe(true);
    buildLayerControl();
    expect(isOn('adsb_aircraft')).toBe(false);
    expect(radarOn()).toBe(false);
  });

  it('does not restore the mode once it has been switched off', () => {
    togglePlansMode();
    togglePlansMode();
    const saved = localStorage.getItem('sar_layer_ui');
    reset();
    localStorage.setItem('sar_layer_ui', saved);
    restoreLayerUiState();
    expect(S.plansMode).toBe(false);
  });
});
