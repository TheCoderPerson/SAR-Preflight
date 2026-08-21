// ============================================================
// SAR Preflight — data proxy (Cloudflare Worker): canopy + live TFR
//
// A small CORS+Range proxy so the browser-only SAR Preflight app can read data
// from upstreams that either block CORS or need server-side fetching:
//   • /chm/{quadkey}.tif , /tiles.geojson  → Meta/WRI 1 m canopy COG tiles
//       (public S3 bucket that serves Range but sends NO CORS headers)
//   • /tfr/...                              → FAA TFR GeoServer (live TFR polygons)
//   • /usfs/...                             → USFS EDW ArcGIS (roads/trails/MVUM)
//   • /blm/...                              → BLM ArcGIS (GTLF transport, surface mgmt agency)
//   • POST /feedback                        → in-app user feedback → Discord webhook
//       (requires the DISCORD_WEBHOOK_URL secret; without it the route answers 503)
//
// Abuse protection (see README):
//   • Only the two upstreams above are reachable (never an open proxy; `..` rejected).
//   • Requests whose Origin/Referer isn't in ALLOWED_ORIGINS get 403, so other
//     sites can't hot-link it and burn your quota.
//   • Per-IP rate limit (RATE_LIMITER binding in wrangler.toml) returns 429 to
//     scripted abuse that spoofs an allowed Origin. Optional — the code guards
//     on the binding existing.
//   • Workers FREE plan has no overage billing — past ~100k req/day it just
//     returns errors until the next UTC day; it cannot cost you money.
//
// Deploy: paste into a Worker at dash.cloudflare.com (Workers & Pages → your
// Worker → Edit code → paste → Deploy), or `wrangler deploy` from this folder.
// Set the Worker URL in the app: Config tab → "Data proxy URL".
// ============================================================

const CANOPY_UPSTREAM = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/';
const CANOPY_CACHE_TTL = 604800; // 7 days — canopy is static

// FAA NOTAM Search public backend (undocumented; advisory). The /notam route does
// the session-cookie + full-form-params + pagination dance the browser can't.
const NOTAM_HOME = 'https://notams.aim.faa.gov/notamSearch/';
const NOTAM_SEARCH = 'https://notams.aim.faa.gov/notamSearch/search';
const UA = 'Mozilla/5.0 (compatible; SAR-Preflight/1.0)';

// Live ADS-B traffic — the public providers increasingly block browser CORS, so
// the /adsb route fetches them server-side (first success wins) and adds CORS.
const ADSB_UPSTREAMS = [
  { name: 'adsb.fi',        url: (lat, lon, dist) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}` },
  { name: 'airplanes.live', url: (lat, lon, dist) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${dist}` },
  { name: 'adsb.lol',       url: (lat, lon, dist) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}` },
];

// Path-prefix routes (checked before the canopy default). TFR is safety-critical
// and time-sensitive, so it is cached for only a few seconds.
const ROUTES = [
  { prefix: '/tfr/', upstream: 'https://tfr.faa.gov/', cacheTtl: 30 },
  // Self-hosted gov ArcGIS servers that block browser CORS. Static-ish vector data
  // (forest roads/trails/MVUM, BLM transport + surface-management-agency polygons),
  // so cache for a day. Closed-proxy model is preserved: fixed upstream, `..` rejected.
  { prefix: '/usfs/', upstream: 'https://apps.fs.usda.gov/', cacheTtl: 86400 },
  { prefix: '/blm/',  upstream: 'https://gis.blm.gov/',      cacheTtl: 86400 },
];

// Only these origins may use the proxy. Add your production origin here if it
// differs. Any localhost / 127.0.0.1 port is auto-allowed for local dev (see
// isAllowedOrigin below), so you don't need to list local test ports.
// NOTE: the offline single-file (opened via file://) sends no Origin and relies
// on the IndexedDB cache, so it does not need to be listed.
const ALLOWED_ORIGINS = new Set([
  'https://thecoderperson.github.io',    // GitHub Pages deployment (production)
  'https://sar-preflight-dev.pages.dev', // Cloudflare Pages (dev branch)
  'http://localhost:8000',               // (any localhost port is allowed anyway)
  'http://127.0.0.1:8000',
]);

// Cloudflare Pages serves the dev project at a stable URL plus a per-commit
// preview subdomain (https://<hash>.sar-preflight-dev.pages.dev) — allow both.
// NOTE: if your Pages project name differs, change the host string below.
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    // Local development on ANY port. A remote site cannot forge Origin: localhost
    // (the browser always sets Origin to the real page origin), so this can't be
    // hot-linked from another website — it only allows pages you serve locally.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    const host = url.host;
    if (host === 'sar-preflight-dev.pages.dev' || host.endsWith('.sar-preflight-dev.pages.dev')) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function allowedOriginFor(req) {
  const origin = req.headers.get('Origin');
  if (origin && isAllowedOrigin(origin)) return origin;
  const ref = req.headers.get('Referer');
  if (ref) {
    try { const o = new URL(ref).origin; if (isAllowedOrigin(o)) return o; } catch (_) { /* ignore */ }
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
  async fetch(req, env) {
    const allow = allowedOriginFor(req);

    if (req.method === 'OPTIONS') {
      if (!allow) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(allow) });
    }
    // Origin check FIRST: a disallowed origin learns nothing about the method
    // policy, and an allowed one gets a 405 it can actually read (a response
    // without CORS headers surfaces in the browser as a misleading CORS error).
    if (!allow) return new Response('forbidden', { status: 403 });
    const reqUrl = new URL(req.url);
    const isFeedback = reqUrl.pathname === '/feedback' || reqUrl.pathname === '/feedback/';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && isFeedback)) {
      return new Response('method not allowed', { status: 405, headers: corsHeaders(allow) });
    }

    // Per-IP rate limit (guarded: works fine when deployed without the binding).
    if (env && env.RATE_LIMITER) {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') || '' });
        if (!success) {
          return new Response('rate limited', {
            status: 429,
            headers: Object.assign({}, corsHeaders(allow), {
              'Retry-After': '60',
              'Access-Control-Expose-Headers': 'Retry-After',
            }),
          });
        }
      } catch (_) { /* limiter unavailable → fail open */ }
    }

    if (isFeedback) {
      if (req.method !== 'POST') {
        return new Response('POST required', { status: 405, headers: corsHeaders(allow) });
      }
      return handleFeedback(req, env, allow);
    }
    if (reqUrl.pathname === '/notam' || reqUrl.pathname === '/notam/') {
      return handleNotam(reqUrl, allow);
    }
    if (reqUrl.pathname === '/adsb' || reqUrl.pathname === '/adsb/') {
      return handleAdsb(reqUrl, allow);
    }

    const route = resolveTarget(reqUrl);
    if (!route) return new Response('bad path', { status: 400, headers: corsHeaders(allow) });

    // A browser-ish User-Agent: the FAA TFR detail-XML host rejects default
    // bot UAs. Harmless for the S3 canopy bucket.
    const upHeaders = { 'User-Agent': 'Mozilla/5.0 (compatible; SAR-Preflight/1.0)' };
    const range = req.headers.get('Range');
    if (range) upHeaders.Range = range;
    // IMPORTANT: do NOT force-cache Range requests. With cacheEverything, Cloudflare
    // tries to pull the FULL object into cache to satisfy a range — on the 300 MB+
    // canopy COGs that times out and returns 500 on cold fetches. Range reads are
    // proxied uncached (the app caches the processed raster in IndexedDB anyway);
    // only whole-object GETs (tiles.geojson, TFR/XML) use the edge cache.
    //
    // ...and NEVER edge-cache a canopy COG even without a Range header. These
    // objects run 300 MB - 1 GB (023010300.tif is 1.08 GB / 65536^2 px). Caching
    // one poisons the edge with the whole object for CANOPY_CACHE_TTL, after
    // which a later Range request can be answered from that cached full object
    // as a 200 carrying the ENTIRE file instead of the requested bytes. The
    // browser then tries to pull a gigabyte through geotiff.js, the tab stalls,
    // the connection dies, and — because the aborted response has no CORS
    // headers — Chrome reports it as a bogus "blocked by CORS policy" error.
    // Observed live on the dev origin. Nothing is lost by skipping the cache
    // here: the app stores the processed raster in IndexedDB anyway.
    const isCanopyTif = route.target.startsWith(CANOPY_UPSTREAM) && /\.tif$/i.test(reqUrl.pathname);
    const cf = (range || isCanopyTif)
      ? { cacheEverything: false }
      : { cacheEverything: true, cacheTtl: route.cacheTtl };

    // The upstream fetch MUST be guarded. An unhandled rejection here returns
    // Cloudflare's own error page, which carries no Access-Control-Allow-Origin,
    // so every upstream hiccup reaches the operator as a misleading CORS error
    // that the app cannot detect or report. A CORS-bearing 502 lets
    // _proxyFetch/_fetchCanopyFromProxy see the real status and retry or degrade.
    let up;
    try {
      up = await fetch(route.target, { method: req.method, headers: upHeaders, cf });
    } catch (err) {
      return new Response('upstream fetch failed: ' + (err && err.message ? err.message : 'unknown'), {
        status: 502,
        headers: Object.assign({}, corsHeaders(allow), { 'Content-Type': 'text/plain' }),
      });
    }

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
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ---- NOTAMs: drive the FAA NOTAM Search backend (cookie + full params + paging) ----
function dms(v) {
  v = Math.abs(v);
  let d = Math.floor(v);
  let m = Math.floor((v - d) * 60);
  let s = Math.round((v - d - m / 60) * 3600);
  if (s >= 60) { s -= 60; m += 1; }
  if (m >= 60) { m -= 60; d += 1; }
  return { d, m, s };
}

function extractCookies(resp) {
  let arr = [];
  try { if (typeof resp.headers.getSetCookie === 'function') arr = resp.headers.getSetCookie(); } catch (_) { /* ignore */ }
  if (!arr.length) { const sc = resp.headers.get('set-cookie'); if (sc) arr = [sc]; }
  return arr.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
}

function jsonResponse(obj, status, allow) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(allow)),
  });
}

async function handleNotam(url, allow) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lng = parseFloat(url.searchParams.get('lng'));
  let radius = parseInt(url.searchParams.get('radius') || '20', 10);
  if (!isFinite(lat) || !isFinite(lng)) return jsonResponse({ error: 'lat and lng required', notamList: [] }, 400, allow);
  if (!isFinite(radius) || radius < 1) radius = 20;
  if (radius > 100) radius = 100;

  // 1) establish a session cookie (the backend 302s without it)
  let cookie = '';
  try { cookie = extractCookies(await fetch(NOTAM_HOME, { headers: { 'User-Agent': UA } })); } catch (_) { /* try anyway */ }

  const la = dms(lat), lo = dms(lng);
  const fields = (offset) => {
    const p = new URLSearchParams();
    // The backend silently 302s unless the COMPLETE field set is present (even empties).
    p.set('searchType', '3');               // 3 = lat/long + radius
    p.set('designatorsForLocation', '');
    p.set('designatorForAccountable', '');
    p.set('latDegrees', String(la.d)); p.set('latMinutes', String(la.m)); p.set('latSeconds', String(la.s));
    p.set('latitudeDirection', lat >= 0 ? 'N' : 'S');
    p.set('longDegrees', String(lo.d)); p.set('longMinutes', String(lo.m)); p.set('longSeconds', String(lo.s));
    p.set('longitudeDirection', lng >= 0 ? 'E' : 'W');
    p.set('radius', String(radius));        // NM
    p.set('sortColumns', '5 false');
    p.set('sortDirection', 'true');
    p.set('radiusSearchOnDesignator', 'false');
    p.set('radiusSearchDesignator', '');
    p.set('freeFormText', '');
    p.set('offset', String(offset));
    p.set('notamsOnly', 'false');
    p.set('filters', '');
    p.set('minRunwayLength', '');
    p.set('minRunwayWidth', '');
    p.set('runwaySurfaceTypes', '');
    return p.toString();
  };

  let all = [], total = 0, offset = 0, countsByType = null;
  const MAX_PAGES = 6; // backstop: up to ~180 NOTAMs
  for (let page = 0; page < MAX_PAGES; page++) {
    let data;
    try {
      const r = await fetch(NOTAM_SEARCH, {
        method: 'POST',
        redirect: 'manual', // a 3xx = params/cookie rejected → stop
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': UA,
          'Cookie': cookie,
          'Origin': 'https://notams.aim.faa.gov',
          'Referer': NOTAM_HOME,
        },
        body: fields(offset),
      });
      if (r.status !== 200) break;
      data = await r.json();
    } catch (_) { break; }
    if (!data || data.error) break;
    const list = Array.isArray(data.notamList) ? data.notamList : [];
    all = all.concat(list);
    if (!countsByType && data.countsByType) countsByType = data.countsByType;
    total = (data.totalNotamCount != null) ? Number(data.totalNotamCount) : all.length;
    offset += 30;
    if (list.length === 0 || all.length >= total) break;
  }

  return jsonResponse({ notamList: all, totalNotamCount: total, countsByType }, 200, allow);
}

// ---- ADS-B: first provider that responds wins; pass its JSON through ----
async function handleAdsb(url, allow) {
  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');
  let dist = parseInt(url.searchParams.get('dist') || '0', 10);
  if (!isFinite(parseFloat(lat)) || !isFinite(parseFloat(lon)) || !dist) {
    return jsonResponse({ error: 'lat, lon, dist required', ac: [] }, 400, allow);
  }
  if (dist > 250) dist = 250; // provider cap

  for (const up of ADSB_UPSTREAMS) {
    try {
      const r = await fetch(up.url(lat, lon, dist), { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const body = await r.text();
      const h = Object.assign(
        { 'Content-Type': 'application/json', 'X-Adsb-Source': up.name },
        corsHeaders(allow),
      );
      h['Access-Control-Expose-Headers'] = 'X-Adsb-Source'; // let the app read which provider served
      return new Response(body, { status: 200, headers: h }); // real-time data: no edge cache
    } catch (_) { /* try next provider */ }
  }
  return jsonResponse({ error: 'all ADS-B providers failed', ac: [] }, 502, allow);
}

// ---- Feedback: forward in-app feedback to a Discord webhook ----
// The webhook URL is a Worker SECRET (never in this file — the repo is public):
//   wrangler secret put DISCORD_WEBHOOK_URL
// or dashboard → Worker → Settings → Variables & Secrets → Add → Secret.
// Without it the route answers 503 and the app tells the user feedback is
// unavailable. On top of the global RATE_LIMITER, a tighter FEEDBACK_LIMITER
// binding (3/min per IP, wrangler.toml) keeps a script from flooding the
// Discord channel; like every binding here, absent just means disabled.
async function handleFeedback(req, env, allow) {
  const hook = env && env.DISCORD_WEBHOOK_URL;
  if (!hook) return jsonResponse({ ok: false, error: 'feedback not configured' }, 503, allow);

  if (env && env.FEEDBACK_LIMITER) {
    try {
      const { success } = await env.FEEDBACK_LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') || '' });
      if (!success) {
        return new Response(JSON.stringify({ ok: false, error: 'rate limited' }), {
          status: 429,
          headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(allow), {
            'Retry-After': '60',
            'Access-Control-Expose-Headers': 'Retry-After',
          }),
        });
      }
    } catch (_) { /* limiter unavailable → fail open */ }
  }

  let body;
  try {
    const raw = await req.text();
    if (raw.length > 16384) return jsonResponse({ ok: false, error: 'message too large' }, 413, allow);
    body = JSON.parse(raw);
  } catch (_) {
    return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400, allow);
  }

  // Clip every field defensively — Discord hard-limits embed descriptions to
  // 4096 chars and field values to 1024, and rejects the whole message on
  // violation, which would surface to the user as an inexplicable failure.
  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const message = clip(body && body.message, 4000);
  if (!message) return jsonResponse({ ok: false, error: 'message required' }, 400, allow);
  const contact = clip(body && body.contact, 200);
  const version = clip(body && body.version, 40);
  const ua = clip(body && body.ua, 300);

  const fields = [{ name: 'Origin', value: allow, inline: true }];
  if (version) fields.push({ name: 'App version', value: version, inline: true });
  if (contact) fields.push({ name: 'Contact', value: contact, inline: true });
  if (ua) fields.push({ name: 'Browser', value: ua, inline: false });

  const payload = {
    embeds: [{
      title: 'App feedback',
      description: message,
      color: 0x00c8ff,
      fields,
      timestamp: new Date().toISOString(),
    }],
    // User-supplied text must never be able to ping @everyone/roles in the server.
    allowed_mentions: { parse: [] },
  };

  let r;
  try {
    r = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    return jsonResponse({ ok: false, error: 'delivery failed' }, 502, allow);
  }
  if (!r.ok) return jsonResponse({ ok: false, error: 'delivery failed (' + r.status + ')' }, 502, allow);
  return jsonResponse({ ok: true }, 200, allow);
}
