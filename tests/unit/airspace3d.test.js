const {
  laancCeilingColor, AIRSPACE_CLASS_COLORS, SUA_COLORS, LAANC_COLORS,
} = require('../../sar-preflight-core.js');

// The 3D airspace volume pipeline (rings/posts at altitude) was removed after
// field feedback — airspace drapes flat in 3D like every other vector layer.
// The shared palettes + LAANC ceiling banding remain, used by the 2D layers.

describe('airspace palettes', () => {
  it('class colors cover B/C/D/E', () => {
    ['B', 'C', 'D', 'E'].forEach(c => expect(AIRSPACE_CLASS_COLORS[c]).toMatch(/^#/));
  });

  it('SUA colors cover MOA/Restricted/Prohibited/Alert/Warning codes', () => {
    ['M', 'R', 'P', 'A', 'W'].forEach(c => expect(SUA_COLORS[c]).toMatch(/^#/));
  });
});

describe('laancCeilingColor(ceil)', () => {
  it('bands match the 2D layer palette', () => {
    expect(laancCeilingColor(0)).toBe(LAANC_COLORS[0]);
    expect(laancCeilingColor(100)).toBe(LAANC_COLORS[100]);
    expect(laancCeilingColor(150)).toBe(LAANC_COLORS[200]);
    expect(laancCeilingColor(300)).toBe(LAANC_COLORS[300]);
    expect(laancCeilingColor(400)).toBe(LAANC_COLORS[400]);
  });

  it('null/negative -> unknown gray', () => {
    expect(laancCeilingColor(null)).toBe('#888888');
    expect(laancCeilingColor(-1)).toBe('#888888');
  });
});
