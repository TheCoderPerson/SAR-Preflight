// Advisories banner: collapse (banner to one line + hide the area bar) and the
// "Limits from Config profile" line naming the profile the limits come from.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = {
  map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() },
  Draw: { Event: {} }, FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }), clearLayers: vi.fn(), addLayer: vi.fn(), getLayers: () => [] })),
};

const app = require('../../sar-preflight.js');
const { S, computeAssessment, toggleAssessmentCollapsed, restoreAssessCollapsed, ASSESS_COLLAPSED_KEY, openLimitsProfileConfig } = app;

function setBody() {
  document.body.innerHTML = `
    <div class="side-panel" id="sidePanel">
      <div class="assessment-banner" id="assessmentBanner">
        <span id="assessBadge" class="assessment-badge">--</span>
        <div class="assess-body"><span id="assessText">--</span><div id="assessProfile"></div></div>
        <button id="assessToggle" aria-expanded="true"></button>
      </div>
      <div class="area-info-bar" id="areaInfoBar"></div>
      <div id="noAreaState"></div>
      <button class="tab-btn" data-tab="config"></button>
      <div id="tab-config" class="tab-panel" style="display:none"><select id="cfgSopProfile"></select></div>
    </div>
    <input id="cfgMaxWind" type="number" value="27" />
  `;
}

describe('advisories collapse', () => {
  beforeEach(() => { setBody(); localStorage.removeItem(ASSESS_COLLAPSED_KEY); S.assessCollapsed = false; });
  afterEach(() => { document.body.innerHTML = ''; localStorage.removeItem(ASSESS_COLLAPSED_KEY); });

  it('collapses the banner AND the operational-area bar, then expands again', () => {
    toggleAssessmentCollapsed();
    const banner = document.getElementById('assessmentBanner');
    const btn = document.getElementById('assessToggle');
    expect(banner.classList.contains('collapsed')).toBe(true);
    expect(document.getElementById('sidePanel').classList.contains('assess-collapsed')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem(ASSESS_COLLAPSED_KEY)).toBe('1');
    toggleAssessmentCollapsed();
    expect(banner.classList.contains('collapsed')).toBe(false);
    expect(document.getElementById('sidePanel').classList.contains('assess-collapsed')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem(ASSESS_COLLAPSED_KEY)).toBe('0');
  });

  it('restores the remembered state without writing it back', () => {
    localStorage.setItem(ASSESS_COLLAPSED_KEY, '1');
    restoreAssessCollapsed();
    expect(S.assessCollapsed).toBe(true);
    expect(document.getElementById('assessmentBanner').classList.contains('collapsed')).toBe(true);
    localStorage.removeItem(ASSESS_COLLAPSED_KEY);
    restoreAssessCollapsed();
    expect(S.assessCollapsed).toBe(false);
  });
});

describe('limits profile line', () => {
  beforeEach(() => {
    setBody();
    S.currentArea = { id: 1 };
    S.areaCenter = { lat: 38.7, lng: -121 };
    S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
    S.wind = { maxWind: 5, maxGust: 8 };
    S.elev = { center: 2000 };
    S.sectionMeta = {};
  });
  afterEach(() => { document.body.innerHTML = ''; S.activeProfile = null; S.currentArea = null; });

  it('names the selected aircraft profile', () => {
    S.activeProfile = DRONE_PROFILES.find(p => p.name === 'DJI Matrice 4T');
    computeAssessment();
    const el = document.getElementById('assessProfile');
    expect(el.textContent).toBe('Limits from Config profile: DJI Matrice 4T');
    expect(document.getElementById('assessText').title).toBe(document.getElementById('assessText').textContent);
  });

  it('says Default with no profile, and flags an edited field', () => {
    S.activeProfile = null;
    computeAssessment();
    expect(document.getElementById('assessProfile').textContent).toBe('Limits from Config profile: Default (no aircraft selected)');
    document.getElementById('cfgMaxWind').value = '20';
    computeAssessment();
    expect(document.getElementById('assessProfile').textContent).toContain('(edited values)');
  });

  it('escapes a custom profile name', () => {
    S.activeProfile = Object.assign({}, DEFAULT_THRESHOLDS, { name: '<img src=x>' });
    computeAssessment();
    expect(document.getElementById('assessProfile').querySelector('img')).toBeNull();
    expect(document.getElementById('assessProfile').textContent).toContain('<img src=x>');
  });

  it('the profile name opens the Config tab', () => {
    Element.prototype.scrollIntoView = vi.fn(); // not implemented in jsdom
    openLimitsProfileConfig();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.getElementById('tab-config').style.display).toBe('');
  });
});
