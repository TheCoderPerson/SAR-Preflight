const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// ---- Leaflet mock ----
class MockGroup {
  constructor(layers) { this._layers = layers || []; }
  getLayers() { return this._layers.slice(); }
  addLayer(l) { this._layers.push(l); }
  clearLayers() { this._layers.length = 0; }
  addTo() { return this; }
}
class MCircle {
  constructor(latlng, opts) { this._ll = latlng; this.options = opts || {}; }
  getBounds() {
    return [[this._ll[0] - 0.01, this._ll[1] - 0.01], [this._ll[0] + 0.01, this._ll[1] + 0.01]];
  }
  bindPopup() { return this; }
  bindTooltip() { return this; }
  on() {} off() {}
}
globalThis.L = {
  Polygon: class {}, Polyline: class {}, Marker: class {}, Circle: MCircle, CircleMarker: class {},
  layerGroup: (init) => new MockGroup(init),
  circle: (ll, opts) => new MCircle(ll, opts),
  geoJSON: () => ({ bindPopup() { return this; }, on() {}, off() {} }),
};

const app = require('../../sar-preflight.js');
const {
  S, searchAnchor, _noteDeviceFix, DEVICE_FIX_MAX_AGE_MS,
  enterCoords, closeCoordSearch, submitCoordSearch, runGeocodeSearch,
  pickGeocodeResult, _applyCoordTarget, _renderGeocodeResults,
} = app;

const FX = require('../fixtures/nominatim-search.json');

const EDC_CENTER = { lat: 38.685, lng: -120.99 };

// Records what the map was asked to do, so pan / fit / area are distinguishable.
function mkMap() {
  const calls = { setView: [], fitBounds: [] };
  return {
    _calls: calls,
    getCenter: () => ({ lat: EDC_CENTER.lat, lng: EDC_CENTER.lng }),
    getZoom: () => 11,
    setView: (ll, z) => { calls.setView.push({ ll, z }); },
    fitBounds: (b, o) => { calls.fitBounds.push({ b, o }); },
    hasLayer: () => true, addLayer: () => {}, removeLayer: () => {}, on: () => {}, off: () => {},
    distance: () => 1500,
  };
}

const MODAL_HTML = `
  <div class="modal-overlay" id="coordSearchModal">
    <input type="text" id="coordSearchInput">
    <div id="coordSearchStatus" class="fetch-status"></div>
    <div id="coordSearchResults"></div>
    <input type="checkbox" id="coordSearchAreaChk">
    <input type="number" id="coordSearchRadius" value="2000" disabled>
    <button id="coordSearchBtn">GO</button>
  </div>`;

function setQuery(v) { document.getElementById('coordSearchInput').value = v; }
function statusText() { return document.getElementById('coordSearchStatus').textContent; }
function rows() { return document.querySelectorAll('#coordSearchResults .geo-result'); }

let fetchCalls;

beforeEach(() => {
  document.body.innerHTML = MODAL_HTML;
  fetchCalls = [];
  S.map = mkMap();
  S.drawnItems = new MockGroup();
  S.mapLayers = {};
  S.deviceFix = null;
  S._geocodeResults = []; S._geocodeAnchor = null; S._geocodeQuery = '';
  S._geocodeAbort = null; S._geocodeGen = 0; S._geocodeLastAt = 0;
  S._geocodeSel = -1; S._geocodeMemo = null;
  globalThis.isOnline = () => true;
});

afterEach(() => {
  document.body.innerHTML = '';
  S.map = null; S.drawnItems = null; S.deviceFix = null;
  delete globalThis.fetch;
  delete globalThis.isOnline;
  delete globalThis.getCachedApiResponse;
  delete globalThis.cacheApiResponse;
});

function stubFetch(payload, opts) {
  opts = opts || {};
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: opts.status ? opts.status < 400 : true,
      status: opts.status || 200,
      headers: { get: () => null },
      json: async () => payload,
    };
  };
}

// ============================================================
// The contract: coordinates never touch the network.
// ============================================================
describe('submitCoordSearch — coordinates bypass the network entirely', () => {
  it('issues ZERO fetches for every supported coordinate format', async () => {
    stubFetch(FX.mountBaldy);
    for (const s of [
      '38.78673, -120.61770',
      "38°47.204', -120°37.062'",
      '38 47 12, -120 37 04',
      '10S 0706918E 4295806N',
    ]) {
      setQuery(s);
      await submitCoordSearch();
      expect(fetchCalls).toEqual([]);          // the whole point
    }
  });

  it('pans without a radius, preserving the pre-existing behavior', async () => {
    stubFetch(FX.mountBaldy);
    setQuery('38.78673, -120.61770');
    await submitCoordSearch();
    expect(fetchCalls).toEqual([]);
    expect(S.map._calls.setView).toHaveLength(1);
    expect(S.map._calls.setView[0].ll[0]).toBeCloseTo(38.78673, 5);
    expect(S.map._calls.setView[0].z).toBe(13);   // max(getZoom()=11, 13)
    expect(S.drawnItems.getLayers()).toHaveLength(0);
  });

  it('builds the op area when the coordinate string carries a radius', async () => {
    stubFetch(FX.mountBaldy);
    setQuery('38.78673, -120.61770, 2000');
    await submitCoordSearch();
    expect(fetchCalls).toEqual([]);
    const layers = S.drawnItems.getLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].options.radius).toBe(2000);
    expect(S.map._calls.fitBounds).toHaveLength(1);
  });

  it('closes the modal after applying a coordinate', async () => {
    stubFetch(FX.mountBaldy);
    setQuery('38.78673, -120.61770');
    await submitCoordSearch();
    expect(document.getElementById('coordSearchModal').classList.contains('active')).toBe(false);
  });

  it('reports an empty box without searching', async () => {
    stubFetch(FX.mountBaldy);
    setQuery('   ');
    await submitCoordSearch();
    expect(fetchCalls).toEqual([]);
    expect(statusText()).toMatch(/place name/i);
  });
});

// ============================================================
// The search path.
// ============================================================
describe('runGeocodeSearch — query, rank, render', () => {
  it('issues exactly one request, biased around the anchor', async () => {
    stubFetch(FX.mountBaldy);
    setQuery('Mount Baldy');
    await submitCoordSearch();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain('nominatim.openstreetmap.org');
    expect(fetchCalls[0]).toContain('q=Mount%20Baldy');
    expect(fetchCalls[0]).toContain('viewbox=');
  });

  it('renders results nearest-first with distance and the FULL matched name', async () => {
    stubFetch(FX.mountBaldy);
    setQuery('Mount Baldy');
    await submitCoordSearch();

    const r = rows();
    expect(r).toHaveLength(4);
    // Nearest first — Washoe County (~108 km), not the provider's importance order.
    expect(r[0].querySelector('.geo-title').textContent).toBe('Mount Baldy');
    expect(r[0].querySelector('.geo-meta').textContent).toContain('Washoe County, Nevada');
    expect(r[0].querySelector('.geo-dist').textContent).toMatch(/mi$/);
    // Every row shows the provider's complete display_name, untruncated.
    r.forEach((el, i) => {
      expect(el.querySelector('.geo-sub').textContent).toBe(S._geocodeResults[i].displayName);
      expect(el.querySelector('.geo-sub').textContent).not.toContain('…');
    });
    expect(statusText()).toContain('4 matches');
  });

  it('names the query back in the empty state instead of rendering a silent blank', async () => {
    stubFetch(FX.empty);
    setQuery('Nonexistent Butte');
    await submitCoordSearch();
    expect(rows()).toHaveLength(0);
    const empty = document.querySelector('#coordSearchResults .geo-empty');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('Nonexistent Butte');
    expect(statusText()).toContain('No matches');
  });

  it('warns when a street-number query only matched a road', async () => {
    stubFetch(FX.addressRoadOnly);
    setQuery('4750 Golden Foothill Pkwy, El Dorado Hills, CA 95762');
    await submitCoordSearch();
    const warn = document.querySelector('#coordSearchResults .geo-warn');
    expect(warn).not.toBeNull();
    expect(warn.textContent).toMatch(/street-number/i);
  });

  it('stays silent when the street number actually matched', async () => {
    stubFetch(FX.addressExact);
    setQuery('2850 Fairlane Ct, Placerville, CA 95667');
    await submitCoordSearch();
    expect(document.querySelector('#coordSearchResults .geo-warn')).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('escapes markup in a query so the empty state cannot inject HTML', async () => {
    stubFetch(FX.empty);
    setQuery('<img src=x onerror=alert(1)>');
    await submitCoordSearch();
    const empty = document.querySelector('#coordSearchResults .geo-empty');
    expect(empty.querySelector('img')).toBeNull();
    expect(empty.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ============================================================
// Failure states.
// ============================================================
describe('failure and degradation', () => {
  it('treats a 429 as an explicit rate-limited state and does NOT retry', async () => {
    stubFetch({}, { status: 429 });
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    expect(fetchCalls).toHaveLength(1);            // exactly one — no retry storm
    expect(statusText()).toMatch(/busy/i);
    expect(document.getElementById('coordSearchStatus').className).toContain('error');
  });

  it('treats a 403 the same way', async () => {
    stubFetch({}, { status: 403 });
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    expect(fetchCalls).toHaveLength(1);
    expect(statusText()).toMatch(/busy/i);
  });

  it('falls back to the IndexedDB cache when the network fails', async () => {
    globalThis.fetch = async () => { fetchCalls.push('x'); throw new Error('network down'); };
    globalThis.getCachedApiResponse = async (endpoint, key) => {
      expect(endpoint).toBe('geocode');
      expect(key).toContain('jenkinson%20lake');
      return { data: FX.jenkinsonLake, timestamp: Date.now() - 3 * 86400000 };
    };
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    expect(rows()).toHaveLength(1);
    expect(statusText()).toContain('cached');
    expect(statusText()).toContain('3d ago');
  });

  it('finds a cached query even though the map has moved since it was cached', async () => {
    // The cache key embeds the anchor, so an exact lookup misses after a pan.
    // Offline that would read as "no such place" despite having the answer.
    globalThis.isOnline = () => false;
    globalThis.getCachedApiResponse = async () => null;              // exact key: miss
    const seen = [];
    globalThis.getCachedApiResponsesByPrefix = async (endpoint, prefix) => {
      seen.push({ endpoint, prefix });
      return [
        { data: FX.jenkinsonLake, timestamp: 2000, areaKey: 'jenkinson%20lake|38.7,-121.0' },
        { data: [], timestamp: 1000, areaKey: 'jenkinson%20lake|39.5,-120.0' },
      ];
    };
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    expect(seen[0].endpoint).toBe('geocode');
    expect(seen[0].prefix).toBe('jenkinson%20lake|');   // query part only, anchor stripped
    expect(rows()).toHaveLength(1);
    expect(statusText()).toContain('cached');
    delete globalThis.getCachedApiResponsesByPrefix;
  });

  it('re-ranks a cached result set against the CURRENT anchor, not the cached one', async () => {
    globalThis.isOnline = () => false;
    globalThis.getCachedApiResponse = async () => (
      { data: FX.mountBaldy, timestamp: Date.now() - 86400000 }
    );
    // Sitting near the Humboldt CA peak now, even though it was cached from EDC.
    _noteDeviceFix({ coords: { latitude: 40.38, longitude: -123.87 }, timestamp: Date.now() });
    setQuery('Mount Baldy');
    await submitCoordSearch();
    expect(S._geocodeResults[0].admin).toBe('Humboldt County, California');
    expect(statusText()).toContain('cached');
  });

  it('offline with no cache says so and points at coordinate entry', async () => {
    globalThis.isOnline = () => false;
    globalThis.fetch = async () => { fetchCalls.push('x'); return { ok: true, json: async () => [] }; };
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    expect(fetchCalls).toEqual([]);                // never even attempted
    expect(statusText()).toMatch(/offline/i);
    expect(statusText()).toMatch(/coordinates/i);
  });

  it('renders the error empty-state, not a blank list, when the search fails outright', async () => {
    globalThis.fetch = async () => { throw new Error('boom'); };
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    const empty = document.querySelector('#coordSearchResults .geo-empty');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toMatch(/coordinates/i);
  });
});

// ============================================================
// Staleness / rate limiting / caching.
// ============================================================
describe('staleness and rate limiting', () => {
  it('a superseded search never repaints over the newer one', async () => {
    let release;
    const gate = new Promise(res => { release = res; });
    globalThis.fetch = async (url) => {
      fetchCalls.push(url);
      if (fetchCalls.length === 1) { await gate; return { ok: true, status: 200, headers: { get: () => null }, json: async () => FX.mountBaldy }; }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => FX.jenkinsonLake };
    };
    const slow = runGeocodeSearch('Mount Baldy');   // will resolve LAST
    await runGeocodeSearch('Jenkinson Lake');       // supersedes it
    release();
    await slow;
    // The stale response must not have overwritten the newer render.
    expect(S._geocodeResults).toHaveLength(1);
    expect(S._geocodeResults[0].name).toBe('Jenkinson Lake');
    expect(rows()).toHaveLength(1);
  });

  it('closing the modal prevents an in-flight search from repainting', async () => {
    let release;
    const gate = new Promise(res => { release = res; });
    globalThis.fetch = async (url) => {
      fetchCalls.push(url);
      await gate;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => FX.mountBaldy };
    };
    const p = runGeocodeSearch('Mount Baldy');
    closeCoordSearch();
    release();
    await p;
    expect(rows()).toHaveLength(0);
    expect(S._geocodeResults).toEqual([]);
  });

  it('a repeated query in one session hits the memo and costs no request', async () => {
    stubFetch(FX.jenkinsonLake);
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    expect(fetchCalls).toHaveLength(1);
    document.getElementById('coordSearchInput').value = 'jenkinson lake';  // case-insensitive key
    await submitCoordSearch();
    expect(fetchCalls).toHaveLength(1);            // still one
    expect(rows()).toHaveLength(1);
  });

  it('writes successful results to the IndexedDB cache under the geocode endpoint', async () => {
    const writes = [];
    globalThis.cacheApiResponse = (endpoint, key, data) => { writes.push({ endpoint, key, data }); };
    stubFetch(FX.jenkinsonLake);
    setQuery('Jenkinson Lake');
    await submitCoordSearch();
    expect(writes).toHaveLength(1);
    expect(writes[0].endpoint).toBe('geocode');
    expect(writes[0].data).toEqual(FX.jenkinsonLake);
  });

  it('spaces consecutive live requests by at least the policy interval', async () => {
    const at = [];
    globalThis.fetch = async (url) => {
      at.push(Date.now());
      fetchCalls.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => FX.mountBaldy };
    };
    await runGeocodeSearch('query one');
    await runGeocodeSearch('query two');       // distinct query -> memo miss -> real fetch
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(core.GEOCODE_MIN_INTERVAL_MS - 50);
  }, 10000);
});

// ============================================================
// Selection -> pan / fit / create area.
// ============================================================
describe('pickGeocodeResult', () => {
  async function search(payload, q) {
    stubFetch(payload);
    setQuery(q);
    await submitCoordSearch();
  }

  it('fits the feature extent when the result has a usable bbox', async () => {
    await search(FX.jenkinsonLake, 'Jenkinson Lake');
    pickGeocodeResult(0);
    expect(S.map._calls.fitBounds).toHaveLength(1);
    expect(S.map._calls.setView).toHaveLength(0);
    const [[s, w], [n, e]] = S.map._calls.fitBounds[0].b;
    expect(s).toBeCloseTo(38.7146812, 6);
    expect(w).toBeCloseTo(-120.5732408, 6);
    expect(n).toBeCloseTo(38.7371481, 6);
    expect(e).toBeCloseTo(-120.5288582, 6);
  });

  it('pans with a minimum zoom when the bbox is house-sized', async () => {
    await search(FX.addressExact, '2850 Fairlane Ct, Placerville, CA 95667');
    pickGeocodeResult(0);
    expect(S.map._calls.setView).toHaveLength(1);
    expect(S.map._calls.fitBounds).toHaveLength(0);
    expect(S.map._calls.setView[0].z).toBe(13);
  });

  it('creates the op area when the checkbox is on, overriding the extent fit', async () => {
    await search(FX.jenkinsonLake, 'Jenkinson Lake');
    document.getElementById('coordSearchAreaChk').checked = true;
    document.getElementById('coordSearchRadius').value = '1500';
    pickGeocodeResult(0);
    const layers = S.drawnItems.getLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].options.radius).toBe(1500);
  });

  it('ignores an out-of-range index', async () => {
    await search(FX.jenkinsonLake, 'Jenkinson Lake');
    pickGeocodeResult(99);
    pickGeocodeResult(-1);
    expect(S.map._calls.fitBounds).toHaveLength(0);
    expect(S.map._calls.setView).toHaveLength(0);
  });

  it('closes the modal after a pick', async () => {
    document.getElementById('coordSearchModal').classList.add('active');
    await search(FX.jenkinsonLake, 'Jenkinson Lake');
    document.getElementById('coordSearchModal').classList.add('active');
    pickGeocodeResult(0);
    expect(document.getElementById('coordSearchModal').classList.contains('active')).toBe(false);
  });
});

// ============================================================
// The ranking anchor.
// ============================================================
describe('searchAnchor', () => {
  it('uses the map center when there is no device fix', () => {
    const a = searchAnchor();
    expect(a.source).toBe('map');
    expect(a.lat).toBeCloseTo(EDC_CENTER.lat, 6);
  });

  it('prefers a recent GPS fix over the map center', () => {
    _noteDeviceFix({ coords: { latitude: 39.1, longitude: -120.2, accuracy: 8 }, timestamp: Date.now() });
    const a = searchAnchor();
    expect(a.source).toBe('gps');
    expect(a.lat).toBeCloseTo(39.1, 6);
    expect(a.at).toBeGreaterThan(0);
  });

  it('falls back to the map center once the fix goes stale', () => {
    _noteDeviceFix({
      coords: { latitude: 39.1, longitude: -120.2, accuracy: 8 },
      timestamp: Date.now() - (DEVICE_FIX_MAX_AGE_MS + 60000),
    });
    expect(searchAnchor().source).toBe('map');
  });

  it('NEVER calls navigator.geolocation — a search must not provoke a permission prompt', () => {
    let called = 0;
    const prev = globalThis.navigator && globalThis.navigator.geolocation;
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      value: { getCurrentPosition: () => { called++; }, watchPosition: () => { called++; } },
      configurable: true,
    });
    searchAnchor();
    expect(called).toBe(0);
    Object.defineProperty(globalThis.navigator, 'geolocation', { value: prev, configurable: true });
  });

  it('ignores a garbage fix rather than ranking from NaN', () => {
    _noteDeviceFix({ coords: { latitude: NaN, longitude: -120.2 }, timestamp: Date.now() });
    expect(S.deviceFix).toBeNull();
    expect(searchAnchor().source).toBe('map');
    _noteDeviceFix(null);
    expect(S.deviceFix).toBeNull();
  });

  it('returns null when there is no fix and no map', () => {
    S.map = null;
    expect(searchAnchor()).toBeNull();
  });

  it('ranks results from the GPS fix when one is present', async () => {
    // A fix near the Humboldt County CA peak flips which "Mount Baldy" wins.
    _noteDeviceFix({ coords: { latitude: 40.38, longitude: -123.87 }, timestamp: Date.now() });
    stubFetch(FX.mountBaldy);
    setQuery('Mount Baldy');
    await submitCoordSearch();
    expect(S._geocodeAnchor.source).toBe('gps');
    expect(S._geocodeResults[0].admin).toBe('Humboldt County, California');
  });
});
