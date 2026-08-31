const { routeStrategy, latlngToTile, getCacheName, navigationStrategy, stripRedirect, useCachedResponse, cacheFirst, APP_SHELL, CACHE_STATIC, CACHE_CDN, CACHE_TILES, CACHE_SECTIONAL, SAR_VERSION } = require('../../sw.js');

const SECTIONAL_TILE = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/10/396/164?ed=2026-05-13';
const SECTIONAL_META = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer?f=json';

describe('routeStrategy(url)', () => {
  it('routes map tiles to cache-first', () => {
    expect(routeStrategy('https://a.basemaps.cartocdn.com/dark_all/11/335/785.png')).toBe('cache-first');
    expect(routeStrategy('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/11/785/335')).toBe('cache-first');
    expect(routeStrategy('https://a.tile.opentopomap.org/11/335/785.png')).toBe('cache-first');
  });

  it('routes FAA VFR sectional tiles to cache-first', () => {
    expect(routeStrategy(SECTIONAL_TILE)).toBe('cache-first');
  });

  it('routes Esri streets/labels reference tiles to cache-first', () => {
    expect(routeStrategy('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/12/1571/671')).toBe('cache-first');
    expect(routeStrategy('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/12/1571/671')).toBe('cache-first');
  });

  it('routes FAA VFR sectional service metadata to network-first', () => {
    expect(routeStrategy(SECTIONAL_META)).toBe('network-first');
  });

  it('routes CDN assets to cache-first', () => {
    expect(routeStrategy('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js')).toBe('cache-first');
    expect(routeStrategy('https://fonts.googleapis.com/css2?family=JetBrains+Mono')).toBe('cache-first');
    expect(routeStrategy('https://fonts.gstatic.com/s/jetbrainsmono/v1/font.woff2')).toBe('cache-first');
  });

  it('routes radar tiles to network-only', () => {
    expect(routeStrategy('https://tilecache.rainviewer.com/v2/radar/123/256/11/335/785/2/1_1.png')).toBe('network-only');
  });

  // Deliberately network-only, NOT network-first: the search layer keeps its own
  // IndexedDB cache with an explicit "cached · N ago" status line. A second,
  // invisible SW cache would render a stale hit as if it were live. Asserting the
  // exact string makes a later "optimization" to network-first fail loudly.
  it('routes place/address search to network-only, never network-first or cache-first', () => {
    const url = 'https://nominatim.openstreetmap.org/search?q=Jenkinson+Lake&format=jsonv2&limit=10';
    expect(routeStrategy(url)).toBe('network-only');
  });

  // Deliberately network-only, NOT cache-first or network-first: the app keeps
  // its own IndexedDB cache for TFR/NOTAM with an explicit stale/expired UI. A
  // cache-first hit pins the FIRST response for the life of the deployed
  // version and lets "Re-check now" report week-old airspace as LIVE. Matching
  // is by pathname so user-configured custom proxy bases are covered too.
  it('routes data-proxy TFR/NOTAM/ADS-B to network-only, never cache-first or network-first', () => {
    expect(routeStrategy('https://sar-canopy-proxy.joja15.workers.dev/tfr/geoserver/TFR/ows?service=WFS&bbox=1,2,3,4')).toBe('network-only');
    expect(routeStrategy('https://sar-canopy-proxy.joja15.workers.dev/tfr/download/detail_4_3635.xml')).toBe('network-only');
    expect(routeStrategy('https://sar-canopy-proxy.joja15.workers.dev/notam?lat=38.68500&lng=-120.99000&radius=25')).toBe('network-only');
    expect(routeStrategy('https://custom-proxy.example.workers.dev/notam?lat=1&lng=2&radius=20')).toBe('network-only'); // custom base, same route shape
    expect(routeStrategy('https://sar-canopy-proxy.joja15.workers.dev/adsb?lat=38.6850&lon=-120.9900&dist=25')).toBe('network-only');
  });

  it('leaves proxy canopy tiles on the cache-first default (range reads skip routing anyway)', () => {
    expect(routeStrategy('https://sar-canopy-proxy.joja15.workers.dev/chm/023010212.tif')).toBe('cache-first');
  });

  it('routes API endpoints to network-first', () => {
    expect(routeStrategy('https://api.open-meteo.com/v1/forecast?lat=38')).toBe('network-first');
    expect(routeStrategy('https://air-quality-api.open-meteo.com/v1/air-quality?lat=38')).toBe('network-first');
    expect(routeStrategy('https://api.open-elevation.com/api/v1/lookup')).toBe('network-first');
    expect(routeStrategy('https://api.sunrise-sunset.org/json?lat=38')).toBe('network-first');
    expect(routeStrategy('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json')).toBe('network-first');
    expect(routeStrategy('https://overpass-api.de/api/interpreter')).toBe('network-first');
    expect(routeStrategy('https://api.weather.gov/alerts/active?point=38,-120')).toBe('network-first');
    expect(routeStrategy('https://api.rainviewer.com/public/weather-maps.json')).toBe('network-first');
  });

  it('routes app shell to cache-first (default)', () => {
    expect(routeStrategy('http://localhost:3000/sar-preflight.html')).toBe('cache-first');
    expect(routeStrategy('http://localhost:3000/sar-preflight.js')).toBe('cache-first');
    expect(routeStrategy('http://localhost:3000/manifest.json')).toBe('cache-first');
  });

  // The ?cb= probes exist to see PAST every cache (they detect newly deployed
  // versions). The cache-first default would put one unique-query entry per
  // check into CACHE_STATIC, forever. Plain version.js must stay cache-first
  // so the shell still loads offline.
  it('routes deployed-version probes to network-only, plain files stay cache-first', () => {
    expect(routeStrategy('http://localhost:3000/version.js?cb=1722600000000')).toBe('network-only');
    expect(routeStrategy('http://localhost:3000/CHANGELOG.md?cb=1722600000000')).toBe('network-only');
    expect(routeStrategy('http://localhost:3000/version.js')).toBe('cache-first');
    expect(routeStrategy('http://localhost:3000/CHANGELOG.md')).toBe('cache-first');
  });
});

describe('APP_SHELL', () => {
  // charts.js was missing from the precache list: shell refreshes never
  // updated it and a fresh install couldn't run offline until the first
  // opportunistic fetch cached it.
  it('includes every locally loaded script', () => {
    expect(APP_SHELL).toContain('./sar-preflight-charts.js');
    expect(APP_SHELL).toContain('./sar-preflight.js');
    expect(APP_SHELL).toContain('./version.js');
  });
});

// The canopy VEG classifier appends this marker only after a plain tile fetch
// came back UNREADABLE — which on a long-lived install means an opaque entry
// left in CACHE_TILES by a pre-guard version of this SW. A cached answer here
// is not merely stale, it is unusable, so this must be network-only and must
// be tested BEFORE the arcgisonline cache-first rule.
describe('imagery pixel-sampling retry', () => {
  const SAMPLE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/1/2?sarcors=1';

  it('routes the cors retry to network-only, never cache-first', () => {
    expect(routeStrategy(SAMPLE)).toBe('network-only');
  });

  it('leaves the plain imagery tile URL on cache-first so it still works offline', () => {
    expect(routeStrategy(SAMPLE.split('?')[0])).toBe('cache-first');
  });
});

describe('useCachedResponse(cached, request)', () => {
  const opaque = { type: 'opaque' };
  const basic = { type: 'basic' };

  it('refuses an opaque cached entry for a cors request', () => {
    expect(useCachedResponse(opaque, { mode: 'cors' })).toBe(false);
  });

  // Tile DISPLAY still uses that entry — bypassing for <img> would mean a
  // second download of every tile the user has already looked at.
  it('still serves an opaque cached entry to a no-cors image request', () => {
    expect(useCachedResponse(opaque, { mode: 'no-cors' })).toBe(true);
  });

  it('serves readable entries to anyone', () => {
    expect(useCachedResponse(basic, { mode: 'cors' })).toBe(true);
    expect(useCachedResponse(basic, { mode: 'no-cors' })).toBe(true);
  });

  it('treats a cache miss as a miss', () => {
    expect(useCachedResponse(null, { mode: 'cors' })).toBe(false);
    expect(useCachedResponse(undefined, { mode: 'cors' })).toBe(false);
  });
});

describe('cacheFirst(request) with legacy opaque tiles', () => {
  const TILE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/1/2';
  let savedCaches, savedFetch;

  function stub(cached) {
    const puts = [];
    globalThis.caches = {
      match: () => Promise.resolve(cached),
      open: () => Promise.resolve({ put: (req, resp) => { puts.push([req, resp]); return Promise.resolve(); } }),
    };
    return puts;
  }

  beforeEach(() => { savedCaches = globalThis.caches; savedFetch = globalThis.fetch; });
  afterEach(() => { globalThis.caches = savedCaches; globalThis.fetch = savedFetch; });

  it('goes to the network for a cors request and overwrites the opaque entry', async () => {
    const puts = stub({ type: 'opaque', status: 0 });
    const fresh = new Response('tile', { status: 200 });
    let fetched = false;
    globalThis.fetch = () => { fetched = true; return Promise.resolve(fresh); };
    const out = await cacheFirst({ url: TILE, mode: 'cors' });
    expect(fetched).toBe(true);
    expect(out).toBe(fresh);
    expect(puts.length).toBe(1);   // the cache heals itself
  });

  it('serves the opaque entry to a no-cors request without hitting the network', async () => {
    const cached = { type: 'opaque', status: 0 };
    stub(cached);
    let fetched = false;
    globalThis.fetch = () => { fetched = true; return Promise.reject(new Error('offline')); };
    const out = await cacheFirst({ url: TILE, mode: 'no-cors' });
    expect(out).toBe(cached);
    expect(fetched).toBe(false);
  });
});

describe('latlngToTile(lat, lng, zoom)', () => {
  it('calculates correct tile for El Dorado County at z=11', () => {
    const tile = latlngToTile(38.685, -120.99, 11);
    expect(tile.x).toBe(335);
    expect(tile.y).toBe(785);
  });

  it('calculates correct tile at z=14', () => {
    const tile = latlngToTile(38.685, -120.99, 14);
    expect(tile.x).toBe(2685);
    expect(tile.y).toBe(6280);
  });

  it('calculates correct tile at equator/prime meridian', () => {
    const tile = latlngToTile(0, 0, 1);
    expect(tile.x).toBe(1);
    expect(tile.y).toBe(1);
  });

  it('handles negative coordinates', () => {
    const tile = latlngToTile(-33.8688, 151.2093, 10);
    expect(tile.x).toBeGreaterThan(0);
    expect(tile.y).toBeGreaterThan(0);
  });

  it('tile count scales with zoom level', () => {
    const t10 = latlngToTile(38.685, -120.99, 10);
    const t11 = latlngToTile(38.685, -120.99, 11);
    // At z+1, x and y are in range [2*prev, 2*prev+1] due to integer flooring
    expect(t11.x).toBeGreaterThanOrEqual(t10.x * 2);
    expect(t11.x).toBeLessThanOrEqual(t10.x * 2 + 1);
    expect(t11.y).toBeGreaterThanOrEqual(t10.y * 2);
    expect(t11.y).toBeLessThanOrEqual(t10.y * 2 + 1);
  });
});

describe('getCacheName(url)', () => {
  it('returns CACHE_TILES for tile URLs', () => {
    expect(getCacheName('https://a.basemaps.cartocdn.com/dark_all/11/335/785.png')).toBe(CACHE_TILES);
    expect(getCacheName('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/12/1571/671')).toBe(CACHE_TILES);
  });

  it('returns CACHE_SECTIONAL for FAA VFR sectional tiles', () => {
    expect(getCacheName(SECTIONAL_TILE)).toBe(CACHE_SECTIONAL);
  });

  it('returns CACHE_CDN for CDN URLs', () => {
    expect(getCacheName('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js')).toBe(CACHE_CDN);
  });

  it('returns CACHE_STATIC for other URLs', () => {
    expect(getCacheName('http://localhost:3000/sar-preflight.html')).toBe(CACHE_STATIC);
  });

  it('CACHE_STATIC is keyed by SAR_VERSION so bumping the version invalidates it', () => {
    expect(CACHE_STATIC).toBe('sar-static-' + SAR_VERSION);
    expect(SAR_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}(-[a-z])?$/);
  });
});

describe('stripRedirect(response)', () => {
  it('passes non-redirected responses through unchanged (same reference)', () => {
    const resp = new Response('ok', { status: 200 });
    expect(stripRedirect(resp)).toBe(resp);
  });

  it('rebuilds redirected responses with the redirected flag cleared', async () => {
    // Response constructor can't set redirected:true, so mimic one
    const fake = { redirected: true, body: 'shell html', status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' } };
    const out = stripRedirect(fake);
    expect(out.redirected).toBe(false);
    expect(out.status).toBe(200);
    expect(await out.text()).toBe('shell html');
  });
});

describe('navigationStrategy(request)', () => {
  const NAV_URL = 'https://example.test/sar-preflight.html';
  let savedCaches, savedFetch;

  // caches stub: matchImpl(key, opts) -> Response | undefined; records cache.put calls
  function stubCaches(matchImpl) {
    const puts = [];
    globalThis.caches = {
      match: (key, opts) => Promise.resolve(matchImpl(key, opts)),
      open: () => Promise.resolve({ put: (req, resp) => { puts.push([req, resp]); return Promise.resolve(); } }),
    };
    return puts;
  }

  beforeEach(() => {
    savedCaches = globalThis.caches;
    savedFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.caches = savedCaches;
    globalThis.fetch = savedFetch;
  });

  it('serves a cached navigation without touching the network', async () => {
    const cached = new Response('cached shell', { status: 200 });
    stubCaches(key => (key === NAV_URL ? cached : undefined));
    let fetched = false;
    globalThis.fetch = () => { fetched = true; return Promise.reject(new Error('offline')); };
    const out = await navigationStrategy(NAV_URL);
    expect(out).toBe(cached);
    expect(fetched).toBe(false);
  });

  it('matches the cache ignoring query strings (e.g. ?homescreen=1 start_url)', async () => {
    const cached = new Response('cached shell', { status: 200 });
    let seenOpts;
    stubCaches((key, opts) => { seenOpts = opts; return key === NAV_URL ? cached : undefined; });
    const out = await navigationStrategy(NAV_URL);
    expect(out).toBe(cached);
    expect(seenOpts).toEqual({ ignoreSearch: true });
  });

  it('on cache miss fetches from network and caches a 200', async () => {
    const puts = stubCaches(() => undefined);
    const net = new Response('fresh shell', { status: 200 });
    globalThis.fetch = () => Promise.resolve(net);
    const out = await navigationStrategy(NAV_URL);
    expect(out).toBe(net);
    expect(puts.length).toBe(1);
    expect(puts[0][0]).toBe(NAV_URL);
  });

  it('does not cache non-200 network responses', async () => {
    const puts = stubCaches(() => undefined);
    globalThis.fetch = () => Promise.resolve(new Response('nope', { status: 404 }));
    const out = await navigationStrategy(NAV_URL);
    expect(out.status).toBe(404);
    expect(puts.length).toBe(0);
  });

  it('offline with no direct match falls back to the cached app shell HTML', async () => {
    const shell = new Response('app shell', { status: 200 });
    stubCaches(key => (key === './sar-preflight.html' ? shell : undefined));
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const out = await navigationStrategy(NAV_URL);
    expect(out).toBe(shell);
  });

  it('offline with nothing cached returns a 503', async () => {
    stubCaches(() => undefined);
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const out = await navigationStrategy(NAV_URL);
    expect(out.status).toBe(503);
  });

  it('rebuilds a redirected cached response so navigations do not throw', async () => {
    const fake = { redirected: true, body: 'redirected shell', status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' } };
    stubCaches(key => (key === NAV_URL ? fake : undefined));
    const out = await navigationStrategy(NAV_URL);
    expect(out.redirected).toBe(false);
    expect(await out.text()).toBe('redirected shell');
  });
});
