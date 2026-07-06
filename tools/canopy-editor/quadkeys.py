"""Quadkey / Web-Mercator tiling math for the Meta/WRI canopy tiles.

Python port of the verified helpers in ../../sar-preflight-raster.js
(lines 26-105). Keep the two in sync: the PWA and this tool must agree
on which z9 quadkey covers a given lat/lng.
"""

import math

# Meta/WRI Global Canopy Height (1 m) — Bing-quadkey z9 COG tiles.
META_ZOOM = 9
META_BASE_DEFAULT = (
    "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float"
)

WEBMERC_R = 6378137.0  # EPSG:3857 sphere radius (metres)


def lng_to_merc_x(lng):
    return WEBMERC_R * lng * math.pi / 180.0


def lat_to_merc_y(lat):
    r = lat * math.pi / 180.0
    return WEBMERC_R * math.log(math.tan(math.pi / 4.0 + r / 2.0))


def merc_x_to_lng(x):
    return x / WEBMERC_R * 180.0 / math.pi


def merc_y_to_lat(y):
    return (2.0 * math.atan(math.exp(y / WEBMERC_R)) - math.pi / 2.0) * 180.0 / math.pi


def lnglat_to_tile_xy(lng, lat, z):
    n = 2 ** z
    x = math.floor((lng + 180.0) / 360.0 * n)
    lat_rad = lat * math.pi / 180.0
    y = math.floor((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    x = max(0, min(n - 1, x))
    y = max(0, min(n - 1, y))
    return x, y


def tile_xy_to_quadkey(x, y, z):
    qk = []
    for i in range(z, 0, -1):
        digit = 0
        mask = 1 << (i - 1)
        if x & mask:
            digit += 1
        if y & mask:
            digit += 2
        qk.append(str(digit))
    return "".join(qk)


def quadkey_to_tile_xy(qk):
    x = y = 0
    z = len(qk)
    for i in range(z, 0, -1):
        mask = 1 << (i - 1)
        d = qk[z - i]
        if d == "1":
            x |= mask
        elif d == "2":
            y |= mask
        elif d == "3":
            x |= mask
            y |= mask
    return x, y, z


def tile_xy_bounds(x, y, z):
    """Geographic bounds {north, south, east, west} of a slippy tile."""
    n = 2 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    return {"north": north, "south": south, "east": east, "west": west}


def quadkey_bounds(qk):
    x, y, z = quadkey_to_tile_xy(qk)
    return tile_xy_bounds(x, y, z)


def meta_quadkeys_for_bbox(west, south, east, north, z=META_ZOOM):
    """Quadkeys (at META_ZOOM) covering a geographic bbox."""
    nwx, nwy = lnglat_to_tile_xy(west, north, z)
    sex, sey = lnglat_to_tile_xy(east, south, z)
    out = []
    for x in range(min(nwx, sex), max(nwx, sex) + 1):
        for y in range(min(nwy, sey), max(nwy, sey) + 1):
            out.append(tile_xy_to_quadkey(x, y, z))
    return out


def meta_tile_url(qk, base=META_BASE_DEFAULT):
    return f"{base}/chm/{qk}.tif"
