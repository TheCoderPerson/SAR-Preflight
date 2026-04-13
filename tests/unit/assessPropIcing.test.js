const { assessPropIcing } = require('../../sar-preflight-core.js');

describe('assessPropIcing(tempF, dewF)', () => {
  describe('no icing conditions', () => {
    it('warm and dry (75F / 50F) returns None/green', () => {
      const r = assessPropIcing(75, 50);
      expect(r.risk).toBe('None');
      expect(r.level).toBe('green');
      expect(r.severity).toBe('none');
      expect(r.reason).toBeNull();
    });

    it('cold but dry (35F / 20F, 15F spread) returns None', () => {
      const r = assessPropIcing(35, 20);
      expect(r.risk).toBe('None');
      expect(r.severity).toBe('none');
    });

    it('warm and humid (60F / 58F) returns None — temp above threshold', () => {
      const r = assessPropIcing(60, 58);
      expect(r.risk).toBe('None');
      expect(r.severity).toBe('none');
    });

    it('boundary: exactly 41F / 36F (5F spread) returns None — temp check is strict <', () => {
      const r = assessPropIcing(41, 36);
      expect(r.risk).toBe('None');
      expect(r.severity).toBe('none');
    });
  });

  describe('CAUTION — prop icing possible', () => {
    it('40F / 35F (5F spread, inclusive) returns Possible/amber', () => {
      const r = assessPropIcing(40, 35);
      expect(r.risk).toBe('Possible');
      expect(r.level).toBe('amber');
      expect(r.severity).toBe('caution');
      expect(r.reason).toContain('40');
      expect(r.reason).toContain('5');
      expect(r.reason).toContain('spread');
    });

    it('38F / 35F (3F spread) returns Possible/amber', () => {
      const r = assessPropIcing(38, 35);
      expect(r.risk).toBe('Possible');
      expect(r.level).toBe('amber');
      expect(r.severity).toBe('caution');
    });

    it('33F / 28F (5F spread, above freezing) returns Possible not Likely', () => {
      const r = assessPropIcing(33, 28);
      expect(r.risk).toBe('Possible');
      expect(r.severity).toBe('caution');
    });

    it('does NOT trigger CAUTION when spread is 6F (> 5)', () => {
      const r = assessPropIcing(38, 32);
      expect(r.risk).toBe('None');
    });
  });

  describe('NO-GO — freezing + saturated', () => {
    it('30F / 28F (2F spread) returns Likely/red/nogo', () => {
      const r = assessPropIcing(30, 28);
      expect(r.risk).toBe('Likely');
      expect(r.level).toBe('red');
      expect(r.severity).toBe('nogo');
      expect(r.reason).toContain('freezing');
      expect(r.reason).toContain('saturated');
    });

    it('exactly 32F / 27F (5F spread) returns Likely/red/nogo — both thresholds inclusive', () => {
      const r = assessPropIcing(32, 27);
      expect(r.risk).toBe('Likely');
      expect(r.severity).toBe('nogo');
    });

    it('28F / 20F (8F spread, freezing but wider spread) falls back to sub-freezing Possible', () => {
      const r = assessPropIcing(28, 20);
      expect(r.risk).toBe('Possible');
      expect(r.severity).toBe('caution');
      expect(r.reason).toContain('sub-freezing');
    });
  });

  describe('sub-freezing fallback (legacy conservative behavior)', () => {
    it('25F / 0F (25F spread, very dry) still returns Possible — any below freezing', () => {
      const r = assessPropIcing(25, 0);
      expect(r.risk).toBe('Possible');
      expect(r.level).toBe('amber');
      expect(r.severity).toBe('caution');
      expect(r.reason).toContain('sub-freezing');
    });

    it('20F with null dew returns Possible via fallback', () => {
      const r = assessPropIcing(20, null);
      expect(r.risk).toBe('Possible');
      expect(r.severity).toBe('caution');
    });
  });

  describe('null / missing inputs', () => {
    it('null temp returns No data', () => {
      const r = assessPropIcing(null, 30);
      expect(r.risk).toBe('No data');
      expect(r.level).toBe('green');
      expect(r.severity).toBe('none');
    });

    it('undefined temp returns No data', () => {
      const r = assessPropIcing(undefined, undefined);
      expect(r.risk).toBe('No data');
    });

    it('50F with null dew returns None — no rule applies', () => {
      const r = assessPropIcing(50, null);
      expect(r.risk).toBe('None');
      expect(r.severity).toBe('none');
    });

    it('NaN dew with warm temp returns None (NaN treated as missing)', () => {
      const r = assessPropIcing(50, NaN);
      expect(r.risk).toBe('None');
    });

    it('NaN dew with sub-freezing temp falls back to Possible', () => {
      const r = assessPropIcing(20, NaN);
      expect(r.risk).toBe('Possible');
      expect(r.reason).toContain('sub-freezing');
    });
  });

  describe('return object shape', () => {
    it('always has risk, level, severity, reason keys', () => {
      const r = assessPropIcing(50, 45);
      expect(r).toHaveProperty('risk');
      expect(r).toHaveProperty('level');
      expect(r).toHaveProperty('severity');
      expect(r).toHaveProperty('reason');
    });

    it('level is one of green | amber | red', () => {
      const scenarios = [[75, 50], [38, 35], [30, 28], [null, null]];
      scenarios.forEach(([t, d]) => {
        const r = assessPropIcing(t, d);
        expect(['green', 'amber', 'red']).toContain(r.level);
      });
    });

    it('severity is one of none | caution | nogo', () => {
      const scenarios = [[75, 50], [38, 35], [30, 28]];
      scenarios.forEach(([t, d]) => {
        const r = assessPropIcing(t, d);
        expect(['none', 'caution', 'nogo']).toContain(r.severity);
      });
    });
  });
});
