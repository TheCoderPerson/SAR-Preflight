const { calcGustFactor, calcWindShear } = require('../../sar-preflight-core.js');

describe('calcGustFactor(maxGust, maxSustained)', () => {
  it('returns ratio of gust to sustained wind', () => {
    expect(calcGustFactor(30, 20)).toBeCloseTo(1.5);
  });

  it('returns 0 when sustained wind is 0', () => {
    expect(calcGustFactor(10, 0)).toBe(0);
  });

  it('returns 0 when sustained wind is null', () => {
    expect(calcGustFactor(10, null)).toBe(0);
  });

  it('returns 0 when sustained wind is undefined', () => {
    expect(calcGustFactor(10, undefined)).toBe(0);
  });

  it('returns 1.0 when gust equals sustained', () => {
    expect(calcGustFactor(15, 15)).toBeCloseTo(1.0);
  });

  it('returns 2.0 for double gust factor', () => {
    expect(calcGustFactor(40, 20)).toBeCloseTo(2.0);
  });

  it('handles small values correctly', () => {
    expect(calcGustFactor(3, 2)).toBeCloseTo(1.5);
  });

  it('returns high factor for large gust relative to sustained', () => {
    expect(calcGustFactor(50, 15)).toBeCloseTo(3.333, 2);
  });

  it('returns 0 when both are 0', () => {
    expect(calcGustFactor(0, 0)).toBe(0);
  });
});

describe('calcWindShear(windProfile)', () => {
  const makeProfile = (entries) =>
    entries.map(([speed, dir], i) => ({ alt: `${i * 100} ft`, speed, dir, gust: speed + 5 }));

  describe('returns correct structure', () => {
    it('returns maxSpeedChange, maxDirChange, and level', () => {
      const profile = makeProfile([[10, 180], [12, 185]]);
      const result = calcWindShear(profile);
      expect(typeof result.maxSpeedChange).toBe('number');
      expect(typeof result.maxDirChange).toBe('number');
      expect(typeof result.level).toBe('string');
    });
  });

  describe('green level (low shear)', () => {
    it('returns green for small speed and direction changes', () => {
      const profile = makeProfile([[10, 180], [12, 185], [14, 190]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('green');
      expect(result.maxSpeedChange).toBe(2);
      expect(result.maxDirChange).toBe(5);
    });

    it('returns green for uniform wind', () => {
      const profile = makeProfile([[10, 180], [10, 180], [10, 180]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('green');
      expect(result.maxSpeedChange).toBe(0);
      expect(result.maxDirChange).toBe(0);
    });

    it('returns green at speed boundary of 8 mph', () => {
      const profile = makeProfile([[10, 180], [18, 180]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('green');
      expect(result.maxSpeedChange).toBe(8);
    });

    it('returns green at direction boundary of 25 degrees', () => {
      const profile = makeProfile([[10, 180], [10, 205]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('green');
      expect(result.maxDirChange).toBe(25);
    });
  });

  describe('amber level (moderate shear)', () => {
    it('returns amber when speed change exceeds 8 mph', () => {
      const profile = makeProfile([[10, 180], [19, 180]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('amber');
      expect(result.maxSpeedChange).toBe(9);
    });

    it('returns amber when direction change exceeds 25 degrees', () => {
      const profile = makeProfile([[10, 180], [10, 210]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('amber');
      expect(result.maxDirChange).toBe(30);
    });

    it('returns amber at speed boundary of 15 mph', () => {
      const profile = makeProfile([[10, 180], [25, 180]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('amber');
      expect(result.maxSpeedChange).toBe(15);
    });

    it('returns amber at direction boundary of 45 degrees', () => {
      const profile = makeProfile([[10, 180], [10, 225]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('amber');
      expect(result.maxDirChange).toBe(45);
    });
  });

  describe('red level (severe shear)', () => {
    it('returns red when speed change exceeds 15 mph', () => {
      const profile = makeProfile([[10, 180], [26, 180]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('red');
      expect(result.maxSpeedChange).toBe(16);
    });

    it('returns red when direction change exceeds 45 degrees', () => {
      const profile = makeProfile([[10, 180], [10, 230]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('red');
      expect(result.maxDirChange).toBe(50);
    });

    it('returns red when both speed and direction exceed red thresholds', () => {
      const profile = makeProfile([[5, 90], [25, 180]]);
      const result = calcWindShear(profile);
      expect(result.level).toBe('red');
      expect(result.maxSpeedChange).toBe(20);
      expect(result.maxDirChange).toBe(90);
    });
  });

  describe('direction wrapping around 360/0 boundary', () => {
    it('correctly handles wrap from 350 to 10 (20 degree change, not 340)', () => {
      const profile = makeProfile([[10, 350], [10, 10]]);
      const result = calcWindShear(profile);
      expect(result.maxDirChange).toBe(20);
      expect(result.level).toBe('green');
    });

    it('correctly handles wrap from 10 to 350', () => {
      const profile = makeProfile([[10, 10], [10, 350]]);
      const result = calcWindShear(profile);
      expect(result.maxDirChange).toBe(20);
      expect(result.level).toBe('green');
    });

    it('correctly handles large wrap difference', () => {
      const profile = makeProfile([[10, 5], [10, 315]]);
      const result = calcWindShear(profile);
      // |5 - 315| = 310, > 180 so 360 - 310 = 50
      expect(result.maxDirChange).toBe(50);
      expect(result.level).toBe('red');
    });
  });

  describe('multi-layer profile picks maximum', () => {
    it('finds max shear in middle of profile', () => {
      const profile = makeProfile([[10, 180], [12, 182], [25, 182], [27, 184]]);
      const result = calcWindShear(profile);
      // Biggest speed jump is layer 1->2: |25-12|=13
      expect(result.maxSpeedChange).toBe(13);
    });

    it('finds max direction change in middle of profile', () => {
      const profile = makeProfile([[10, 180], [10, 182], [10, 230], [10, 232]]);
      const result = calcWindShear(profile);
      // Biggest dir jump is layer 1->2: |230-182|=48
      expect(result.maxDirChange).toBe(48);
    });
  });

  describe('edge cases', () => {
    it('handles single-element profile (no shear)', () => {
      const profile = makeProfile([[10, 180]]);
      const result = calcWindShear(profile);
      expect(result.maxSpeedChange).toBe(0);
      expect(result.maxDirChange).toBe(0);
      expect(result.level).toBe('green');
    });

    it('handles empty profile', () => {
      const result = calcWindShear([]);
      expect(result.maxSpeedChange).toBe(0);
      expect(result.maxDirChange).toBe(0);
      expect(result.level).toBe('green');
    });
  });
});
