// ============================================================
// SAR Preflight — data proxy (Cloudflare Worker): canopy + live TFR
//
// A small CORS+Range proxy so the browser-only SAR Preflight app can read data
// from upstreams that either block CORS or need server-side fetching:
//   • /chm/{quadkey}.tif , /tiles.geojson  → Meta/WRI 1 m canopy COG tiles
//       (public S3 bucket that serves Range but sends NO CORS headers)
//   • /tfr/...                              → FAA TFR GeoServer (live TFR polygons)
//
// Abuse protection (see README):
//   • Only the two upstreams above are reachable (never an open proxy; `..` rejected).
//   • Requests whose Origin/Referer isn't in ALLOWED_ORIGINS get 403, so other
//     sites can't hot-link it and burn your quota.
//   • Workers FREE plan has no overage billing — past ~100k req/day it just
//     returns errors until the next UTC day; it cannot cost you money.
//
// Deploy: paste into a Worker at dash.cloudflare.com (Workers & Pages → your
// Worker → Edit code → paste → Deploy), or `wrangler deploy` from this folder.
// Set the Worker URL in the app: Config tab → "Data proxy URL".
// ============================================================

const CANOPY_UPSTREAM = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/';
const CANOPY_CACHE_TTL = 604800; // 7 days — canopy is static

// Path-prefix routes (checked before the canopy default). TFR is safety-critical
// and time-sensitive, so it is cached for only a few seconds.
const ROUTES = [
  { prefix: '/tfr/', upstream: 'https://tfr.faa.gov/', cacheTtl: 30 },
];

// Only these origins may use the proxy. Add your dev origin while testing.
// NOTE: the offline single-file (opened via file://) sends no Origin and relies
// on the IndexedDB cache, so it does not need to be listed.
const ALLOWED_ORIGINS = new Set([
  'https://thecoderperson.github.io', // GitHub Pages deployment
  'http://localhost:8000',            // local testing (python -m http.server 8000)
  'http://127.0.0.1:8000',
]);

function allowedOriginFor(req) {
  const origin = req.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  const ref = req.headers.get('Referer');
  if (ref) {
    try { const o = new URL(ref).origin; if (ALLOWED_ORIGINS.has(o)) return o; } catch (_) { /* ignore */ }
  }
  return null;
}

// Map an incoming request path to its upstream URL + cache TTL (or null if invalid).
function resolveTarget(url) {
  for (const r of ROUTES) {
    if (url.pathname.startsWith(r.prefix)) {
      const rest = url.pathname.slice(r.prefix.length);
      if (!rest || rest.includes('..')) return null;
      return { target: r.upstream + rest + url.search, cacheTtl: r.cacheTtl };
    }
  }
  const rel = url.pathname.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  return { target: CANOPY_UPSTREAM + rel, cacheTtl: CANOPY_CACHE_TTL };
}

export default {
  async fetch(req) {
    const allow = allowedOriginFor(req);

    if (req.method === 'OPTIONS') {
      if (!allow) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(allow) });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }
    if (!allow) return new Response('forbidden', { status: 403 });

    const route = resolveTarget(new URL(req.url));
    if (!route) return new Response('bad path', { status: 400, headers: corsHeaders(allow) });

    const range = req.headers.get('Range');
    const up = await fetch(route.target, {
      method: req.method,
      headers: range ? { Range: range } : {},
      cf: { cacheEverything: true, cacheTtl: route.cacheTtl },
    });

    const h = new Headers(up.headers);
    h.set('Access-Control-Allow-Origin', allow);
    h.set('Vary', 'Origin');
    h.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
    h.set('Accept-Ranges', 'bytes');
    return new Response(up.body, { status: up.status, headers: h });
  },
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
