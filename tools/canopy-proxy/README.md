# SAR Preflight data proxy (Cloudflare Worker)

A small CORS+Range proxy so the browser-only app can read CORS-blocked sources:

1. **Canopy** — Meta/WRI Global Canopy Height 1 m tiles for the **vegetation overlay**
   and **viewshed** (`dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float`).
   That public S3 bucket serves HTTP Range but **sends no CORS headers**, so the
   in-browser GeoTIFF reader can't fetch COG windows directly. Served at `/chm/{quadkey}.tif`.
2. **Live TFRs** — the FAA TFR GeoServer (`tfr.faa.gov`), also CORS-restricted. Served
   at the `/tfr/...` route with a near-zero cache (TFRs are time-critical).
3. **Live NOTAMs** — the public FAA NOTAM Search backend (`notams.aim.faa.gov`). The
   `/notam?lat=&lng=&radius=` route does the session-cookie + full-form-params +
   pagination dance server-side and returns aggregated JSON. **Unofficial/undocumented
   endpoint — advisory only.**
4. **Live ADS-B traffic** — the public providers (adsb.fi / airplanes.live / adsb.lol)
   increasingly block browser CORS. The `/adsb?lat=&lon=&dist=` route fetches them
   server-side (first success wins), passes the JSON through, and adds CORS (real-time,
   uncached). The served provider is reported in the `X-Adsb-Source` response header.
5. **USFS roads/trails/MVUM** — the USFS EDW ArcGIS server (`apps.fs.usda.gov`) is
   self-hosted and blocks browser CORS. Served at the `/usfs/...` route (cached a day;
   forest roads change slowly). The app appends the full ArcGIS query path after `/usfs/`.
6. **BLM transport + public-land ownership** — the BLM ArcGIS server (`gis.blm.gov`),
   also CORS-restricted, for BLM GTLF roads/trails and the National Surface Management
   Agency (public vs private land) layer. Served at the `/blm/...` route (cached a day).
7. **User feedback** — `POST /feedback` forwards in-app feedback (Config tab →
   Feedback) to a **Discord webhook**, so users can reach the maintainer without any
   email address appearing anywhere. See [Feedback → Discord](#feedback--discord).

It only ever forwards those upstreams (it is not a general open proxy; `..` is
rejected), and it enforces an Origin allowlist (below).

> **The app ships with a built-in default proxy** (the maintainer's Worker,
> `https://sar-canopy-proxy.joja15.workers.dev`), so end users don't need to deploy
> anything — everything below is only for **self-hosting your own** proxy (e.g. for
> a fork hosted on a different origin, or to be independent of the shared one).
> Entering a URL in Config tab → "Data proxy URL" overrides the default; clearing
> it returns to the default.

## Deploy (self-hosting only)

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

Paste that URL into the app: **Config tab → "Data proxy URL"**. The app stores it
in `localStorage` and appends `/chm/{quadkey}.tif` to fetch tiles.

## Feedback → Discord

The `/feedback` route accepts `POST` JSON (`{ message, contact?, version?, ua? }`)
from the app's Config tab → Feedback panel and posts it as an embed to a Discord
webhook. Setup (one-time):

1. In your Discord server: channel → ⚙ Edit Channel → **Integrations → Webhooks →
   New Webhook** → Copy Webhook URL.
2. Store it as a Worker **secret** (never commit it — this repo is public):

   ```bash
   cd tools/canopy-proxy
   wrangler secret put DISCORD_WEBHOOK_URL     # paste the URL when prompted
   ```

   Or in the dashboard: Worker → Settings → Variables & Secrets → Add → type
   **Secret**, name `DISCORD_WEBHOOK_URL`.

Until the secret is set, the route answers **503** and the app shows "feedback
unavailable" — nothing else is affected. Spam protection: the Origin allowlist and
global rate limit above apply, plus a tighter `FEEDBACK_LIMITER` (3 messages/min
per IP, `wrangler.toml`), a 4,000-char message cap, and `allowed_mentions: none`
so a message can never ping `@everyone`. Feedback is delivered fire-and-forget;
nothing is stored in the Worker.

## Offline

Once you load an area while online, the app caches the processed canopy raster for
that view in IndexedDB, so the overlay and viewshed for previously-viewed areas keep
working in the field with no network (and no proxy) available.

## Preventing abuse

Four things keep the proxy from being misused (they stack: the Origin allowlist
stops browsers, the per-IP rate limit stops scripts, the free-plan cap stops bills):

1. **No surprise bill.** On the Workers **free plan** there is no usage-based billing.
   If the ~100,000 requests/day limit is ever hit, the Worker just returns errors
   until the next UTC day — it cannot cost you money. (Real SAR usage is a few
   hundred requests/day, nowhere near the limit.)
2. **Not an open proxy.** The Worker only ever forwards a fixed set of upstreams (the
   Meta canopy bucket, the FAA TFR/NOTAM hosts, the ADS-B providers, and the USFS/BLM
   ArcGIS servers) and rejects `..`, so the worst anyone could do is fetch the same
   public data — it can't be repurposed to proxy arbitrary URLs.
3. **Origin allowlist.** `worker.js` rejects (HTTP 403) any request whose
   `Origin`/`Referer` isn't in `ALLOWED_ORIGINS`, so other websites can't hot-link
   it from a browser. **Edit `ALLOWED_ORIGINS`** to match where you host the app
   (your GitHub Pages origin is preconfigured; add/remove your local dev origin as
   needed) and redeploy. Note: a CORS `Access-Control-Allow-Origin` header alone
   does **not** block abuse — it only controls which browsers may *read* the
   response — which is why the Worker actively rejects disallowed origins instead.
4. **Per-IP rate limit.** The Origin check only binds real browsers — a script
   (curl) can spoof an allowed `Origin` header. The `RATE_LIMITER` binding in
   `wrangler.toml` (Cloudflare's Workers rate-limiting binding) caps each IP at
   300 requests/min; excess requests get **429** with a `Retry-After: 60` header,
   and the app surfaces this in its status bar. Note: dashboard **WAF rate-limiting
   rules do not apply to `*.workers.dev`** (they need a custom domain in your zone),
   which is why the limit lives in the Worker. The code guards on the binding, so
   removing the `[[ratelimits]]` block just disables it. **Rate-limit bindings are
   wrangler-only** — the dashboard has no UI for them, so a Worker that has only
   ever been paste-deployed in the dashboard editor runs without them (everything
   still works; the limits are simply inactive). A single `wrangler deploy` from
   this folder activates them, and they persist across later dashboard edits.

If you host the shared/default proxy, also consider a Cloudflare **Notification**
(dashboard → Notifications) on Workers usage so a traffic spike emails you before
the daily cap kicks in.
