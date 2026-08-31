// renderNotamsTab hydration must honor the IndexedDB record's staleness
// (classifyStaleness): an 'expired' record (>4x the 1 h TTL) is REFUSED with a
// loud CACHE EXPIRED pill + banner, while 'fresh'/'stale' hydrate loudly
// labeled as cached — never silently as if live.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

const layerGroupMock = () => ({ _layers: [], addLayer(x){ this._layers.push(x); }, clearLayers(){ this._layers = []; }, getLayers(){ return this._layers; }, addTo(){ return this; } });
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const { S, renderNotamsTab } = require('../../sar-preflight.js');

S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };

const center = { lat: 38.65, lng: -120.95 };

function setBody() {
  document.body.innerHTML = `
    <div id="autoCheckStatusSection" style="display:none;">
      <div id="autoCheckIndicator"></div>
      <span id="autoCheckStatus"></span>
      <button id="autoCheckReBtn" style="display:none;"></button>
      <div id="autoCheckDetail"></div>
    </div>
    <span id="notamStatus" class="fetch-status"></span>
    <div id="tfrStaleBanner"></div>
    <div id="notamDeepLinks"></div>
    <div id="tfrList"></div><span id="tfrCount"></span>
    <div id="meta_tfr"></div><div id="meta_notam"></div>
    <textarea id="notamPasteBox"></textarea>
    <div id="notamParseMsg"></div>
    <div id="notamList"></div>
    <span id="airClass"></span><span id="airLAANC"></span><span id="airLAANCAlt"></span>
    <span id="airNearAirport"></span><span id="airNearDist"></span><span id="airHeliports"></span>
  `;
}

const cachedTfr = { id: '6/4112', name: 'Wildfire', polygons: [[[38.6, -121.0], [38.6, -120.9], [38.7, -120.9], [38.7, -121.0]]] };
const cachedNotam = { id: '01/234', location: 'SAC', body: 'OBST TOWER' };

function makeRec(status, ageMs) {
  const ts = Date.now() - ageMs;
  return {
    status,
    timestamp: ts,
    data: {
      tfrs: [cachedTfr],
      notams: [cachedNotam],
      meta: { fileName: 'live', importedAtMs: ts, source: 'FAA GeoServer (live via proxy)' },
      notamMeta: { fetchedAtMs: ts, source: 'live' },
    },
  };
}

describe('renderNotamsTab hydration honors classifyStaleness', () => {
  beforeEach(() => {
    setBody();
    S.tfrs = []; S.importedNotams = [];
    S.tfrImportMeta = null; S.notamFetchMeta = null;
    S.restrictionCacheExpired = null;
    S.sectionMeta.tfr = null; S.sectionMeta.notam = null;
    S.areaCenter = center; S.currentArea = null;
    S.nearbyAirports = [];
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  });
  afterEach(() => {
    S.tfrs = []; S.importedNotams = []; S.tfrImportMeta = null; S.notamFetchMeta = null;
    S.restrictionCacheExpired = null;
    document.body.innerHTML = '';
    localStorage.removeItem('sar_canopy_proxy');
    delete globalThis.getCachedApiResponse;
    delete globalThis.areaKey;
  });

  it('EXPIRED record is refused: nothing hydrates, red pulsing pill + EXPIRED banner', async () => {
    globalThis.getCachedApiResponse = async () => makeRec('expired', 3 * 86400000); // 3 days old
    await renderNotamsTab(center.lat, center.lng);
    expect(S.tfrs.length).toBe(0);
    expect(S.importedNotams.length).toBe(0);
    expect(document.getElementById('notamStatus').className).toContain('expired');
    const banner = document.getElementById('tfrStaleBanner').textContent;
    expect(banner).toMatch(/EXPIRED/);
    expect(banner).toMatch(/1800wxbrief\.com/);
    expect(S.restrictionCacheExpired).toBeTruthy();
  });

  it('FRESH record hydrates, marked cached — banner says fetched + (cached)', async () => {
    globalThis.getCachedApiResponse = async () => makeRec('fresh', 5 * 60000); // 5 min old
    await renderNotamsTab(center.lat, center.lng);
    expect(S.tfrs.length).toBe(1);
    expect(S.importedNotams.length).toBe(1);
    expect(S.tfrImportMeta.cached).toBe(true);
    expect(S.sectionMeta.tfr.status).toBe('cached');
    expect(S.sectionMeta.notam.status).toBe('cached');
    const banner = document.getElementById('tfrStaleBanner').textContent;
    expect(banner).toMatch(/Live FAA data fetched/);
    expect(banner).toMatch(/\(cached\)/);
  });

  it('STALE (>1h) record hydrates but the banner goes red with the STALE re-verify line', async () => {
    globalThis.getCachedApiResponse = async () => makeRec('stale', 2 * 3600000); // 2 h old
    await renderNotamsTab(center.lat, center.lng);
    expect(S.tfrs.length).toBe(1);
    const el = document.getElementById('tfrStaleBanner');
    expect(el.textContent).toMatch(/STALE: re-verify ≤ 1 hr before launch/);
  });

  it('round-trips notamMeta into S.notamFetchMeta with cached:true', async () => {
    globalThis.getCachedApiResponse = async () => makeRec('fresh', 60000);
    await renderNotamsTab(center.lat, center.lng);
    expect(S.notamFetchMeta).toBeTruthy();
    expect(S.notamFetchMeta.cached).toBe(true);
    expect(S.notamFetchMeta.source).toBe('live');
  });

  it('RACE GUARD: a live result landing during the IDB await is not clobbered', async () => {
    globalThis.getCachedApiResponse = async () => {
      // Simulate fetchLiveRestrictions finishing while the IDB read is in flight.
      S.tfrs = [{ id: 'LIVE-NOW', polygons: [], _live: true }];
      return makeRec('fresh', 5 * 60000);
    };
    await renderNotamsTab(center.lat, center.lng);
    expect(S.tfrs.map(t => t.id)).toEqual(['LIVE-NOW']); // cached rec did NOT overwrite
  });

  it('manual import keeps the exact legacy banner string', async () => {
    globalThis.getCachedApiResponse = async () => null;
    S.tfrImportMeta = { fileName: 'tfr_export.geojson', importedAtMs: Date.now() - 5 * 60000, source: 'file' };
    await renderNotamsTab(center.lat, center.lng);
    expect(document.getElementById('tfrStaleBanner').textContent).toBe('Imported tfr_export.geojson • 5m ago');
  });
});
