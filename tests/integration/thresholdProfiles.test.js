const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { readActiveThresholds, computeAssessment, S } = require('../../sar-preflight.js');
const { DEFAULT_THRESHOLDS, DRONE_PROFILES } = core;

describe('readActiveThresholds() + profile-driven assessment', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="cfgMaxWind" type="number" value="27" />
      <input id="cfgFlightTime" type="number" value="38" />
      <span id="assessBadge" class="assessment-badge">--</span>
      <span id="assessText">--</span>
    `;
    S.activeProfile = null;
    S.wx = {}; S.wind = {}; S.elev = {};
    S.kp = null; S.aqi = null;
  });
  afterEach(() => { document.body.innerHTML = ''; S.activeProfile = null; });

  describe('readActiveThresholds()', () => {
    it('returns DEFAULT_THRESHOLDS when no profile and inputs at defaults', () => {
      const t = readActiveThresholds();
      expect(t.maxWindTol).toBe(27);
      expect(t.flightTime).toBe(38);
      expect(t.visNoGo).toBe(DEFAULT_THRESHOLDS.visNoGo);
    });

    it('overlays edited input values over defaults', () => {
      document.getElementById('cfgMaxWind').value = '15';
      expect(readActiveThresholds().maxWindTol).toBe(15);
    });

    it('falls back to default when an input is blank', () => {
      document.getElementById('cfgMaxWind').value = '';
      expect(readActiveThresholds().maxWindTol).toBe(27);
    });

    it('uses the active profile, but live input edits win over it', () => {
      S.activeProfile = DRONE_PROFILES.find(p => p.name === 'DJI Neo'); // maxWindTol 18
      // input still shows 27 (default) -> input wins over profile in the merge
      expect(readActiveThresholds().maxWindTol).toBe(27);
      // when the input is blank, the profile value comes through
      document.getElementById('cfgMaxWind').value = '';
      expect(readActiveThresholds().maxWindTol).toBe(18);
      // and flightTime (no input override here besides default 38) overlays from input
      expect(readActiveThresholds().flightTime).toBe(38);
    });

    it('missing inputs entirely are tolerated (null-safe)', () => {
      document.body.innerHTML = '';
      const t = readActiveThresholds();
      expect(t.maxWindTol).toBe(27);
      expect(t.kpCaution).toBe(DEFAULT_THRESHOLDS.kpCaution);
    });
  });

  describe('computeAssessment() honors the active profile via inputs', () => {
    function setProfileInputs(p) {
      // Simulate loadSopProfile populating the inputs from a profile
      document.getElementById('cfgMaxWind').value = p.maxWindTol;
      document.getElementById('cfgFlightTime').value = p.flightTime;
      S.activeProfile = p;
    }
    it('Neo (18 mph NO-GO) flags 20 mph wind as NO-GO', () => {
      setProfileInputs(DRONE_PROFILES.find(p => p.name === 'DJI Neo'));
      S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
      S.wind = { maxWind: 20, maxGust: 22 };
      S.elev = { center: 2000 };
      computeAssessment();
      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
    });

    it('M300 (27 mph NO-GO) treats the same 20 mph as CAUTION', () => {
      setProfileInputs(DRONE_PROFILES.find(p => p.name === 'DJI Matrice 300 RTK'));
      S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
      S.wind = { maxWind: 20, maxGust: 22 };
      S.elev = { center: 2000 };
      computeAssessment();
      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
    });

    it('hazardous AQI forces NO-GO; unhealthy AQI is CAUTION', () => {
      S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };
      S.aqi = 300; // >= aqiNoGo 250
      computeAssessment();
      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
      S.aqi = 175; // between aqiCaution 150 and aqiNoGo 250
      computeAssessment();
      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
    });

    it('elevated Kp raises a GNSS caution', () => {
      S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };
      S.kp = 6; // >= kpCaution 5
      computeAssessment();
      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
      expect(document.getElementById('assessText').textContent).toMatch(/Kp/);
    });
  });
});
