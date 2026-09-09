// fetchFireDanger — regional branches and failure reporting.
//
// Outside California only ONE request is queued, so destructuring
// `[firesRes, nfdrsRes]` left nfdrsRes undefined and `nfdrsRes.status` threw
// before the national NFDRS fallback ran or the fires reached state — every
// non-CA area reported a fire-danger ERROR with no perimeters. A failed
// perimeter request must also be an error, not "no fires · LIVE", and a copy
// served by the Service Worker's offline fallback is labeled by its cache time.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

const layerGroupMock = () => ({
  _layers: [],
  addLayer(x) { this._layers.push(x); },
  clearLayers() { this._layers = []; },
  getLayers() { return this._layers; },
  addTo() { return this; },
});
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  geoJSON: () => ({ bindPopup() { return this; } }),
};

const { S, fetchFireDanger } = require('../../sar-preflight.js');

S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };

const boundsAround = (lat, lng) => ({
  getSouthWest: () => ({ lat: lat - 0.1, lng: lng - 0.1 }),
  getNorthEast: () => ({ lat: lat + 0.1, lng: lng + 0.1 }),
});

const perimeter = (name) => ({
  type: 'Feature',
  properties: { poly_IncidentName: name, poly_GISAcres: 1200, attr_PercentContained: 35, poly_CreateDate: 1757000000000 },
  geometry: { type: 'Polygon', coordinates: [[[-105.1, 39.6], [-104.9, 39.6], [-104.9, 39.8], [-105.1, 39.6]]] },
});
const ok = (body, headers) => ({
  ok: true, status: 200,
  headers: { get: (k) => (headers && headers[k]) != null ? headers[k] : null },
  json: async () => body,
});

// Route by URL fragment; unmatched URLs reject (offline for that host).
function mockFetch(plan) {
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(String(url));
    const key = Object.keys(plan).find(k => String(url).includes(k));
    if (!key) return Promise.reject(new Error('unmocked ' + url));
    const r = plan[key];
    if (r && r.reject) return Promise.reject(new Error(r.reject));
    return Promise.resolve(r);
  };
  return calls;
}

describe('fetchFireDanger', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="notamList"></div><div id="layerList"></div>';
    S.activeFires = null;
    S.fireDanger = null;
    S.dataSourceErrors = {};
    S.sectionMeta = {};
    delete S.mapLayers.fire_perimeters;
  });
  afterEach(() => { delete globalThis.fetch; document.body.innerHTML = ''; });

  it('outside California (Colorado): perimeters reach state and status is LIVE', async () => {
    const calls = mockFetch({
      WFIGS_Interagency_Perimeters_Current: ok({ type: 'FeatureCollection', features: [perimeter('Quarry')] }),
      // national NFDRS station lookup answers empty → fallback resolves null, harmlessly
      NFDRS_ERC_and_BI_Percentiles_and_Trends: ok({ features: [] }),
    });
    await fetchFireDanger(39.7, -105.0, boundsAround(39.7, -105.0));
    expect(S.activeFires.length).toBe(1);
    expect(S.activeFires[0].name).toBe('Quarry');
    expect(S.fireDanger).toBeNull();
    expect(S.sectionMeta.fireDanger.status).toBe('live');
    expect(S.dataSourceErrors['Fire Danger']).toBeUndefined();
    expect(calls.some(u => u.includes('CA_NFDRS'))).toBe(false);          // CA-only source not queried
    expect(document.getElementById('notamList').innerHTML).toContain('Quarry');
  });

  it('inside California: CA NFDRS rating is applied alongside perimeters', async () => {
    mockFetch({
      WFIGS_Interagency_Perimeters_Current: ok({ type: 'FeatureCollection', features: [] }),
      CA_NFDRS: ok({ features: [{ properties: { PSAName: 'Northern Sierra', Avg_BI: 40, Avg_BI_Pct: 75, Avg_ERC: 60, Avg_ERC_Pct: 80, Avg_FM100Hr: 8, Avg_FM1000Hr: 10 } }] }),
    });
    await fetchFireDanger(38.68, -120.99, boundsAround(38.68, -120.99));
    expect(S.activeFires).toEqual([]);
    expect(S.fireDanger.psa).toBe('Northern Sierra');
    expect(S.sectionMeta.fireDanger.status).toBe('live');
  });

  it('a failed perimeter request is an ERROR, not "no fires · LIVE"', async () => {
    S.activeFires = [{ name: 'previous' }];
    mockFetch({ WFIGS_Interagency_Perimeters_Current: { ok: false, status: 503 }, CA_NFDRS: ok({ features: [] }) });
    await fetchFireDanger(38.68, -120.99, boundsAround(38.68, -120.99));
    expect(S.sectionMeta.fireDanger.status).toBe('error');
    expect(S.sectionMeta.fireDanger.error).toContain('503');
    expect(S.dataSourceErrors['Fire Danger']).toBeTruthy();
    expect(S.activeFires).toEqual([{ name: 'previous' }]);   // not cleared by a failure
  });

  it('a rejected perimeter request (network down) is an ERROR too', async () => {
    mockFetch({ WFIGS_Interagency_Perimeters_Current: { reject: 'Failed to fetch' }, CA_NFDRS: ok({ features: [] }) });
    await fetchFireDanger(38.68, -120.99, boundsAround(38.68, -120.99));
    expect(S.sectionMeta.fireDanger.status).toBe('error');
    expect(S.sectionMeta.fireDanger.error).toContain('Failed to fetch');
  });

  it('perimeters served from the Service Worker offline fallback are labeled CACHED by their stored time', async () => {
    const ts = Date.now() - 5 * 3600 * 1000;
    mockFetch({
      WFIGS_Interagency_Perimeters_Current: ok({ type: 'FeatureCollection', features: [perimeter('Old')] }, { 'X-SAR-SW-Cache': String(ts) }),
      CA_NFDRS: ok({ features: [] }),
    });
    await fetchFireDanger(38.68, -120.99, boundsAround(38.68, -120.99));
    expect(S.activeFires.length).toBe(1);
    expect(S.sectionMeta.fireDanger.status).toBe('cached');
    expect(S.sectionMeta.fireDanger.cachedAt).toBe(ts);
    expect(S.sectionMeta.fireDanger.updatedAt == null || S.sectionMeta.fireDanger.updatedAt < Date.now() - 1000).toBe(true);
  });
});
