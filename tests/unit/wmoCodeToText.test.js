const { wmoCodeToText } = require('../../sar-preflight-core.js');

describe('wmoCodeToText(code)', () => {
  describe('all defined WMO codes', () => {
    const definedCodes = {
      0: 'Clear',
      1: 'Mainly Clear',
      2: 'Partly Cloudy',
      3: 'Overcast',
      45: 'Fog',
      48: 'Rime Fog',
      51: 'Light Drizzle',
      53: 'Drizzle',
      55: 'Heavy Drizzle',
      61: 'Light Rain',
      63: 'Rain',
      65: 'Heavy Rain',
      71: 'Light Snow',
      73: 'Snow',
      75: 'Heavy Snow',
      77: 'Snow Grains',
      80: 'Rain Showers',
      81: 'Mod Rain Showers',
      82: 'Heavy Rain Showers',
      85: 'Snow Showers',
      86: 'Heavy Snow Showers',
      95: 'Thunderstorm',
      96: 'T-Storm w/ Hail',
      99: 'Severe T-Storm',
    };

    Object.entries(definedCodes).forEach(([code, text]) => {
      it(`code ${code} -> "${text}"`, () => {
        expect(wmoCodeToText(Number(code))).toBe(text);
      });
    });
  });

  describe('unknown codes return "WMO {code}"', () => {
    it('code 10 -> "WMO 10"', () => {
      expect(wmoCodeToText(10)).toBe('WMO 10');
    });

    it('code 100 -> "WMO 100"', () => {
      expect(wmoCodeToText(100)).toBe('WMO 100');
    });

    it('code -1 -> "WMO -1"', () => {
      expect(wmoCodeToText(-1)).toBe('WMO -1');
    });

    it('code 50 -> "WMO 50" (not defined despite being between drizzle codes)', () => {
      expect(wmoCodeToText(50)).toBe('WMO 50');
    });

    it('code 999 -> "WMO 999"', () => {
      expect(wmoCodeToText(999)).toBe('WMO 999');
    });
  });

  describe('boundary between known and unknown', () => {
    it('code 4 is unknown (gap between 3 and 45)', () => {
      expect(wmoCodeToText(4)).toBe('WMO 4');
    });

    it('code 44 is unknown (just before Fog)', () => {
      expect(wmoCodeToText(44)).toBe('WMO 44');
    });

    it('code 46 is unknown (just after Fog)', () => {
      expect(wmoCodeToText(46)).toBe('WMO 46');
    });

    it('code 94 is unknown (just before Thunderstorm)', () => {
      expect(wmoCodeToText(94)).toBe('WMO 94');
    });

    it('code 97 is unknown (between T-Storm w/ Hail and Severe)', () => {
      expect(wmoCodeToText(97)).toBe('WMO 97');
    });
  });
});
