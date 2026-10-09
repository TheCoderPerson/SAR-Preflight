const { limitsProfileInfo, DEFAULT_THRESHOLDS, DRONE_PROFILES } = require('../../sar-preflight-core.js');

const KEYS = ['maxWindTol', 'windCaution', 'flightTime', 'tempColdNoGo'];
const m4t = DRONE_PROFILES.find(p => p.name === 'DJI Matrice 4T');

describe('limitsProfileInfo', () => {
  it('names the selected aircraft profile when the fields match it', () => {
    const active = Object.assign({}, DEFAULT_THRESHOLDS, m4t);
    expect(limitsProfileInfo(m4t, DEFAULT_THRESHOLDS, active, KEYS)).toEqual({ name: 'DJI Matrice 4T', isDefault: false, edited: false });
  });

  it('flags a field edited away from the profile', () => {
    const active = Object.assign({}, DEFAULT_THRESHOLDS, m4t, { maxWindTol: 20 });
    expect(limitsProfileInfo(m4t, DEFAULT_THRESHOLDS, active, KEYS).edited).toBe(true);
  });

  it('ignores keys outside the Config fields and missing active values', () => {
    const active = Object.assign({}, DEFAULT_THRESHOLDS, m4t, { kpCaution: 9 });
    delete active.flightTime;
    expect(limitsProfileInfo(m4t, DEFAULT_THRESHOLDS, active, KEYS).edited).toBe(false);
  });

  it('reports Default when no profile is selected', () => {
    const info = limitsProfileInfo(null, DEFAULT_THRESHOLDS, Object.assign({}, DEFAULT_THRESHOLDS), KEYS);
    expect(info).toEqual({ name: 'Default', isDefault: true, edited: false });
    expect(limitsProfileInfo(null, DEFAULT_THRESHOLDS, { maxWindTol: 30 }, KEYS).edited).toBe(true);
  });

  it('a saved custom profile missing a key falls back to the default for the comparison', () => {
    const custom = { name: 'Team M30T', maxWindTol: 25 };
    const active = Object.assign({}, DEFAULT_THRESHOLDS, custom);
    expect(limitsProfileInfo(custom, DEFAULT_THRESHOLDS, active, KEYS)).toEqual({ name: 'Team M30T', isDefault: false, edited: false });
  });
});
