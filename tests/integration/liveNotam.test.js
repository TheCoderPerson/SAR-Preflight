const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

const layerGroupMock = () => ({ _layers: [], addLayer(x){ this._layers.push(x); }, clearLayers(){ this._layers = []; }, getLayers(){ return this._layers; }, addTo(){ return this; } });
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const { S, fetchNotams } = require('../../sar-preflight.js');

S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };

const payload = {
  notamList: [
    { facilityDesignator: 'SAC', notamNumber: '01/234', keyword: 'OBST', traditionalMessage: '!SAC 01/234 OBST TOWER', mapPointer: 'POINT(-121.49 38.51)', startDate: '2026-06-13T00:00:00', endDate: '2026-12-31T23:59:00' },
    { facilityDesignator: 'MHR', notamNumber: '05/678', keyword: 'GPS', traditionalMessage: '!MHR 05/678 GPS UNREL', mapPointer: 'POINT(-121.20 38.55)' },
  ],
  totalNotamCount: 2,
};

function setBody() {
  document.body.innerHTML = `
    <input id="cfgMaxWind" type="number" value="27" />
    <span id="assessBadge" class="assessment-badge">--</span><span id="assessText">--</span>
    <span id="notamStatus"></span>
    <div id="notamList"></div>
    <div id="layerList"></div>
  `;
}

describe('fetchNotams (live NOTAMs via proxy)', () => {
  beforeEach(() => {
    setBody();
    S.importedNotams = [];
    S.currentArea = null; // skip computeAssessment
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
  });
  afterEach(() => {
    S.importedNotams = []; document.body.innerHTML = '';
    localStorage.removeItem('sar_canopy_proxy');
    delete globalThis.fetch;
  });

  it('is a no-op when no proxy is configured', async () => {
    localStorage.removeItem('sar_canopy_proxy');
    let called = false;
    globalThis.fetch = () => { called = true; return Promise.resolve({ ok: true, json: async () => payload }); };
    await fetchNotams(38.65, -120.99, 20);
    expect(called).toBe(false);
    expect(S.importedNotams.length).toBe(0);
  });

  it('fetches the /notam route with lat/lng/radius and populates S.importedNotams', async () => {
    let calledUrl = null;
    globalThis.fetch = (url) => { calledUrl = url; return Promise.resolve({ ok: true, json: async () => payload }); };
    await fetchNotams(38.65, -120.99, 25);
    expect(calledUrl).toContain('https://x.workers.dev/notam?');
    expect(calledUrl).toContain('lat=38.65');
    expect(calledUrl).toContain('lng=-120.99');
    expect(calledUrl).toContain('radius=25');
    expect(S.importedNotams.length).toBe(2);
    expect(S.importedNotams[0].source).toBe('notamSearch');
    expect(S.importedNotams.every(n => n._live)).toBe(true);
    expect(document.getElementById('notamList').innerHTML).toContain('01/234');
  });

  it('replaces the previous live set but keeps manual NOTAMs', async () => {
    S.importedNotams = [
      { id: 'M-1', location: 'XXX', body: 'manual' },
      { id: 'OLD', location: 'YYY', body: 'stale', _live: true },
    ];
    globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => payload });
    await fetchNotams(38.65, -120.99, 20);
    const ids = S.importedNotams.map(n => n.id);
    expect(ids).toContain('M-1');
    expect(ids).not.toContain('OLD');
    expect(ids).toContain('01/234');
  });

  it('on fetch error keeps existing NOTAMs', async () => {
    S.importedNotams = [{ id: 'M-1', location: 'XXX', body: 'manual' }];
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 502 });
    await fetchNotams(38.65, -120.99, 20);
    expect(S.importedNotams.map(n => n.id)).toContain('M-1');
  });
});
