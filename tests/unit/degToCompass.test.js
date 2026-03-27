const { degToCompass } = require('../../sar-preflight-core.js');

describe('degToCompass(d)', () => {
  describe('cardinal directions', () => {
    it('0 degrees -> N', () => {
      expect(degToCompass(0)).toBe('N');
    });

    it('90 degrees -> E', () => {
      expect(degToCompass(90)).toBe('E');
    });

    it('180 degrees -> S', () => {
      expect(degToCompass(180)).toBe('S');
    });

    it('270 degrees -> W', () => {
      expect(degToCompass(270)).toBe('W');
    });

    it('360 degrees -> N (full circle)', () => {
      expect(degToCompass(360)).toBe('N');
    });
  });

  describe('all 16 compass points at exact centers', () => {
    const expected = [
      [0, 'N'],
      [22.5, 'NNE'],
      [45, 'NE'],
      [67.5, 'ENE'],
      [90, 'E'],
      [112.5, 'ESE'],
      [135, 'SE'],
      [157.5, 'SSE'],
      [180, 'S'],
      [202.5, 'SSW'],
      [225, 'SW'],
      [247.5, 'WSW'],
      [270, 'W'],
      [292.5, 'WNW'],
      [315, 'NW'],
      [337.5, 'NNW'],
    ];

    expected.forEach(([deg, dir]) => {
      it(`${deg} degrees -> ${dir}`, () => {
        expect(degToCompass(deg)).toBe(dir);
      });
    });
  });

  describe('wraparound beyond 360', () => {
    it('720 degrees -> N (two full rotations)', () => {
      expect(degToCompass(720)).toBe('N');
    });

    it('450 degrees -> E (360+90)', () => {
      expect(degToCompass(450)).toBe('E');
    });

    it('540 degrees -> S (360+180)', () => {
      expect(degToCompass(540)).toBe('S');
    });

    it('630 degrees -> W (360+270)', () => {
      expect(degToCompass(630)).toBe('W');
    });
  });

  describe('negative input', () => {
    it('-90 degrees -> W (equivalent to 270)', () => {
      expect(degToCompass(-90)).toBe('W');
    });

    it('-180 degrees -> S', () => {
      expect(degToCompass(-180)).toBe('S');
    });

    it('-270 degrees -> E (equivalent to 90)', () => {
      expect(degToCompass(-270)).toBe('E');
    });

    it('-360 degrees -> N', () => {
      expect(degToCompass(-360)).toBe('N');
    });

    it('-45 degrees -> NW (equivalent to 315)', () => {
      expect(degToCompass(-45)).toBe('NW');
    });
  });

  describe('boundary values between sectors', () => {
    it('just below 11.25 stays N', () => {
      expect(degToCompass(11)).toBe('N');
    });

    it('just above 11.25 becomes NNE', () => {
      expect(degToCompass(12)).toBe('NNE');
    });

    it('348.75+ wraps to N', () => {
      expect(degToCompass(350)).toBe('N');
    });
  });
});
