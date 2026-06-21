const { kpAtTime } = require('../../sar-preflight-core.js');

// ============================================================
// kpAtTime(rows, dateMs)
// Nearest-bin Kp lookup from SWPC 3-hourly forecast rows [{t, kp}].
// ============================================================

const H = 3600 * 1000;
const ROWS = [
  { t: 0, kp: 2 },
  { t: 3 * H, kp: 4 },
  { t: 6 * H, kp: 6 },
];

describe('kpAtTime(rows, dateMs)', () => {
  it('returns null for empty / invalid rows', () => {
    expect(kpAtTime([], 0)).toBeNull();
    expect(kpAtTime(null, 0)).toBeNull();
    expect(kpAtTime(undefined, 1000)).toBeNull();
  });

  it('returns the kp of the exact-match row', () => {
    expect(kpAtTime(ROWS, 3 * H)).toBe(4);
  });

  it('returns the nearest row when between bins', () => {
    expect(kpAtTime(ROWS, 1 * H)).toBe(2);   // closer to t=0
    expect(kpAtTime(ROWS, 2 * H)).toBe(4);   // closer to t=3h
    expect(kpAtTime(ROWS, 5 * H)).toBe(6);   // closer to t=6h
  });

  it('clamps before the first / after the last bin', () => {
    expect(kpAtTime(ROWS, -10 * H)).toBe(2);
    expect(kpAtTime(ROWS, 100 * H)).toBe(6);
  });

  it('ignores rows missing t or kp', () => {
    const rows = [{ t: 0, kp: 2 }, { t: null, kp: 9 }, { kp: 8 }, { t: 6 * H, kp: 6 }];
    expect(kpAtTime(rows, 6 * H)).toBe(6);
    expect(kpAtTime(rows, 0)).toBe(2);
  });
});
