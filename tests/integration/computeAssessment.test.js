const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { computeAssessment, S } = require('../../sar-preflight.js');

describe('computeAssessment()', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="cfgMaxWind" type="number" value="27" />
      <span id="assessBadge" class="assessment-badge">--</span>
      <span id="assessText">--</span>
    `;
    // Reset state
    S.wx = {};
    S.wind = {};
    S.elev = {};
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('GO assessment', () => {
    it('shows GO badge with nominal conditions', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      const badge = document.getElementById('assessBadge');
      expect(badge.textContent).toBe('GO');
      expect(badge.className).toBe('assessment-badge go');
    });

    it('shows nominal text for GO', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      expect(document.getElementById('assessText').textContent).toBe(
        'All conditions nominal for UAS operations'
      );
    });

    it('GO when all state objects are empty (defaults are safe)', () => {
      S.wx = {};
      S.wind = {};
      S.elev = {};

      computeAssessment();

      const badge = document.getElementById('assessBadge');
      expect(badge.textContent).toBe('GO');
      expect(badge.className).toBe('assessment-badge go');
    });
  });

  describe('CAUTION assessment', () => {
    it('shows CAUTION badge when winds are elevated (16-27 mph)', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 20, maxGust: 25 };
      S.elev = { center: 2000 };

      computeAssessment();

      const badge = document.getElementById('assessBadge');
      expect(badge.textContent).toBe('CAUTION');
      expect(badge.className).toBe('assessment-badge caution');
    });

    it('shows CAUTION for reduced visibility (1-5 mi)', () => {
      S.wx = {
        visibility: 4000, // ~2.5 miles
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
      expect(document.getElementById('assessText').textContent).toContain('visibility');
    });

    it('shows CAUTION for cold temperature (< 35F)', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 30,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
      expect(document.getElementById('assessText').textContent).toContain('Cold');
    });

    it('shows CAUTION for high elevation (> 6000 ft)', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 7000 };

      computeAssessment();

      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
      expect(document.getElementById('assessText').textContent).toContain('elevation');
    });

    it('shows CAUTION for moderate precipitation (31-60%)', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 45,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
      expect(document.getElementById('assessText').textContent).toContain('Precip');
    });
  });

  describe('NO-GO assessment', () => {
    it('shows NO-GO badge when wind exceeds tolerance', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 30, maxGust: 35 };
      S.elev = { center: 2000 };

      computeAssessment();

      const badge = document.getElementById('assessBadge');
      expect(badge.textContent).toBe('NO-GO');
      expect(badge.className).toBe('assessment-badge nogo');
    });

    it('shows NO-GO text with wind issue detail', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 30, maxGust: 35 };
      S.elev = { center: 2000 };

      computeAssessment();

      expect(document.getElementById('assessText').textContent).toContain('exceeds limits');
    });

    it('shows NO-GO for thunderstorm', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 95,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      const badge = document.getElementById('assessBadge');
      expect(badge.textContent).toBe('NO-GO');
      expect(badge.className).toBe('assessment-badge nogo');
      expect(document.getElementById('assessText').textContent).toContain('Thunderstorm');
    });

    it('shows NO-GO for very low visibility (< 1 mi)', () => {
      S.wx = {
        visibility: 1000, // ~0.62 mi
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
      expect(document.getElementById('assessText').textContent).toContain('Visibility');
    });

    it('shows NO-GO for high precipitation (> 60%)', () => {
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 70,
        weather_code: 0,
      };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };

      computeAssessment();

      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
      expect(document.getElementById('assessText').textContent).toContain('Precip');
    });
  });

  describe('respects cfgMaxWind input', () => {
    it('uses cfgMaxWind value as wind tolerance', () => {
      document.getElementById('cfgMaxWind').value = '15';
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 18, maxGust: 20 };
      S.elev = { center: 2000 };

      computeAssessment();

      // 18 > 15 -> NO-GO
      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
    });

    it('higher tolerance allows higher winds', () => {
      document.getElementById('cfgMaxWind').value = '35';
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 30, maxGust: 35 };
      S.elev = { center: 2000 };

      computeAssessment();

      // 30 > 35 is false, 35 > 40 is false -> no wind issue
      // But 30 > 15 -> CAUTION (elevated winds)
      expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
    });

    it('defaults to 27 when cfgMaxWind is empty', () => {
      document.getElementById('cfgMaxWind').value = '';
      S.wx = {
        visibility: 16000,
        temperature_2m: 65,
        precipitation_probability: 0,
        weather_code: 0,
      };
      S.wind = { maxWind: 28, maxGust: 30 };
      S.elev = { center: 2000 };

      computeAssessment();

      // 28 > 27 -> NO-GO
      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
    });
  });

  describe('badge className mapping', () => {
    it('GO -> "assessment-badge go"', () => {
      S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };
      computeAssessment();
      expect(document.getElementById('assessBadge').className).toBe('assessment-badge go');
    });

    it('CAUTION -> "assessment-badge caution"', () => {
      S.wx = { visibility: 16000, temperature_2m: 30, precipitation_probability: 0, weather_code: 0 };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };
      computeAssessment();
      expect(document.getElementById('assessBadge').className).toBe('assessment-badge caution');
    });

    it('NO-GO -> "assessment-badge nogo"', () => {
      S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 95 };
      S.wind = { maxWind: 5, maxGust: 8 };
      S.elev = { center: 2000 };
      computeAssessment();
      expect(document.getElementById('assessBadge').className).toBe('assessment-badge nogo');
    });
  });

  describe('multiple issues', () => {
    it('shows all NO-GO issues joined in text', () => {
      S.wx = {
        visibility: 500,
        temperature_2m: 65,
        precipitation_probability: 80,
        weather_code: 96,
      };
      S.wind = { maxWind: 35, maxGust: 40 };
      S.elev = { center: 2000 };

      computeAssessment();

      const text = document.getElementById('assessText').textContent;
      expect(text).toContain('\u2022'); // bullet separator
      expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
    });
  });
});
