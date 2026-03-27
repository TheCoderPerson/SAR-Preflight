const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { computeOpsData, S } = require('../../sar-preflight.js');

describe('computeOpsData()', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="cfgFlightTime" type="number" value="38" />
      <span id="opsTempFactor"></span>
      <span id="opsAltFactor"></span>
      <span id="opsWindFactor"></span>
      <span id="opsFlightTime"></span>
      <span id="opsCapacity"></span>
      <div id="opsCapBar" style="width: 0%; background: green;"></div>
      <span id="opsBirds"></span>
    `;
    // Reset state
    S.wx = {};
    S.wind = {};
    S.elev = {};
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('nominal conditions (warm, low elevation, calm wind)', () => {
    beforeEach(() => {
      S.wx = { temperature_2m: 70 };  // 21.1C -> tempFactor 1.0
      S.elev = { center: 1000 };      // altFactor 1.0
      S.wind = { maxWind: 5 };        // windFactor 1.0
    });

    it('shows 100% temperature factor', () => {
      computeOpsData();
      expect(document.getElementById('opsTempFactor').textContent).toBe('100%');
    });

    it('sets tempFactor color to green', () => {
      computeOpsData();
      expect(document.getElementById('opsTempFactor').classList.contains('green')).toBe(true);
    });

    it('shows 100% altitude factor', () => {
      computeOpsData();
      expect(document.getElementById('opsAltFactor').textContent).toBe('100%');
    });

    it('sets altFactor color to green', () => {
      computeOpsData();
      expect(document.getElementById('opsAltFactor').classList.contains('green')).toBe(true);
    });

    it('shows 100% wind factor', () => {
      computeOpsData();
      expect(document.getElementById('opsWindFactor').textContent).toBe('100%');
    });

    it('sets windFactor color to green', () => {
      computeOpsData();
      expect(document.getElementById('opsWindFactor').classList.contains('green')).toBe(true);
    });

    it('shows full flight time (~38 min)', () => {
      computeOpsData();
      expect(document.getElementById('opsFlightTime').textContent).toBe('~38 min');
    });

    it('sets flight time color to green', () => {
      computeOpsData();
      expect(document.getElementById('opsFlightTime').classList.contains('green')).toBe(true);
    });

    it('shows 100% capacity', () => {
      computeOpsData();
      expect(document.getElementById('opsCapacity').textContent).toBe('100% of nominal');
    });

    it('sets capacity bar width to 100%', () => {
      computeOpsData();
      expect(document.getElementById('opsCapBar').style.width).toBe('100%');
    });

    it('sets capacity bar color to green', () => {
      computeOpsData();
      expect(document.getElementById('opsCapBar').style.background).toContain('green');
    });
  });

  describe('cold, high altitude, high wind conditions', () => {
    beforeEach(() => {
      S.wx = { temperature_2m: 31 };   // -0.56C -> tempFactor 0.70
      S.elev = { center: 9000 };       // altFactor 0.75
      S.wind = { maxWind: 30 };        // windFactor 0.65
    });

    it('shows 70% temperature factor', () => {
      computeOpsData();
      expect(document.getElementById('opsTempFactor').textContent).toBe('70%');
    });

    it('sets tempFactor color to red for severe derating', () => {
      computeOpsData();
      expect(document.getElementById('opsTempFactor').classList.contains('red')).toBe(true);
    });

    it('shows 75% altitude factor', () => {
      computeOpsData();
      expect(document.getElementById('opsAltFactor').textContent).toBe('75%');
    });

    it('sets altFactor color to red for high altitude', () => {
      computeOpsData();
      expect(document.getElementById('opsAltFactor').classList.contains('red')).toBe(true);
    });

    it('shows 65% wind factor', () => {
      computeOpsData();
      expect(document.getElementById('opsWindFactor').textContent).toBe('65%');
    });

    it('sets windFactor color to red for high wind', () => {
      computeOpsData();
      expect(document.getElementById('opsWindFactor').classList.contains('red')).toBe(true);
    });

    it('computes severely reduced flight time', () => {
      computeOpsData();
      // combined = 0.70 * 0.75 * 0.65 = ~0.341
      // estTime = round(38 * 0.341) = round(12.96) = 13
      expect(document.getElementById('opsFlightTime').textContent).toBe('~13 min');
    });

    it('sets flight time color to red for short time', () => {
      computeOpsData();
      expect(document.getElementById('opsFlightTime').classList.contains('red')).toBe(true);
    });

    it('shows low capacity percentage', () => {
      computeOpsData();
      // combined ~0.341 -> 34% capacity
      expect(document.getElementById('opsCapacity').textContent).toBe('34% of nominal');
    });

    it('sets capacity bar to low width', () => {
      computeOpsData();
      expect(document.getElementById('opsCapBar').style.width).toBe('34%');
    });

    it('sets capacity bar color to red', () => {
      computeOpsData();
      expect(document.getElementById('opsCapBar').style.background).toContain('red');
    });
  });

  describe('moderate conditions', () => {
    beforeEach(() => {
      S.wx = { temperature_2m: 45 };   // 7.22C -> tempFactor 0.90
      S.elev = { center: 3000 };       // altFactor 0.95
      S.wind = { maxWind: 12 };        // windFactor 0.88
    });

    it('shows 90% temperature factor', () => {
      computeOpsData();
      expect(document.getElementById('opsTempFactor').textContent).toBe('90%');
    });

    it('sets tempFactor color to amber for moderate derating', () => {
      computeOpsData();
      // 0.90 is not > 0.9, so amber
      expect(document.getElementById('opsTempFactor').classList.contains('amber')).toBe(true);
    });

    it('shows 95% altitude factor', () => {
      computeOpsData();
      expect(document.getElementById('opsAltFactor').textContent).toBe('95%');
    });

    it('sets altFactor color to green for moderate altitude', () => {
      computeOpsData();
      expect(document.getElementById('opsAltFactor').classList.contains('green')).toBe(true);
    });

    it('shows 88% wind factor', () => {
      computeOpsData();
      expect(document.getElementById('opsWindFactor').textContent).toBe('88%');
    });

    it('computes moderate flight time', () => {
      computeOpsData();
      // combined = 0.90 * 0.95 * 0.88 = ~0.7524
      // estTime = round(38 * 0.7524) = round(28.59) = 29
      expect(document.getElementById('opsFlightTime').textContent).toBe('~29 min');
    });

    it('sets flight time color to green (> 28)', () => {
      computeOpsData();
      expect(document.getElementById('opsFlightTime').classList.contains('green')).toBe(true);
    });
  });

  describe('cfgFlightTime input', () => {
    it('uses cfgFlightTime value for nominal flight time', () => {
      document.getElementById('cfgFlightTime').value = '55';
      S.wx = { temperature_2m: 70 };
      S.elev = { center: 1000 };
      S.wind = { maxWind: 5 };

      computeOpsData();

      expect(document.getElementById('opsFlightTime').textContent).toBe('~55 min');
    });

    it('defaults to 38 when cfgFlightTime is empty', () => {
      document.getElementById('cfgFlightTime').value = '';
      S.wx = { temperature_2m: 70 };
      S.elev = { center: 1000 };
      S.wind = { maxWind: 5 };

      computeOpsData();

      expect(document.getElementById('opsFlightTime').textContent).toBe('~38 min');
    });

    it('defaults to 38 when cfgFlightTime is non-numeric', () => {
      document.getElementById('cfgFlightTime').value = 'abc';
      S.wx = { temperature_2m: 70 };
      S.elev = { center: 1000 };
      S.wind = { maxWind: 5 };

      computeOpsData();

      expect(document.getElementById('opsFlightTime').textContent).toBe('~38 min');
    });
  });

  describe('default values when state is empty', () => {
    it('uses defaults (65F temp, 1500ft elev, 5mph wind)', () => {
      S.wx = {};
      S.elev = {};
      S.wind = {};

      computeOpsData();

      // temp 65F -> 18.33C -> tempFactor 1.0
      // elev 1500 -> altFactor 1.0
      // wind 5 -> windFactor 1.0
      expect(document.getElementById('opsTempFactor').textContent).toBe('100%');
      expect(document.getElementById('opsAltFactor').textContent).toBe('100%');
      expect(document.getElementById('opsWindFactor').textContent).toBe('100%');
    });
  });

  describe('bird risk seasonal display', () => {
    it('renders a bird risk assessment string', () => {
      S.wx = { temperature_2m: 70 };
      S.elev = { center: 1000 };
      S.wind = { maxWind: 5 };

      computeOpsData();

      const text = document.getElementById('opsBirds').textContent;
      expect(text.length).toBeGreaterThan(0);
      // The text should relate to bird activity
      expect(text).toMatch(/nesting|migration|bird activity/i);
    });
  });

  describe('capacity bar color thresholds', () => {
    it('green when capacity > 85%', () => {
      S.wx = { temperature_2m: 70 };
      S.elev = { center: 1000 };
      S.wind = { maxWind: 5 };

      computeOpsData();
      // 100% capacity -> green
      expect(document.getElementById('opsCapBar').style.background).toContain('green');
    });

    it('amber when capacity 71-85%', () => {
      // Need combined ~0.80
      // tempFactor=0.90 (45F), altFactor=0.95 (3000ft), windFactor=0.88 (12mph) = 0.7524
      // That gives 75%, which is in the amber zone (> 70, <= 85)
      S.wx = { temperature_2m: 45 };
      S.elev = { center: 3000 };
      S.wind = { maxWind: 12 };

      computeOpsData();

      expect(document.getElementById('opsCapBar').style.background).toContain('amber');
    });

    it('red when capacity <= 70%', () => {
      // Need combined <= 0.70
      S.wx = { temperature_2m: 31 };  // 0.70
      S.elev = { center: 5000 };      // 0.90
      S.wind = { maxWind: 18 };       // 0.80
      // combined = 0.70 * 0.90 * 0.80 = 0.504 -> 50%

      computeOpsData();

      expect(document.getElementById('opsCapBar').style.background).toContain('red');
    });
  });

  describe('flight time color thresholds', () => {
    it('green when estimated time > 28 min', () => {
      S.wx = { temperature_2m: 70 };
      S.elev = { center: 1000 };
      S.wind = { maxWind: 5 };

      computeOpsData();
      // 38 min -> green
      expect(document.getElementById('opsFlightTime').classList.contains('green')).toBe(true);
    });

    it('amber when estimated time 21-28 min', () => {
      // Need combined ~0.66 to get estTime ~25 from 38 min
      // tempFactor=0.82 (37F), altFactor=0.95 (3000ft), windFactor=0.88 (12mph) = 0.686
      // estTime = round(38 * 0.686) = round(26.1) = 26 -> amber
      S.wx = { temperature_2m: 37 };
      S.elev = { center: 3000 };
      S.wind = { maxWind: 12 };

      computeOpsData();

      expect(document.getElementById('opsFlightTime').classList.contains('amber')).toBe(true);
    });

    it('red when estimated time <= 20 min', () => {
      S.wx = { temperature_2m: 31 };
      S.elev = { center: 9000 };
      S.wind = { maxWind: 30 };

      computeOpsData();
      // ~13 min -> red
      expect(document.getElementById('opsFlightTime').classList.contains('red')).toBe(true);
    });
  });
});
