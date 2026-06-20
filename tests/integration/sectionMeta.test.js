const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = {
  map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() },
  Draw: { Event: {} }, FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({
    addTo: vi.fn(function () { return this; }), clearLayers: vi.fn(), addLayer: vi.fn(), getLayers: vi.fn(() => []),
  })),
  geoJSON: vi.fn(() => ({ bindPopup: vi.fn(function () { return this; }) })),
};

const { fetchNWSAlerts, S } = require('../../sar-preflight.js');

// A real fetch (fetchNWSAlerts -> the 'alerts' section) populates S.sectionMeta
// across the three outcome branches: live / cached / error.
describe('fetch -> S.sectionMeta wiring (alerts)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="alertStatus"></span>
      <div id="alertSection" style="display:none;"><div id="alertList"></div></div>
      <div id="layerList"></div>
      <input id="cfgMaxWind" type="number" value="27" />
      <span id="assessBadge" class="assessment-badge">--</span>
      <span id="assessText">--</span>
      <div class="section-meta" id="meta_alerts"></div>
    `;
    S.nwsAlerts = [];
    S.mapLayers = {};
    S.wireHazardCounts = {};
    S.sectionMeta = {};
    S.areaCenter = { lat: 38.69, lng: -120.99 };
    S.map = { hasLayer: vi.fn(() => true) };
    globalThis.fetch = vi.fn();
    delete globalThis.getCachedApiResponse;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    delete globalThis.getCachedApiResponse;
  });

  it('records status:live with a fresh timestamp on success', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ features: [] }) });
    await fetchNWSAlerts(38.69, -120.99);
    expect(S.sectionMeta.alerts.status).toBe('live');
    expect(S.sectionMeta.alerts.updatedAt).toBeGreaterThan(0);
    expect(S.sectionMeta.alerts.error).toBeNull();
  });

  it('records status:cached with the cache timestamp when the fetch fails but a cache exists', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    globalThis.getCachedApiResponse = vi.fn(() => Promise.resolve({
      data: { features: [] }, timestamp: 1700000000000, status: 'stale',
    }));
    await fetchNWSAlerts(38.69, -120.99);
    expect(S.sectionMeta.alerts.status).toBe('cached');
    expect(S.sectionMeta.alerts.cachedAt).toBe(1700000000000);
  });

  it('records status:error when the fetch fails and there is no cache', async () => {
    globalThis.fetch.mockRejectedValue(new Error('boom'));
    await fetchNWSAlerts(38.69, -120.99);
    expect(S.sectionMeta.alerts.status).toBe('error');
    expect(S.sectionMeta.alerts.error).toBeTruthy();
  });
});
