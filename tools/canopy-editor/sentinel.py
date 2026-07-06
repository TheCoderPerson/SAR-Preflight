"""Sentinel-2 L2A access via Element84 Earth Search (AWS open data).

Free, no auth: STAC API for scene discovery, public COGs on S3 for pixels
(windowed reads via rasterio/GDAL — never whole scenes).
"""

import io
import json
import os

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import reproject
from PIL import Image

import canopy

STAC_URL = "https://earth-search.aws.element84.com/v1"
COLLECTION = "sentinel-2-l2a"
NDVI_RES_M = 10.0
PREVIEW_MAX_PX = 2048

_client = None


def _cat():
    global _client
    if _client is None:
        from pystac_client import Client
        _client = Client.open(STAC_URL)
    return _client


def _s2_dir(aoi_id):
    d = os.path.join(canopy.aoi_dir(aoi_id), "s2")
    os.makedirs(d, exist_ok=True)
    return d


def _item_summary(item):
    p = item.properties
    return {
        "id": item.id,
        "datetime": p.get("datetime"),
        "cloud": p.get("eo:cloud_cover"),
        "sun_azimuth": p.get("view:sun_azimuth"),
        "sun_elevation": p.get("view:sun_elevation"),
    }


def search_scenes(bbox, start, end, max_cloud=30.0, limit=40):
    """Scenes intersecting the bbox, newest first."""
    search = _cat().search(
        collections=[COLLECTION],
        bbox=bbox,
        datetime=f"{start}/{end}",
        query={"eo:cloud_cover": {"lt": float(max_cloud)}},
        sortby=["-properties.datetime"],
        max_items=limit,
    )
    return [_item_summary(i) for i in search.items()]


def _fetch_item(aoi_id, item_id):
    """STAC item (asset hrefs + sun geometry), cached on disk per AOI."""
    path = os.path.join(_s2_dir(aoi_id), f"{item_id}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    results = list(
        _cat().search(collections=[COLLECTION], ids=[item_id], max_items=1).items()
    )
    if not results:
        raise ValueError(f"Sentinel-2 item {item_id!r} not found on Earth Search")
    item = results[0]
    needed = {}
    for key in ("visual", "red", "nir", "scl"):
        asset = item.assets.get(key)
        if asset is not None:
            needed[key] = asset.href
    missing = {"visual", "red", "nir"} - set(needed)
    if missing:
        raise ValueError(
            f"scene {item_id} is missing expected assets {sorted(missing)} — "
            "Earth Search schema may have changed"
        )
    data = {"summary": _item_summary(item), "assets": needed}
    with open(path, "w") as f:
        json.dump(data, f, indent=1)
    return data


def scene_info(aoi_id, item_id):
    return _fetch_item(aoi_id, item_id)["summary"]


def _aoi_merc_bounds(meta):
    m = meta["merc"]
    left = m["x0"]
    top = m["y0"]
    right = left + meta["width"] * m["resx"]
    bottom = top - meta["height"] * m["resy"]
    return left, bottom, right, top


def _read_asset_window(href, meta, out_w, out_h, resampling=Resampling.bilinear):
    """Read the AOI window of a (UTM) asset warped to the EPSG:3857 AOI grid.

    The VRT is given the destination grid directly, so GDAL warps exactly the
    needed window (no boundless read, no full-scene decode)."""
    left, bottom, right, top = _aoi_merc_bounds(meta)
    transform = from_origin(left, top, (right - left) / out_w, (top - bottom) / out_h)
    env = dict(canopy.GDAL_ENV, CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.jp2")
    with rasterio.Env(**env):
        with rasterio.open("/vsicurl/" + href) as ds:
            with WarpedVRT(ds, crs="EPSG:3857", transform=transform,
                           width=out_w, height=out_h, resampling=resampling) as vrt:
                data = vrt.read()
    return data, transform


def preview_png(aoi_id, item_id):
    """True-color (TCI) preview of the AOI as PNG bytes, cached per scene.

    Rendered onto the exact mosaic bounds so the Leaflet overlay aligns with
    the canopy layer pixel-for-pixel.
    """
    png_path = os.path.join(_s2_dir(aoi_id), f"{item_id}_tci.png")
    if os.path.exists(png_path):
        with open(png_path, "rb") as f:
            return f.read()
    meta = canopy.load_aoi(aoi_id)
    item = _fetch_item(aoi_id, item_id)
    scale = max(meta["width"], meta["height"]) / float(PREVIEW_MAX_PX)
    out_w = max(1, round(meta["width"] / max(scale, 1.0)))
    out_h = max(1, round(meta["height"] / max(scale, 1.0)))
    data, _ = _read_asset_window(item["assets"]["visual"], meta, out_w, out_h)
    rgb = np.transpose(data[:3], (1, 2, 0)).astype(np.uint8)
    alpha = np.where(rgb.sum(axis=2) == 0, 0, 255).astype(np.uint8)  # scene border
    rgba = np.dstack([rgb, alpha])
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG")
    png = buf.getvalue()
    with open(png_path, "wb") as f:
        f.write(png)
    return png


def _ndvi_tif(aoi_id, item_id):
    return os.path.join(_s2_dir(aoi_id), f"{item_id}_ndvi10.tif")


def build_ndvi(aoi_id, item_id):
    """NDVI over the AOI at ~10 m in EPSG:3857, cached as a small GeoTIFF."""
    path = _ndvi_tif(aoi_id, item_id)
    if os.path.exists(path):
        return path
    meta = canopy.load_aoi(aoi_id)
    item = _fetch_item(aoi_id, item_id)
    left, bottom, right, top = _aoi_merc_bounds(meta)
    out_w = max(1, round((right - left) / NDVI_RES_M))
    out_h = max(1, round((top - bottom) / NDVI_RES_M))
    red, transform = _read_asset_window(item["assets"]["red"], meta, out_w, out_h)
    nir, _ = _read_asset_window(item["assets"]["nir"], meta, out_w, out_h)
    red = red[0].astype(np.float32)
    nir = nir[0].astype(np.float32)
    denom = nir + red
    with np.errstate(divide="ignore", invalid="ignore"):
        ndvi = np.where(denom > 0, (nir - red) / denom, np.nan).astype(np.float32)
    profile = dict(canopy.GTIFF_PROFILE)
    profile.update(blockxsize=256, blockysize=256)
    with rasterio.open(path, "w", width=out_w, height=out_h,
                       transform=transform, **profile) as dst:
        dst.write(ndvi, 1)
    return path


def ndvi_on_window(meta, item_id, r0, r1, c0, c1):
    """NDVI resampled (bilinear) onto a window of the 1 m canopy grid."""
    aoi_id = meta["aoi_id"]
    path = build_ndvi(aoi_id, item_id)
    m = meta["merc"]
    dst_transform = from_origin(
        m["x0"] + c0 * m["resx"], m["y0"] - r0 * m["resy"], m["resx"], m["resy"]
    )
    dst = np.full((r1 - r0, c1 - c0), np.nan, dtype=np.float32)
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            dst_transform=dst_transform,
            dst_crs="EPSG:3857",
            resampling=Resampling.bilinear,
            src_nodata=None,
            dst_nodata=np.nan,
        )
    return dst


def ndvi_png(aoi_id, item_id, threshold=0.4):
    """NDVI visualization for threshold tuning: green above, gray below."""
    with rasterio.open(build_ndvi(aoi_id, item_id)) as ds:
        ndvi = ds.read(1)
    h, w = ndvi.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    valid = np.isfinite(ndvi)
    veg = valid & (ndvi >= threshold)
    bare = valid & ~veg
    rgba[veg] = (34, 197, 94, 190)
    rgba[bare] = (120, 113, 108, 150)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG")
    return buf.getvalue()
