// Data-proxy /notam route — a failed or short retrieval is an ERROR response.
//
// The Worker paginates the FAA NOTAM Search backend. It used to `break` out of
// the loop on any failure and still answer HTTP 200 with whatever it had (often
// nothing), which the app treats as a trustworthy "0 NOTAMs" and labels LIVE.
import { handleNotam } from '../../tools/canopy-proxy/worker.js';

const HOME = 'https://notams.aim.faa.gov/notamSearch/';
const SEARCH = 'https://notams.aim.faa.gov/notamSearch/search';
const url = () => new URL('https://proxy.example/notam?lat=38.685&lng=-120.99&radius=25');

const item = (n) => ({ facilityDesignator: 'SAC', notamNumber: '01/' + n, keyword: 'OBST', traditionalMessage: '!SAC OBST ' + n });
const page = (items, total) => new Response(JSON.stringify({ notamList: items, totalNotamCount: total }), { status: 200, headers: { 'Content-Type': 'application/json' } });

// `pages` answers successive POSTs to the search endpoint; the session GET always succeeds.
function mockFetch(pages) {
  let i = 0;
  const posts = [];
  globalThis.fetch = (u, opts) => {
    if (u === HOME) return Promise.resolve(new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } }));
    if (u === SEARCH) {
      posts.push(opts);
      const r = pages[Math.min(i++, pages.length - 1)];
      if (typeof r === 'function') return r();
      return Promise.resolve(r);
    }
    return Promise.reject(new Error('unexpected ' + u));
  };
  return posts;
}

describe('proxy handleNotam', () => {
  let savedFetch;
  beforeEach(() => { savedFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = savedFetch; });

  it('upstream 503 → 502 with an error, never a 200 empty list', async () => {
    mockFetch([new Response('unavailable', { status: 503 })]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('HTTP 503');
    expect(body.notamList).toEqual([]);
    expect(body.partial).toBe(false);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('a 3xx (session/params rejected) is reported as such', async () => {
    mockFetch([new Response('', { status: 302, headers: { Location: HOME } })]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/HTTP 302.*rejected/);
  });

  it('network failure → 502 "unreachable"', async () => {
    mockFetch([() => Promise.reject(new Error('connect ECONNRESET'))]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/unreachable.*ECONNRESET/);
  });

  it('backend error body → 502', async () => {
    mockFetch([new Response(JSON.stringify({ error: 'Search failed' }), { status: 200 })]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Search failed');
  });

  it('a failure on page 2 → 502 flagged partial, with the page-1 items for diagnostics', async () => {
    const first = Array.from({ length: 30 }, (_, k) => item(k));
    mockFetch([page(first, 45), new Response('', { status: 503 })]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.partial).toBe(true);
    expect(body.notamList.length).toBe(30);
    expect(body.totalNotamCount).toBe(45);
  });

  it('a complete search → 200, not truncated', async () => {
    mockFetch([page([item(1), item(2)], 2)]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.notamList.length).toBe(2);
    expect(body.truncated).toBe(false);
  });

  it('a genuinely empty search → 200 with an empty list', async () => {
    mockFetch([page([], 0)]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(200);
    expect((await res.json()).notamList).toEqual([]);
  });

  it('paginates to the total and stops', async () => {
    const p1 = Array.from({ length: 30 }, (_, k) => item(k));
    const p2 = Array.from({ length: 15 }, (_, k) => item(30 + k));
    const posts = mockFetch([page(p1, 45), page(p2, 45), new Response('', { status: 503 })]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(200);
    expect((await res.json()).notamList.length).toBe(45);
    expect(posts.length).toBe(2);
    expect(String(posts[1].body)).toContain('offset=30');
  });

  it('hitting the page backstop before the total is a 200 flagged truncated', async () => {
    const full = Array.from({ length: 30 }, (_, k) => item(k));
    mockFetch([() => Promise.resolve(page(full, 1000))]);   // every page reports 30 of 1000 (fresh Response per call)
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.notamList.length).toBe(180);
  });
});
