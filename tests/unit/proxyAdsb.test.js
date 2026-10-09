// Data-proxy /adsb route: first provider that answers wins; when all fail the
// 502 says WHY per provider (it used to say only "all ADS-B providers failed").
import { handleAdsb, _adsbCooldownUntil } from '../../tools/canopy-proxy/worker.js';

const url = () => new URL('https://proxy.example/adsb?lat=38.69&lon=-121.59&dist=25');
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const ENV = { FlyItaly: 'test-key' };

let calls;
function mockFetch(handlers) {
  calls = [];
  globalThis.fetch = (u, opts) => {
    calls.push({ u, opts });
    for (const [needle, h] of Object.entries(handlers)) if (u.includes(needle)) return h();
    return Promise.reject(new Error('unexpected ' + u));
  };
}

beforeEach(() => { for (const k of Object.keys(_adsbCooldownUntil)) delete _adsbCooldownUntil[k]; });

describe('handleAdsb', () => {
  it('asks FlyItalyADSB first, with its key and the radius in KILOMETRES', async () => {
    mockFetch({ flyitalyadsb: () => Promise.resolve(json({ ac: [{ hex: 'abc' }] })) });
    const res = await handleAdsb(url(), '*', ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Adsb-Source')).toBe('flyitalyadsb');
    expect(calls).toHaveLength(1);
    expect(calls[0].u).toBe('https://api.flyitalyadsb.com/v2/lat/38.69/lon/-121.59/dist/47'); // 25 nm → 46.3 km, rounded up
    expect(calls[0].opts.headers['X-Api-Key']).toBe('test-key');
  });

  it('skips FlyItalyADSB when no key is configured, and never sends a key to other providers', async () => {
    mockFetch({ 'adsb.fi': () => Promise.resolve(json({ ac: [] })) });
    const res = await handleAdsb(url(), '*', {});
    expect(res.headers.get('X-Adsb-Source')).toBe('adsb.fi');
    expect(calls.some(c => c.u.includes('flyitalyadsb'))).toBe(false);
    expect(calls.every(c => !('X-Api-Key' in c.opts.headers))).toBe(true);
  });

  it('no longer asks airplanes.live (it 403s every unregistered client)', async () => {
    mockFetch({ 'adsb.fi': () => Promise.resolve(json({ aircraft: [] })) });
    await handleAdsb(url(), '*', {});
    expect(calls.some(c => c.u.includes('airplanes.live'))).toBe(false);
  });

  it('sends a User-Agent carrying contact info (adsb.lol rejects generic agents)', async () => {
    mockFetch({ 'adsb.fi': () => Promise.resolve(json({}, 503)), 'adsb.lol': () => Promise.resolve(json({ ac: [] })) });
    const res = await handleAdsb(url(), '*', {});
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Adsb-Source')).toBe('adsb.lol');
    for (const c of calls) expect(c.opts.headers['User-Agent']).toMatch(/https:\/\/github\.com\//);
  });

  it('a 200 without an aircraft list is a failure, never "no traffic"', async () => {
    mockFetch({ flyitalyadsb: () => Promise.resolve(json({ message: 'invalid key' })),
                'adsb.fi': () => Promise.resolve(json({ ac: [{ hex: 'x' }] })) });
    const res = await handleAdsb(url(), '*', ENV);
    expect(res.headers.get('X-Adsb-Source')).toBe('adsb.fi');
  });

  it('a provider that refuses (403/429) is paused instead of asked on every poll', async () => {
    // FlyItaly fails so adsb.fi is tried, and it refuses.
    mockFetch({ flyitalyadsb: () => Promise.resolve(json({}, 500)),
                'adsb.fi': () => Promise.resolve(new Response('Forbidden', { status: 403 })),
                'adsb.lol': () => Promise.resolve(json({ ac: [] })) });
    await handleAdsb(url(), '*', ENV);
    expect(calls.filter(c => c.u.includes('adsb.fi'))).toHaveLength(1);
    await handleAdsb(url(), '*', ENV);                       // second poll
    expect(calls.filter(c => c.u.includes('adsb.fi'))).toHaveLength(1); // not asked again
  });

  it('reports each provider failure in the 502 body', async () => {
    mockFetch({
      flyitalyadsb: () => Promise.resolve(json({}, 500)),
      'adsb.fi': () => Promise.resolve(new Response('Forbidden', { status: 403 })),
      'adsb.lol': () => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })),
    });
    const res = await handleAdsb(url(), '*', ENV);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ac).toEqual([]);
    expect(body.providers).toEqual([
      { name: 'flyitalyadsb', status: 500, detail: '{}' },
      { name: 'adsb.fi', status: 403, detail: 'Forbidden' },
      { name: 'adsb.lol', status: 0, detail: 'timeout' },
    ]);
  });
});
