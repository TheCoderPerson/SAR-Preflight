// fetchLiveRestrictions — the combined TFR+NOTAM auto-check must be fail-safe:
// EITHER leg failing yields state 'error' (stale _live survivors from a prior
// pass must never dress a failed check up as CHECKED), the RETRY entries re-run
// the pair, and NOTAM success persists even when the TFR leg failed.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

const layerGroupMock = () => ({ _layers: [], addLayer(x){ this._layers.push(x); }, clearLayers(){ this._layers = []; }, getLayers(){ return this._layers; }, addTo(){ return this; } });
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const { S, fetchLiveRestrictions, fetchNotams, retryFailedSource, _notamSearchRadiusNm } = require('../../sar-preflight.js');

S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };

const tfrGeoJson = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { NOTAM_KEY: '6/4112-1-FDC-F', TITLE: 'Wildfire near Placerville', LEGAL: 'HAZARDS', CNS_LOCATION_ID: 'ZOA', STATE: 'CA' },
    geometry: { type: 'Polygon', coordinates: [[[-121.0, 38.6], [-120.9, 38.6], [-120.9, 38.7], [-121.0, 38.7], [-121.0, 38.6]]] },
  }],
};
const notamPayload = {
  notamList: [
    { facilityDesignator: 'SAC', notamNumber: '01/234', keyword: 'OBST', traditionalMessage: '!SAC 01/234 OBST TOWER', mapPointer: 'POINT(-121.49 38.51)' },
  ],
  totalNotamCount: 1,
};

const bounds = {
  getSouthWest: () => ({ lat: 38.6, lng: -121.0 }),
  getNorthEast: () => ({ lat: 38.7, lng: -120.9 }),
};
const center = { lat: 38.65, lng: -120.95 };

// fetch mock that routes by URL and records every (url, opts) call.
function installFetch({ tfrOk = true, notamOk = true } = {}) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/geoserver/')) {
      return Promise.resolve(tfrOk ? { ok: true, json: async () => tfrGeoJson } : { ok: false, status: 503 });
    }
    if (url.includes('/download/detail_')) return Promise.resolve({ ok: false, status: 404 }); // geometry-only is fine
    if (url.includes('/notam?')) {
      return Promise.resolve(notamOk ? { ok: true, json: async () => notamPayload } : { ok: false, status: 502 });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
  return calls;
}

function setBody() {
  document.body.innerHTML = `
    <input id="cfgMaxWind" type="number" value="27" />
    <span id="assessBadge" class="assessment-badge">--</span><span id="assessText">--</span>
    <div id="autoCheckStatusSection" style="display:none;">
      <div id="autoCheckIndicator"></div>
      <span id="autoCheckStatus"></span>
      <button id="autoCheckReBtn" style="display:none;"></button>
      <div id="autoCheckDetail"></div>
    </div>
    <span id="notamStatus"></span>
    <div id="tfrStaleBanner"></div>
    <div id="notamDeepLinks"></div>
    <div id="tfrList"></div><span id="tfrCount"></span>
    <div id="meta_tfr"></div><div id="meta_notam"></div>
    <textarea id="notamPasteBox"></textarea>
    <div id="notamParseMsg"></div>
    <div id="notamList"></div>
    <div id="layerList"></div>
    <input id="cfgFlightTime" type="number" value="38" />
    <span id="opsTempFactor"></span><span id="opsAltFactor"></span><span id="opsWindFactor"></span>
    <span id="opsFlightTime"></span><span id="opsCapacity"></span>
    <div id="opsCapBar" style="width: 0%; background: green;"></div>
    <span id="opsBirds"></span><span id="opsBirdSeason"></span><span id="opsBirdTime"></span><span id="opsBirdRisk"></span>
  `;
}

describe('fetchLiveRestrictions (combined auto-check)', () => {
  beforeEach(() => {
    setBody();
    S.tfrs = []; S.importedNotams = [];
    S.tfrImportMeta = null; S.notamFetchMeta = null;
    S.sectionMeta.tfr = null; S.sectionMeta.notam = null;
    S.dataSourceErrors = {};
    S.autoCheck = { state: 'idle', ms: 0, tfrCount: 0, notamCount: 0 };
    S.areaCenter = center; S.areaBounds = bounds;
    S.currentArea = null; // skip computeAssessment DOM churn
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
  });
  afterEach(() => {
    S.tfrs = []; S.importedNotams = []; S.dataSourceErrors = {};
    document.body.innerHTML = '';
    localStorage.removeItem('sar_canopy_proxy');
    delete globalThis.fetch;
    delete globalThis.cacheApiResponse;
    delete globalThis.areaKey;
  });

  // The badge branches need hasArea; render again with an area set AFTER the
  // fetch so computeAssessment's DOM churn stays out of the fetch path.
  function renderWithArea() {
    S.currentArea = {};
    const { renderAutoCheckStatus } = require('../../sar-preflight.js');
    renderAutoCheckStatus();
    S.currentArea = null;
  }

  it('both legs ok -> state ok, CHECKED badge with fetched stamps, live pill', async () => {
    installFetch();
    await fetchLiveRestrictions(center, bounds);
    expect(S.autoCheck.state).toBe('ok');
    expect(S.autoCheck.tfrOk).toBe(true);
    expect(S.autoCheck.notamOk).toBe(true);
    renderWithArea();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('CHECKED');
    expect(document.getElementById('autoCheckDetail').textContent).toMatch(/fetched/);
    expect(document.getElementById('notamStatus').textContent).toMatch(/LIVE/);
    expect(S.sectionMeta.tfr.status).toBe('live');
    expect(S.sectionMeta.notam.status).toBe('live');
  });

  it('TFR ok + NOTAM failed -> state error, CHECK FAILED pill, per-leg flags', async () => {
    installFetch({ notamOk: false });
    await fetchLiveRestrictions(center, bounds);
    expect(S.autoCheck.state).toBe('error');
    expect(S.autoCheck.tfrOk).toBe(true);
    expect(S.autoCheck.notamOk).toBe(false);
    renderWithArea();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('FAILED');
    expect(document.getElementById('notamStatus').textContent).toBe('CHECK FAILED');
    expect(document.getElementById('autoCheckDetail').textContent).toMatch(/1800wxbrief\.com/);
  });

  it('REGRESSION: both legs fail with stale _live survivors -> still error, never ok', async () => {
    // Previous-pass survivors — the old logic counted these and reported 'ok'.
    S.tfrs = [{ id: 'OLD-LIVE', polygons: [], name: 'stale', _live: true }];
    S.importedNotams = [{ id: 'OLD-N', location: 'XXX', body: 'stale', _live: true }];
    installFetch({ tfrOk: false, notamOk: false });
    await fetchLiveRestrictions(center, bounds);
    expect(S.autoCheck.state).toBe('error');
    renderWithArea();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('FAILED');
    expect(document.getElementById('autoCheckStatus').textContent).not.toBe('CHECKED');
  });

  it('sends cache:"no-store" on the /tfr/ and /notam calls', async () => {
    const calls = installFetch();
    await fetchLiveRestrictions(center, bounds);
    const wfs = calls.find(c => c.url.includes('/geoserver/'));
    const notam = calls.find(c => c.url.includes('/notam?'));
    expect(wfs.opts && wfs.opts.cache).toBe('no-store');
    expect(notam.opts && notam.opts.cache).toBe('no-store');
  });

  it('retryFailedSource("TFR") re-runs BOTH legs', async () => {
    const calls = installFetch();
    await retryFailedSource('TFR');
    expect(calls.some(c => c.url.includes('/geoserver/'))).toBe(true);
    expect(calls.some(c => c.url.includes('/notam?'))).toBe(true);
  });

  it('_notamSearchRadiusNm sizes the search to the area within 10-50 NM', () => {
    expect(_notamSearchRadiusNm(center, bounds)).toBeGreaterThanOrEqual(10);
    expect(_notamSearchRadiusNm(center, bounds)).toBeLessThanOrEqual(50);
    expect(_notamSearchRadiusNm(center, null)).toBe(20); // fallback
  });
});

describe('fetchNotams persistence (ordering fix)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<span id="notamStatus"></span><div id="notamList"></div><div id="meta_notam"></div><div id="layerList"></div>';
    S.importedNotams = []; S.notamFetchMeta = null;
    S.sectionMeta.notam = null;
    S.areaCenter = center;
    S.currentArea = null;
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
  });
  afterEach(() => {
    S.importedNotams = []; document.body.innerHTML = '';
    localStorage.removeItem('sar_canopy_proxy');
    delete globalThis.fetch;
    delete globalThis.cacheApiResponse;
    delete globalThis.areaKey;
  });

  it('a NOTAM success persists to IndexedDB with notamMeta even when no TFR fetch ran', async () => {
    globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
    globalThis.cacheApiResponse = vi.fn();
    globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => notamPayload });
    await fetchNotams(center.lat, center.lng, 20);
    expect(S.notamFetchMeta && S.notamFetchMeta.fetchedAtMs).toBeTruthy();
    expect(S.sectionMeta.notam.status).toBe('live');
    expect(globalThis.cacheApiResponse).toHaveBeenCalledTimes(1);
    const [endpoint, , payload] = globalThis.cacheApiResponse.mock.calls[0];
    expect(endpoint).toBe('tfr_import');
    expect(payload.notamMeta).toBe(S.notamFetchMeta);
    expect(payload.notams.length).toBe(1);
  });

  it('a NOTAM failure marks the section error and records the source error', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 502 });
    await fetchNotams(center.lat, center.lng, 20);
    expect(S.sectionMeta.notam.status).toBe('error');
    expect(S.dataSourceErrors.NOTAM).toBeTruthy();
  });
});
