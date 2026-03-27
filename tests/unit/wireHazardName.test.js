const { wireHazardName } = require('../../sar-preflight-core.js');

describe('wireHazardName(tags, cat)', () => {
  describe('power_line', () => {
    it('with voltage 115000 -> "115kV"', () => {
      const result = wireHazardName({ voltage: '115000' }, 'power_line');
      expect(result).toBe('115kV');
    });

    it('with voltage 230000 -> "230kV"', () => {
      const result = wireHazardName({ voltage: '230000' }, 'power_line');
      expect(result).toBe('230kV');
    });

    it('with operator -> includes operator', () => {
      const result = wireHazardName({ operator: 'PG&E' }, 'power_line');
      expect(result).toContain('PG&E');
    });

    it('with ref -> includes "Ref: {ref}"', () => {
      const result = wireHazardName({ ref: 'Line-42' }, 'power_line');
      expect(result).toContain('Ref: Line-42');
    });

    it('with voltage and operator -> joined by em dash', () => {
      const result = wireHazardName({ voltage: '115000', operator: 'PG&E' }, 'power_line');
      expect(result).toBe('115kV — PG&E');
    });

    it('with voltage, operator, and ref -> all joined by em dash', () => {
      const result = wireHazardName({ voltage: '115000', operator: 'PG&E', ref: 'X-1' }, 'power_line');
      expect(result).toBe('115kV — PG&E — Ref: X-1');
    });

    it('empty tags -> "Transmission Line"', () => {
      const result = wireHazardName({}, 'power_line');
      expect(result).toBe('Transmission Line');
    });
  });

  describe('power_minor_line', () => {
    it('with voltage -> adds "V" suffix', () => {
      const result = wireHazardName({ voltage: '240' }, 'power_minor_line');
      expect(result).toBe('240V');
    });

    it('with operator -> includes operator', () => {
      const result = wireHazardName({ operator: 'SMUD' }, 'power_minor_line');
      expect(result).toBe('SMUD');
    });

    it('with voltage and operator -> joined by em dash', () => {
      const result = wireHazardName({ voltage: '240', operator: 'SMUD' }, 'power_minor_line');
      expect(result).toBe('240V — SMUD');
    });

    it('empty tags -> "Distribution Line"', () => {
      const result = wireHazardName({}, 'power_minor_line');
      expect(result).toBe('Distribution Line');
    });
  });

  describe('power_cable', () => {
    it('with location -> includes location', () => {
      const result = wireHazardName({ location: 'underground' }, 'power_cable');
      expect(result).toBe('Power Cable (underground)');
    });

    it('empty tags -> defaults to "overhead"', () => {
      const result = wireHazardName({}, 'power_cable');
      expect(result).toBe('Power Cable (overhead)');
    });

    it('with location "indoor"', () => {
      const result = wireHazardName({ location: 'indoor' }, 'power_cable');
      expect(result).toBe('Power Cable (indoor)');
    });
  });

  describe('telecom_line', () => {
    it('with operator -> includes operator', () => {
      const result = wireHazardName({ operator: 'AT&T' }, 'telecom_line');
      expect(result).toContain('AT&T');
    });

    it('with telecom:medium -> includes medium', () => {
      const result = wireHazardName({ 'telecom:medium': 'fibre' }, 'telecom_line');
      expect(result).toContain('fibre');
    });

    it('with operator and medium -> joined by em dash', () => {
      const result = wireHazardName({ operator: 'AT&T', 'telecom:medium': 'fibre' }, 'telecom_line');
      expect(result).toBe('AT&T — fibre');
    });

    it('empty tags -> "Telecom Line"', () => {
      const result = wireHazardName({}, 'telecom_line');
      expect(result).toBe('Telecom Line');
    });
  });

  describe('aerialway', () => {
    it('with name and aerialway type -> "name (type)"', () => {
      const result = wireHazardName({ name: 'Eagle Lift', aerialway: 'chair_lift' }, 'aerialway');
      expect(result).toBe('Eagle Lift (chair lift)');
    });

    it('with aerialway type only -> type with underscores replaced', () => {
      const result = wireHazardName({ aerialway: 'gondola' }, 'aerialway');
      expect(result).toBe('gondola');
    });

    it('with aerialway type containing underscores', () => {
      const result = wireHazardName({ aerialway: 'drag_lift' }, 'aerialway');
      expect(result).toBe('drag lift');
    });

    it('with name only -> "name ()"', () => {
      const result = wireHazardName({ name: 'Summit Express' }, 'aerialway');
      expect(result).toBe('Summit Express ()');
    });

    it('empty tags -> "Aerialway"', () => {
      const result = wireHazardName({}, 'aerialway');
      expect(result).toBe('Aerialway');
    });
  });

  describe('unknown category', () => {
    it('returns empty string for unknown category', () => {
      const result = wireHazardName({ name: 'test' }, 'unknown_cat');
      expect(result).toBe('');
    });

    it('returns empty string for undefined category', () => {
      const result = wireHazardName({}, 'something_else');
      expect(result).toBe('');
    });
  });
});
