// Response Time Estimate — the fetch flow against mocked services. Fixtures
// are real answers captured from the live services (Nov 2026): Valhalla route
// / trace_attributes / pedestrian route (Placerville → north of Wrights Lake)
// and Caltrans QuickMap KML during a winter storm with an R-2 chain control on
// eastbound US 50.
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

class MockGroup {
  constructor() { this._layers = []; }
  getLayers() { return this._layers.slice(); }
  addLayer(l) { this._layers.push(l); return this; }
  clearLayers() { this._layers.length = 0; }
  addTo() { return this; }
}
class MockShape {
  constructor(ll, opts) { this._ll = ll; this.options = opts || {}; }
  bindPopup(html) { this._popup = html; return this; }
  getLatLngs() { return this._ll; }
  on() {} off() {}
}
globalThis.L = {
  layerGroup: () => new MockGroup(),
  polyline: (ll, o) => new MockShape(ll, o),
  circleMarker: (ll, o) => new MockShape(ll, o),
};
// The key the app scopes an area's data by (sar-preflight-offline.js in the browser).
globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;

const app = require('../../sar-preflight.js');
const {
  S, SECTION_DEFS, SECTION_CELLS, UNKNOWN_CELL_TEXT, RESPONSE_CFG_KEY,
  fetchResponseEstimate, startResponseEstimate, autoResponseEstimate, recomputeResponseForHour,
  _setValhallaInterval, getResponseSettings, saveResponseSetting, saveResponseBase, selectResponseDest,
  onResponseStagingClick, clearResponseStaging, startResponseStagingPick, _resetResponse,
  _briefingResponseLines, _exportResponseRecords, buildBriefingText, collectExportFolderGroups,
  invalidateAreaRequests, EXPORT_SKIP_LAYERS, VEC3D_SKIP,
} = app;

const fx = name => path.join(__dirname, '..', 'fixtures', name);
const ROUTE = require('../fixtures/valhalla-route-auto.json');
const TRACE = require('../fixtures/valhalla-trace.json');
const PED = require('../fixtures/valhalla-route-ped.json');
const CC_KML = fs.readFileSync(fx('quickmap-v2_cc.kml'), 'utf8');
const CHIN_KML = fs.readFileSync(fx('quickmap-v2_chin.kml'), 'utf8');
const EMPTY_KML = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Caltrans Chain Controls</name></Document></kml>';

const BASE = { label: 'Placerville base', lat: 38.7296, lng: -120.7985 };
const OBSERVER = { lat: 38.869, lng: -120.229 }; // ~800 m east of the end of the jeep trail
const HOUR = 3600000;

const res = (body, init) => ({
  ok: !init || !init.status || (init.status >= 200 && init.status < 300),
  status: (init && init.status) || 200,
  headers: { get: k => ((init && init.headers) || {})[k] || null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// One mock for every service. `over` replaces the answer for a service:
// { route, trace, ped, wx, cc, chin, alerts, mvum (roads), mvumt (trails), elev } — a function
// (url, opts) => response, or a value.
let calls;
function mockServices(over) {
  over = over || {};
  calls = [];
  const use = (key, dflt, url, opts) => {
    const v = key in over ? over[key] : dflt;
    return typeof v === 'function' ? v(url, opts) : v;
  };
  globalThis.fetch = vi.fn(async (url, opts) => {
    url = String(url);
    const kind = /valhalla.*\/trace_attributes/.test(url) ? 'trace'
      : /valhalla.*\/route/.test(url) ? (JSON.parse(opts.body).costing === 'pedestrian' ? 'ped' : 'route')
      : /open-meteo\.com\/v1\/forecast/.test(url) ? 'wx'
      : /\/caltrans\/v2_cc\.kml/.test(url) ? 'cc'
      : /\/caltrans\/v2_chin\.kml/.test(url) ? 'chin'
      : /api\.weather\.gov\/alerts/.test(url) ? 'alerts'
      : /\/usfs\/.*MapServer\/2\/query/.test(url) ? 'mvumt'
      : /\/usfs\//.test(url) ? 'mvum'
      : /getSamples|\/v1\/elevation/.test(url) ? 'elev' : 'other';
    calls.push({ kind, url, opts, at: Date.now() });
    if (opts && opts.signal && opts.signal.aborted) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
    switch (kind) {
      case 'route': return use('route', res(ROUTE), url, opts);
      case 'trace': return use('trace', res(TRACE), url, opts);
      case 'ped': return use('ped', res(PED), url, opts);
      case 'wx': return use('wx', wxAnswer(url, {}), url, opts);
      case 'cc': return use('cc', res(EMPTY_KML), url, opts);
      case 'chin': return use('chin', res(EMPTY_KML), url, opts);
      case 'alerts': return use('alerts', res({ features: [] }), url, opts);
      case 'mvum': return use('mvum', res({ type: 'FeatureCollection', features: [] }), url, opts);
      case 'mvumt': return use('mvumt', res({ type: 'FeatureCollection', features: [] }), url, opts);
      case 'elev': {
        if (/getSamples/.test(url)) return res({}, { status: 500 }); // 3DEP down → Open-Meteo elevation
        const n = (url.match(/latitude=([^&]*)/)[1] || '').split(',').length;
        return use('elev', res({ elevation: Array.from({ length: n }, (_, i) => 2000 + i * 10) }), url, opts);
      }
      default: return res({}, { status: 404 });
    }
  });
}
const count = kind => calls.filter(c => c.kind === kind).length;

// Open-Meteo multi-point answer: one object per requested point, 48 hourly values.
function wxAnswer(url, v, startMs) {
  const n = (url.match(/latitude=([^&]*)/)[1] || '').split(',').length;
  const t0 = Math.floor((startMs || Date.now()) / HOUR) * 3600;
  const fill = x => Array(48).fill(x == null ? 0 : x);
  const one = () => ({ hourly: { time: Array.from({ length: 48 }, (_, i) => t0 + i * 3600),
    rain: fill(v.rain), showers: fill(0), snowfall: fill(v.snowfall), snow_depth: fill(v.depth), weather_code: fill(v.code) } });
  return res(n === 1 ? one() : Array.from({ length: n }, one));
}

const CELL_IDS = SECTION_CELLS.response;
const text = id => document.getElementById(id).textContent;
const cls = id => document.getElementById(id).className;

function seed(opts) {
  opts = opts || {};
  document.body.innerHTML =
    '<span class="fetch-status" id="responseStatus"></span><div class="section-meta" id="meta_response"></div>'
    + '<div id="respPrompt" style="display:none;"></div>'
    + CELL_IDS.map(id => `<div class="data-value" id="${id}">--</div>`).join('')
    + '<div class="data-value" id="respLoad">--</div>'
    + '<div id="respDestList"></div><div id="respAlertList"></div>'
    + '<button id="respStagingBtn"></button><button id="respStagingClear" style="display:none;"></button><div id="respStagingNote"></div>';
  localStorage.setItem(RESPONSE_CFG_KEY, JSON.stringify(Object.assign({ consent: true, base: BASE }, opts.cfg || {})));
  S.map = { hasLayer: () => true, addLayer: () => {}, removeLayer: () => {}, getContainer: () => ({ style: {} }) };
  S.mapLayers = {};
  S.areaCenter = { lat: 38.86, lng: -120.23 };
  S.sectionMeta = {};
  S.viewsheds = opts.observers || [];
  S.activeViewshedId = S.viewsheds.length ? S.viewsheds[0].id : null;
  S.deviceFix = opts.fix || null;
  S.response = null; S._responseStaging = null; S._responseMemo = null; S._responsePicking = false;
  S.timeIdx = 0; S.wx = null;
  S.dataSourceErrors = {};
  _setValhallaInterval(0);
}
const observer = (id, name, ll) => ({ id, name, observer: ll || OBSERVER });

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  document.body.innerHTML = '';
  S.map = null; S.mapLayers = {}; S.areaCenter = null; S.sectionMeta = {}; S.viewsheds = [];
  S.response = null; S._responseStaging = null; S._responseMemo = null; S.deviceFix = null; S.wx = null; S.timeIdx = 0;
  if (S._responseTimer) { clearTimeout(S._responseTimer); S._responseTimer = null; }
  delete globalThis.fetch; delete globalThis.getCachedApiResponse; delete globalThis.cacheApiResponse; delete globalThis.getAppState;
  _setValhallaInterval(1100);
});

describe('section registry', () => {
  it('is a section with an UPDATE button that does not feed the assessment', () => {
    expect(SECTION_DEFS.response).toBeTruthy();
    expect(SECTION_DEFS.response.computes).toBeNull();
    expect(SECTION_DEFS.response.lines).toEqual([{ id: 'meta_response', button: true }]);
  });
  it('keeps the route layer out of the generic export harvest and the 3D mirror', () => {
    expect(EXPORT_SKIP_LAYERS.has('response_route')).toBe(true);
    expect(VEC3D_SKIP.has('response_route')).toBe(true);
  });
});

describe('consent', () => {
  it('sends nothing until the user has agreed, and shows the disclosure instead', async () => {
    seed({ cfg: { consent: false } });
    mockServices();
    await fetchResponseEstimate({ userGesture: true });
    await autoResponseEstimate();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const prompt = document.getElementById('respPrompt');
    expect(prompt.style.display).toBe('');
    expect(prompt.textContent).toMatch(/sends your start point/);
    expect(prompt.querySelector('button').getAttribute('onclick')).toBe('startResponseEstimate()');
  });
  it('the consent button records consent and runs the estimate', async () => {
    seed({ cfg: { consent: false } });
    mockServices();
    await startResponseEstimate();
    expect(getResponseSettings().consent).toBe(true);
    expect(count('route')).toBe(1);
    expect(document.getElementById('respPrompt').style.display).toBe('none');
  });
  it('with consent but automatic estimates off, drawing an area sends nothing', async () => {
    seed({ cfg: { auto: false } });
    mockServices();
    await autoResponseEstimate();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('drive-only estimate (no observers)', () => {
  it('routes to the road nearest the area centre and fills the section', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    expect(count('route')).toBe(1);
    expect(count('trace')).toBe(1);
    expect(count('ped')).toBe(0); // no observer → no hike leg
    const body = JSON.parse(calls.find(c => c.kind === 'route').opts.body);
    expect(body.locations[0]).toEqual({ lat: BASE.lat, lon: BASE.lng });
    expect(body.locations[1]).toEqual({ lat: 38.86, lon: -120.23 });
    expect(body.costing).toBe('auto');

    expect(text('respTotal')).toMatch(/^1 h \d+ min to Road nearest area centre · ETA \d\d:\d\d$/);
    expect(text('respStart')).toBe('Saved base: Placerville base');
    expect(text('respLoad')).toBe('30 min');
    expect(text('respRoad')).toMatch(/^(\d+ h( \d+ min)?|\d+ min) · 44 mi$/);
    expect(text('respForest')).toMatch(/^\d+ min · 1\.3 mi at 15 mph$/); // the jeep trail only — Wrights Lake Road is paved
    expect(text('respHike')).toMatch(/^n\/a/);
    expect(text('respChains')).toMatch(/^None on route \(Caltrans QuickMap, checked \d\d:\d\d\)$/);
    expect(text('respWx')).toMatch(/^No rain or snow forecast along the route · departing \d\d:\d\d$/);
    expect(S.sectionMeta.response.status).toBe('live');
    expect(document.getElementById('responseStatus').textContent).toBe('LIVE');
    // Everything verified and nothing adverse: the total is green. The unpaved
    // road not being an MVUM road is flagged on its own cell only.
    expect(document.getElementById('respTotal').classList.contains('green')).toBe(true);
    expect(text('respAccess')).toMatch(/not on the MVUM/);
    expect(document.getElementById('respAccess').classList.contains('amber')).toBe(true);
  });

  it('adds the equipment-loading time and the forest road at the configured speed', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    const d = S.response.dests[0];
    expect(d.sum.loadMin).toBe(30);
    expect(d.sum.forestMin).toBeCloseTo(2.168 / RESPONSE_KM_PER_MI / 15 * 60, 1);
    expect(d.sum.totalMin).toBeCloseTo(30 + d.est.roadMin + d.est.forestMin, 6);
    expect(d.sum.chainMin).toBe(0);
  });

  it('draws the route layer: road solid, forest road dashed, with start and road-end markers', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    const layers = S.mapLayers.response_route.getLayers();
    const lines = layers.filter(l => Array.isArray(l._ll) && Array.isArray(l._ll[0]) && l._ll.length > 1 && l.options.weight === 4);
    expect(lines.some(l => l.options.dashArray)).toBe(true);
    expect(lines.some(l => !l.options.dashArray)).toBe(true);
    expect(layers.some(l => /Road end/.test(l._popup || ''))).toBe(true);
    expect(layers.some(l => /Response start/.test(l._popup || ''))).toBe(true);
  });

  it('never touches the banner\'s data-source errors, even when everything fails', async () => {
    seed();
    mockServices({ route: res({ error_code: 199, error: 'boom' }, { status: 500 }), wx: res({}, { status: 500 }) });
    await fetchResponseEstimate({});
    expect(S.dataSourceErrors).toEqual({});
  });
});

describe('observer destinations', () => {
  it('routes to each observer and adds a hike leg from the road end', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices();
    await fetchResponseEstimate({});
    expect(count('route')).toBe(1);
    expect(count('ped')).toBe(1);
    const ped = JSON.parse(calls.find(c => c.kind === 'ped').opts.body);
    expect(ped.costing).toBe('pedestrian');
    expect(ped.locations[1]).toEqual({ lat: OBSERVER.lat, lon: OBSERVER.lng });
    expect(ped.locations[0].lat).toBeCloseTo(38.868293, 5); // the drive's last point
    const d = S.response.dests[0];
    expect(d.hikeMin).toBeGreaterThan(0);
    expect(text('respHike')).toMatch(/min · .* · \+[\d,]+ ft$/);
    expect(text('respTotal')).toMatch(/to Observer 1/);
    expect(d.sum.totalMin).toBeCloseTo(30 + d.est.roadMin + d.est.forestMin + d.hikeMin, 6);
  });

  it('an observer at the road end has no hike leg', async () => {
    seed({ observers: [observer('vs_1', 'Roadside', { lat: 38.8683, lng: -120.2383 })] });
    mockServices();
    await fetchResponseEstimate({});
    expect(count('ped')).toBe(0);
    expect(text('respHike')).toBe('At road — no hike');
    expect(S.response.dests[0].sum.hikeMin).toBe(0);
  });

  it('labels a hike whose climb is unknown as a flat estimate', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices({ elev: res({}, { status: 500 }) });
    await fetchResponseEstimate({});
    expect(text('respHike')).toMatch(/climb unknown \(flat estimate\)/);
    expect(document.getElementById('respHike').classList.contains('amber')).toBe(true);
  });

  it('falls back to a straight off-trail line when trail routing fails', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices({ ped: res({ error: 'server exploded' }, { status: 500 }) });
    await fetchResponseEstimate({});
    const d = S.response.dests[0];
    expect(d.hikePlan.mode).toBe('direct');
    expect(text('respHike')).toMatch(/off-trail/);
    expect(text('respHike')).toMatch(/trail routing unavailable/);
  });

  it('routes only the new observer when one is added (session memo)', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices();
    await fetchResponseEstimate({});
    S.viewsheds.push(observer('vs_2', 'Observer 2', { lat: 38.84, lng: -120.25 }));
    const before = { route: count('route'), trace: count('trace') };
    await fetchResponseEstimate({});
    expect(count('route') - before.route).toBe(1);
    expect(count('trace') - before.trace).toBe(1);
    expect(S.response.dests.length).toBe(2);
    expect(document.querySelectorAll('.resp-dest-row').length).toBe(2);
  });

  it('caps the destinations routed per run and says so', async () => {
    const obs = Array.from({ length: 8 }, (_, i) => observer('vs_' + i, 'Observer ' + (i + 1), { lat: 38.80 + i * 0.01, lng: -120.25 }));
    seed({ observers: obs });
    mockServices();
    await fetchResponseEstimate({});
    expect(count('route')).toBe(6);
    const rows = [...document.querySelectorAll('.resp-dest-row')].map(r => r.textContent);
    expect(rows.length).toBe(8);
    expect(rows.filter(t => /not estimated/.test(t)).length).toBe(2);
  });

  it('shows the tapped destination\'s details', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1'), observer('vs_2', 'Observer 2', { lat: 38.84, lng: -120.25 })] });
    mockServices();
    await fetchResponseEstimate({});
    expect(text('respTotal')).toMatch(/to Observer 1/);
    selectResponseDest('vs_2');
    expect(text('respTotal')).toMatch(/to Observer 2/);
    expect(document.querySelector('.resp-dest-row.active .resp-dest-name').textContent).toBe('Observer 2');
  });
});

describe('staging point', () => {
  it('drives to the staging point once and hikes to each observer from it', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1'), observer('vs_2', 'Observer 2', { lat: 38.871, lng: -120.231 })] });
    mockServices();
    S._responseStaging = { areaKey: globalThis.areaKey(38.86, -120.23), lat: 38.85, lng: -120.24 };
    await fetchResponseEstimate({});
    expect(count('route')).toBe(1);
    expect(JSON.parse(calls.find(c => c.kind === 'route').opts.body).locations[1]).toEqual({ lat: 38.85, lon: -120.24 });
    expect(count('ped')).toBe(2);
    expect(S.response.dests[0].driveKey).toBe(S.response.dests[1].driveKey);
    expect(document.getElementById('respStagingClear').style.display).toBe('');
    expect(document.getElementById('respStagingNote').textContent).toMatch(/Staging point set/);
  });

  it('a map tap while armed sets it and re-runs; clearing goes back to the observer', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices();
    startResponseStagingPick();
    expect(S._responsePicking).toBe(true);
    onResponseStagingClick({ lat: 38.85, lng: -120.24 });
    expect(S._responsePicking).toBe(false);
    expect(S._responseStaging).toMatchObject({ lat: 38.85, lng: -120.24 });
    await vi.waitFor(() => expect(S.response && S.response.computedAt).toBeTruthy());
    expect(S.response.staging).toBeTruthy();
    clearResponseStaging();
    await vi.waitFor(() => expect(S.response.staging).toBeNull());
    expect(S._responseStaging).toBeNull();
  });

  it('with no observers the staging point is the (drive-only) destination', async () => {
    seed();
    mockServices();
    S._responseStaging = { areaKey: globalThis.areaKey(38.86, -120.23), lat: 38.85, lng: -120.24 };
    await fetchResponseEstimate({});
    expect(text('respTotal')).toMatch(/to Staging point/);
    expect(count('ped')).toBe(0);
  });
});

describe('start location', () => {
  it('prefers a fresh device fix over the saved base', async () => {
    seed({ fix: { lat: 38.70, lng: -120.90, accM: 12, at: Date.now() - 60000 } });
    mockServices();
    await fetchResponseEstimate({});
    expect(JSON.parse(calls.find(c => c.kind === 'route').opts.body).locations[0]).toEqual({ lat: 38.70, lon: -120.90 });
    expect(text('respStart')).toMatch(/^GPS fix \d\d:\d\d \(1 min ago, ±12 m\)$/);
  });
  it('uses an older fix (under 30 min) before the base, and flags its age', async () => {
    seed({ fix: { lat: 38.70, lng: -120.90, accM: null, at: Date.now() - 20 * 60000 } });
    mockServices();
    await fetchResponseEstimate({});
    expect(JSON.parse(calls.find(c => c.kind === 'route').opts.body).locations[0].lat).toBe(38.70);
    expect(text('respStart')).toMatch(/20 min ago/);
    expect(document.getElementById('respStart').classList.contains('amber')).toBe(true);
  });
  it('falls back to the saved base when the fix is too old', async () => {
    seed({ fix: { lat: 38.70, lng: -120.90, accM: null, at: Date.now() - 2 * HOUR } });
    mockServices();
    await fetchResponseEstimate({});
    expect(JSON.parse(calls.find(c => c.kind === 'route').opts.body).locations[0]).toEqual({ lat: BASE.lat, lon: BASE.lng });
  });
  it('with no fix and no base asks for a start and sends nothing', async () => {
    seed({ cfg: { base: null } });
    mockServices();
    await fetchResponseEstimate({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(document.getElementById('respPrompt').textContent).toMatch(/No start location/);
    expect(S.sectionMeta.response).toBeUndefined(); // idle, not an error
  });
  it('saves a base from coordinates without any lookup', async () => {
    seed({ cfg: { base: null } });
    mockServices();
    const b = await saveResponseBase('38.7296, -120.7985');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(b).toMatchObject({ lat: 38.7296, lng: -120.7985 });
    expect(getResponseSettings().base.lat).toBe(38.7296);
    await saveResponseBase('');
    expect(getResponseSettings().base).toBeNull();
  });
});

describe('chain controls and closures (Caltrans)', () => {
  it('adds the delay once for a control on the route and names it', async () => {
    seed();
    mockServices({ cc: res(CC_KML), chin: res(CHIN_KML) });
    await fetchResponseEstimate({});
    const d = S.response.dests[0];
    expect(d.sum.chainMin).toBe(45);
    expect(d.sum.totalMin).toBeCloseTo(30 + d.est.roadMin + d.est.forestMin + 45, 6);
    expect(text('respChains')).toMatch(/^Chain control on route \(\+45 min\): R-2 · Eastbound US 50 at Fred's Place/);
    expect(document.getElementById('respChains').classList.contains('amber')).toBe(true);
    expect(document.querySelector('.resp-dest-sub').textContent).toMatch(/chain control 45/);
    // markers for the control are on the route layer
    expect(S.mapLayers.response_route.getLayers().some(l => /R-2 · Eastbound US 50 at Fred/.test(l._popup || ''))).toBe(true);
  });

  it('uses a changed delay from the settings', async () => {
    seed({ cfg: { chainDelayMin: 20 } });
    mockServices({ cc: res(CC_KML) });
    await fetchResponseEstimate({});
    expect(S.response.dests[0].sum.chainMin).toBe(20);
    expect(text('respChains')).toMatch(/\+20 min/);
  });

  it('a closure on the route adds no time and reads CLOSED — verify, if open', async () => {
    seed();
    const closure = EMPTY_KML.replace('</Document>',
      '<Placemark><description><![CDATA[<h2 class="iw-title">Eastbound US 50</h2><p class="iw-text"><strong>Location: </strong>Fred\'s Place</p><p class="iw-text">Closed to traffic.</p>]]></description><styleUrl>#full-closure</styleUrl><Point><coordinates>-120.24378,38.78058</coordinates></Point></Placemark></Document>');
    mockServices({ cc: res(closure) });
    await fetchResponseEstimate({});
    const d = S.response.dests[0];
    expect(d.sum.closed).toBe(true);
    expect(d.sum.chainMin).toBe(0);
    expect(text('respTotal')).toMatch(/^CLOSED — verify · if open: 1 h/);
    expect(document.getElementById('respTotal').classList.contains('red')).toBe(true);
    expect(text('respChains')).toMatch(/^CLOSED on route — verify: CLOSED · Eastbound US 50 at Fred's Place/);
  });

  it('a failed feed reads UNVERIFIED — never "none"', async () => {
    seed();
    mockServices({ cc: res('nope', { status: 502 }) });
    await fetchResponseEstimate({});
    expect(text('respChains')).toMatch(/^UNVERIFIED — check QuickMap \(HTTP 502\)$/);
    expect(document.getElementById('respChains').classList.contains('amber')).toBe(true);
    expect(S.response.dests[0].sum.level).toBe('amber');
    expect(S.response.dests[0].sum.chainMin).toBe(0);
  });

  it('an answer that is not a KML (proxy route not deployed) is UNVERIFIED, not "none"', async () => {
    seed();
    mockServices({ cc: res('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>') });
    await fetchResponseEstimate({});
    expect(text('respChains')).toMatch(/^UNVERIFIED — check QuickMap \(answer was not a Caltrans KML/);
  });

  it('notes a missing highway-information feed without losing the chain-control check', async () => {
    seed();
    mockServices({ chin: res('x', { status: 500 }) });
    await fetchResponseEstimate({});
    expect(text('respChains')).toMatch(/^None on route \(.*highway-information feed unavailable\)$/);
    expect(document.getElementById('respChains').classList.contains('amber')).toBe(true);
  });
});

describe('weather along the route', () => {
  it('requests one multi-point 48 h forecast', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    expect(count('wx')).toBe(1);
    const url = calls.find(c => c.kind === 'wx').url;
    expect(url).toMatch(/hourly=rain,showers,snowfall,snow_depth,weather_code/);
    expect(url).toMatch(/forecast_hours=48/);
    const n = url.match(/latitude=([^&]*)/)[1].split(',').length;
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThanOrEqual(12);
  });

  it('rain lengthens the drive by the configured percent', async () => {
    seed();
    mockServices({ wx: url => wxAnswer(url, { rain: 2 }) });
    await fetchResponseEstimate({});
    const e = S.response.dests[0].est;
    expect(e.roadMin).toBeCloseTo(e.baseRoadMin / 0.75, 3);
    expect(text('respWx')).toMatch(/^rain on 46 mi \(−25 % speed\)/);
    expect(text('respRoad')).toMatch(/\(dry: [^)]+\)$/);
    expect(document.getElementById('respWx').classList.contains('amber')).toBe(true);
  });

  it('falling snow caps the speed on the whole route', async () => {
    seed();
    mockServices({ wx: url => wxAnswer(url, { snowfall: 1.5 }) });
    await fetchResponseEstimate({});
    const e = S.response.dests[0].est;
    expect(e.roadMin).toBeCloseTo(e.roadMi / 15 * 60, 3);
    expect(text('respWx')).toMatch(/snow falling on 46 mi \(≤ 15 mph\)/);
  });

  it('snow on the ground slows minor and forest roads, not the highway', async () => {
    seed();
    mockServices({ wx: url => wxAnswer(url, { depth: 0.5 }) });
    await fetchResponseEstimate({});
    const e = S.response.dests[0].est;
    expect(e.snowMi).toBe(0);
    expect(e.groundSnowMi).toBeGreaterThan(9);   // Wrights Lake Road + the jeep trail
    expect(e.groundSnowMi).toBeLessThan(11);
    expect(text('respWx')).toMatch(/snow on the ground on .* off-highway/);
  });

  it('a failed forecast leaves the time unadjusted and says UNKNOWN', async () => {
    seed();
    mockServices({ wx: res({ error: true, reason: 'Too many requests' }, { status: 429 }) });
    await fetchResponseEstimate({});
    const d = S.response.dests[0];
    expect(d.est.roadMin).toBeCloseTo(d.est.baseRoadMin, 6);
    expect(text('respWx')).toMatch(/^UNKNOWN — drive time not adjusted for weather \(HTTP 429: Too many requests\)$/);
    expect(d.sum.level).toBe('amber');
  });

  it('an answer with the wrong number of points is rejected', async () => {
    seed();
    mockServices({ wx: res([{ hourly: { time: [1] } }]) });
    await fetchResponseEstimate({});
    expect(text('respWx')).toMatch(/^UNKNOWN/);
  });

  it('labels a forecast the service worker served from its offline copy', async () => {
    seed();
    const at = Date.now() - 20 * 60000;
    mockServices({ wx: url => Object.assign(wxAnswer(url, {}), { headers: { get: k => (k === 'X-SAR-SW-Cache' ? String(at) : null) } }) });
    await fetchResponseEstimate({});
    expect(text('respWx')).toMatch(/\(cached forecast from \d\d:\d\d\)$/);
    expect(S.response.wx.status).toBe('cached');
  });
});

describe('time bar', () => {
  it('re-evaluates for the selected departure hour without any request', async () => {
    seed();
    // Dry now, raining from +6 h.
    mockServices({ wx: url => {
      const r = wxAnswer(url, {});
      return Object.assign(r, { json: async () => {
        const j = await wxAnswer(url, {}).json();
        j.forEach(o => { o.hourly.rain = o.hourly.rain.map((_, i) => (i >= 6 ? 3 : 0)); });
        return j;
      } });
    } });
    await fetchResponseEstimate({});
    expect(text('respWx')).toMatch(/^No rain or snow/);
    const dry = S.response.dests[0].sum.totalMin;
    const n = globalThis.fetch.mock.calls.length;

    const t0 = Math.floor(Date.now() / HOUR) * HOUR;
    S.wx = { hourly: { time: Array.from({ length: 24 }, (_, i) => new Date(t0 + i * HOUR).toISOString()) } };
    S.timeIdx = 8;
    recomputeResponseForHour();
    expect(globalThis.fetch.mock.calls.length).toBe(n);
    expect(text('respWx')).toMatch(/^rain on/);
    expect(S.response.dests[0].sum.totalMin).toBeGreaterThan(dry);
    expect(S.response.forecastHour).toBe(true);
    expect(text('respChains')).toMatch(/current status, not a forecast/);

    S.timeIdx = 0;
    recomputeResponseForHour();
    expect(text('respWx')).toMatch(/^No rain or snow/);
  });

  it('a departure beyond the forecast window is unknown, never dry', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    S.wx = { hourly: { time: [new Date().toISOString(), new Date(Date.now() + 100 * HOUR).toISOString()] } };
    S.timeIdx = 1;
    recomputeResponseForHour();
    expect(text('respWx')).toMatch(/^UNKNOWN — drive time not adjusted for weather \(departure is beyond the 48 h forecast\)$/);
  });

  it('a changed setting re-evaluates without a request', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    const n = globalThis.fetch.mock.calls.length;
    const before = S.response.dests[0].sum.totalMin;
    saveResponseSetting('loadMin', '60');
    expect(globalThis.fetch.mock.calls.length).toBe(n);
    expect(S.response.dests[0].sum.totalMin).toBeCloseTo(before + 30, 6);
    expect(text('respLoad')).toBe('1 h');
    saveResponseSetting('forestMph', 5);
    expect(text('respForest')).toMatch(/at 5 mph$/);
  });
});

describe('weather warnings along the route (NWS)', () => {
  const alert = (id, event) => ({ id, properties: { id, event, severity: 'Severe', headline: event + ' issued', description: 'Heavy snow.', onset: '2026-11-17T22:00:00-08:00', expires: '2026-11-18T16:15:00-08:00', senderName: 'NWS Sacramento CA' }, geometry: null });
  it('checks several points and shows a green card only when all answered with none', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    expect(count('alerts')).toBeGreaterThanOrEqual(3);
    expect(count('alerts')).toBeLessThanOrEqual(8);
    expect(document.getElementById('respAlertList').textContent).toMatch(/NO ACTIVE WARNINGS ALONG ROUTE/);
  });
  it('lists each warning once with where on the route it applies', async () => {
    seed();
    let i = 0;
    mockServices({ alerts: () => res({ features: (i++ === 0) ? [] : [alert('urn:1', 'Winter Storm Warning')] }) });
    await fetchResponseEstimate({});
    const cards = document.querySelectorAll('#respAlertList .notam-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toMatch(/Winter Storm Warning/);
    expect(cards[0].querySelector('.notam-meta').textContent).toMatch(/en route, at destination/);
    expect(S.response.alerts.alerts.length).toBe(1);
  });
  it('a point that fails makes the check INCOMPLETE, never a green all-clear', async () => {
    seed();
    let i = 0;
    mockServices({ alerts: () => ((i++ === 1) ? res({}, { status: 503 }) : res({ features: [] })) });
    await fetchResponseEstimate({});
    const t = document.getElementById('respAlertList').textContent;
    expect(t).toMatch(/INCOMPLETE — \d of \d points checked live/);
    expect(t).not.toMatch(/NO ACTIVE WARNINGS/);
  });
  it('every point failing reads UNKNOWN', async () => {
    seed();
    mockServices({ alerts: res({}, { status: 500 }) });
    await fetchResponseEstimate({});
    expect(document.getElementById('respAlertList').textContent).toMatch(/ROUTE WARNINGS UNKNOWN/);
  });
  it('leaves the area\'s own alert state alone', async () => {
    seed();
    S.nwsAlerts = [{ id: 'area', event: 'Wind Advisory' }];
    mockServices({ alerts: res({ features: [alert('urn:1', 'Winter Storm Warning')] }) });
    await fetchResponseEstimate({});
    expect(S.nwsAlerts).toEqual([{ id: 'area', event: 'Wind Advisory' }]);
    S.nwsAlerts = [];
  });
});

describe('forest road access (MVUM)', () => {
  const mvum = dates => ({ type: 'FeatureCollection', features: [{ type: 'Feature',
    properties: { id: '12N77', name: 'BARRETT LAKE', operationalmaintlevel: '2 - HIGH CLEARANCE VEHICLES', seasonal: 'seasonal',
      highclearancevehicle: 'open', highclearancevehicle_datesopen: dates },
    geometry: { type: 'LineString', coordinates: valhallaEdgesToSegments(TRACE).coords.slice(2307, 2384).map(p => [p[1], p[0]]) } }] });
  it('flags a high-clearance seasonal road, without changing the drive time', async () => {
    seed();
    mockServices({ mvum: res(mvum('01/01-12/31')) });
    await fetchResponseEstimate({});
    expect(text('respAccess')).toMatch(/^12N77 BARRETT LAKE: high clearance, seasonal — open 01\/01-12\/31$/);
    const withMvum = S.response.dests[0].est.driveMin;
    seed();
    mockServices({ mvum: res({}, { status: 500 }) });
    await fetchResponseEstimate({});
    expect(S.response.dests[0].est.driveMin).toBeCloseTo(withMvum, 6); // MVUM never sets speed
    expect(text('respAccess')).toMatch(/^MVUM status unverified/);
    expect(document.getElementById('respAccess').classList.contains('amber')).toBe(true);
  });
  it('a road closed for the season turns the access cell red', async () => {
    seed();
    const m = new Date().getMonth() + 1; // a one-month window that never includes today
    const other = String(((m + 5) % 12) + 1).padStart(2, '0');
    mockServices({ mvum: res(mvum(`${other}/01-${other}/20`)) });
    await fetchResponseEstimate({});
    expect(text('respAccess')).toMatch(/CLOSED now/);
    expect(document.getElementById('respAccess').classList.contains('red')).toBe(true);
    expect(S.response.dests[0].sum.level).toBe('amber');
  });
  it('flags a motorized trail from the MVUM trails layer', async () => {
    seed();
    const trail = { type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { id: '16E21', name: null, seasonal: 'yearlong', fourwd_gt50inches: 'open', fourwd_gt50_datesopen: '01/01-12/31' },
      geometry: { type: 'LineString', coordinates: valhallaEdgesToSegments(TRACE).coords.slice(2307, 2384).map(p => [p[1], p[0]]) } }] };
    mockServices({ mvumt: res(trail) });
    await fetchResponseEstimate({});
    expect(text('respAccess')).toBe('16E21: motorized trail (4WD / high clearance)');
    expect(document.getElementById('respAccess').classList.contains('amber')).toBe(true);
  });
  it('both MVUM layers failing reads unverified', async () => {
    seed();
    mockServices({ mvum: res({}, { status: 500 }), mvumt: res({}, { status: 500 }) });
    await fetchResponseEstimate({});
    expect(text('respAccess')).toMatch(/^MVUM status unverified \(HTTP 500\)$/);
  });
  it('asks for MVUM roads and trails only around the unpaved part of the route', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    expect(count('mvum')).toBe(1);
    expect(count('mvumt')).toBe(1);
    const g = decodeURIComponent(calls.find(c => c.kind === 'mvum').url).match(/geometry=([-\d.,]+)/)[1].split(',').map(Number);
    expect(g[2] - g[0]).toBeLessThan(0.05); // a few km wide, not the 70 km route
    expect(text('respAccess')).toMatch(/not on the MVUM/);
  });
});

describe('routing failures', () => {
  it('no stored route → cells UNKNOWN: NEEDS UPDATE and an error status', async () => {
    seed();
    mockServices({ route: res({ error_code: 199, error: 'Unknown' }, { status: 500 }) });
    await fetchResponseEstimate({});
    expect(S.sectionMeta.response.status).toBe('error');
    ['respTotal', 'respRoad', 'respForest', 'respChains', 'respWx'].forEach(id => {
      expect(text(id)).toBe(UNKNOWN_CELL_TEXT);
      expect(document.getElementById(id).classList.contains('red')).toBe(true);
    });
    expect(document.querySelector('.resp-dest-row').textContent).toMatch(/UNKNOWN.*routing failed — Unknown/);
    expect(count('wx')).toBe(0); // nothing to sample
  });

  it('falls back to the stored route for this start and destination, labelled cached', async () => {
    seed();
    const stored = valhallaEdgesToSegments(TRACE);
    const at = Date.now() - 3 * HOUR;
    globalThis.getCachedApiResponse = vi.fn(async (endpoint) => (endpoint === 'response_route'
      ? { data: { coords: stored.coords, km: stored.km, sec: 4600, segments: stored.segments, surfaceDetail: true }, timestamp: at } : null));
    mockServices({ route: () => { throw new TypeError('Failed to fetch'); } });
    await fetchResponseEstimate({});
    expect(S.sectionMeta.response.status).toBe('cached');
    expect(S.sectionMeta.response.cachedAt).toBe(at);
    expect(text('respRoad')).toMatch(/\(cached route\)$/);
    expect(S.response.dests[0].sum.level).toBe('amber');
    expect(text('respTotal')).toMatch(/^1 h/);
  });

  it('stores a routed leg for that fallback', async () => {
    seed();
    globalThis.cacheApiResponse = vi.fn();
    mockServices();
    await fetchResponseEstimate({});
    expect(globalThis.cacheApiResponse).toHaveBeenCalledWith('response_route', expect.stringMatching(/^auto\|/), expect.objectContaining({ surfaceDetail: true }));
  });

  it('"no road near this point" is an answer, shown as NO ROAD FOUND', async () => {
    seed();
    mockServices({ route: res({ error_code: 171, error: 'No suitable edges near location' }, { status: 400 }) });
    await fetchResponseEstimate({});
    expect(text('respTotal')).toMatch(/^NO ROAD FOUND for Road nearest area centre — no road found near this point$/);
    expect(document.getElementById('respTotal').classList.contains('red')).toBe(true);
    expect(S.sectionMeta.response.status).toBe('live');
  });

  it('without per-edge surface the route is timed from its maneuvers, conservatively, and says so', async () => {
    seed();
    mockServices({ trace: res({ error_code: 154, error: 'Path distance exceeds the max distance limit' }, { status: 400 }) });
    await fetchResponseEstimate({});
    const drive = S.response.drives[S.response.dests[0].driveKey];
    expect(drive.surfaceDetail).toBe(false);
    expect(drive.segments.map(s => s.kind)).toEqual(['local', 'local', 'highway', 'local', 'forest']);
    expect(text('respForest')).toMatch(/surface detail unavailable/);
    expect(S.response.dests[0].sum.level).toBe('amber');
    expect(S.sectionMeta.response.status).toBe('live');
  });

  it('one failed destination among several is PARTIAL; the others keep their numbers', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1'), observer('vs_2', 'Observer 2', { lat: 38.84, lng: -120.25 })] });
    let n = 0;
    mockServices({ route: () => ((n++ === 1) ? res({ error_code: 199, error: 'Unknown' }, { status: 500 }) : res(ROUTE)) });
    await fetchResponseEstimate({});
    expect(S.sectionMeta.response).toMatchObject({ status: 'error', partial: true });
    expect(document.getElementById('responseStatus').textContent).toBe('PARTIAL');
    expect(text('respTotal')).toMatch(/to Observer 1/);
    const rows = [...document.querySelectorAll('.resp-dest-row')].map(r => r.textContent);
    expect(rows[1]).toMatch(/UNKNOWN/);
    selectResponseDest('vs_2');
    expect(text('respTotal')).toBe(UNKNOWN_CELL_TEXT);
  });

  it('a failed re-run keeps this route\'s earlier answer, flagged stale', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    const before = text('respTotal');
    S._responseMemo = null; // force a real request
    mockServices({ route: () => { throw new TypeError('Failed to fetch'); } });
    await fetchResponseEstimate({});
    expect(S.sectionMeta.response.status).toBe('error');
    expect(text('respTotal')).toBe(before + ' (stale: Verify)');
    expect(S.response.dests[0].sum.ok).toBe(true);
  });

  it('a failure for a DIFFERENT destination set never labels the old numbers stale', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    S.viewsheds = [observer('vs_9', 'Elsewhere', { lat: 38.5, lng: -120.4 })];
    mockServices({ route: () => { throw new TypeError('Failed to fetch'); } });
    await fetchResponseEstimate({});
    expect(text('respTotal')).toBe(UNKNOWN_CELL_TEXT);
  });
});

describe('request ownership', () => {
  it('drops a run superseded by an area change', async () => {
    seed();
    let release;
    const gate = new Promise(r => { release = r; });
    mockServices({ route: async () => { await gate; return res(ROUTE); } });
    const p = fetchResponseEstimate({});
    await vi.waitFor(() => expect(count('route')).toBe(1));
    invalidateAreaRequests();
    release();
    await p;
    expect(S.response).toBeNull();
    expect(text('respTotal')).toBe('--');
    expect(S.sectionMeta.response).toBeUndefined();
  });

  it('a newer run wins over an older one still in flight', async () => {
    seed();
    let release;
    const gate = new Promise(r => { release = r; });
    let first = true;
    mockServices({ wx: async url => { if (first) { first = false; await gate; return wxAnswer(url, { rain: 5 }); } return wxAnswer(url, {}); } });
    const old = fetchResponseEstimate({});
    await vi.waitFor(() => expect(count('wx')).toBe(1));
    await fetchResponseEstimate({});
    expect(text('respWx')).toMatch(/^No rain or snow/);
    release();
    await old;
    expect(text('respWx')).toMatch(/^No rain or snow/); // the late rainy answer was dropped
  });

  it('spaces routing requests by the minimum interval', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices();
    _setValhallaInterval(60);
    await fetchResponseEstimate({});
    const times = calls.filter(c => c.kind === 'route' || c.kind === 'trace' || c.kind === 'ped').map(c => c.at);
    expect(times.length).toBe(3);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(50);
  });

  it('clearing the area drops the estimate and the staging point', async () => {
    seed();
    mockServices();
    S._responseStaging = { areaKey: globalThis.areaKey(38.86, -120.23), lat: 38.85, lng: -120.24 };
    await fetchResponseEstimate({});
    _resetResponse();
    expect(S.response).toBeNull();
    expect(S._responseStaging).toBeNull();
    expect(S.mapLayers.response_route.getLayers().length).toBe(0);
    expect(text('respTotal')).toBe('--');
  });
});

describe('briefing and export', () => {
  it('adds a RESPONSE TIME block that never identifies the start location', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices({ cc: res(CC_KML) });
    await fetchResponseEstimate({});
    const lines = _briefingResponseLines();
    expect(lines[0]).toMatch(/^  Start: saved base location \| Departure: .* \(now\) \| Equipment loading: 30 min$/);
    expect(lines[1]).toMatch(/^  Observer 1: \d h \d+ min total, ETA .* — load 30 \+ road \d+ \+ forest road \d+ \+ chain control 45 \+ hike \d+ min/);
    expect(lines.join('\n')).toMatch(/Chain controls \/ closures: Chain control on route/);
    expect(lines.join('\n')).toMatch(/Warnings along route: none active/);
    expect(lines.join('\n')).not.toMatch(/38\.7296|-120\.7985/); // never the start's coordinates
    expect(lines.join('\n')).not.toMatch(/Placerville base/);     // nor its label: a geocoded label is a street address
    const text = buildBriefingText();
    const block = text.slice(text.indexOf('--- RESPONSE TIME ---'), text.indexOf('--- DISCLAIMER ---'));
    expect(block).toMatch(/Observer 1:/);
    expect(block.trim().split('\n').every(l => l.trim() !== '')).toBe(true); // no blank line inside the block
  });
  it('has no block when there is no estimate', () => {
    seed();
    expect(_briefingResponseLines()).toEqual([]);
    expect(buildBriefingText()).not.toMatch(/RESPONSE TIME/);
  });
  it('builds export records for the route, the road end and the hike', async () => {
    seed({ observers: [observer('vs_1', 'Observer 1')] });
    mockServices();
    await fetchResponseEstimate({});
    const recs = _exportResponseRecords();
    expect(recs.filter(r => r.kind === 'line' && r.styleId === 'responseRoad').length).toBeGreaterThanOrEqual(1);
    expect(recs.filter(r => r.kind === 'line' && r.styleId === 'responseForest').length).toBe(1);
    expect(recs.filter(r => r.kind === 'line' && r.styleId === 'responseHike').length).toBe(1);
    expect(recs.filter(r => r.kind === 'point').map(r => r.name)).toEqual(['Road end — Observer 1']);
    expect(recs[0].description).toMatch(/total — load 30/);
    recs.forEach(r => expect(KML_STYLE_DEFS[r.styleId]).toBeTruthy());
  });
  it('the generic layer harvest never picks the route up', async () => {
    seed();
    mockServices();
    await fetchResponseEstimate({});
    expect(S.mapLayers.response_route.getLayers().length).toBeGreaterThan(0);
    const groups = collectExportFolderGroups(null);
    expect(groups.some(g => /Response/.test(g.label))).toBe(false);
  });
});
