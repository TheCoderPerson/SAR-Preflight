// The red DATA SOURCE ERRORS panel must list a failed source as soon as that
// source fails — not once every other fetch for the area has settled. A weather
// failure used to show UNKNOWN in its own section for minutes while the panel
// still listed only TFR/NOTAM, until slow Overpass mirrors finally gave up.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.formatAge = require('../../sar-preflight-offline.js').formatAge; // a global in the browser
globalThis.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {}, getLayers: () => [] }) };

const { S, recordDataSourceError, clearDataSourceError, showDataSourceStatus } = require('../../sar-preflight.js');

const tick = () => Promise.resolve().then(() => {});
const panel = () => document.getElementById('dataSourceWarning');
const listed = () => {
  const p = panel();
  return p ? [...p.querySelectorAll('.ds-details b')].map(b => b.textContent) : [];
};

beforeEach(() => {
  document.body.innerHTML = '<div><div id="assessmentBanner"></div></div>';
  S.dataSourceErrors = {};
  S.areaCenter = { lat: 38.76, lng: -120.57 };
});
afterEach(() => { S.areaCenter = null; });

describe('DATA SOURCE ERRORS panel', () => {
  it('lists a source the moment it fails, without waiting for the area load to finish', async () => {
    recordDataSourceError('TFR', new Error('TFR HTTP 403'));
    await tick();
    expect(listed()).toEqual(['TFR']);

    recordDataSourceError('Weather', new Error('no answer within 20 s'));
    await tick();
    expect(listed()).toEqual(['TFR', 'Weather']);
    expect(panel().textContent).toContain('DATA SOURCE ERRORS: TFR, Weather');
    expect(panel().textContent).toContain('no answer within 20 s');
  });

  it('drops a source when it recovers, and the panel when none is left', async () => {
    recordDataSourceError('Weather', new Error('x'));
    recordDataSourceError('Airports', new Error('y'));
    await tick();
    clearDataSourceError('Weather');
    await tick();
    expect(listed()).toEqual(['Airports']);
    clearDataSourceError('Airports');
    await tick();
    expect(panel()).toBeNull();
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
    expect(listed()).toEqual(['Weather']);
    expect(inserted).toEqual(['dataSourceWarning']);
  });

  it('keeps [details] open across redraws', async () => {
    recordDataSourceError('TFR', new Error('a'));
    await tick();
    panel().querySelector('.ds-details').style.display = 'block'; // the user opened it
    recordDataSourceError('Weather', new Error('b'));
    await tick();
    expect(panel().querySelector('.ds-details').style.display).toBe('block');
    expect(listed()).toEqual(['TFR', 'Weather']);
  });

  it('stays hidden with no area drawn (the banner it sits beside is hidden)', async () => {
    S.areaCenter = null;
    recordDataSourceError('Radar', new Error('x'));
    await tick();
    expect(panel()).toBeNull();
    expect(S.dataSourceErrors.Radar).toBeTruthy(); // still recorded for when an area is drawn
    S.areaCenter = { lat: 1, lng: 2 };
    showDataSourceStatus();
    expect(listed()).toEqual(['Radar']);
  });

  it('clearing a source that never failed changes nothing', async () => {
    recordDataSourceError('TFR', new Error('a'));
    await tick();
    const before = panel();
    clearDataSourceError('Weather');
    await tick();
    expect(panel()).toBe(before);
  });
});
