const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { S, renderAutoCheckStatus, _restrictionEmptyMsg } = require('../../sar-preflight.js');

function setBody() {
  document.body.innerHTML = `
    <div id="autoCheckStatusSection" style="display:none;">
      <div id="autoCheckIndicator"></div>
      <span id="autoCheckStatus"></span>
      <button id="autoCheckReBtn" style="display:none;"></button>
      <div id="autoCheckDetail"></div>
    </div>`;
}

describe('renderAutoCheckStatus', () => {
  beforeEach(() => {
    setBody();
    S.currentArea = null;
    S.autoCheck = { state: 'idle', ms: 0, tfrCount: 0, notamCount: 0 };
    localStorage.removeItem('sar_canopy_proxy');
  });
  afterEach(() => { document.body.innerHTML = ''; localStorage.removeItem('sar_canopy_proxy'); });

  it('shows OFF and hides Re-check when no proxy is configured', () => {
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('OFF');
    expect(document.getElementById('autoCheckDetail').textContent).toMatch(/Config/);
    expect(document.getElementById('autoCheckReBtn').style.display).toBe('none');
    expect(document.getElementById('autoCheckStatusSection').style.display).toBe('');
  });

  it('shows READY when proxy is set but no area drawn', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('READY');
    expect(document.getElementById('autoCheckReBtn').style.display).toBe('none'); // no area yet
  });

  it('shows CHECKED with counts + Re-check when a check succeeded with results', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'ok', ms: Date.now(), tfrCount: 2, notamCount: 37 };
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('CHECKED');
    const detail = document.getElementById('autoCheckDetail').textContent;
    expect(detail).toMatch(/2 TFRs/);
    expect(detail).toMatch(/37 NOTAMs/);
    expect(detail).toMatch(/Advisory/);
    expect(document.getElementById('autoCheckReBtn').style.display).toBe('');
  });

  it('shows CHECKED "none in this area" when the check found nothing', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'ok', ms: Date.now(), tfrCount: 0, notamCount: 0 };
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckDetail').textContent).toMatch(/no active TFRs or NOTAMs/);
  });

  it('shows FAILED on error', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'error', ms: Date.now(), tfrCount: 0, notamCount: 0 };
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('FAILED');
  });
});

describe('_restrictionEmptyMsg', () => {
  beforeEach(() => { S.currentArea = null; S.autoCheck = { state: 'idle' }; localStorage.removeItem('sar_canopy_proxy'); });
  afterEach(() => localStorage.removeItem('sar_canopy_proxy'));

  it('falls back to the manual message with no proxy', () => {
    expect(_restrictionEmptyMsg('TFRs')).toMatch(/No TFR file imported/);
    expect(_restrictionEmptyMsg('NOTAMs')).toMatch(/No NOTAMs parsed/);
  });

  it('says "auto-checked, none in area" after a successful auto-check', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'ok' };
    expect(_restrictionEmptyMsg('TFRs')).toMatch(/Auto-checked — no active TFRs/);
    expect(_restrictionEmptyMsg('NOTAMs')).toMatch(/Auto-checked — no active NOTAMs/);
  });

  it('says "checking" while a check is in progress', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'checking' };
    expect(_restrictionEmptyMsg('TFRs')).toMatch(/Checking for TFRs/);
  });
});
