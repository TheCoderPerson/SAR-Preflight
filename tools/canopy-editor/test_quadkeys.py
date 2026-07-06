"""Parity tests against the JS-verified fixtures in tests/unit
(sar-preflight-raster.js is the reference implementation)."""

import math

import quadkeys as qk


def test_verified_fixture():
    # Verified in sar-preflight-raster.js line 19: (-120.99, 38.685) -> "023010211"
    x, y = qk.lnglat_to_tile_xy(-120.99, 38.685, 9)
    assert qk.tile_xy_to_quadkey(x, y, 9) == "023010211"


def test_quadkey_roundtrip():
    for key in ("023010211", "0", "3333", "0231302"):
        x, y, z = qk.quadkey_to_tile_xy(key)
        assert qk.tile_xy_to_quadkey(x, y, z) == key


def test_bbox_cover_contains_point_tile():
    keys = qk.meta_quadkeys_for_bbox(-121.05, 38.60, -120.90, 38.75)
    assert "023010211" in keys
    assert len(keys) >= 1


def test_bounds_contain_origin_point():
    b = qk.quadkey_bounds("023010211")
    assert b["west"] <= -120.99 <= b["east"]
    assert b["south"] <= 38.685 <= b["north"]


def test_mercator_roundtrip():
    for lng, lat in ((-120.99, 38.685), (0.0, 0.0), (150.1, -33.9)):
        assert math.isclose(qk.merc_x_to_lng(qk.lng_to_merc_x(lng)), lng, abs_tol=1e-9)
        assert math.isclose(qk.merc_y_to_lat(qk.lat_to_merc_y(lat)), lat, abs_tol=1e-9)
