"""Export the edited canopy.

Two formats, each serving a different consumer:
  1. AOI mosaic GeoTIFF (EPSG:3857, Float32 metres, NaN->0) — a single file
     for QGIS/CalTopo and for a future SAR-Preflight "load local canopy" mode.
  2. Per-quadkey tiles in the exact Meta layout (output/chm/{qk}.tif) — served
     by this tool's /chm/{quadkey}.tif route so the PWA's existing canopy
     fetcher consumes edits today with no app changes.

Tile patching is a lossless array copy: the AOI mosaic grid was snapped to the
Meta tile pixel grid at ingest, so pixels line up exactly (no resampling).
"""

import os
import shutil
import time
import urllib.request
from datetime import date

import numpy as np
import rasterio
from rasterio.windows import Window
from shapely.geometry import box, shape

import canopy
import edits
import quadkeys as qk

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(TOOL_DIR, "output")
TILE_CACHE = os.path.join(canopy.CACHE_DIR, "tiles")
ALIGN_EPS = 1e-3  # metres; grid-alignment tolerance


def export_mosaic(aoi_id):
    """Write the edited AOI mosaic to output/. Returns the file path."""
    meta = canopy.load_aoi(aoi_id)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out = os.path.join(
        OUTPUT_DIR, f"canopy_edited_{aoi_id}_{date.today().isoformat()}.tif"
    )
    with rasterio.open(edits.current_tif(aoi_id)) as src:
        arr = src.read(1)
        transform = src.transform
    arr = np.nan_to_num(arr, nan=0.0)
    with rasterio.open(out, "w", width=meta["width"], height=meta["height"],
                       transform=transform, **canopy.GTIFF_PROFILE) as dst:
        dst.write(arr, 1)
    return out


def _edited_quadkeys(aoi_id):
    """Quadkeys whose tiles intersect any edit-op geometry."""
    meta = canopy.load_aoi(aoi_id)
    state = edits.load_ops(aoi_id)
    keys = []
    for key in meta["quadkeys"]:
        b = qk.quadkey_bounds(key)
        tile_box = box(b["west"], b["south"], b["east"], b["north"])
        if any(shape(op["geometry"]).intersects(tile_box) for op in state["ops"]):
            keys.append(key)
    return keys


def _download_tile(url, dest, attempts=canopy.TILE_ATTEMPTS):
    """Download the full original tile once (the one deliberately heavy path —
    Meta tiles are large; cached and reused across exports)."""
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    last = None
    for attempt in range(attempts):
        if attempt:
            time.sleep(canopy.BACKOFF_S * attempt)
        try:
            with urllib.request.urlopen(url, timeout=120) as resp, open(tmp, "wb") as f:
                shutil.copyfileobj(resp, f, length=1 << 20)
            os.replace(tmp, dest)
            return dest
        except Exception as e:
            last = e
            if os.path.exists(tmp):
                os.remove(tmp)
    raise RuntimeError(f"failed to download {url}: {last}")


def _cast_to(dtype, sub):
    """Cast edited (float, metres) values to the tile's dtype. The published
    Meta tiles are uint8 whole metres, so fractional set-heights round."""
    if np.issubdtype(np.dtype(dtype), np.integer):
        info = np.iinfo(dtype)
        return np.clip(np.rint(sub), info.min, info.max).astype(dtype)
    return sub.astype(dtype)


def _patch_tile(src_path, out_path, meta, mosaic):
    """Stream-copy a tile in full-width row bands, replacing pixels covered by
    the AOI mosaic. Never holds the full tile in memory (a z9 tile decodes to
    4+ GB), and reads sequentially — the source tiles are strip-organized, so
    row bands are the only access pattern that doesn't re-decode rows per
    column. Output is 512-px tiled (better for windowed readers than the
    source's 1-row strips). Returns the number of pixels changed."""
    m = meta["merc"]
    with rasterio.open(src_path) as src:
        t = src.transform
        if (abs(t.a - m["resx"]) > ALIGN_EPS or abs(-t.e - m["resy"]) > ALIGN_EPS):
            raise RuntimeError(f"tile resolution {t.a} != mosaic {m['resx']} — cannot patch losslessly")
        col_shift = (m["x0"] - t.c) / t.a  # mosaic origin in tile pixel coords
        row_shift = (t.f - m["y0"]) / -t.e
        if (abs(col_shift - round(col_shift)) > 1e-3
                or abs(row_shift - round(row_shift)) > 1e-3):
            raise RuntimeError("tile/mosaic pixel grids are not aligned — cannot patch losslessly")
        col_shift, row_shift = round(col_shift), round(row_shift)

        dtype = src.dtypes[0]
        is_float = np.issubdtype(np.dtype(dtype), np.floating)
        profile = src.profile.copy()
        profile.update(driver="GTiff", tiled=True, compress="deflate",
                       predictor=3 if is_float else 2,
                       blockxsize=512, blockysize=512, BIGTIFF="IF_SAFER")
        # ~64 MB row bands, aligned to the 512-px output tile rows.
        band_rows = max(512, (64 << 20) // (src.width * np.dtype(dtype).itemsize))
        band_rows -= band_rows % 512
        changed = 0
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with rasterio.open(out_path, "w", **profile) as dst:
            for row_off in range(0, src.height, band_rows):
                h = min(band_rows, src.height - row_off)
                window = Window(0, row_off, src.width, h)
                block = src.read(1, window=window)
                # Mosaic rows/cols covering this band (aligned integer offsets).
                r0 = max(0, row_off - row_shift)
                r1 = min(meta["height"], row_off + h - row_shift)
                c0 = max(0, -col_shift)
                c1 = min(meta["width"], src.width - col_shift)
                if r1 > r0 and c1 > c0:
                    br0 = r0 + row_shift - row_off
                    bc0 = c0 + col_shift
                    sub = mosaic[r0:r1, c0:c1]
                    tgt = block[br0:br0 + (r1 - r0), bc0:bc0 + (c1 - c0)]
                    ok = np.isfinite(sub)
                    cast = _cast_to(dtype, np.where(ok, sub, 0))
                    changed += int(np.count_nonzero(ok & (tgt != cast)))
                    tgt[ok] = cast[ok]
                dst.write(block, 1, window=window)
    return changed


def export_quadkey_tiles(aoi_id):
    """Patch every tile touched by an edit; write Meta-layout copies to
    output/chm/. Returns [{quadkey, path, pixels_changed, tile_mb}]."""
    meta = canopy.load_aoi(aoi_id)
    keys = _edited_quadkeys(aoi_id)
    if not keys:
        return []
    with rasterio.open(edits.current_tif(aoi_id)) as ds:
        mosaic = ds.read(1)
    results = []
    for key in keys:
        url = qk.meta_tile_url(key, meta.get("base", qk.META_BASE_DEFAULT))
        cached = _download_tile(url, os.path.join(TILE_CACHE, f"{key}.tif"))
        out_path = os.path.join(OUTPUT_DIR, "chm", f"{key}.tif")
        changed = _patch_tile(cached, out_path, meta, mosaic)
        results.append({
            "quadkey": key,
            "path": out_path,
            "pixels_changed": changed,
            "tile_mb": round(os.path.getsize(cached) / 1e6, 1),
        })
    return results


def patched_tile_path(quadkey):
    """Path of a previously exported patched tile, or None."""
    p = os.path.join(OUTPUT_DIR, "chm", f"{quadkey}.tif")
    return p if os.path.exists(p) else None
