// The banner shows no GO / CAUTION / NO-GO verdict. It names what was found,
// lists every item (limits first, then advisories) and leaves the decision to
// the Remote Pilot in Command. `level` remains the internal enum only.
const { assessRisk, assessmentDisplay, assessmentLabelForLog } = require('../../sar-preflight-core.js');

const VERDICT = /\b(GO|NO-GO|CAUTION)\b/;

describe('assessmentDisplay(result)', () => {
  it('nothing found → NOMINAL, green, nominal text', () => {
    const d = assessmentDisplay({ level: 'GO', issues: [], cautions: [] });
    expect(d.label).toBe('NOMINAL');
    expect(d.cls).toBe('go');
    expect(d.text).toBe('All conditions nominal for UAS operations');
    expect(d.limits).toEqual([]);
    expect(d.advisories).toEqual([]);
  });

  it('advisories only → count + ADVISORY/ADVISORIES, amber, items listed', () => {
    const one = assessmentDisplay({ level: 'CAUTION', issues: [], cautions: ['Elevated winds'] });
    expect(one.label).toBe('1 ADVISORY');
    expect(one.cls).toBe('caution');
    expect(one.text).toBe('Elevated winds');
    const two = assessmentDisplay({ level: 'CAUTION', issues: [], cautions: ['Elevated winds', 'High elevation'] });
    expect(two.label).toBe('2 ADVISORIES');
    expect(two.text).toBe('Elevated winds • High elevation');
  });

  it('limits exceeded → count + LIMIT(S) EXCEEDED, red, limits listed', () => {
    const one = assessmentDisplay({ level: 'NO-GO', issues: ['Wind 30/35g exceeds limits'], cautions: [] });
    expect(one.label).toBe('1 LIMIT EXCEEDED');
    expect(one.cls).toBe('nogo');
    expect(one.text).toBe('Wind 30/35g exceeds limits');
    const two = assessmentDisplay({ level: 'NO-GO', issues: ['Wind 30/35g exceeds limits', 'Visibility 0.0 mi'], cautions: [] });
    expect(two.label).toBe('2 LIMITS EXCEEDED');
  });

  it('limits AND advisories are both listed — advisories are not hidden behind a limit', () => {
    const d = assessmentDisplay({ level: 'NO-GO', issues: ['Thunderstorm activity'], cautions: ['Elevated winds', 'Cold — battery impact'] });
    expect(d.label).toBe('1 LIMIT EXCEEDED');
    expect(d.text).toBe('Thunderstorm activity | Advisory: Elevated winds • Cold — battery impact');
    expect(d.limits).toEqual(['Thunderstorm activity']);
    expect(d.advisories).toEqual(['Elevated winds', 'Cold — battery impact']);
  });

  it('never emits a verdict word, whatever the level', () => {
    const cases = [
      assessRisk({ visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 }, { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27),
      assessRisk({ visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 }, { maxWind: 20, maxGust: 22 }, { center: 2000 }, 27),
      assessRisk({ visibility: 0, temperature_2m: 65, precipitation_probability: 0, weather_code: 99 }, { maxWind: 40, maxGust: 50 }, { center: 7000 }, 27),
      { level: 'NO-GO', issues: ['x'], cautions: ['y'] },
    ];
    for (const r of cases) {
      const d = assessmentDisplay(r);
      expect(d.label).not.toMatch(VERDICT);
      expect(d.text).not.toMatch(VERDICT);
    }
  });

  it('tolerates a missing/partial result', () => {
    expect(assessmentDisplay(null).label).toBe('NOMINAL');
    expect(assessmentDisplay({}).label).toBe('NOMINAL');
    expect(assessmentDisplay({ issues: ['a'] }).label).toBe('1 LIMIT EXCEEDED');
  });
});

describe('assessmentLabelForLog(assessment)', () => {
  it('prefers the stored label', () => {
    expect(assessmentLabelForLog({ level: 'NO-GO', label: '2 LIMITS EXCEEDED' })).toBe('2 LIMITS EXCEEDED');
  });

  it('maps legacy verdict-only entries to the new wording', () => {
    expect(assessmentLabelForLog({ level: 'GO' })).toBe('NOMINAL');
    expect(assessmentLabelForLog({ level: 'CAUTION' })).toBe('ADVISORY');
    expect(assessmentLabelForLog({ level: 'NO-GO' })).toBe('LIMIT EXCEEDED');
  });

  it('degrades to -- when nothing is stored', () => {
    expect(assessmentLabelForLog(null)).toBe('--');
    expect(assessmentLabelForLog({})).toBe('--');
  });
});
