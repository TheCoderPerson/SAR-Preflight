// A failed data source must not leave a reassuring value on screen. The cells
// it owns read "UNKNOWN: NEEDS UPDATE" in red — never "None", "--" or the
// previous area's numbers — unless this area already has that source's data
// (then the freshness line says "Update failed — showing HH:MM data").
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = {
  map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() },
  Draw: { Event: {} }, FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }), clearLayers: vi.fn(), addLayer: vi.fn(), getLayers: () => [] })),
  geoJSON: () => ({ bindPopup() { return this; } }),
};

const { S, markSection, computeAirspace, fetchFireDanger, renderFireDangerUnknown,
        SECTION_CELLS, sectionCellsFor, UNKNOWN_CELL_TEXT } = require('../../sar-preflight.js');

const ALL_IDS = Object.keys(SECTION_CELLS).reduce((a, k) => a.concat(sectionCellsFor(k)), []);
const cells = () => ALL_IDS.map(id => `<div class="data-value" id="${id}">--</div>`).join('');
const metas = () => ['meta_wx', 'meta_vis', 'meta_precip', 'meta_forecast', 'meta_wind', 'meta_aqi', 'meta_airspace', 'meta_sua', 'meta_fire', 'meta_elev']
  .map(id => `<div class="section-meta" id="${id}"></div>`).join('');
const text = id => document.getElementById(id).textContent;
const isRed = id => document.getElementById(id).classList.contains('red');

describe('SECTION_CELLS', () => {
  it('names only ids that exist in the app HTML (typo guard)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8');
    const missing = ALL_IDS.filter(id => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });
});

describe('markSection error → owned cells read UNKNOWN', () => {
  beforeEach(() => {
    document.body.innerHTML = cells() + metas() + '<div id="fireDangerCards"></div>';
    S.sectionMeta = {};
    S.areaCenter = { lat: 38.7, lng: -121 };
    S.map = {};
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('a data-less failure blanks every cell the section owns, red, and nothing else', () => {
    document.getElementById('wxTemp').textContent = '72°F';
    document.getElementById('wxAQI').textContent = '41';
    markSection('weather', { status: 'error', error: 'HTTP 503' });
    expect(text('wxTemp')).toBe(UNKNOWN_CELL_TEXT);
    expect(isRed('wxTemp')).toBe(true);
    expect(text('windMax')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('wxAQI')).toBe('41');                 // airQuality is its own section
  });

  it('keeps the values when this area already has that section\'s data (freshness line says so)', () => {
    document.getElementById('wxTemp').textContent = '72°F';
    markSection('weather', { status: 'live', updatedAt: Date.now() - 60000, error: null });
    markSection('weather', { status: 'error', error: 'HTTP 503' });
    expect(text('wxTemp')).toBe('72°F');
    expect(document.getElementById('meta_wx').textContent).toContain('showing');
  });

  it('a rollup section blanks only the failed sub-source\'s cells', () => {
    document.getElementById('airNearAirport').textContent = 'KPVF — Placerville';
    document.getElementById('airMOA').textContent = 'None';
    markSection('airspace', { source: 'faa', status: 'error', error: 'HTTP 502' });
    expect(text('airMOA')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airClass')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airNearAirport')).toBe('KPVF — Placerville');
  });

  it('partial errors leave the cells to the fetcher', () => {
    document.getElementById('airMOA').textContent = 'None';
    markSection('airspace', { source: 'faa', status: 'error', error: '1 of 6 failed', partial: true });
    expect(text('airMOA')).toBe('None');
  });

  it('a later cached/live mark does not itself blank anything', () => {
    markSection('weather', { status: 'error', error: 'x' });
    document.getElementById('wxTemp').textContent = '70°F';   // fetcher re-rendered from cache
    markSection('weather', { status: 'cached', cachedAt: Date.now() - 3600000, error: 'x' });
    expect(text('wxTemp')).toBe('70°F');
  });
});

describe('computeAirspace — per-layer FAA state', () => {
  const fc = (features) => ({ type: 'FeatureCollection', features: features || [] });
  const moa = { type: 'Feature', properties: { NAME: 'Hunter MOA', TYPE_CODE: 'MOA' }, geometry: null };
  beforeEach(() => {
    document.body.innerHTML = cells() + metas();
    S.sectionMeta = {};
    S.nearbyAirports = [];
    S.faaAirspace = null;
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('a failed Special Use Airspace layer shows UNKNOWN, not a green "None"', () => {
    S.faaAirspace = { classAirspace: fc(), sua: { type: 'FeatureCollection', features: [], _unavailable: true }, tfrs: fc(), laanc: fc(), nsRestrictions: fc(), prohibited: fc() };
    computeAirspace(38.7, -121);
    for (const id of ['airMOA', 'airRestricted', 'airProhibited']) {
      expect(text(id)).toBe(UNKNOWN_CELL_TEXT);
      expect(isRed(id)).toBe(true);
    }
    expect(text('airTFR')).toBe('None');
    expect(document.getElementById('airTFR').classList.contains('green')).toBe(true);
    expect(text('airNSRestrict')).toBe('None');
  });

  it('failed TFR-area and NS-restriction layers show UNKNOWN too', () => {
    S.faaAirspace = { classAirspace: fc(), sua: fc(), tfrs: { features: [], _unavailable: true }, laanc: fc(), nsRestrictions: { features: [], _unavailable: true }, prohibited: fc() };
    computeAirspace(38.7, -121);
    expect(text('airTFR')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airNSRestrict')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airMOA')).toBe('None');
  });

  it('a layer filled from the cached copy is labeled "(cached)" in amber', () => {
    S.faaAirspace = { classAirspace: fc(), sua: { features: [moa], _cachedAt: Date.now() - 600000 }, tfrs: { features: [], _cachedAt: Date.now() - 600000 }, laanc: fc(), nsRestrictions: fc(), prohibited: fc() };
    computeAirspace(38.7, -121);
    expect(text('airMOA')).toBe('Hunter MOA (cached)');
    expect(document.getElementById('airMOA').classList.contains('amber')).toBe(true);
    expect(text('airTFR')).toBe('None (cached)');
    expect(document.getElementById('airTFR').classList.contains('amber')).toBe(true);
  });

  it('live layers render exactly as before', () => {
    S.faaAirspace = { classAirspace: fc(), sua: fc([moa]), tfrs: fc(), laanc: fc(), nsRestrictions: fc(), prohibited: fc() };
    computeAirspace(38.7, -121);
    expect(text('airMOA')).toBe('Hunter MOA');
    expect(document.getElementById('airMOA').classList.contains('amber')).toBe(true);
    expect(text('airRestricted')).toBe('None');
    expect(document.getElementById('airRestricted').classList.contains('green')).toBe(true);
  });

  it('with the whole FAA fetch failed, class airspace is UNKNOWN rather than a guess from the airport table', () => {
    S.sectionMeta = { airspace: { sources: { faa: { status: 'error', error: 'all failed' } } } };
    computeAirspace(38.7, -121);
    expect(text('airClass')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airLAANC')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airMOA')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airTFR')).toBe(UNKNOWN_CELL_TEXT);
  });

  it('with no FAA data and no failure recorded (not fetched yet), the built-in fallback still classifies', () => {
    computeAirspace(38.7, -121);
    expect(text('airClass')).toContain('Class G');
  });
});

describe('fire danger failure', () => {
  const bounds = { getSouthWest: () => ({ lat: 38.6, lng: -121.1 }), getNorthEast: () => ({ lat: 38.8, lng: -120.9 }) };
  beforeEach(() => {
    document.body.innerHTML = cells() + metas() + '<div id="notamList"></div><div id="fireDangerCards"><div>No wildland fire perimeters detected</div></div><div id="layerList"></div>';
    S.sectionMeta = {};
    S.dataSourceErrors = {};
    S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
  });
  afterEach(() => { document.body.innerHTML = ''; delete globalThis.fetch; });

  it('renderFireDangerUnknown replaces the card with an UNKNOWN notice', () => {
    renderFireDangerUnknown(new Error('HTTP 503'));
    const card = document.getElementById('fireDangerCards').textContent;
    expect(card).toContain(UNKNOWN_CELL_TEXT);
    expect(card).toContain('HTTP 503');
    expect(card).not.toContain('No wildland fire perimeters detected');
  });

  it('a failed perimeter fetch with no prior data shows the UNKNOWN card and blanks wxFire', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
    await fetchFireDanger(38.68, -120.99, bounds);
    expect(document.getElementById('fireDangerCards').textContent).toContain(UNKNOWN_CELL_TEXT);
    expect(text('wxFire')).toBe(UNKNOWN_CELL_TEXT);
  });

  it('a failed refresh keeps this area\'s earlier card when one exists', async () => {
    markSection('fireDanger', { status: 'live', updatedAt: Date.now() - 60000, error: null });
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
    await fetchFireDanger(38.68, -120.99, bounds);
    expect(document.getElementById('fireDangerCards').textContent).toContain('No wildland fire perimeters detected');
  });
});
