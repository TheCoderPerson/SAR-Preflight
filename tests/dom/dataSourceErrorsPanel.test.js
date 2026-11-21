// The DATA SOURCES list under the advisories shows EVERY source the app queries
// with its status: red ERROR (plain-language cause + RETRY), cyan UPDATING…,
// green OK with its age, amber CACHED. A failed source must be listed as soon
// as it fails — not once every other fetch for the area has settled.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.formatAge = require('../../sar-preflight-offline.js').formatAge; // a global in the browser
globalThis.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {}, getLayers: () => [] }) };

const app = require('../../sar-preflight.js');
const { S, recordDataSourceError, clearDataSourceError, showDataSourceStatus, trackFetchStart, trackFetchEnd, dataSourceRows } = app;

const tick = () => Promise.resolve().then(() => {});
const panel = () => document.getElementById('dataSourceWarning');
const inState = st => {
  const p = panel();
  return p ? [...p.querySelectorAll('.ds-row.ds-' + st + ' b')].map(b => b.textContent) : [];
};
const row = name => panel() && panel().querySelector(`.ds-row[data-source="${name}"]`);

beforeEach(() => {
  document.body.innerHTML = '<div><div id="assessmentBanner"></div></div>';
  S.dataSourceErrors = {};
  S.dataSourceOkAt = {};
  S._activeFetches = {};
  S.sectionMeta = {};
  S._dsListCollapsed = false;
  S.areaCenter = { lat: 38.76, lng: -120.57 };
});
afterEach(() => { S.areaCenter = null; S._activeFetches = {}; });

describe('DATA SOURCES list', () => {
  it('lists a source the moment it fails, without waiting for the area load to finish', async () => {
    recordDataSourceError('TFR', new Error('TFR HTTP 403'));
    await tick();
    expect(inState('error')).toEqual(['TFR']);

    recordDataSourceError('Weather', new Error('no answer within 20 s'));
    await tick();
    expect(inState('error').sort()).toEqual(['TFR', 'Weather']);
    expect(panel().textContent).toContain('2 ERRORS');
    expect(panel().textContent).toContain('no answer within 20 s');
  });

  it('explains the server answer in plain words', async () => {
    recordDataSourceError('TFR', new Error('TFR HTTP 403'));
    recordDataSourceError('Weather', new Error('HTTP 503'));
    recordDataSourceError('Smoke', new Error('no answer within 20 s'));
    await tick();
    expect(row('TFR').textContent).toMatch(/ERROR — Access refused/);
    expect(row('TFR').textContent).toContain('TFR HTTP 403 (access refused)');
    expect(row('Weather').textContent).toMatch(/Service unavailable/);
    expect(row('Smoke').textContent).toMatch(/Timed out/);
    expect(row('TFR').querySelector('button').textContent).toBe('RETRY');
  });

  it('shows every queried source: cyan while updating, green with its age once it answered', async () => {
    trackFetchStart('Elevation');
    await tick();
    expect(row('Elevation').className).toContain('ds-updating');
    expect(row('Elevation').textContent).toContain('UPDATING');
    // Sources this area has not started yet are listed too, as not checked.
    expect(row('Smoke').className).toContain('ds-waiting');

    clearDataSourceError('Elevation');
    trackFetchEnd('Elevation');
    await tick();
    expect(row('Elevation').className).toContain('ds-ok');
    expect(row('Elevation').textContent).toMatch(/OK · <1m ago/);
  });

  it('reads a section freshness record: live = OK with age, cached = amber with the copy age', async () => {
    S.sectionMeta.weather = { status: 'live', updatedAt: Date.now() - 5 * 60000 };
    S.sectionMeta.airspace = { status: 'cached', sources: { faa: { status: 'cached', cachedAt: Date.now() - 3 * 3600000 } } };
    showDataSourceStatus();
    expect(row('Weather').textContent).toMatch(/OK · 5m ago/);
    expect(row('FAA Airspace').className).toContain('ds-cached');
    expect(row('FAA Airspace').textContent).toMatch(/CACHED · 3h old/);
  });

  it('a section that failed without a recorded source error is still an ERROR with RETRY', () => {
    S.sectionMeta.water = { status: 'error', error: 'HTTP 502', errorAt: Date.now() };
    showDataSourceStatus();
    expect(row('Water (NHD)').className).toContain('ds-error');
    expect(row('Water (NHD)').textContent).toMatch(/Bad gateway/);
  });

  it('a retry in flight shows UPDATING, not the old error', async () => {
    recordDataSourceError('Weather', new Error('HTTP 503'));
    trackFetchStart('Weather');
    await tick();
    expect(row('Weather').className).toContain('ds-updating');
    expect(row('Air Quality').className).toContain('ds-updating'); // fetched in the same request
  });

  it('background polls (ADS-B, radar) keep their last state instead of flashing UPDATING', async () => {
    S.sectionMeta.adsb = { status: 'live', updatedAt: Date.now() };
    trackFetchStart('ADS-B');
    await tick();
    expect(row('ADS-B').className).toContain('ds-ok');
    trackFetchEnd('ADS-B');
  });

  it('on-demand sources appear only once used', () => {
    showDataSourceStatus();
    expect(row('Viewshed')).toBeNull();
    expect(row('Response Time')).toBeNull();
    recordDataSourceError('Viewshed', new Error('3DEP HTTP 504'));
    showDataSourceStatus();
    expect(row('Viewshed').className).toContain('ds-error');
  });

  it('redraws once for several changes in the same tick', async () => {
    const inserted = [];
    const banner = document.getElementById('assessmentBanner');
    const orig = banner.parentElement.insertBefore.bind(banner.parentElement);
    banner.parentElement.insertBefore = (n, ref) => { inserted.push(n.id); return orig(n, ref); };
    recordDataSourceError('Weather', new Error('a'));
    recordDataSourceError('Air Quality', new Error('b'));
    clearDataSourceError('Air Quality');
    expect(panel()).toBeNull();               // not yet: batched to the next tick
    await tick();
    expect(inState('error')).toEqual(['Weather']);
    expect(inserted).toEqual(['dataSourceWarning']);
  });

  it('[hide list] collapses to the summary line and is remembered across redraws', async () => {
    recordDataSourceError('TFR', new Error('a'));
    await tick();
    panel().querySelector('.ds-toggle').click();
    expect(panel().querySelector('.ds-details').style.display).toBe('none');
    expect(panel().textContent).toContain('1 ERROR');
    recordDataSourceError('Weather', new Error('b'));
    await tick();
    expect(panel().querySelector('.ds-details').style.display).toBe('none');
    panel().querySelector('.ds-toggle').click();
    expect(panel().querySelector('.ds-details').style.display).toBe('block');
  });

  it('stays hidden with no area drawn (the banner it sits beside is hidden)', async () => {
    S.areaCenter = null;
    recordDataSourceError('Radar', new Error('x'));
    await tick();
    expect(panel()).toBeNull();
    expect(S.dataSourceErrors.Radar).toBeTruthy(); // still recorded for when an area is drawn
    S.areaCenter = { lat: 1, lng: 2 };
    showDataSourceStatus();
    expect(inState('error')).toEqual(['Radar']);
  });

  it('feeds the banner: errors first, then updating; logistics-only sources never', () => {
    recordDataSourceError('TFR', new Error('TFR HTTP 403'));
    S._activeFetches = { 'FAA Airspace': 1 };
    S.sectionMeta.response = { status: 'error', error: 'HTTP 504' };
    const adv = dataSourceAdvisories(dataSourceRows());
    expect(adv).toEqual(['Data source errors: TFR (access refused)', 'Data sources updating: FAA Airspace']);
  });
});
