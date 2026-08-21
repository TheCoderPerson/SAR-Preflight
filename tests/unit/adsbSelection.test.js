// Selected-aircraft panel lifecycle: resolveAdsbSelection decides, per render
// pass, whether the panel updates, shows a SIGNAL LOST banner, or closes.
// Time-based (not miss-count) because renderAdsbMap runs more than once per
// 5 s poll (DEM arrival + hi-res AGL refinement re-render mid-cycle).
const { resolveAdsbSelection } = require('../../sar-preflight-core.js');

const MAX = 30000;
const ac = (hex) => ({ hex, lat: 38.7, lon: -120.9, agl: 1200 });

describe('resolveAdsbSelection', () => {
  it('nothing selected → none', () => {
    expect(resolveAdsbSelection(null, [ac('abc123')], null, 1000, MAX)).toEqual({ action: 'none' });
    expect(resolveAdsbSelection('', [], null, 1000, MAX)).toEqual({ action: 'none' });
  });

  it('selected hex present → update with that aircraft', () => {
    const target = ac('abc123');
    const res = resolveAdsbSelection('abc123', [ac('other1'), target], null, 1000, MAX);
    expect(res.action).toBe('update');
    expect(res.ac).toBe(target);
  });

  it('hex present even after a lost stretch → update (recovery)', () => {
    const target = ac('abc123');
    const res = resolveAdsbSelection('abc123', [target], 1000, 25000, MAX);
    expect(res.action).toBe('update');
    expect(res.ac).toBe(target);
  });

  it('first miss (no lostAt yet) → lost with 0 seconds', () => {
    expect(resolveAdsbSelection('abc123', [ac('other1')], null, 99000, MAX))
      .toEqual({ action: 'lost', lostSecs: 0 });
    expect(resolveAdsbSelection('abc123', [], null, 99000, MAX))
      .toEqual({ action: 'lost', lostSecs: 0 });
  });

  it('missing under the threshold → lost with elapsed seconds', () => {
    expect(resolveAdsbSelection('abc123', [], 10000, 22000, MAX))
      .toEqual({ action: 'lost', lostSecs: 12 });
  });

  it('missing at/over the threshold → close', () => {
    expect(resolveAdsbSelection('abc123', [], 10000, 10000 + MAX, MAX)).toEqual({ action: 'close' });
    expect(resolveAdsbSelection('abc123', [], 10000, 10000 + MAX + 5000, MAX)).toEqual({ action: 'close' });
  });
});
