const { routeStrategy, latlngToTile, getCacheName } = require('../../sw.js');

describe('routeStrategy(url)', () => {
  it('routes map tiles to cache-first', () => {
    expect(routeStrategy('https://a.basemaps.cartocdn.com/dark_all/11/335/785.png')).toBe('cache-first');
    expect(routeStrategy('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/11/785/335')).toBe('cache-first');
    expect(routeStrategy('https://a.tile.opentopomap.org/11/335/785.png')).toBe('cache-first');
  });

  it('routes CDN assets to cache-first', () => {
    expect(routeStrategy('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js')).toBe('cache-first');
    expect(routeStrategy('https://fonts.googleapis.com/css2?family=JetBrains+Mono')).toBe('cache-first');
    expect(routeStrategy('https://fonts.gstatic.com/s/jetbrainsmono/v1/font.woff2')).toBe('cache-first');
  });

  it('routes radar tiles to network-only', () => {
    expect(routeStrategy('https://tilecache.rainviewer.com/v2/radar/123/256/11/335/785/2/1_1.png')).toBe('network-only');
  });

  it('routes API endpoints to network-first', () => {
    expect(routeStrategy('https://api.open-meteo.com/v1/forecast?lat=38')).toBe('network-first');
    expect(routeStrategy('https://air-quality-api.open-meteo.com/v1/air-quality?lat=38')).toBe('network-first');
    expect(routeStrategy('https://api.open-elevation.com/api/v1/lookup')).toBe('network-first');
    expect(routeStrategy('https://api.sunrise-sunset.org/json?lat=38')).toBe('network-first');
    expect(routeStrategy('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json')).toBe('network-first');
    expect(routeStrategy('https://overpass-api.de/api/interpreter')).toBe('network-first');
    expect(routeStrategy('https://api.weather.gov/alerts/active?point=38,-120')).toBe('network-first');
    expect(routeStrategy('https://api.rainviewer.com/public/weather-maps.json')).toBe('network-first');
  });

  it('routes app shell to cache-first (default)', () => {
    expect(routeStrategy('http://localhost:3000/sar-preflight.html')).toBe('cache-first');
    expect(routeStrategy('http://localhost:3000/sar-preflight.js')).toBe('cache-first');
    expect(routeStrategy('http://localhost:3000/manifest.json')).toBe('cache-first');
  });
});

describe('latlngToTile(lat, lng, zoom)', () => {
  it('calculates correct tile for El Dorado County at z=11', () => {
    const tile = latlngToTile(38.685, -120.99, 11);
    expect(tile.x).toBe(335);
    expect(tile.y).toBe(785);
  });

  it('calculates correct tile at z=14', () => {
    const tile = latlngToTile(38.685, -120.99, 14);
    expect(tile.x).toBe(2685);
    expect(tile.y).toBe(6280);
  });

  it('calculates correct tile at equator/prime meridian', () => {
    const tile = latlngToTile(0, 0, 1);
    expect(tile.x).toBe(1);
    expect(tile.y).toBe(1);
  });

  it('handles negative coordinates', () => {
    const tile = latlngToTile(-33.8688, 151.2093, 10);
    expect(tile.x).toBeGreaterThan(0);
    expect(tile.y).toBeGreaterThan(0);
  });

  it('tile count scales with zoom level', () => {
    const t10 = latlngToTile(38.685, -120.99, 10);
    const t11 = latlngToTile(38.685, -120.99, 11);
    // At z+1, x and y are in range [2*prev, 2*prev+1] due to integer flooring
    expect(t11.x).toBeGreaterThanOrEqual(t10.x * 2);
    expect(t11.x).toBeLessThanOrEqual(t10.x * 2 + 1);
    expect(t11.y).toBeGreaterThanOrEqual(t10.y * 2);
    expect(t11.y).toBeLessThanOrEqual(t10.y * 2 + 1);
  });
});

describe('getCacheName(url)', () => {
  it('returns CACHE_TILES for tile URLs', () => {
    expect(getCacheName('https://a.basemaps.cartocdn.com/dark_all/11/335/785.png')).toBe('sar-tiles-v1');
  });

  it('returns CACHE_CDN for CDN URLs', () => {
    expect(getCacheName('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js')).toBe('sar-cdn-v1');
  });

  it('returns CACHE_STATIC for other URLs', () => {
    expect(getCacheName('http://localhost:3000/sar-preflight.html')).toBe('sar-static-v1');
  });
});
