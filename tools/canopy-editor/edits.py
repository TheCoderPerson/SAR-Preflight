"""Non-destructive canopy edits: an ordered op list applied over the original
mosaic. canopy_edited.tif is always apply(canopy_orig, ops); undo/delete
recompute from the original, so nothing is ever lost until export.

Op types:
  clear        — zero every pixel inside the polygon
  clear_nonveg — zero pixels inside the polygon whose current NDVI (from a
                 chosen Sentinel-2 scene) is below the threshold; surviving
                 vegetation keeps its height
  set_height   — set a constant height (m) inside the polygon (regrowth /
                 shadow-derived estimates)
"""

import json
import os

import numpy as np
import rasterio
from rasterio import features
from rasterio.transform import from_origin
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

import canopy
import quadkeys as qk

OP_TYPES = ("clear", "clear_nonveg", "set_height")


def edits_path(aoi_id):
    return os.path.join(canopy.aoi_dir(aoi_id), "edits.json")


def load_ops(aoi_id):
    path = edits_path(aoi_id)
    if not os.path.exists(path):
        return {"ops": [], "next_id": 1}
    with open(path) as f:
        return json.load(f)


def _save_ops(aoi_id, state):
    with open(edits_path(aoi_id), "w") as f:
        json.dump(state, f, indent=1)


def _to_merc(geom_geojson):
    """GeoJSON (lon/lat) -> shapely geometry in EPSG:3857."""
    g = shape(geom_geojson)
    return shp_transform(
        lambda x, y, z=None: (
            np.vectorize(qk.lng_to_merc_x)(x), np.vectorize(qk.lat_to_merc_y)(y)
        ),
        g,
    )


def _geom_window(meta, geom_merc):
    """Clamped (r0, r1, c0, c1) mosaic window covering the geometry bounds."""
    m = meta["merc"]
    minx, miny, maxx, maxy = geom_merc.bounds
    c0 = int(np.floor((minx - m["x0"]) / m["resx"]))
    c1 = int(np.ceil((maxx - m["x0"]) / m["resx"]))
    r0 = int(np.floor((m["y0"] - maxy) / m["resy"]))
    r1 = int(np.ceil((m["y0"] - miny) / m["resy"]))
    c0, r0 = max(0, c0), max(0, r0)
    c1, r1 = min(meta["width"], c1), min(meta["height"], r1)
    return r0, r1, c0, c1


def _apply_op(arr, meta, op):
    """Apply one op to the mosaic array in place. Returns pixels changed."""
    geom = _to_merc(op["geometry"])
    r0, r1, c0, c1 = _geom_window(meta, geom)
    if r1 <= r0 or c1 <= c0:
        return 0
    m = meta["merc"]
    win_transform = from_origin(
        m["x0"] + c0 * m["resx"], m["y0"] - r0 * m["resy"], m["resx"], m["resy"]
    )
    mask = features.geometry_mask(
        [geom], out_shape=(r1 - r0, c1 - c0), transform=win_transform, invert=True
    )
    view = arr[r0:r1, c0:c1]
    params = op.get("params") or {}

    if op["type"] == "clear":
        target = mask & np.isfinite(view) & (view != 0)
        view[target] = 0.0
    elif op["type"] == "set_height":
        h = float(params.get("height_m", 0.0))
        target = mask & (~np.isclose(np.nan_to_num(view, nan=-1.0), h))
        view[target] = h
    elif op["type"] == "clear_nonveg":
        import sentinel  # lazy: avoids import cost when unused
        threshold = float(params.get("ndvi_threshold", 0.4))
        item_id = params["item"]
        ndvi = sentinel.ndvi_on_window(meta, item_id, r0, r1, c0, c1)
        nonveg = mask & np.isfinite(ndvi) & (ndvi < threshold)
        target = nonveg & np.isfinite(view) & (view != 0)
        view[target] = 0.0
    else:
        raise ValueError(f"unknown op type {op['type']!r}")
    return int(np.count_nonzero(target))


def _write_edited(aoi_id, meta, arr):
    m = meta["merc"]
    transform = from_origin(m["x0"], m["y0"], m["resx"], m["resy"])
    with rasterio.open(
        canopy.edited_tif(aoi_id), "w", width=meta["width"], height=meta["height"],
        transform=transform, **canopy.GTIFF_PROFILE,
    ) as dst:
        dst.write(arr, 1)


def _read(path):
    with rasterio.open(path) as ds:
        return ds.read(1)


def current_tif(aoi_id):
    """Path of the raster reflecting all ops (edited if any, else original)."""
    e = canopy.edited_tif(aoi_id)
    return e if os.path.exists(e) else canopy.orig_tif(aoi_id)


def add_op(aoi_id, op_type, geometry, params=None):
    if op_type not in OP_TYPES:
        raise ValueError(f"op type must be one of {OP_TYPES}")
    meta = canopy.load_aoi(aoi_id)
    state = load_ops(aoi_id)
    op = {
        "id": state["next_id"],
        "type": op_type,
        "geometry": geometry,
        "params": params or {},
    }
    # Incremental: apply just this op on top of the current edited raster.
    arr = _read(current_tif(aoi_id))
    op["pixels_changed"] = _apply_op(arr, meta, op)
    _write_edited(aoi_id, meta, arr)
    state["ops"].append(op)
    state["next_id"] += 1
    _save_ops(aoi_id, state)
    return op


def _recompute(aoi_id, state):
    """Rebuild canopy_edited from canopy_orig + remaining ops."""
    meta = canopy.load_aoi(aoi_id)
    if not state["ops"]:
        e = canopy.edited_tif(aoi_id)
        if os.path.exists(e):
            os.remove(e)
        _save_ops(aoi_id, state)
        return
    arr = _read(canopy.orig_tif(aoi_id))
    for op in state["ops"]:
        op["pixels_changed"] = _apply_op(arr, meta, op)
    _write_edited(aoi_id, meta, arr)
    _save_ops(aoi_id, state)


def undo(aoi_id):
    state = load_ops(aoi_id)
    if not state["ops"]:
        return None
    removed = state["ops"].pop()
    _recompute(aoi_id, state)
    return removed


def delete_op(aoi_id, op_id):
    state = load_ops(aoi_id)
    before = len(state["ops"])
    state["ops"] = [o for o in state["ops"] if o["id"] != op_id]
    if len(state["ops"]) == before:
        return False
    _recompute(aoi_id, state)
    return True
