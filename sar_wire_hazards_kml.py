#!/usr/bin/env python3
"""
SAR Overhead Wire Hazard Extractor
===================================
Extracts all overhead wire/cable hazards from OpenStreetMap via Overpass API
and generates a color-coded KML file for import into CalTopo.

Hazard categories (color-coded in KML):
  - Power Transmission Lines (RED)        - power=line
  - Power Distribution Lines (ORANGE)     - power=minor_line
  - Power Cables (DARK RED)               - power=cable
  - Telecom/Communication Lines (BLUE)    - communication=line, telecom=line, telephone=line
  - Aerialways - Ski Lifts/Cables (PURPLE) - aerialway=*
  - Utility Poles (YELLOW dots)           - power=pole, power=tower, man_made=utility_pole

Usage:
  # El Dorado County + Placer County + Hwy 50 corridor
  python3 sar_wire_hazards_kml.py

  # Custom area by county name
  python3 sar_wire_hazards_kml.py --area "El Dorado County"

  # Custom bounding box (south,west,north,east)
  python3 sar_wire_hazards_kml.py --bbox 38.6,-121.1,39.1,-120.0

  # Skip utility poles (lines only, smaller file)
  python3 sar_wire_hazards_kml.py --no-poles

Author: Built for EDSAR UAS Team
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime

# --- Configuration ---

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Default areas: El Dorado County, Placer County, and a bbox for Hwy 50 corridor
DEFAULT_AREAS = [
    {"name": "El Dorado County", "type": "area"},
    {"name": "Placer County", "type": "area"},
]

# Extended bbox to cover Hwy 50 corridor from Placerville to Echo Summit
# and Crystal Basin / Ice House Road area
HWY50_BBOX = (38.72, -120.85, 38.95, -120.02)

# KML color format is aabbggrr (alpha, blue, green, red)
HAZARD_CATEGORIES = {
    "power_line": {
        "label": "Power Transmission Lines",
        "color": "ff0000ff",       # Red
        "width": 3,
        "description": "High-voltage transmission lines on towers/pylons",
    },
    "power_minor_line": {
        "label": "Power Distribution Lines",
        "color": "ff0080ff",       # Orange
        "width": 2,
        "description": "Distribution lines on wooden poles (most common low-altitude hazard)",
    },
    "power_cable": {
        "label": "Power Cables (Overhead)",
        "color": "ff0000aa",       # Dark Red
        "width": 2,
        "description": "Power cables - may be overhead or underground",
    },
    "telecom_line": {
        "label": "Telecom / Communication Lines",
        "color": "ffff8800",       # Blue
        "width": 2,
        "description": "Telephone, fiber, and communication cables on poles",
    },
    "aerialway": {
        "label": "Aerialways (Ski Lifts, Cable Cars, Zip Lines)",
        "color": "ffaa00aa",       # Purple
        "width": 3,
        "description": "Chair lifts, gondolas, cable cars, zip lines, cargo tramways",
    },
    "utility_pole": {
        "label": "Utility Poles & Towers",
        "color": "ff00ccff",       # Yellow
        "width": 0,
        "description": "Poles and towers - indicates likely overhead wires even if wires not mapped",
    },
}


def build_overpass_query(areas=None, bbox=None, include_poles=True):
    """Build the Overpass QL query for all overhead hazards."""

    area_filters = []

    if areas:
        for area in areas:
            if area["type"] == "area":
                county = area["name"]
                # Build area lookup for US counties
                area_filters.append(
                    f'area["name"="{county}"]["admin_level"="6"]["boundary"="administrative"]->.a{len(area_filters)};'
                )

    # Build way queries for each area
    query_parts = []

    # Helper to generate way queries for a given area or bbox
    def add_way_queries(scope):
        """scope is either (area:.aN) or (bbox coords)"""
        queries = [
            f'  way["power"="line"]{scope};',
            f'  way["power"="minor_line"]{scope};',
            f'  way["power"="cable"]{scope};',
            f'  way["communication"="line"]{scope};',
            f'  way["telecom"="line"]{scope};',
            f'  way["telephone"="line"]{scope};',
            f'  way["aerialway"]{scope};',
        ]
        if include_poles:
            queries.extend([
                f'  node["power"="pole"]{scope};',
                f'  node["power"="tower"]{scope};',
                f'  node["man_made"="utility_pole"]{scope};',
            ])
        return queries

    # Start building the query
    query = "[out:json][timeout:300];\n"

    # Add area declarations
    for decl in area_filters:
        query += decl + "\n"

    query += "(\n"

    # Add queries for each named area
    for i in range(len(area_filters)):
        scope = f"(area.a{i})"
        query_parts = add_way_queries(scope)
        for qp in query_parts:
            query += qp + "\n"

    # Add bbox queries if specified
    if bbox:
        s, w, n, e = bbox
        scope = f"({s},{w},{n},{e})"
        for qp in add_way_queries(scope):
            query += qp + "\n"

    query += ");\n"
    query += "out body;\n"
    query += ">;\n"
    query += "out skel qt;\n"

    return query


def fetch_overpass(query):
    """Send query to Overpass API and return JSON response."""
    print(f"Sending query to Overpass API ({len(query)} chars)...")
    print("This may take 1-3 minutes for large areas. Please be patient.\n")

    encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")

    req = urllib.request.Request(
        OVERPASS_URL,
        data=encoded,
        headers={"User-Agent": "SAR-Wire-Hazard-Extractor/1.0"},
    )

    max_retries = 3
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=360) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code == 504:
                wait = 30 * (attempt + 1)
                print(f"  Server busy (HTTP {e.code}), retrying in {wait}s... (attempt {attempt+1}/{max_retries})")
                time.sleep(wait)
            elif e.code == 400:
                # Read the error body for diagnostic info
                try:
                    body = e.read().decode("utf-8", errors="replace")[:500]
                except Exception:
                    body = "(could not read error body)"
                print(f"  HTTP 400 Bad Request from Overpass API.")
                print(f"  This usually means the bounding box coordinates are invalid.")
                print(f"  Overpass requires: south,west,north,east where south < north and west < east.")
                print(f"  Server response: {body}")
                raise
            else:
                print(f"  HTTP Error {e.code}: {e.reason}")
                raise
        except urllib.error.URLError as e:
            print(f"  Connection error: {e.reason}")
            if attempt < max_retries - 1:
                time.sleep(10)
            else:
                raise

    raise RuntimeError("Failed to fetch data after retries")


def categorize_element(element):
    """Determine the hazard category for an OSM element."""
    tags = element.get("tags", {})

    if tags.get("power") == "line":
        return "power_line"
    elif tags.get("power") == "minor_line":
        return "power_minor_line"
    elif tags.get("power") == "cable":
        return "power_cable"
    elif tags.get("communication") == "line":
        return "telecom_line"
    elif tags.get("telecom") == "line":
        return "telecom_line"
    elif tags.get("telephone") == "line":
        return "telecom_line"
    elif "aerialway" in tags:
        return "aerialway"
    elif tags.get("power") in ("pole", "tower"):
        return "utility_pole"
    elif tags.get("man_made") == "utility_pole":
        return "utility_pole"

    return None


def build_element_name(element, category):
    """Build a descriptive name for a KML placemark."""
    tags = element.get("tags", {})
    parts = []

    if category == "power_line":
        voltage = tags.get("voltage", "")
        if voltage:
            # Convert to kV for readability
            try:
                kv = int(voltage) / 1000
                parts.append(f"{kv:.0f}kV")
            except (ValueError, TypeError):
                parts.append(voltage)
        operator = tags.get("operator", "")
        if operator:
            parts.append(operator)
        ref = tags.get("ref", "")
        if ref:
            parts.append(f"Ref: {ref}")
        if not parts:
            parts.append("Transmission Line")

    elif category == "power_minor_line":
        voltage = tags.get("voltage", "")
        if voltage:
            parts.append(f"{voltage}V")
        operator = tags.get("operator", "")
        if operator:
            parts.append(operator)
        if not parts:
            parts.append("Distribution Line")

    elif category == "power_cable":
        location = tags.get("location", "unknown")
        parts.append(f"Power Cable ({location})")

    elif category == "telecom_line":
        operator = tags.get("operator", "")
        medium = tags.get("telecom:medium", "")
        if operator:
            parts.append(operator)
        if medium:
            parts.append(medium)
        if not parts:
            parts.append("Telecom Line")

    elif category == "aerialway":
        aw_type = tags.get("aerialway", "unknown")
        name = tags.get("name", "")
        readable_type = aw_type.replace("_", " ").title()
        if name:
            parts.append(f"{name} ({readable_type})")
        else:
            parts.append(readable_type)

    elif category == "utility_pole":
        pole_type = tags.get("power", tags.get("man_made", "pole"))
        material = tags.get("material", "")
        if material:
            parts.append(f"{pole_type} ({material})")
        else:
            parts.append(pole_type.replace("_", " ").title())

    return " | ".join(parts)


def generate_kml(data, output_file, include_poles=True):
    """Generate a styled KML file from Overpass JSON data."""

    elements = data.get("elements", [])
    print(f"Processing {len(elements)} OSM elements...")

    # Index nodes by ID for way coordinate lookups
    nodes = {}
    ways = []
    points = []

    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = (el.get("lon", 0), el.get("lat", 0))
            # Check if this node has hazard tags (poles/towers)
            cat = categorize_element(el)
            if cat:
                points.append((el, cat))
        elif el["type"] == "way":
            cat = categorize_element(el)
            if cat:
                ways.append((el, cat))

    print(f"  Found {len(ways)} wire/cable ways")
    print(f"  Found {len(points)} poles/towers")

    # Count by category
    cat_counts = defaultdict(int)
    for _, cat in ways:
        cat_counts[cat] += 1
    for _, cat in points:
        cat_counts[cat] += 1

    print("\n  Breakdown by hazard type:")
    for cat_id, info in HAZARD_CATEGORIES.items():
        count = cat_counts.get(cat_id, 0)
        if count > 0:
            print(f"    {info['label']}: {count}")

    # Build KML
    kml_ns = "http://www.opengis.net/kml/2.2"
    ET.register_namespace("", kml_ns)

    kml = ET.Element(f"{{{kml_ns}}}kml")
    doc = ET.SubElement(kml, f"{{{kml_ns}}}Document")

    # Document name and description
    name_el = ET.SubElement(doc, f"{{{kml_ns}}}name")
    name_el.text = "SAR Overhead Wire Hazards"

    desc_el = ET.SubElement(doc, f"{{{kml_ns}}}description")
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")
    desc_el.text = (
        f"Overhead wire and cable hazards for UAS operations.\n"
        f"Generated: {generated}\n"
        f"Source: OpenStreetMap via Overpass API\n\n"
        f"WARNING: This data may be incomplete. Not all power lines,\n"
        f"telecom cables, and aerial wires are mapped in OSM.\n"
        f"Always conduct a visual scan for wires during operations.\n\n"
        f"Total features: {len(ways)} lines, {len(points)} poles/towers"
    )

    # Create styles for each category
    for cat_id, info in HAZARD_CATEGORIES.items():
        if cat_counts.get(cat_id, 0) == 0:
            continue

        style = ET.SubElement(doc, f"{{{kml_ns}}}Style")
        style.set("id", f"style_{cat_id}")

        if info["width"] > 0:  # Line style
            line_style = ET.SubElement(style, f"{{{kml_ns}}}LineStyle")
            color = ET.SubElement(line_style, f"{{{kml_ns}}}color")
            color.text = info["color"]
            width = ET.SubElement(line_style, f"{{{kml_ns}}}width")
            width.text = str(info["width"])
        else:  # Point style (poles)
            icon_style = ET.SubElement(style, f"{{{kml_ns}}}IconStyle")
            color = ET.SubElement(icon_style, f"{{{kml_ns}}}color")
            color.text = info["color"]
            scale = ET.SubElement(icon_style, f"{{{kml_ns}}}scale")
            scale.text = "0.5"
            icon = ET.SubElement(icon_style, f"{{{kml_ns}}}Icon")
            href = ET.SubElement(icon, f"{{{kml_ns}}}href")
            href.text = "http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png"

    # Create folders for each category
    for cat_id, info in HAZARD_CATEGORIES.items():
        if cat_counts.get(cat_id, 0) == 0:
            continue
        if cat_id == "utility_pole" and not include_poles:
            continue

        folder = ET.SubElement(doc, f"{{{kml_ns}}}Folder")
        folder_name = ET.SubElement(folder, f"{{{kml_ns}}}name")
        folder_name.text = f"{info['label']} ({cat_counts[cat_id]})"

        folder_desc = ET.SubElement(folder, f"{{{kml_ns}}}description")
        folder_desc.text = info["description"]

        # Default visibility: poles off, lines on
        visibility = ET.SubElement(folder, f"{{{kml_ns}}}visibility")
        visibility.text = "0" if cat_id == "utility_pole" else "1"

        # Add ways (lines) for this category
        for el, el_cat in ways:
            if el_cat != cat_id:
                continue

            node_refs = el.get("nodes", [])
            coords = []
            for nid in node_refs:
                if nid in nodes:
                    lon, lat = nodes[nid]
                    coords.append(f"{lon},{lat},0")

            if len(coords) < 2:
                continue

            pm = ET.SubElement(folder, f"{{{kml_ns}}}Placemark")
            pm_name = ET.SubElement(pm, f"{{{kml_ns}}}name")
            pm_name.text = build_element_name(el, el_cat)

            style_url = ET.SubElement(pm, f"{{{kml_ns}}}styleUrl")
            style_url.text = f"#style_{cat_id}"

            # Add OSM tags as description
            tags = el.get("tags", {})
            if tags:
                pm_desc = ET.SubElement(pm, f"{{{kml_ns}}}description")
                tag_lines = [f"{k}: {v}" for k, v in sorted(tags.items())]
                tag_lines.append(f"\nOSM Way ID: {el['id']}")
                pm_desc.text = "\n".join(tag_lines)

            line_string = ET.SubElement(pm, f"{{{kml_ns}}}LineString")
            tessellate = ET.SubElement(line_string, f"{{{kml_ns}}}tessellate")
            tessellate.text = "1"
            coordinates = ET.SubElement(line_string, f"{{{kml_ns}}}coordinates")
            coordinates.text = " ".join(coords)

        # Add points (poles/towers) for this category
        for el, el_cat in points:
            if el_cat != cat_id:
                continue

            lon = el.get("lon", 0)
            lat = el.get("lat", 0)

            pm = ET.SubElement(folder, f"{{{kml_ns}}}Placemark")
            pm_name = ET.SubElement(pm, f"{{{kml_ns}}}name")
            pm_name.text = build_element_name(el, el_cat)

            style_url = ET.SubElement(pm, f"{{{kml_ns}}}styleUrl")
            style_url.text = f"#style_{cat_id}"

            tags = el.get("tags", {})
            if tags:
                pm_desc = ET.SubElement(pm, f"{{{kml_ns}}}description")
                tag_lines = [f"{k}: {v}" for k, v in sorted(tags.items())]
                tag_lines.append(f"\nOSM Node ID: {el['id']}")
                pm_desc.text = "\n".join(tag_lines)

            point = ET.SubElement(pm, f"{{{kml_ns}}}Point")
            coordinates = ET.SubElement(point, f"{{{kml_ns}}}coordinates")
            coordinates.text = f"{lon},{lat},0"

    # Write KML
    tree = ET.ElementTree(kml)
    ET.indent(tree, space="  ")
    tree.write(output_file, xml_declaration=True, encoding="UTF-8")

    print(f"\nKML written to: {output_file}")
    print(f"File size: {round(os.path.getsize(output_file) / 1024, 1)} KB")


def main():
    parser = argparse.ArgumentParser(
        description="Extract overhead wire hazards from OSM for SAR UAS safety briefings.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Default: El Dorado + Placer Counties + Hwy 50 corridor
  python3 sar_wire_hazards_kml.py

  # Single county
  python3 sar_wire_hazards_kml.py --area "El Dorado County"

  # Custom bounding box (south,west,north,east)
  python3 sar_wire_hazards_kml.py --bbox 38.7,-120.5,39.0,-120.0

  # Lines only (no poles - smaller file, cleaner map)
  python3 sar_wire_hazards_kml.py --no-poles

  # Custom output filename
  python3 sar_wire_hazards_kml.py -o my_hazards.kml
        """,
    )

    parser.add_argument(
        "--area",
        action="append",
        help="County or admin area name (can specify multiple). "
             "Defaults to El Dorado County + Placer County.",
    )
    parser.add_argument(
        "--bbox",
        type=str,
        help="Bounding box as south,west,north,east (decimal degrees). "
             "If used alone, queries ONLY the bbox area. "
             "If combined with --area, queries both.",
    )
    parser.add_argument(
        "--no-poles",
        action="store_true",
        help="Skip utility poles/towers (lines and cables only - smaller file).",
    )
    parser.add_argument(
        "-o", "--output",
        type=str,
        default=None,
        help="Output KML filename (default: auto-generated from area names).",
    )

    args = parser.parse_args()

    # Parse bbox first so we know if it was provided
    bbox = None
    if args.bbox:
        try:
            bbox = tuple(float(x) for x in args.bbox.split(","))
            if len(bbox) != 4:
                raise ValueError
        except ValueError:
            print("Error: --bbox must be 4 comma-separated decimal values (e.g., 38.7,-120.5,39.0,-120.0)")
            sys.exit(1)

        # Auto-correct coordinate order
        # Users often swap south/north or west/east when grabbing from a map.
        # Overpass requires south < north and west < east.
        s, w, n, e = bbox
        corrected = False
        if s > n:
            s, n = n, s
            corrected = True
        if w > e:
            w, e = e, w
            corrected = True
        if corrected:
            print(f"NOTE: Bbox coordinates were out of order, auto-corrected to: {s},{w},{n},{e}")
            print(f"      (Format is south,west,north,east)\n")
        bbox = (s, w, n, e)

    # Determine areas
    # Priority logic:
    #   --area provided           -> use those areas (+ bbox if also given)
    #   --bbox provided (no area) -> bbox ONLY, no default areas
    #   neither provided          -> defaults (El Dorado + Placer + Hwy 50 bbox)
    if args.area:
        areas = [{"name": a, "type": "area"} for a in args.area]
    elif bbox:
        # bbox-only mode: don't add default county areas
        areas = []
    else:
        # No args at all: use defaults
        areas = DEFAULT_AREAS
        bbox = HWY50_BBOX

    # Determine output filename
    if args.output:
        output_file = args.output
    else:
        if areas:
            area_slug = "_".join(a["name"].replace(" ", "").replace("County", "Co")
                                for a in areas)
            output_file = f"wire_hazards_{area_slug}.kml"
        else:
            # bbox-only: use coordinates in filename
            s, w, n, e = bbox
            output_file = f"wire_hazards_bbox_{s}_{w}_{n}_{e}.kml"

    include_poles = not args.no_poles

    print("=" * 60)
    print("SAR Overhead Wire Hazard Extractor")
    print("=" * 60)
    if areas:
        print(f"Areas: {', '.join(a['name'] for a in areas)}")
    if bbox:
        print(f"Bounding box: {bbox}")
    if not areas and not bbox:
        print("ERROR: No area or bounding box specified.")
        sys.exit(1)
    print(f"Include poles/towers: {include_poles}")
    print(f"Output: {output_file}")
    print()

    # Build and execute query
    query = build_overpass_query(areas=areas, bbox=bbox, include_poles=include_poles)

    print("--- Overpass Query ---")
    print(query[:500] + ("..." if len(query) > 500 else ""))
    print("--- End Query ---\n")

    data = fetch_overpass(query)

    # Generate KML
    generate_kml(data, output_file, include_poles=include_poles)

    print()
    print("=" * 60)
    print("IMPORT INTO CALTOPO:")
    print("  1. Open your CalTopo map")
    print("  2. Click 'Import' in the left panel under Map Objects")
    print("  3. Select this KML file")
    print("  4. Features will appear organized by hazard type")
    print()
    print("IMPORTANT SAFETY NOTE:")
    print("  This data may be INCOMPLETE. Not all wires are mapped.")
    print("  Rural distribution lines and telecom drops are often missing.")
    print("  Always conduct a visual scan for overhead wires during ops.")
    print("=" * 60)


if __name__ == "__main__":
    main()
