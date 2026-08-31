// ============================================================
// SAR Preflight — Service Worker
// Cache management, offline fetch, tile pre-download
// ============================================================

// Import version constant — changes to version.js are part of the SW
// update-check byte comparison, so bumping SAR_VERSION automatically causes
// browsers to detect a new SW and run install/activate again.
if (typeof importScripts === 'function') {
  importScripts('./version.js');
} else if (typeof require !== 'undefined') {
  // Node/Vitest test environment: require the module and expose as a global
  globalThis.SAR_VERSION = require('./version.js').SAR_VERSION;
}

const CACHE_STATIC    = 'sar-static-' + SAR_VERSION;
const CACHE_CDN       = 'sar-cdn-v1';
const CACHE_TILES     = 'sar-tiles-v1';
const CACHE_API       = 'sar-api-v1';
const CACHE_SECTIONAL = 'sar-sectional-v1'; // FAA VFR sectional tiles (edition-tagged)

const CURRENT_CACHES = [CACHE_STATIC, CACHE_CDN, CACHE_TILES, CACHE_API, CACHE_SECTIONAL];

// App shell files to pre-cache on install
const APP_SHELL = [
  './',
  './sar-preflight.html',
  './version.js',
  './sar-preflight-core.js',
  './sar-preflight-raster.js',
  './sar-preflight.js',
  './sar-preflight-offline.js',
  './sar-preflight-charts.js',
  './manifest.json',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
];

// CDN resources to pre-cache
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js',
  'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.12.1/proj4.js',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap',
];

// Re-download the app shell from the origin and commit it to CACHE_STATIC.
// Each fetch carries a unique ?swr= query: a CDN edge (GitHub Pages/Fastly,
// max-age=600) keys its cache on the full URL, so `cache:'reload'` alone —
// which only bypasses the BROWSER HTTP cache — can re-download the OLD bytes
// for up to 10 minutes after a deploy. The version probe (?cb=) always busts
// the edge, so without this the app detects an update it can't actually
// download, and the "Update Available → reload → same version" loop follows.
// Fetch ALL files first, commit under the CLEAN URLs only when every fetch is
// a 200 — a partial commit would leave a mixed old/new shell, which is worse
// than either version. (A fetch made from SW context does not re-enter this
// SW's own fetch handler, so nothing here recurses or pollutes other caches.)
async function refreshAppShell() {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fetched = await Promise.all(APP_SHELL.map(async (u) => {
    const bust = u + (u.includes('?') ? '&' : '?') + 'swr=' + stamp;
    const resp = await fetch(new Request(bust, { cache: 'reload' }));
    if (resp.status !== 200) throw new Error(u + ' HTTP ' + resp.status);
    return [u, resp];
  }));
  const cache = await caches.open(CACHE_STATIC);
  await Promise.all(fetched.map(([u, resp]) => cache.put(new Request(u), resp)));
}

// --- Install: pre-cache app shell + CDN ---
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      refreshAppShell(),
      // CDN assets are version-pinned URLs — immutable, HTTP cache is fine.
      // Best-effort per asset: one CDN hiccup must not reject the whole install
      // (a rejected install means NOTHING gets cached and offline never works).
      caches.open(CACHE_CDN).then(cache =>
        Promise.allSettled(CDN_ASSETS.map(u => cache.add(u).catch(() => {})))),
    ]).then(() => self.skipWaiting())
  );
});

// --- Activate: clean old caches ---
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(name => !CURRENT_CACHES.includes(name))
          .map(name => caches.delete(name))
      )
    ).then(() => purgeCartoTiles())
      .then(() => self.clients.claim())
  );
});

// One-time storage reclaim: the app stopped requesting CARTO basemap tiles
// (CARTO watermarks keyless requests "API KEY REQUIRED", Aug 2026), so any
// cartocdn entries in the tile cache — including large pre-downloaded offline
// regions — are dead weight that CACHE_TILES (not version-keyed) would keep
// forever. Best-effort; never blocks activation.
async function purgeCartoTiles() {
  try {
    const cache = await caches.open(CACHE_TILES);
    const keys = await cache.keys();
    await Promise.allSettled(
      keys.filter(req => req.url.includes('basemaps.cartocdn.com'))
        .map(req => cache.delete(req))
    );
  } catch (_) { /* reclaim only */ }
}

// --- Fetch: route by URL pattern ---
self.addEventListener('fetch', event => {
  // Skip non-GET requests (POST to Overpass, Open-Elevation, etc.)
  if (event.request.method !== 'GET') return;

  // Navigation requests (PWA cold launch / page load) — cache-first so the
  // precached app shell answers even with no connectivity. Without this the
  // start_url navigation falls through to the dead network and iOS Safari
  // shows "not connected to the internet" despite a fully cached shell.
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationStrategy(event.request));
    return;
  }

  // Skip chrome-extension and other non-http(s) URLs
  if (!event.request.url.startsWith('http')) return;

  // Never touch usage-analytics traffic: let the Cloudflare Web Analytics beacon
  // (static.cloudflareinsights.com) and its RUM endpoint go straight to network,
  // uncached — so analytics is never served from cache and never runs offline.
  if (event.request.url.includes('cloudflareinsights.com')) return;

  // Skip byte-range requests (e.g. the canopy COG reads via GeoTIFF.js). They
  // return 206 Partial Content, which the Cache API cannot store — caching one
  // throws "Partial response (206) is unsupported" and the failure can corrupt
  // or drop the range read, producing partial/blank canopy coverage. Let the
  // browser fetch these straight from the network, uncached. (Canopy rasters
  // are cached separately in IndexedDB by the app, so offline still works.)
  if (event.request.headers.has('range')) return;

  const url = event.request.url;

  // Local chart tiles — always serve from cache only (never fetch from network)
  if (url.includes('local-tiles.sar-preflight/')) {
    event.respondWith(
      caches.match(event.request).then(r => r || new Response('', { status: 404 }))
    );
    return;
  }

  // FAA VFR Sectional tiles — cache-first with cross-edition offline fallback
  if (url.includes('/VFR_Sectional/MapServer/tile/')) {
    event.respondWith(sectionalTileStrategy(event.request));
    return;
  }

  const strategy = routeStrategy(url);

  if (strategy === 'cache-first') {
    event.respondWith(cacheFirst(event.request));
  } else if (strategy === 'network-first') {
    event.respondWith(networkFirst(event.request));
  }
  // network-only: don't intercept, let browser handle normally
});

function routeStrategy(url) {
  // FAA VFR Sectional service metadata (edition check) — network-first
  if (url.includes('/VFR_Sectional/MapServer') && !url.includes('/tile/')) return 'network-first';

  // Imagery pixel-sampling retry (canopy VEG classifier) — network-only.
  // This marker is only ever appended after a plain tile fetch came back
  // unreadable, which on a long-lived install means an OPAQUE entry left in
  // CACHE_TILES by a pre-guard version of this SW. Answering it from cache
  // would return that same unreadable response forever. Network-only also
  // keeps the marked URL out of CACHE_TILES so it cannot double tile storage.
  // Must be tested BEFORE the arcgisonline cache-first rule below.
  if (url.includes('sarcors=1')) return 'network-only';

  // Map tiles — cache-first (opportunistic + pre-downloaded)
  if (url.includes('basemaps.cartocdn.com') ||
      url.includes('arcgisonline.com') ||
      url.includes('opentopomap.org') ||
      url.includes('/VFR_Sectional/MapServer/tile/'))             return 'cache-first';

  // CDN assets — cache-first
  if (url.includes('cdnjs.cloudflare.com') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com'))       return 'cache-first';

  // Radar tiles — network-only (time-sensitive)
  if (url.includes('tilecache.rainviewer.com')) return 'network-only';

  // Place/address search — network-only. This layer does its OWN IndexedDB
  // caching, with its own TTL and its own explicit "cached · N ago" status
  // line. Letting the SW cache it too would create a second, invisible cache
  // whose staleness the UI cannot report, so a stale hit would render as if it
  // were live — exactly the failure mode this feature is built to avoid.
  // (Omitting it entirely is worse still: it would fall through to the
  // cache-first default below and pin the first response forever.)
  if (url.includes('nominatim.openstreetmap.org')) return 'network-only';

  // FAA-derived live safety data (+ live traffic) via the data proxy —
  // network-only. The proxy base is user-configurable (localStorage, which SW
  // scope cannot read synchronously), but every proxy — built-in or custom —
  // serves these routes at the SAME pathnames, so match on pathname. Same
  // hazard class as nominatim above: the app keeps its own IndexedDB cache for
  // TFR/NOTAM with an explicit stale/expired UI; a cache-first hit here pins
  // the FIRST response for the life of the deployed version and lets
  // "Re-check now" report week-old airspace as LIVE. /adsb is included because
  // a pinned response freezes live traffic. /chm/ canopy tiles are unaffected
  // (range requests are skipped before routing) and /feedback is POST (never
  // routed here).
  const path = urlPathname(url);
  if (path.startsWith('/tfr/') || path === '/notam' || path === '/adsb') return 'network-only';

  // API endpoints — network-first with cache fallback
  if (url.includes('api.open-meteo.com') ||
      url.includes('air-quality-api.open-meteo.com') ||
      url.includes('api.open-elevation.com') ||
      url.includes('api.sunrise-sunset.org') ||
      url.includes('services.swpc.noaa.gov') ||
      url.includes('overpass-api.de') ||
      url.includes('api.weather.gov') ||
      url.includes('api.rainviewer.com'))      return 'network-first';

  // Deployed-version probes — network-only. They exist to see PAST every
  // cache; letting the cache-first default store them would pollute
  // CACHE_STATIC with one unique-query entry per check that can never be
  // served again. (Plain version.js stays cache-first — required offline.)
  if (url.includes('version.js?cb=') || url.includes('CHANGELOG.md?cb=')) return 'network-only';

  // App shell and everything else — cache-first
  return 'cache-first';
}

function urlPathname(url) {
  try { return new URL(url).pathname; } catch (_) { return ''; }
}

// Whether a cached entry may answer this request.
//
// An OPAQUE cached tile cannot satisfy a CORS request: the browser turns an
// opaque SW response into a network error, and its pixels are unreadable by
// canvas (which is what the canopy VEG classifier needs). Opaque entries can
// only be legacy — this SW has gated on `response.status === 200` (opaque is
// status 0) since before the classifier shipped, and CACHE_TILES was never
// renamed, so an install old enough predates the guard. Bypassing lets the
// cors response overwrite the entry via the normal cache.put below, so the
// cache heals itself as the user pans. A no-cors <img> request is still served
// from the opaque entry, so tile display sees no regression and no extra
// network traffic.
function useCachedResponse(cached, request) {
  if (!cached) return false;
  return !(cached.type === 'opaque' && request && request.mode === 'cors');
}

// --- Cache-first: serve from cache, fallback to network ---
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (useCachedResponse(cached, request)) return cached;
  try {
    const response = await fetch(request);
    // Only cache full 200 responses — never 206 (partial) or other statuses;
    // Cache.put() throws on a 206. Suppress any put rejection so it can't
    // surface as an uncaught error or affect the returned response.
    if (response.status === 200) {
      const cacheName = getCacheName(request.url);
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

// Responding to a navigation with a Response whose redirected flag is set
// throws in Chrome/Safari ("redirect mode is not 'follow'") — rebuild such
// responses so the flag is cleared before they're returned.
function stripRedirect(response) {
  if (!response || !response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// --- Navigations: cache-first, offline fallback to the app shell HTML ---
// Cache-first matches the rest of the shell (JS files are cache-first from the
// version-keyed static cache) so the served HTML always matches the cached JS;
// freshness comes from the SW byte-diff update flow, not from navigations.
async function navigationStrategy(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return stripRedirect(cached);
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const shell = await caches.match('./sar-preflight.html');
    if (shell) return stripRedirect(shell);
    return new Response('Offline — app not cached yet. Connect to the internet and reload once.', { status: 503 });
  }
}

// --- Network-first: try network, fallback to cache ---
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await caches.open(CACHE_API);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', cached: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function getCacheName(url) {
  if (url.includes('/VFR_Sectional/MapServer/tile/')) return CACHE_SECTIONAL;
  if (url.includes('basemaps.cartocdn.com') ||
      url.includes('arcgisonline.com') ||
      url.includes('opentopomap.org'))         return CACHE_TILES;
  if (url.includes('cdnjs.cloudflare.com') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com'))   return CACHE_CDN;
  return CACHE_STATIC;
}

// --- FAA VFR Sectional: cache-first, with offline fallback to any cached
// edition of the same tile (so a 56-day edition rollover doesn't blank the
// chart when offline; the URL's ?ed= query is ignored for the fallback) ---
async function sectionalTileStrategy(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await caches.open(CACHE_SECTIONAL);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const fallback = await caches.match(request, { ignoreSearch: true });
    if (fallback) return fallback;
    return new Response('', { status: 404 });
  }
}

// --- Tile pre-download via postMessage ---
self.addEventListener('message', event => {
  if (event.data?.type === 'DOWNLOAD_TILES') {
    downloadTiles(event.data, event.source || event.ports?.[0]);
  }
  if (event.data?.type === 'REFRESH_SHELL') {
    // Re-pull the app shell from the network into the current static cache.
    // Used by applyUpdate() when a new version is deployed but sw.js itself is
    // byte-identical (so the browser never installs a new SW): refreshing the
    // cache this active SW serves from, then reloading, picks up the new
    // version. (The old approach — unregister + reload — fell back to the
    // browser HTTP cache, which can hold the OLD shell for its full max-age;
    // on GitHub Pages that's 10 min of "Update Available" → reload → same old
    // version → modal loop.)
    const port = event.ports && event.ports[0];
    event.waitUntil(
      refreshAppShell()
        .then(() => { port?.postMessage({ ok: true }); })
        .catch(() => { port?.postMessage({ ok: false }); })
    );
  }
  if (event.data?.type === 'SKIP_WAITING') {
    // Belt-and-braces: install() already calls skipWaiting(), but a worker
    // stuck in `waiting` across a browser restart can lose that flag.
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_TILE_CACHE') {
    Promise.all([caches.delete(CACHE_TILES), caches.delete(CACHE_SECTIONAL)]).then(() => {
      caches.open(CACHE_TILES);     // re-create empty
      caches.open(CACHE_SECTIONAL);
      event.source?.postMessage({ type: 'TILE_CACHE_CLEARED' });
    });
  }
  if (event.data?.type === 'GET_CACHE_SIZE') {
    getCacheSize().then(size => {
      event.source?.postMessage({ type: 'CACHE_SIZE', size });
    });
  }
});

async function downloadTiles(config, client) {
  const { bounds, zooms, providers } = config;

  const providerUrls = {
    // Esri Canvas dark base + labels (CARTO watermarks keyless tiles — Aug 2026).
    basemap: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    basemap_labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    // Legacy alias: an old cached shell can still send 'carto' to this newer SW.
    carto: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    topo: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    sectional: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
    hillshade: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
    streets_roads: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    streets_labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  };
  // Native zoom limits per provider — out-of-range tiles don't exist (skip them).
  // Streets capped at 15: past that the service draws labels only (no road
  // lines), so the app upscales z15 tiles and never requests deeper ones.
  // Esri canvas capped at 16 (its native max in North America).
  const providerZoom = {
    sectional: { min: 8, max: 12 },
    streets_roads: { min: 0, max: 15 }, streets_labels: { min: 0, max: 15 },
    basemap: { min: 0, max: 16 }, basemap_labels: { min: 0, max: 16 }, carto: { min: 0, max: 16 },
  };

  const selectedProviders = providers || ['basemap', 'basemap_labels'];
  const tiles = [];

  for (const z of zooms) {
    const sw = latlngToTile(bounds.south, bounds.west, z);
    const ne = latlngToTile(bounds.north, bounds.east, z);
    for (let x = sw.x; x <= ne.x; x++) {
      for (let y = ne.y; y <= sw.y; y++) {
        for (const prov of selectedProviders) {
          const template = providerUrls[prov];
          if (!template) continue;
          const zr = providerZoom[prov];
          if (zr && (z < zr.min || z > zr.max)) continue;
          let url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');
          if (prov === 'sectional' && config.sectionalEdition) {
            url += '?ed=' + encodeURIComponent(config.sectionalEdition);
          }
          tiles.push(url);
        }
      }
    }
  }

  let done = 0;
  const total = tiles.length;
  const BATCH = 4;

  for (let i = 0; i < total; i += BATCH) {
    const batch = tiles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async url => {
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const cache = await caches.open(getCacheName(url));
            await cache.put(url, resp);
          }
        } catch (e) { /* skip failed tiles */ }
      })
    );
    done += batch.length;
    if (client?.postMessage) {
      client.postMessage({ type: 'TILE_PROGRESS', done, total });
    }
    // Rate limit: 50ms between batches
    await new Promise(r => setTimeout(r, 50));
  }

  if (client?.postMessage) {
    client.postMessage({ type: 'TILE_DOWNLOAD_COMPLETE', total: done });
  }
}

function latlngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

async function getCacheSize() {
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  }
  return { usage: 0, quota: 0 };
}

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    routeStrategy, latlngToTile, getCacheName, refreshAppShell,
    navigationStrategy, stripRedirect, useCachedResponse, cacheFirst,
    CURRENT_CACHES, APP_SHELL, CDN_ASSETS,
    CACHE_STATIC, CACHE_CDN, CACHE_TILES, CACHE_API, CACHE_SECTIONAL,
    SAR_VERSION,
  };
}
