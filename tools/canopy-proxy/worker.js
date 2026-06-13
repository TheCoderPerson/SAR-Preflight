// ============================================================
// SAR Preflight — Canopy CORS+Range proxy (Cloudflare Worker)
//
// The Meta/WRI Global Canopy Height 1 m tiles live in a public AWS S3 bucket
// that serves HTTP Range requests but sends NO CORS headers, so a browser
// (the SAR Preflight app) cannot read them directly. This Worker re-serves the
// Meta path with `Access-Control-Allow-Origin` + Range pass-through so the app's
// GeoTIFF.js reader can fetch COG windows.
//
// Abuse protection (see README): it only proxies the Meta canopy prefix (never an
// open proxy), AND it rejects any request whose Origin/Referer is not in
// ALLOWED_ORIGINS below — so other sites can't hot-link it and burn your quota.
// (On the Workers FREE plan there is no overage billing: past ~100k req/day the
// Worker simply returns errors until the next UTC day — it cannot cost you money.)
//
// Deploy: paste into a Worker at dash.cloudflare.com (Workers & Pages → Create →
// Edit code → paste → Deploy), or `wrangler deploy` from this folder.
// Then set the Worker URL in the app: Config tab → "Canopy proxy URL".
// ============================================================

const UPSTREAM = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/';

// Only these origins may use the proxy. Add your dev origin while testing.
// NOTE: the offline single-file (opened via file://) sends no Origin and relies
// on the IndexedDB cache, so it does not need to be listed.
const ALLOWED_ORIGINS = new Set([
  'https://thecoderperson.github.io', // GitHub Pages deployment
  'http://localhost:8000',            // local testing (python -m http.server 8000)
  'http://127.0.0.1:8000',
]);

// Resolve the allowed origin for this request (Origin header first, Referer host
// as a fallback for browsers that omit Origin on same-page GETs). Returns the
// matched origin string, or null if not allowed.
function allowedOriginFor(req) {
  const origin = req.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  const ref = req.headers.get('Referer');
  if (ref) {
    try { const o = new URL(ref).origin; if (ALLOWED_ORIGINS.has(o)) return o; } catch (_) { /* ignore */ }
  }
  return null;
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

    const rel = new URL(req.url).pathname.replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return new Response('bad path', { status: 400, headers: corsHeaders(allow) });

    const range = req.headers.get('Range');
    const up = await fetch(UPSTREAM + rel, {
      method: req.method,
      headers: range ? { Range: range } : {},
      cf: { cacheEverything: true, cacheTtl: 604800 }, // 7-day edge cache
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
