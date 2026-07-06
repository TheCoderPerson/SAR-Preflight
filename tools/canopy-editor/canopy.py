"""Meta/WRI canopy ingest: windowed COG reads over HTTP, snapped AOI mosaic,
disk cache, and PNG rendering.

The AOI mosaic grid is EPSG:3857 at the tiles' native resolution with its
origin snapped to the Meta tile pixel grid, so per-quadkey export later is a
lossless array copy (no resampling).
"""

import hashlib
import json
import math
import os
import time

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.windows import Window, from_bounds
from PIL import Image

import quadkeys as qk

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")

# Default AOI cap (each dimension). ~12 km of Float32 at ~1 m is ~600 MB peak.
MAX_AOI_KM = 12.0

# Same retry policy as the PWA (sar-preflight.js CANOPY_TILE_ATTEMPTS):
# cold Range reads of these COGs intermittently 5xx even when the tile is fine.
TILE_ATTEMPTS = 4
BACKOFF_S = 0.3

# GDAL knobs for efficient remote COG reads.
GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
    GDAL_HTTP_MAX_RETRY="0",  # we do our own retries with backoff
    VSI_CACHE="TRUE",
    VSI_CACHE_SIZE="33554432",
)

GTIFF_PROFILE = dict(
    driver="GTiff",
    dtype="float32",
    count=1,
    crs="EPSG:3857",
    tiled=True,
    blockxsize=512,
    blockysize=512,
    compress="deflate",
    predictor=3,
    nodata=None,
)


class AoiError(Exception):
    """User-facing AOI/build problem (bad bbox, too large, no tiles)."""


def aoi_dir(aoi_id):
    return os.path.join(CACHE_DIR, aoi_id)


def aoi_meta_path(aoi_id):
    return os.path.join(aoi_dir(aoi_id), "aoi.json")


def load_aoi(aoi_id):
    path = aoi_meta_path(aoi_id)
    if not os.path.exists(path):
        raise AoiError(f"unknown AOI {aoi_id!r} — build it with POST /api/aoi first")
    with open(path) as f:
        return json.load(f)


def orig_tif(aoi_id):
    return os.path.join(aoi_dir(aoi_id), "canopy_orig.tif")


def edited_tif(aoi_id):
    return os.path.join(aoi_dir(aoi_id), "canopy_edited.tif")


def _vsicurl(url):
    return "/vsicurl/" + url


def _open_tile(url):
    """Open a remote COG with retries for transient S3 5xx."""
    last = None
    for attempt in range(TILE_ATTEMPTS):
        if attempt:
            time.sleep(BACKOFF_S * attempt)  # 300/600/900 ms
        try:
            return rasterio.open(_vsicurl(url))
        except rasterio.errors.RasterioIOError as e:
            last = e
    raise last


def build_aoi(bbox, base=qk.META_BASE_DEFAULT, max_aoi_km=MAX_AOI_KM):
    """Build (or reuse) the canopy mosaic for a geographic bbox [w, s, e, n].

    Returns the aoi.json metadata dict.
    """
    west, south, east, north = map(float, bbox)
    if not (west < east and south < north):
        raise AoiError("bbox must be [west, south, east, north] with west<east, south<north")
    if not (-85 < south and north < 85):
        raise AoiError("bbox outside Web Mercator latitude range")

    xmin, xmax = qk.lng_to_merc_x(west), qk.lng_to_merc_x(east)
    ymin, ymax = qk.lat_to_merc_y(south), qk.lat_to_merc_y(north)
    # Mercator metres overstate ground distance by 1/cos(lat); cap on ground km.
    scale = math.cos(math.radians((south + north) / 2.0))
    km_x, km_y = (xmax - xmin) * scale / 1000.0, (ymax - ymin) * scale / 1000.0
    if km_x > max_aoi_km or km_y > max_aoi_km:
        raise AoiError(
            f"AOI is {km_x:.1f} x {km_y:.1f} km; cap is {max_aoi_km:g} km per side. "
            "Draw a smaller area (or run with --max-aoi-km on a big machine)."
        )

    keys = qk.meta_quadkeys_for_bbox(west, south, east, north)

    # Snap the mosaic grid to the pixel grid of the first reachable tile.
    ref = None
    tile_meta = {}
    failed = []
    for key in keys:
        try:
            ds = _open_tile(qk.meta_tile_url(key, base))
        except Exception:
            failed.append(key)
            continue
        with ds:
            tile_meta[key] = dict(transform=list(ds.transform)[:6], width=ds.width,
                                  height=ds.height, nodata=ds.nodata)
            if ref is None:
                ref = ds.transform
    if ref is None:
        raise AoiError(
            "no canopy tiles could be opened for this AOI "
            f"(tried {len(keys)}: {', '.join(keys)}) — Meta S3 may be down, or there "
            "is no canopy coverage here"
        )

    resx, resy = ref.a, -ref.e  # e is negative (north-up)
    # Snap outward so the mosaic fully covers the requested bbox.
    col0 = math.floor((xmin - ref.c) / resx)
    row0 = math.floor((ref.f - ymax) / resy)
    col1 = math.ceil((xmax - ref.c) / resx)
    row1 = math.ceil((ref.f - ymin) / resy)
    width, height = col1 - col0, row1 - row0
    if width <= 0 or height <= 0:
        raise AoiError("degenerate AOI after grid snapping — bbox too small")
    gx0 = ref.c + col0 * resx  # mosaic origin (upper-left), on the tile pixel grid
    gy0 = ref.f - row0 * resy
    transform = from_origin(gx0, gy0, resx, resy)

    aoi_id = hashlib.sha1(
        f"{gx0:.4f}_{gy0:.4f}_{width}_{height}_{resx:.6f}".encode()
    ).hexdigest()[:12]

    meta_path = aoi_meta_path(aoi_id)
    if os.path.exists(meta_path) and os.path.exists(orig_tif(aoi_id)):
        with open(meta_path) as f:
            return json.load(f)  # resume existing session (edits.json survives)

    mosaic = np.full((height, width), np.nan, dtype=np.float32)
    loaded = []
    with rasterio.Env(**GDAL_ENV):
        for key in keys:
            if key in failed:
                continue
            try:
                arr, win_bounds = _read_tile_window(
                    qk.meta_tile_url(key, base), gx0, gy0, resx, resy, width, height
                )
            except Exception:
                failed.append(key)
                continue
            if arr is None:
                continue
            r0, c0 = win_bounds
            dst = mosaic[r0:r0 + arr.shape[0], c0:c0 + arr.shape[1]]
            take = np.isnan(dst) & np.isfinite(arr)
            dst[take] = arr[take]
            loaded.append(key)

    if not loaded:
        raise AoiError("all canopy tile reads failed for this AOI — try again (transient S3 errors) or check connectivity")

    os.makedirs(aoi_dir(aoi_id), exist_ok=True)
    with rasterio.open(orig_tif(aoi_id), "w", width=width, height=height,
                       transform=transform, **GTIFF_PROFILE) as dst:
        dst.write(mosaic, 1)

    meta = {
        "aoi_id": aoi_id,
        "bbox": [west, south, east, north],
        # exact geographic bounds of the snapped mosaic (for Leaflet overlays)
        "bounds": {
            "west": qk.merc_x_to_lng(gx0),
            "east": qk.merc_x_to_lng(gx0 + width * resx),
            "north": qk.merc_y_to_lat(gy0),
            "south": qk.merc_y_to_lat(gy0 - height * resy),
        },
        "merc": {"x0": gx0, "y0": gy0, "resx": resx, "resy": resy},
        "width": width,
        "height": height,
        "res_m": resx,
        "quadkeys": keys,
        "tiles_loaded": loaded,
        "tiles_failed": failed,
        "base": base,
        "tile_meta": tile_meta,
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=1)
    return meta


def _read_tile_window(url, gx0, gy0, resx, resy, width, height):
    """Read the part of one tile that overlaps the mosaic grid.

    Returns (array, (row_off, col_off) into the mosaic) or (None, None) when
    the tile doesn't overlap. Windowed read only — never the whole tile (the
    Meta COGs have no usable overviews and decode to GB full-size).
    """
    with _open_tile(url) as ds:
        tb = ds.bounds
        mxmin, mxmax = gx0, gx0 + width * resx
        mymax, mymin = gy0, gy0 - height * resy
        ixmin, ixmax = max(tb.left, mxmin), min(tb.right, mxmax)
        iymin, iymax = max(tb.bottom, mymin), min(tb.top, mymax)
        if ixmin >= ixmax or iymin >= iymax:
            return None, None
        # Mosaic-grid indices of the intersection (grids are aligned by design).
        c0 = int(round((ixmin - gx0) / resx))
        r0 = int(round((gy0 - iymax) / resy))
        c1 = int(round((ixmax - gx0) / resx))
        r1 = int(round((gy0 - iymin) / resy))
        c0, r0 = max(0, c0), max(0, r0)
        c1, r1 = min(width, c1), min(height, r1)
        if c1 <= c0 or r1 <= r0:
            return None, None
        win = from_bounds(gx0 + c0 * resx, gy0 - r1 * resy,
                          gx0 + c1 * resx, gy0 - r0 * resy, ds.transform)
        win = Window(round(win.col_off), round(win.row_off), c1 - c0, r1 - r0)
        arr = ds.read(1, window=win, boundless=False).astype(np.float32)
        if ds.nodata is not None:
            arr[arr == ds.nodata] = np.nan
        return arr, (r0, c0)


# --- Rendering ---------------------------------------------------------------

def canopy_rgba(arr, max_h=30.0):
    """Tan->green ramp matching the PWA's canopyColorRamp (raster.js:344)."""
    h, w = arr.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    valid = np.isfinite(arr) & (arr > 0)
    t = np.clip(arr[valid], 0, max_h) / max_h
    rgba[valid, 0] = (237 + (13 - 237) * t).astype(np.uint8)
    rgba[valid, 1] = (201 + (94 - 201) * t).astype(np.uint8)
    rgba[valid, 2] = (135 + (40 - 135) * t).astype(np.uint8)
    rgba[valid, 3] = 255
    return rgba


def render_png(tif_path, max_px=2048):
    """Colorized, downsampled PNG of a canopy GeoTIFF (bytes)."""
    with rasterio.open(tif_path) as ds:
        scale = max(ds.width, ds.height) / float(max_px)
        if scale > 1:
            out_w, out_h = round(ds.width / scale), round(ds.height / scale)
        else:
            out_w, out_h = ds.width, ds.height
        arr = ds.read(1, out_shape=(out_h, out_w)).astype(np.float32)
    img = Image.fromarray(canopy_rgba(arr), "RGBA")
    import io
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=False)
    return buf.getvalue()
