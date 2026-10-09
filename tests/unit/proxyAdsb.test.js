// Data-proxy /adsb route: first provider that answers wins; when all fail the
// 502 says WHY per provider (it used to say only "all ADS-B providers failed").
import { handleAdsb } from '../../tools/canopy-proxy/worker.js';

const url = () => new URL('https://proxy.example/adsb?lat=38.69&lon=-121.59&dist=25');
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

let calls;
function mockFetch(handlers) {
  calls = [];
  globalThis.fetch = (u, opts) => {
    calls.push({ u, opts });
    for (const [needle, h] of Object.entries(handlers)) if (u.includes(needle)) return h();
    return Promise.reject(new Error('unexpected ' + u));
  };
}

describe('handleAdsb', () => {
  it('no longer asks airplanes.live (it 403s every unregistered client)', async () => {
    mockFetch({ 'adsb.fi': () => Promise.resolve(json({ aircraft: [] })) });
    await handleAdsb(url(), '*');
    expect(calls.some(c => c.u.includes('airplanes.live'))).toBe(false);
  });

  it('sends a User-Agent carrying contact info (adsb.lol rejects generic agents)', async () => {
    mockFetch({ 'adsb.fi': () => Promise.resolve(json({}, 503)), 'adsb.lol': () => Promise.resolve(json({ ac: [] })) });
    const res = await handleAdsb(url(), '*');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Adsb-Source')).toBe('adsb.lol');
    for (const c of calls) expect(c.opts.headers['User-Agent']).toMatch(/https:\/\/github\.com\//);
  });

  it('reports each provider failure in the 502 body', async () => {
    mockFetch({
      'adsb.fi': () => Promise.resolve(new Response('Forbidden', { status: 403 })),
      'adsb.lol': () => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })),
    });
    const res = await handleAdsb(url(), '*');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ac).toEqual([]);
    expect(body.providers).toEqual([
      { name: 'adsb.fi', status: 403, detail: 'Forbidden' },
      { name: 'adsb.lol', status: 0, detail: 'timeout' },
    ]);
  });
});
