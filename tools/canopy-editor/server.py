"""Canopy Update Tool — local server.

    python server.py [--port 8765] [--max-aoi-km 12] [--upstream-proxy URL]

Serves the editing UI at http://127.0.0.1:PORT/ and, after a per-quadkey
export, doubles as a canopy tile source for the SAR-Preflight PWA: point the
app's Config -> "Data proxy URL" at this server and its existing canopy
fetcher (GET {base}/chm/{quadkey}.tif) receives patched tiles where you
edited and pass-through Meta S3 data everywhere else.

--upstream-proxy forwards the PWA's non-canopy proxy routes (/tfr, /notam,
/adsb, /usfs/, /blm/) to your deployed Cloudflare worker so those keep
working while this server is the proxy base.
"""

import argparse
import os
import urllib.request
from datetime import date, timedelta

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import canopy
import edits
import export
import quadkeys as qk
import sentinel
import shadow

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="SAR-Preflight Canopy Update Tool")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)

CFG = {"max_aoi_km": canopy.MAX_AOI_KM, "upstream_proxy": None}

# The PWA shares one proxy base for several worker routes; pass those through
# to the user's Cloudflare worker when configured (see tools/canopy-proxy/).
PASSTHROUGH_PREFIXES = ("/tfr", "/notam", "/adsb", "/usfs", "/blm")


@app.exception_handler(canopy.AoiError)
async def _aoi_error(request, exc):
    return JSONResponse(status_code=400, content={"error": str(exc)})


@app.get("/")
async def index():
    return FileResponse(os.path.join(TOOL_DIR, "static", "index.html"))


# --- AOI / canopy -------------------------------------------------------------

@app.post("/api/aoi")
def api_aoi(payload: dict = Body(...)):
    bbox = payload.get("bbox")
    if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
        raise HTTPException(400, "expected {\"bbox\": [west, south, east, north]}")
    meta = canopy.build_aoi(bbox, max_aoi_km=CFG["max_aoi_km"])
    ops = edits.load_ops(meta["aoi_id"])["ops"]
    resp = {k: meta[k] for k in
            ("aoi_id", "bounds", "width", "height", "res_m",
             "quadkeys", "tiles_loaded", "tiles_failed")}
    resp["ops"] = ops
    if meta["tiles_failed"]:
        resp["warnings"] = [
            f"{len(meta['tiles_failed'])} of {len(meta['quadkeys'])} canopy tiles "
            "failed to load (transient S3 errors are common — redraw the AOI to retry)"
        ]
    return resp


@app.get("/api/canopy.png")
def api_canopy_png(aoi_id: str, edited: int = 0, max_px: int = 2048):
    path = edits.current_tif(aoi_id) if edited else canopy.orig_tif(aoi_id)
    if not os.path.exists(path):
        raise HTTPException(404, "no canopy raster for this AOI")
    png = canopy.render_png(path, max_px=max_px)
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


# --- Sentinel-2 ----------------------------------------------------------------

@app.get("/api/s2/scenes")
def api_s2_scenes(aoi_id: str, start: str = "", end: str = "",
                  max_cloud: float = 30.0):
    meta = canopy.load_aoi(aoi_id)
    if not end:
        end = date.today().isoformat()
    if not start:
        start = (date.today() - timedelta(days=90)).isoformat()
    try:
        scenes = sentinel.search_scenes(meta["bbox"], start, end, max_cloud)
    except Exception as e:
        raise HTTPException(502, f"Earth Search STAC query failed: {e}")
    return {"scenes": scenes, "start": start, "end": end}


@app.get("/api/s2/preview.png")
def api_s2_preview(aoi_id: str, item: str):
    try:
        png = sentinel.preview_png(aoi_id, item)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return Response(png, media_type="image/png")


@app.get("/api/s2/ndvi.png")
def api_s2_ndvi(aoi_id: str, item: str, threshold: float = 0.4):
    try:
        png = sentinel.ndvi_png(aoi_id, item, threshold)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


# --- Edits ----------------------------------------------------------------------

@app.get("/api/edits")
def api_edits_list(aoi_id: str):
    return edits.load_ops(aoi_id)


@app.post("/api/edits")
def api_edits_add(payload: dict = Body(...)):
    aoi_id = payload.get("aoi_id")
    op_type = payload.get("type")
    geometry = payload.get("geometry")
    params = payload.get("params") or {}
    if not aoi_id or not geometry or op_type not in edits.OP_TYPES:
        raise HTTPException(400, f"need aoi_id, geometry, type in {edits.OP_TYPES}")
    if op_type == "set_height":
        h = params.get("height_m")
        if h is None or not (0 <= float(h) <= 60):
            raise HTTPException(400, "set_height needs params.height_m in 0..60")
    if op_type == "clear_nonveg" and not params.get("item"):
        raise HTTPException(400, "clear_nonveg needs params.item (a Sentinel-2 scene id)")
    try:
        return edits.add_op(aoi_id, op_type, geometry, params)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/edits/undo")
def api_edits_undo(payload: dict = Body(...)):
    removed = edits.undo(payload["aoi_id"])
    if removed is None:
        raise HTTPException(400, "nothing to undo")
    return {"removed": removed}


@app.delete("/api/edits/{op_id}")
def api_edits_delete(op_id: int, aoi_id: str):
    if not edits.delete_op(aoi_id, op_id):
        raise HTTPException(404, f"no op {op_id}")
    return {"deleted": op_id}


# --- Shadow --------------------------------------------------------------------

@app.post("/api/shadow")
def api_shadow(payload: dict = Body(...)):
    line = payload.get("line") or {}
    coords = line.get("coordinates")
    if not coords:
        raise HTTPException(400, "need line: GeoJSON LineString")
    item = payload.get("item")
    when = payload.get("datetime")
    source = None
    if item:
        info = sentinel.scene_info(payload["aoi_id"], item)
        elev, azim = info.get("sun_elevation"), info.get("sun_azimuth")
        source = f"Sentinel-2 scene {item} sun geometry"
    elif when:
        lng, lat = coords[0]
        pos = shadow.solar_position(lat, lng, shadow.parse_utc(when))
        elev, azim = pos["elevation"], pos["azimuth"]
        source = f"NOAA solar position for {when} (lower confidence — verify the image capture time)"
    else:
        raise HTTPException(400, "need item (Sentinel-2 scene) or datetime (UTC)")
    try:
        result = shadow.estimate_height(coords, elev, azim)
    except ValueError as e:
        raise HTTPException(400, str(e))
    result["source"] = source
    return result


# --- Export / serve mode ---------------------------------------------------------

@app.post("/api/export")
def api_export(payload: dict = Body(...)):
    aoi_id = payload["aoi_id"]
    out = {"mosaic": export.export_mosaic(aoi_id)}
    if payload.get("per_quadkey"):
        out["tiles"] = export.export_quadkey_tiles(aoi_id)
    return out


def _proxy_upstream(url: str, request: Request):
    """Stream a remote file, passing the Range header through (needed by
    geotiff.js in the PWA; S3 itself sends no CORS headers, hence the proxy)."""
    headers = {}
    rng = request.headers.get("range")
    if rng:
        headers["Range"] = rng
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        raise HTTPException(e.code, f"upstream: {e.reason}")
    except Exception as e:
        raise HTTPException(502, f"upstream fetch failed: {e}")
    out_headers = {"Accept-Ranges": "bytes"}
    for h in ("Content-Range", "Content-Length", "Content-Type", "ETag", "Last-Modified"):
        v = resp.headers.get(h)
        if v:
            out_headers[h] = v
    return StreamingResponse(resp, status_code=resp.status, headers=out_headers)


@app.get("/chm/{quadkey}.tif")
def serve_chm(quadkey: str, request: Request):
    if not quadkey.isdigit():
        raise HTTPException(400, "bad quadkey")
    patched = export.patched_tile_path(quadkey)
    if patched:
        return FileResponse(patched, media_type="image/tiff")
    return _proxy_upstream(qk.meta_tile_url(quadkey), request)


# Mounted BEFORE the catch-all below — Starlette matches routes in
# registration order, and /{path:path} would otherwise swallow /static/*.
app.mount("/static", StaticFiles(directory=os.path.join(TOOL_DIR, "static")))


@app.api_route("/{path:path}", methods=["GET"])
def passthrough(path: str, request: Request):
    """Forward the PWA's other worker routes to the user's Cloudflare worker
    (only when --upstream-proxy is set); everything else 404s and the PWA
    degrades gracefully."""
    full = "/" + path
    if CFG["upstream_proxy"] and full.startswith(PASSTHROUGH_PREFIXES):
        q = ("?" + str(request.url.query)) if request.url.query else ""
        return _proxy_upstream(CFG["upstream_proxy"].rstrip("/") + full + q, request)
    raise HTTPException(404, "not found")


def main():
    import uvicorn
    ap = argparse.ArgumentParser(description="SAR-Preflight canopy update tool")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--max-aoi-km", type=float, default=canopy.MAX_AOI_KM,
                    help="AOI size cap per side, km (memory guard)")
    ap.add_argument("--upstream-proxy", default=None,
                    help="Cloudflare worker URL to forward /tfr,/notam,/adsb,/usfs,/blm to")
    args = ap.parse_args()
    CFG["max_aoi_km"] = args.max_aoi_km
    CFG["upstream_proxy"] = args.upstream_proxy
    print(f"Canopy Update Tool -> http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
