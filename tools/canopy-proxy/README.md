# Canopy CORS proxy (Cloudflare Worker)

The SAR Preflight app's **vegetation height overlay** and **viewshed** features read
Meta/WRI Global Canopy Height 1 m tiles. Those tiles live in a public AWS S3 bucket
(`dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float`) that
serves HTTP Range requests but **sends no CORS headers**, so a browser cannot read
them directly. This tiny Worker re-serves that path with CORS + Range so the app's
in-browser GeoTIFF reader can fetch COG windows. It is locked to the Meta prefix and
is not a general open proxy.

> The app works without this proxy — the DEM/terrain side of the viewshed uses
> USGS 3DEP (already CORS-enabled). The canopy overlay and the vegetation-aware
> viewshed simply stay dormant (with a hint) until a proxy URL is configured.

## Deploy

```bash
npm i -g wrangler          # one-time
wrangler login             # one-time, opens a browser
cd tools/canopy-proxy
wrangler deploy
```

`wrangler deploy` prints a URL like:

```
https://sar-canopy-proxy.<your-subdomain>.workers.dev
```

Paste that URL into the app: **Config tab → "Canopy proxy URL"**. The app stores it
in `localStorage` and appends `/chm/{quadkey}.tif` to fetch tiles.

## Offline

Once you load an area while online, the app caches the processed canopy raster for
that view in IndexedDB, so the overlay and viewshed for previously-viewed areas keep
working in the field with no network (and no proxy) available.

## Preventing abuse

Three things keep the proxy from being misused:

1. **No surprise bill.** On the Workers **free plan** there is no usage-based billing.
   If the ~100,000 requests/day limit is ever hit, the Worker just returns errors
   until the next UTC day — it cannot cost you money. (Real SAR usage is a few
   hundred requests/day, nowhere near the limit.)
2. **Not an open proxy.** The Worker only ever forwards the Meta canopy prefix
   (`forests/v1/alsgedi_global_v6_float/…`) and rejects `..`, so the worst anyone
   could do is fetch the same public canopy tiles — it can't be repurposed to
   proxy arbitrary URLs.
3. **Origin allowlist.** `worker.js` rejects (HTTP 403) any request whose
   `Origin`/`Referer` isn't in `ALLOWED_ORIGINS`, so other websites can't hot-link
   it from a browser. **Edit `ALLOWED_ORIGINS`** to match where you host the app
   (your GitHub Pages origin is preconfigured; add/remove your local dev origin as
   needed) and redeploy. Note: a CORS `Access-Control-Allow-Origin` header alone
   does **not** block abuse — it only controls which browsers may *read* the
   response — which is why the Worker actively rejects disallowed origins instead.

For extra protection you can optionally add a **Rate limiting rule** in the
Cloudflare dashboard (Security → WAF → Rate limiting rules) to cap requests per IP.
For a SAR tool the allowlist + free-plan limits are normally enough.
