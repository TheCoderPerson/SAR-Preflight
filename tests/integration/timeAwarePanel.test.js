const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { S, snapshotAtIdx, renderWind, computeAssessment, updateTimeContextBanner } = require('../../sar-preflight.js');

// A 3-hour forecast: calm at NOW, gale-force by hour 2. Only ground wind arrays are
// provided (upper winds fall back to a ground multiplier inside renderWind).
function seedWeather() {
  S.wx = {
    temperature_2m: 65, dew_point_2m: 45, visibility: 16000, surface_pressure: 1013,
    precipitation_probability: 0, weather_code: 0,
    wind_speed_10m: 5, wind_direction_10m: 270, wind_gusts_10m: 8,
  };
  S.wx.hourly = {
    time: ['2026-06-20T12:00', '2026-06-20T13:00', '2026-06-20T14:00'],
    temperature_2m: [65, 66, 67],
    dew_point_2m: [45, 45, 45],
    visibility: [16000, 16000, 16000],
    surface_pressure: [1013, 1012, 1011],
    precipitation_probability: [0, 0, 0],
    weather_code: [0, 0, 0],
    wind_speed_10m: [5, 18, 40],
    wind_direction_10m: [270, 275, 290],
    wind_gusts_10m: [8, 26, 55],
  };
  S.wind = {};
  S.elev = { center: 2000 };
  S.timeIdx = 0;
}

describe('time-aware data panel', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="cfgMaxWind" type="number" value="27" />
      <table><tbody id="windTableBody"></tbody></table>
      <span id="assessBadge" class="assessment-badge">--</span>
      <span id="assessText">--</span>
      <div id="panelTimeContext" style="display:none;"></div>
    `;
    seedWeather();
  });
  afterEach(() => { document.body.innerHTML = ''; S.timeIdx = 0; });

  describe('renderWind(snapshot)', () => {
    it('rebuilds S.wind from the selected hour', () => {
      renderWind(snapshotAtIdx(0));
      const calmMax = S.wind.maxWind;
      renderWind(snapshotAtIdx(2));
      const galeMax = S.wind.maxWind;
      expect(galeMax).toBeGreaterThan(calmMax);
      expect(galeMax).toBeGreaterThan(27);
    });
  });

  describe('per-hour GO/CAUTION/NO-GO', () => {
    it('shows GO at the calm NOW hour', () => {
      const snap = snapshotAtIdx(0);
      renderWind(snap);
      computeAssessment(snap);
      expect(document.getElementById('assessBadge').textContent).toBe('GO');
    });

    it('flips to NO-GO when scrubbed to a high-wind forecast hour', () => {
      const snap = snapshotAtIdx(2);
      renderWind(snap);          // rebuild S.wind for hour 2
      computeAssessment(snap);
      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
      expect(document.getElementById('assessText').textContent).toMatch(/wind/i);
    });
  });

  describe('snapshotAtIdx', () => {
    it('returns NOW values at idx 0 and the future hour at idx 2', () => {
      expect(snapshotAtIdx(0).wind_speed_10m).toBe(5);
      expect(snapshotAtIdx(2).wind_speed_10m).toBe(40);
      expect(snapshotAtIdx(2)._isNow).toBe(false);
    });
  });

  describe('updateTimeContextBanner', () => {
    it('is hidden at NOW (idx 0)', () => {
      S.timeIdx = 0;
      updateTimeContextBanner();
      expect(document.getElementById('panelTimeContext').style.display).toBe('none');
    });

    it('shows a FORECAST banner when a future hour is selected', () => {
      S.timeIdx = 2;
      updateTimeContextBanner();
      const el = document.getElementById('panelTimeContext');
      expect(el.style.display).toBe('block');
      expect(el.innerHTML).toMatch(/FORECAST \+2h/);
      expect(el.innerHTML).toMatch(/current-time/);
    });
  });
});
