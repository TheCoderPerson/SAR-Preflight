const { classifyTerrain, estimateVegetation, estimateCellCoverage } = require('../../sar-preflight-core.js');

describe('classifyTerrain(centerElevFt)', () => {
  describe('elevation classifications', () => {
    it('> 6000 -> Mountainous', () => {
      expect(classifyTerrain(6001)).toBe('Mountainous');
    });

    it('10000 -> Mountainous', () => {
      expect(classifyTerrain(10000)).toBe('Mountainous');
    });

    it('> 3000 and <= 6000 -> Hilly/Foothill', () => {
      expect(classifyTerrain(4000)).toBe('Hilly/Foothill');
    });

    it('> 1000 and <= 3000 -> Rolling', () => {
      expect(classifyTerrain(2000)).toBe('Rolling');
    });

    it('<= 1000 -> Flat', () => {
      expect(classifyTerrain(500)).toBe('Flat');
    });

    it('0 -> Flat', () => {
      expect(classifyTerrain(0)).toBe('Flat');
    });

    it('negative elevation -> Flat', () => {
      expect(classifyTerrain(-100)).toBe('Flat');
    });
  });

  describe('boundary values', () => {
    it('exactly 6000 -> Hilly/Foothill (not > 6000)', () => {
      expect(classifyTerrain(6000)).toBe('Hilly/Foothill');
    });

    it('6001 -> Mountainous', () => {
      expect(classifyTerrain(6001)).toBe('Mountainous');
    });

    it('exactly 3000 -> Rolling (not > 3000)', () => {
      expect(classifyTerrain(3000)).toBe('Rolling');
    });

    it('3001 -> Hilly/Foothill', () => {
      expect(classifyTerrain(3001)).toBe('Hilly/Foothill');
    });

    it('exactly 1000 -> Flat (not > 1000)', () => {
      expect(classifyTerrain(1000)).toBe('Flat');
    });

    it('1001 -> Rolling', () => {
      expect(classifyTerrain(1001)).toBe('Rolling');
    });
  });
});

describe('estimateVegetation(centerElevFt)', () => {
  describe('vegetation bands', () => {
    it('> 7000 -> Subalpine', () => {
      expect(estimateVegetation(8000)).toContain('Subalpine');
    });

    it('> 5000 and <= 7000 -> Mixed conifer', () => {
      expect(estimateVegetation(6000)).toContain('Mixed conifer');
    });

    it('> 3000 and <= 5000 -> Pine/oak', () => {
      expect(estimateVegetation(4000)).toContain('Pine/oak');
    });

    it('> 1500 and <= 3000 -> Oak woodland', () => {
      expect(estimateVegetation(2000)).toContain('Oak woodland');
    });

    it('<= 1500 -> Grassland/valley oak', () => {
      expect(estimateVegetation(1000)).toContain('Grassland');
    });

    it('0 elevation -> Grassland/valley oak', () => {
      expect(estimateVegetation(0)).toContain('Grassland');
    });
  });

  describe('boundary values', () => {
    it('exactly 7000 -> Mixed conifer (not > 7000)', () => {
      expect(estimateVegetation(7000)).toContain('Mixed conifer');
    });

    it('7001 -> Subalpine', () => {
      expect(estimateVegetation(7001)).toContain('Subalpine');
    });

    it('exactly 5000 -> Pine/oak (not > 5000)', () => {
      expect(estimateVegetation(5000)).toContain('Pine/oak');
    });

    it('5001 -> Mixed conifer', () => {
      expect(estimateVegetation(5001)).toContain('Mixed conifer');
    });

    it('exactly 3000 -> Oak woodland (not > 3000)', () => {
      expect(estimateVegetation(3000)).toContain('Oak woodland');
    });

    it('3001 -> Pine/oak', () => {
      expect(estimateVegetation(3001)).toContain('Pine/oak');
    });

    it('exactly 1500 -> Grassland/valley oak (not > 1500)', () => {
      expect(estimateVegetation(1500)).toContain('Grassland');
    });

    it('1501 -> Oak woodland', () => {
      expect(estimateVegetation(1501)).toContain('Oak woodland');
    });
  });

  describe('canopy height info', () => {
    it('Subalpine mentions sparse trees', () => {
      expect(estimateVegetation(8000)).toContain('sparse');
    });

    it('Mixed conifer mentions canopy height', () => {
      expect(estimateVegetation(6000)).toContain('canopy');
    });

    it('Pine/oak mentions canopy height', () => {
      expect(estimateVegetation(4000)).toContain('canopy');
    });
  });
});

describe('estimateCellCoverage(centerElevFt)', () => {
  describe('coverage levels', () => {
    it('> 6000 -> Unlikely (red)', () => {
      const result = estimateCellCoverage(7000);
      expect(result.label).toContain('Unlikely');
      expect(result.level).toBe('red');
    });

    it('> 4000 and <= 6000 -> Marginal (amber)', () => {
      const result = estimateCellCoverage(5000);
      expect(result.label).toContain('Marginal');
      expect(result.level).toBe('amber');
    });

    it('<= 4000 -> Likely available (green)', () => {
      const result = estimateCellCoverage(3000);
      expect(result.label).toContain('Likely');
      expect(result.level).toBe('green');
    });

    it('sea level -> green', () => {
      const result = estimateCellCoverage(0);
      expect(result.level).toBe('green');
    });
  });

  describe('boundary values', () => {
    it('exactly 6000 -> Marginal (amber) (not > 6000)', () => {
      const result = estimateCellCoverage(6000);
      expect(result.level).toBe('amber');
    });

    it('6001 -> Unlikely (red)', () => {
      const result = estimateCellCoverage(6001);
      expect(result.level).toBe('red');
    });

    it('exactly 4000 -> Likely (green) (not > 4000)', () => {
      const result = estimateCellCoverage(4000);
      expect(result.level).toBe('green');
    });

    it('4001 -> Marginal (amber)', () => {
      const result = estimateCellCoverage(4001);
      expect(result.level).toBe('amber');
    });
  });

  describe('return structure', () => {
    it('returns object with label and level', () => {
      const result = estimateCellCoverage(3000);
      expect(result).toHaveProperty('label');
      expect(result).toHaveProperty('level');
      expect(typeof result.label).toBe('string');
      expect(typeof result.level).toBe('string');
    });

    it('level is one of red, amber, green', () => {
      expect(['red', 'amber', 'green']).toContain(estimateCellCoverage(0).level);
      expect(['red', 'amber', 'green']).toContain(estimateCellCoverage(5000).level);
      expect(['red', 'amber', 'green']).toContain(estimateCellCoverage(8000).level);
    });
  });
});
