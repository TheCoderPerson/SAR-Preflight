// ============================================================
// SAR Preflight — Service Worker
// Cache management, offline fetch, tile pre-download
// ============================================================

const BUILD_VERSION = '__BUILD_VERSION__';

const CACHE_STATIC = 'sar-static-v2';
const CACHE_CDN    = 'sar-cdn-v1';
const CACHE_TILES  = 'sar-tiles-v1';
const CACHE_API    = 'sar-api-v1';

const CURRENT_CACHES = [CACHE_STATIC, CACHE_CDN, CACHE_TILES, CACHE_API];

// App shell files to pre-cache on install
const APP_SHELL = [
  './',
  './sar-preflight.html',
  './sar-preflight-core.js',
  './sar-preflight.js',
  './sar-preflight-offline.js',
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
];

// --- Install: pre-cache app shell + CDN ---
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_STATIC).then(cache => cache.addAll(APP_SHELL)),
      caches.open(CACHE_CDN).then(cache => cache.addAll(CDN_ASSETS)),
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
    ).then(() => self.clients.claim())
  );
});

// --- Fetch: route by URL pattern ---
self.addEventListener('fetch', event => {
  // Skip non-GET requests (POST to Overpass, Open-Elevation, etc.)
  if (event.request.method !== 'GET') return;

  // Skip navigation requests to avoid redirect issues
  if (event.request.mode === 'navigate') return;

  // Skip chrome-extension and other non-http(s) URLs
  if (!event.request.url.startsWith('http')) return;

  const url = event.request.url;

  // Local chart tiles — always serve from cache only (never fetch from network)
  if (url.includes('local-tiles.sar-preflight/')) {
    event.respondWith(
      caches.match(event.request).then(r => r || new Response('', { status: 404 }))
    );
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
  // Map tiles — cache-first (opportunistic + pre-downloaded)
  if (url.includes('basemaps.cartocdn.com') ||
      url.includes('arcgisonline.com') ||
      url.includes('opentopomap.org') ||
      url.includes('services.arcgisonline.com/ArcGIS/rest/services/Specialty'))             return 'cache-first';

  // CDN assets — cache-first
  if (url.includes('cdnjs.cloudflare.com') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com'))       return 'cache-first';

  // Radar tiles — network-only (time-sensitive)
  if (url.includes('tilecache.rainviewer.com')) return 'network-only';

  // API endpoints — network-first with cache fallback
  if (url.includes('api.open-meteo.com') ||
      url.includes('air-quality-api.open-meteo.com') ||
      url.includes('api.open-elevation.com') ||
      url.includes('api.sunrise-sunset.org') ||
      url.includes('services.swpc.noaa.gov') ||
      url.includes('overpass-api.de') ||
      url.includes('api.weather.gov') ||
      url.includes('api.rainviewer.com'))      return 'network-first';

  // App shell and everything else — cache-first
  return 'cache-first';
}

// --- Cache-first: serve from cache, fallback to network ---
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cacheName = getCacheName(request.url);
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

// --- Network-first: try network, fallback to cache ---
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_API);
      cache.put(request, response.clone());
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
  if (url.includes('basemaps.cartocdn.com') ||
      url.includes('arcgisonline.com') ||
      url.includes('opentopomap.org') ||
      url.includes('services.arcgisonline.com/ArcGIS/rest/services/Specialty'))         return CACHE_TILES;
  if (url.includes('cdnjs.cloudflare.com') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com'))   return CACHE_CDN;
  return CACHE_STATIC;
}

// --- Tile pre-download via postMessage ---
self.addEventListener('message', event => {
  if (event.data?.type === 'DOWNLOAD_TILES') {
    downloadTiles(event.data, event.source || event.ports?.[0]);
  }
  if (event.data?.type === 'CLEAR_TILE_CACHE') {
    caches.delete(CACHE_TILES).then(() => {
      caches.open(CACHE_TILES); // re-create empty
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
  const cache = await caches.open(CACHE_TILES);

  const providerUrls = {
    carto: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    topo: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    sectional: 'https://services.arcgisonline.com/ArcGIS/rest/services/Specialty/World_Navigation_Charts/MapServer/tile/{z}/{y}/{x}',
  };

  const selectedProviders = providers || ['carto'];
  const tiles = [];

  for (const z of zooms) {
    const sw = latlngToTile(bounds.south, bounds.west, z);
    const ne = latlngToTile(bounds.north, bounds.east, z);
    for (let x = sw.x; x <= ne.x; x++) {
      for (let y = ne.y; y <= sw.y; y++) {
        for (const prov of selectedProviders) {
          const template = providerUrls[prov];
          if (!template) continue;
          const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');
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
          if (resp.ok) await cache.put(url, resp);
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
  module.exports = { routeStrategy, latlngToTile, getCacheName, CURRENT_CACHES, APP_SHELL, CDN_ASSETS };
}
