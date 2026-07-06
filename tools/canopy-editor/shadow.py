"""Shadow-length -> vegetation height.

height = shadow_length x tan(sun_elevation)

Sun geometry comes from the Sentinel-2 scene's STAC properties when a scene is
selected (exact for that image), or from the NOAA solar-position algorithm for
a user-supplied UTC date/time (for imagery of known capture time but no STAC
metadata). This is a sanity-check instrument, not a survey: at Sentinel-2's
10 m pixels a half-pixel error at each shadow endpoint is ~10.tan(el) metres
of height uncertainty, and slopes bias it further.
"""

import math
from datetime import datetime, timezone

R_EARTH_M = 6371008.8
S2_PIXEL_M = 10.0
ALIGNMENT_WARN_DEG = 15.0


def haversine_m(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH_M * math.asin(math.sqrt(a))


def bearing_deg(lat1, lng1, lat2, lng2):
    """Initial bearing from point 1 to point 2, degrees clockwise from north."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def solar_position(lat, lng, when_utc):
    """NOAA solar-position algorithm (elevation/azimuth, degrees).

    Accurate to ~0.1 deg for 1900-2100 — far below the shadow-measurement noise.
    when_utc: timezone-aware datetime in UTC.
    """
    if when_utc.tzinfo is None:
        when_utc = when_utc.replace(tzinfo=timezone.utc)
    when_utc = when_utc.astimezone(timezone.utc)

    # Julian day / century
    y, m = when_utc.year, when_utc.month
    d = (when_utc.day + when_utc.hour / 24.0 + when_utc.minute / 1440.0
         + when_utc.second / 86400.0)
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    jd = int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5
    t = (jd - 2451545.0) / 36525.0

    # Sun geometry (all degrees unless noted)
    l0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360.0
    m_anom = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    mr = math.radians(m_anom)
    c = ((1.914602 - t * (0.004817 + 0.000014 * t)) * math.sin(mr)
         + (0.019993 - 0.000101 * t) * math.sin(2 * mr)
         + 0.000289 * math.sin(3 * mr))
    true_long = l0 + c
    omega = 125.04 - 1934.136 * t
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    eps0 = (23.0 + (26.0 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813)))
                    / 60.0) / 60.0)
    eps = eps0 + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(
        math.sin(math.radians(eps)) * math.sin(math.radians(app_long))))

    # Equation of time (minutes)
    vy = math.tan(math.radians(eps / 2.0)) ** 2
    l0r = math.radians(l0)
    eot = 4.0 * math.degrees(
        vy * math.sin(2 * l0r) - 2 * e * math.sin(mr)
        + 4 * e * vy * math.sin(mr) * math.cos(2 * l0r)
        - 0.5 * vy * vy * math.sin(4 * l0r) - 1.25 * e * e * math.sin(2 * mr))

    minutes = (when_utc.hour * 60 + when_utc.minute + when_utc.second / 60.0)
    tst = (minutes + eot + 4.0 * lng) % 1440.0  # true solar time
    ha = tst / 4.0 - 180.0  # hour angle, degrees (tst already wrapped to [0,1440))

    latr, declr, har = math.radians(lat), math.radians(decl), math.radians(ha)
    cos_zen = (math.sin(latr) * math.sin(declr)
               + math.cos(latr) * math.cos(declr) * math.cos(har))
    cos_zen = max(-1.0, min(1.0, cos_zen))
    zen = math.degrees(math.acos(cos_zen))
    elevation = 90.0 - zen

    az_denom = math.cos(latr) * math.sin(math.radians(zen))
    if abs(az_denom) > 1e-9:
        az_rad = ((math.sin(latr) * math.cos(math.radians(zen))) - math.sin(declr)) / az_denom
        az_rad = max(-1.0, min(1.0, az_rad))
        azimuth = 180.0 - math.degrees(math.acos(az_rad))
        if ha > 0:
            azimuth = -azimuth
        azimuth = azimuth % 360.0
    else:
        azimuth = 180.0 if lat > 0 else 0.0
    return {"elevation": elevation, "azimuth": azimuth}


def estimate_height(line_coords, sun_elevation, sun_azimuth, pixel_m=S2_PIXEL_M):
    """Height from a base->shadow-tip polyline ([[lng, lat], ...], GeoJSON order).

    Returns dict with height, uncertainty, geometry diagnostics, warnings.
    """
    if len(line_coords) < 2:
        raise ValueError("shadow line needs at least 2 points")
    if sun_elevation is None or sun_elevation <= 0:
        raise ValueError("sun is below the horizon for the given time/scene")

    length = 0.0
    for (lng1, lat1), (lng2, lat2) in zip(line_coords, line_coords[1:]):
        length += haversine_m(lat1, lng1, lat2, lng2)

    el = math.radians(sun_elevation)
    height = length * math.tan(el)
    # Half-pixel endpoint error at each end of the shadow.
    quantization = pixel_m * math.tan(el)

    warnings = [
        "assumes flat terrain along the shadow — slopes bias the estimate",
    ]
    alignment = None
    if sun_azimuth is not None:
        (lng1, lat1), (lng2, lat2) = line_coords[0], line_coords[-1]
        line_az = bearing_deg(lat1, lng1, lat2, lng2)
        anti_sun = (sun_azimuth + 180.0) % 360.0
        dev = abs((line_az - anti_sun + 180.0) % 360.0 - 180.0)
        alignment = dev
        if dev > ALIGNMENT_WARN_DEG:
            warnings.append(
                f"shadow line deviates {dev:.0f}° from the anti-sun direction "
                f"({anti_sun:.0f}°) — draw from the tree base along its shadow"
            )
    return {
        "length_m": round(length, 1),
        "sun_elevation": round(sun_elevation, 2),
        "sun_azimuth": round(sun_azimuth, 2) if sun_azimuth is not None else None,
        "height_m": round(height, 1),
        "quantization_m": round(quantization, 1),
        "alignment_deg": round(alignment, 1) if alignment is not None else None,
        "warnings": warnings,
    }


def parse_utc(s):
    """Parse an ISO datetime string to aware-UTC (assumes UTC when naive)."""
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
