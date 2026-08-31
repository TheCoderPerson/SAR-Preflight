// Selected-aircraft panel lifecycle: resolveAdsbSelection decides, per render
// pass, whether the panel updates, shows a SIGNAL LOST banner, or closes.
// Time-based (not miss-count) because renderAdsbMap runs more than once per
// 5 s poll (DEM arrival + hi-res AGL refinement re-render mid-cycle).
const { resolveAdsbSelection, adsbAircraftList, adsbPollDelay } = require('../../sar-preflight-core.js');

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

// Providers disagree on the aircraft-array field name (`ac` vs `aircraft`),
// and the proxy passes either body through untouched.
describe('adsbAircraftList', () => {
  const planes = [{ hex: 'a1b2c3' }];
  it('reads readsb-style `ac`', () => {
    expect(adsbAircraftList({ ac: planes })).toBe(planes);
  });
  it('falls back to adsb.fi-style `aircraft`', () => {
    expect(adsbAircraftList({ aircraft: planes })).toBe(planes);
  });
  it('prefers `ac` when both exist', () => {
    expect(adsbAircraftList({ ac: planes, aircraft: [] })).toBe(planes);
  });
  it('empty/malformed responses → []', () => {
    expect(adsbAircraftList(null)).toEqual([]);
    expect(adsbAircraftList({})).toEqual([]);
    expect(adsbAircraftList({ ac: 'not-an-array' })).toEqual([]);
  });
});

// Backoff after consecutive total failures: one blip retries at the normal
// cadence, sustained outages step 30 s → 60 s and stay there.
describe('adsbPollDelay', () => {
  it('normal cadence while healthy and on a single blip', () => {
    expect(adsbPollDelay(0, 5000)).toBe(5000);
    expect(adsbPollDelay(1, 5000)).toBe(5000);
  });
  it('escalates to 30 s then 60 s and holds', () => {
    expect(adsbPollDelay(2, 5000)).toBe(30000);
    expect(adsbPollDelay(3, 5000)).toBe(60000);
    expect(adsbPollDelay(50, 5000)).toBe(60000);
  });
  it('defaults the base cadence to 5 s', () => {
    expect(adsbPollDelay(0)).toBe(5000);
  });
});
