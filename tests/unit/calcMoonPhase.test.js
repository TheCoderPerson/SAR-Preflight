const { calcMoonPhase } = require('../../sar-preflight-core.js');

const VALID_PHASE_NAMES = [
  'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
  'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
];

describe('calcMoonPhase()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('return structure', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-25T19:00:00Z'));
    });

    it('returns an object with name, illumination, and phase', () => {
      const result = calcMoonPhase();
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('illumination');
      expect(result).toHaveProperty('phase');
    });

    it('illumination is a number between 0 and 100', () => {
      const result = calcMoonPhase();
      expect(result.illumination).toBeGreaterThanOrEqual(0);
      expect(result.illumination).toBeLessThanOrEqual(100);
    });

    it('phase is a number between 0 and 1', () => {
      const result = calcMoonPhase();
      expect(result.phase).toBeGreaterThanOrEqual(0);
      expect(result.phase).toBeLessThan(1);
    });

    it('name is one of the 8 valid moon phase names', () => {
      const result = calcMoonPhase();
      expect(VALID_PHASE_NAMES).toContain(result.name);
    });

    it('illumination is an integer (rounded)', () => {
      const result = calcMoonPhase();
      expect(Number.isInteger(result.illumination)).toBe(true);
    });
  });

  describe('known full moon per algorithm (2026-04-18)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
    });

    it('should report Full Moon', () => {
      const result = calcMoonPhase();
      expect(result.name).toBe('Full Moon');
    });

    it('illumination should be very high (> 90%)', () => {
      const result = calcMoonPhase();
      expect(result.illumination).toBeGreaterThan(90);
    });

    it('phase should be near 0.5 (full moon)', () => {
      const result = calcMoonPhase();
      expect(result.phase).toBeGreaterThan(0.40);
      expect(result.phase).toBeLessThan(0.60);
    });
  });

  describe('known new moon per algorithm (2026-04-05)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));
    });

    it('should report New Moon', () => {
      const result = calcMoonPhase();
      expect(result.name).toBe('New Moon');
    });

    it('illumination should be very low (< 10%)', () => {
      const result = calcMoonPhase();
      expect(result.illumination).toBeLessThan(10);
    });
  });

  describe('different dates produce different results', () => {
    it('a week apart yields different illumination', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
      const phase1 = calcMoonPhase();

      vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));
      const phase2 = calcMoonPhase();

      // One week apart, illumination should differ
      expect(phase1.illumination).not.toBe(phase2.illumination);
    });
  });

  describe('name always valid for any date', () => {
    const dates = [
      '2026-01-01T00:00:00Z',
      '2026-06-15T12:00:00Z',
      '2026-09-21T18:00:00Z',
      '2026-12-31T23:59:00Z',
    ];

    dates.forEach((date) => {
      it(`valid phase name for ${date}`, () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(date));
        const result = calcMoonPhase();
        expect(VALID_PHASE_NAMES).toContain(result.name);
      });
    });
  });
});
