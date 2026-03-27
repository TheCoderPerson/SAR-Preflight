// ============================================================
// SAR Preflight — FAA VFR Chart Import & Tile Generation
// Reads FAA GeoTIFF sectional charts, reprojects from Lambert
// Conformal Conic to Web Mercator, slices into map tiles.
// ============================================================

// Sanitize a chart filename into a URL-safe namespace identifier
function sanitizeChartName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().substring(0, 40);
}

// Process an FAA VFR sectional chart GeoTIFF file
// options.collarMargin: fraction of image to trim from each edge (default 0.03 = 3%)
// options.chartId: override the auto-generated chart namespace ID
async function processVFRChart(file, onProgress, options) {
  if (!options) options = {};
  if (typeof GeoTIFF === 'undefined') throw new Error('GeoTIFF library not loaded');
  if (typeof proj4 === 'undefined') throw new Error('proj4 library not loaded');

  onProgress('Reading GeoTIFF...', 0);
  const arrayBuffer = await file.arrayBuffer();
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();
  onProgress(`Image: ${width}x${height}`, 5);

  // Extract georeferencing from GeoTIFF metadata
  const tiepoints = image.getTiePoints();
  const pixelScale = image.getFileDirectory().ModelPixelScale;
  const geoKeys = image.getGeoKeys();

  if (!tiepoints || !tiepoints.length || !pixelScale) {
    throw new Error('GeoTIFF missing georeferencing data (tiepoints/pixel scale)');
  }

  // Build the proj4 projection string from GeoTIFF keys
  const lccDef = buildLCCProjection(geoKeys, image);
  onProgress('Projection: ' + (lccDef ? 'LCC detected' : 'unknown'), 8);

  if (!lccDef) throw new Error('Could not determine chart projection. Only Lambert Conformal Conic charts are supported.');

  // Set up coordinate transform: LCC → WGS84 (lat/lng)
  proj4.defs('LCC_CHART', lccDef);
  proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
  const toLatLng = proj4('LCC_CHART', 'EPSG:4326');
  const fromLatLng = proj4('EPSG:4326', 'LCC_CHART');

  // Calculate geographic bounds (4 corners)
  const tp = tiepoints[0];
  const originX = tp.x - tp.i * pixelScale[0];
  const originY = tp.y + tp.j * pixelScale[1]; // note: pixelScale[1] is positive, Y increases upward
  const endX = originX + width * pixelScale[0];
  const endY = originY - height * pixelScale[1];

  const corners = {
    nw: toLatLng.forward([originX, originY]),
    ne: toLatLng.forward([endX, originY]),
    sw: toLatLng.forward([originX, endY]),
    se: toLatLng.forward([endX, endY]),
  };

  const bounds = {
    north: Math.max(corners.nw[1], corners.ne[1]),
    south: Math.min(corners.sw[1], corners.se[1]),
    west: Math.min(corners.nw[0], corners.sw[0]),
    east: Math.max(corners.ne[0], corners.se[0]),
  };

  onProgress(`Bounds: ${bounds.south.toFixed(2)}°N to ${bounds.north.toFixed(2)}°N`, 10);

  // Read raster data
  onProgress('Reading raster data...', 12);
  const rasters = await image.readRasters();
  const numBands = rasters.length;

  // Handle palette-indexed images (1 band + color map) vs RGB (3 bands)
  let colorMap = null;
  if (numBands === 1) {
    const fd = image.getFileDirectory();
    colorMap = fd.ColorMap; // [R0,R1,...,G0,G1,...,B0,B1,...] scaled 0-65535
  }

  // Collar trimming: exclude a margin band from each edge to remove border text/legends
  const collarMargin = options.collarMargin != null ? options.collarMargin : 0.03;
  const marginPxW = Math.round(width * collarMargin);
  const marginPxH = Math.round(height * collarMargin);

  // Chart namespace for tile URLs (allows multiple charts)
  const chartId = options.chartId || sanitizeChartName(file.name);

  onProgress('Raster loaded, generating tiles...', 15);

  // Determine zoom levels to generate
  // Pixel scale ~42m → native resolution is roughly z=12 (38m/px at equator)
  const zoomLevels = [7, 8, 9, 10, 11, 12];
  const tiles = [];
  let totalTiles = 0;

  // Count total tiles first for progress
  for (const z of zoomLevels) {
    const swTile = latlngToTileCoord(bounds.south, bounds.west, z);
    const neTile = latlngToTileCoord(bounds.north, bounds.east, z);
    totalTiles += (neTile.x - swTile.x + 1) * (swTile.y - neTile.y + 1);
  }

  onProgress(`Generating ${totalTiles} tiles across z=${zoomLevels[0]}-${zoomLevels[zoomLevels.length-1]}...`, 18);

  let processed = 0;
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = 256;
  tileCanvas.height = 256;
  const tileCtx = tileCanvas.getContext('2d');

  for (const z of zoomLevels) {
    const swTile = latlngToTileCoord(bounds.south, bounds.west, z);
    const neTile = latlngToTileCoord(bounds.north, bounds.east, z);

    for (let tx = swTile.x; tx <= neTile.x; tx++) {
      for (let ty = neTile.y; ty <= swTile.y; ty++) {
        // Calculate this tile's geographic bounds
        const tileBounds = tileBoundsLatLng(tx, ty, z);

        // Render the chart onto this 256x256 tile
        const imageData = tileCtx.createImageData(256, 256);
        const pixels = imageData.data;

        for (let py = 0; py < 256; py++) {
          for (let px = 0; px < 256; px++) {
            // Pixel center in lat/lng
            const lng = tileBounds.west + (px + 0.5) / 256 * (tileBounds.east - tileBounds.west);
            const lat = tileBounds.north - (py + 0.5) / 256 * (tileBounds.north - tileBounds.south);

            // Transform to LCC coordinates
            const [projX, projY] = fromLatLng.forward([lng, lat]);

            // Map to source pixel coordinates
            const srcX = (projX - originX) / pixelScale[0];
            const srcY = (originY - projY) / pixelScale[1];

            const ix = Math.round(srcX);
            const iy = Math.round(srcY);

            if (ix >= marginPxW && ix < width - marginPxW && iy >= marginPxH && iy < height - marginPxH) {
              const offset = (py * 256 + px) * 4;
              let r, g, b;
              if (numBands >= 3) {
                r = rasters[0][iy * width + ix];
                g = rasters[1][iy * width + ix];
                b = rasters[2][iy * width + ix];
              } else if (colorMap) {
                const idx = rasters[0][iy * width + ix];
                const cmLen = colorMap.length / 3;
                r = Math.round(colorMap[idx] / 257);
                g = Math.round(colorMap[cmLen + idx] / 257);
                b = Math.round(colorMap[2 * cmLen + idx] / 257);
              } else {
                r = g = b = rasters[0][iy * width + ix];
              }
              // Collar/border removal is handled by the margin trim above.
              // No color-based transparency — white, green, and black are all
              // legitimate chart colors (text boxes, terrain, contour lines).
              pixels[offset] = r;
              pixels[offset + 1] = g;
              pixels[offset + 2] = b;
              pixels[offset + 3] = 255;
            }
            // else: transparent (outside chart coverage)
          }
        }

        tileCtx.putImageData(imageData, 0, 0);
        const blob = await new Promise(r => tileCanvas.toBlob(r, 'image/png'));
        const url = `https://local-tiles.sar-preflight/faa-sectional-${chartId}/${z}/${tx}/${ty}.png`;
        tiles.push({ url, blob, z, x: tx, y: ty });

        processed++;
        if (processed % 10 === 0 || processed === totalTiles) {
          const pct = Math.round(15 + (processed / totalTiles) * 80);
          onProgress(`Tile ${processed}/${totalTiles} (z=${z})`, pct);
        }
      }
    }
  }

  // Cache all tiles
  onProgress('Caching tiles...', 96);
  if ('caches' in window) {
    const cache = await caches.open('sar-tiles-v1');
    for (const tile of tiles) {
      const response = new Response(tile.blob, { headers: { 'Content-Type': 'image/png' } });
      await cache.put(new Request(tile.url), response);
    }
  }

  onProgress(`Done! ${tiles.length} tiles cached.`, 100);

  return {
    bounds,
    tileCount: tiles.length,
    zoomRange: [zoomLevels[0], zoomLevels[zoomLevels.length - 1]],
    chartName: file.name.replace(/\.[^.]+$/, ''),
    chartId,
  };
}

// Build a proj4 LCC projection string from GeoTIFF keys
function buildLCCProjection(geoKeys, image) {
  const fd = image.getFileDirectory();
  const geoDoubles = fd.GeoDoubleParams;
  const geoAscii = fd.GeoAsciiParams;

  // Check if it's LCC (ProjCoordTrans key 3075 = 8 means LCC, or check ASCII)
  if (geoAscii && !geoAscii.toLowerCase().includes('lambert')) {
    return null;
  }

  // Parse GeoKeyDirectory to find the EXACT mapping of GeoDoubleParams indices.
  // The GeoKeyDirectory tells us which index in GeoDoubleParams corresponds to
  // each projection parameter. This avoids assuming a fixed order.
  const geoKeyDir = fd.GeoKeyDirectory;
  if (geoKeyDir && geoDoubles) {
    const numKeys = geoKeyDir[3];
    const paramMap = {};
    // GeoKey IDs for LCC parameters:
    // 3078=StdParallel1, 3079=StdParallel2
    // 3084=FalseOriginLong, 3085=FalseOriginLat
    // 3080=NatOriginLong, 3081=NatOriginLat (alternative to 3084/3085)
    // 3082=FalseEasting, 3083=FalseNorthing
    // 3086=FalseOriginEasting, 3087=FalseOriginNorthing
    const keyNames = {
      3078: 'lat1', 3079: 'lat2',
      3080: 'lon0', 3081: 'lat0',
      3082: 'fe', 3083: 'fn',
      3084: 'lon0', 3085: 'lat0', // false origin variants
      3086: 'fe', 3087: 'fn',     // false origin variants
    };

    for (let i = 0; i < numKeys; i++) {
      const base = 4 + i * 4;
      const keyID = geoKeyDir[base];
      const locTag = geoKeyDir[base + 1];
      const valOffset = geoKeyDir[base + 3];
      if (locTag === 34736 && keyNames[keyID]) { // 34736 = GeoDoubleParams tag
        paramMap[keyNames[keyID]] = geoDoubles[valOffset];
      }
    }

    if (paramMap.lat1 !== undefined && paramMap.lat2 !== undefined && paramMap.lon0 !== undefined) {
      const lat0 = paramMap.lat0 ?? paramMap.lat1;
      const fe = paramMap.fe ?? 0;
      const fn = paramMap.fn ?? 0;
      return `+proj=lcc +lat_1=${paramMap.lat1} +lat_2=${paramMap.lat2} +lat_0=${lat0} +lon_0=${paramMap.lon0} +x_0=${fe} +y_0=${fn} +datum=NAD83 +units=m +no_defs`;
    }
  }

  // Fallback: if GeoKeyDirectory parsing fails, use raw GeoDoubleParams with correct FAA layout
  // FAA layout: [FalseOriginLat, FalseOriginLong, StdParallel1, StdParallel2, FE, FN, InvFlat, SemiMajor]
  if (geoDoubles && geoDoubles.length >= 4) {
    const lat0 = geoDoubles[0];
    const lon0 = geoDoubles[1];
    const lat1 = geoDoubles[2];
    const lat2 = geoDoubles[3];
    const fe = geoDoubles[4] || 0;
    const fn = geoDoubles[5] || 0;
    return `+proj=lcc +lat_1=${lat1} +lat_2=${lat2} +lat_0=${lat0} +lon_0=${lon0} +x_0=${fe} +y_0=${fn} +datum=NAD83 +units=m +no_defs`;
  }

  return null;
}

// Convert lat/lng to tile coordinates (same formula as sw.js)
function latlngToTileCoord(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

// Get geographic bounds of a tile
function tileBoundsLatLng(x, y, z) {
  const n = Math.pow(2, z);
  const west = x / n * 360 - 180;
  const east = (x + 1) / n * 360 - 180;
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { north, south, east, west };
}

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { processVFRChart, buildLCCProjection, latlngToTileCoord, tileBoundsLatLng, sanitizeChartName };
}
