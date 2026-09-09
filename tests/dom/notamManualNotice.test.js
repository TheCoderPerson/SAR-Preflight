// When the live NOTAM leg fails, the operator must be told to update NOTAMs
// manually — in the assessment banner AND in the NOTAMs tab.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = {
  map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() },
  Draw: { Event: {} }, FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }), clearLayers: vi.fn(), addLayer: vi.fn(), getLayers: () => [] })),
};

const { S, computeAssessment, renderAutoCheckStatus, renderNotamManualNotice, NOTAM_MANUAL_UPDATE_CAUTION } = require('../../sar-preflight.js');

function setBody() {
  document.body.innerHTML = `
    <input id="cfgMaxWind" type="number" value="27" />
    <span id="assessBadge" class="assessment-badge">--</span><span id="assessText">--</span>
    <div id="autoCheckStatusSection"><div id="autoCheckIndicator"></div><span id="autoCheckStatus"></span><div id="autoCheckDetail"></div><button id="autoCheckReBtn"></button></div>
    <div id="notamManualNotice" style="display:none;"></div>
  `;
}

describe('NOTAMs need manual update', () => {
  beforeEach(() => {
    setBody();
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = { id: 1 };
    S.areaCenter = { lat: 38.7, lng: -121 };
    S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
    S.wind = { maxWind: 5, maxGust: 8 };
    S.elev = { center: 2000 };
    S.faaAirspace = null;
    S.sectionMeta = {};
    S.tfrs = []; S.importedNotams = [];
  });
  afterEach(() => { document.body.innerHTML = ''; localStorage.removeItem('sar_canopy_proxy'); S.autoCheck = null; S.currentArea = null; });

  it('assessment lists the NOTAM manual-update line when only the NOTAM leg failed', () => {
    S.autoCheck = { state: 'error', tfrOk: true, notamOk: false };
    computeAssessment();
    const text = document.getElementById('assessText').textContent;
    expect(text).toContain('NOTAMs NEED MANUAL UPDATE');
    expect(text).not.toContain('TFR check FAILED');
    expect(document.getElementById('assessBadge').textContent).toMatch(/ADVISOR/);
  });

  it('assessment lists both lines when both legs failed, and only the TFR line when only TFRs failed', () => {
    S.autoCheck = { state: 'error', tfrOk: false, notamOk: false };
    computeAssessment();
    let text = document.getElementById('assessText').textContent;
    expect(text).toContain(NOTAM_MANUAL_UPDATE_CAUTION);
    expect(text).toContain('TFR check FAILED');

    S.autoCheck = { state: 'error', tfrOk: false, notamOk: true };
    computeAssessment();
    text = document.getElementById('assessText').textContent;
    expect(text).toContain('TFR check FAILED');
    expect(text).not.toContain('NOTAMs NEED MANUAL UPDATE');
  });

  it('NOTAMs tab shows the red notice with the steps when the NOTAM leg failed, and hides it when live', () => {
    S.sectionMeta = { notam: { status: 'error', error: 'NOTAM HTTP 502: FAA NOTAM Search HTTP 403' } };
    renderNotamManualNotice();
    const el = document.getElementById('notamManualNotice');
    expect(el.style.display).not.toBe('none');
    expect(el.textContent).toContain('NOTAMs NEED MANUAL UPDATE');
    expect(el.textContent).toContain('FAA NOTAM Search HTTP 403');
    expect(el.textContent).toContain('paste');
    expect(el.textContent).toContain('1800wxbrief.com');

    S.sectionMeta = { notam: { status: 'live', updatedAt: Date.now() } };
    renderNotamManualNotice();
    expect(el.style.display).toBe('none');
  });

  it('renderAutoCheckStatus drives the notice and names the NOTAM leg in its detail line', () => {
    S.sectionMeta = { tfr: { status: 'live', updatedAt: Date.now() }, notam: { status: 'error', error: 'HTTP 403' } };
    S.autoCheck = { state: 'error', tfrOk: true, notamOk: false, tfrCount: 1, notamCount: 0 };
    renderAutoCheckStatus();
    expect(document.getElementById('notamManualNotice').style.display).not.toBe('none');
    expect(document.getElementById('autoCheckDetail').textContent).toContain('NOTAMs NEED MANUAL UPDATE');
    expect(document.getElementById('autoCheckStatus').textContent).toBe('FAILED');
  });
});
