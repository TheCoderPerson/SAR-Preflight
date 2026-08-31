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
    S.sectionMeta.tfr = null; S.sectionMeta.notam = null;
    S.tfrImportMeta = null;
    localStorage.removeItem('sar_canopy_proxy');
  });
  afterEach(() => { document.body.innerHTML = ''; localStorage.removeItem('sar_canopy_proxy'); });

  it('shows READY via the built-in default proxy when no custom proxy is configured', () => {
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('READY');
    expect(document.getElementById('autoCheckReBtn').style.display).toBe('none'); // no area yet
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

  it('shows fetched-at stamps in the CHECKED detail when the section metas carry them', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    const now = Date.now();
    S.sectionMeta.tfr = { status: 'live', updatedAt: now - 2 * 60000 };
    S.sectionMeta.notam = { status: 'live', updatedAt: now - 60000 };
    S.autoCheck = { state: 'ok', ms: now, tfrCount: 2, notamCount: 37 };
    renderAutoCheckStatus();
    const detail = document.getElementById('autoCheckDetail').textContent;
    expect(detail).toMatch(/TFRs fetched/);
    expect(detail).toMatch(/NOTAMs fetched/);
    expect(detail).toMatch(/2 TFRs/);
    expect(detail).toMatch(/37 NOTAMs/);
  });

  it('shows FAILED on error, naming 1800wxbrief.com', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'error', ms: Date.now(), tfrCount: 0, notamCount: 0 };
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('FAILED');
    expect(document.getElementById('autoCheckDetail').textContent).toMatch(/1800wxbrief\.com/);
  });

  it('labels prior data STALE on error and never shows the CHECKED badge', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.sectionMeta.tfr = { status: 'error', updatedAt: Date.now() - 3 * 3600000 };
    S.autoCheck = { state: 'error', ms: Date.now(), tfrCount: 1, notamCount: 0 };
    renderAutoCheckStatus();
    expect(document.getElementById('autoCheckStatus').textContent).toBe('FAILED');
    const detail = document.getElementById('autoCheckDetail').textContent;
    expect(detail).toMatch(/STALE/);
    expect(detail).toMatch(/1800wxbrief\.com/);
  });
});

describe('_restrictionEmptyMsg', () => {
  beforeEach(() => {
    S.currentArea = null; S.autoCheck = { state: 'idle' };
    S.sectionMeta.tfr = null; S.sectionMeta.notam = null;
    localStorage.removeItem('sar_canopy_proxy');
  });
  afterEach(() => localStorage.removeItem('sar_canopy_proxy'));

  it('falls back to the manual message with no proxy', () => {
    expect(_restrictionEmptyMsg('TFRs')).toMatch(/No TFR file imported/);
    expect(_restrictionEmptyMsg('NOTAMs')).toMatch(/No NOTAMs parsed/);
  });

  it('says "auto-checked <stamp>, none in area" after a successful auto-check', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'ok' };
    S.sectionMeta.tfr = { status: 'live', updatedAt: Date.now() - 2 * 60000 };
    S.sectionMeta.notam = { status: 'live', updatedAt: Date.now() - 60000 };
    expect(_restrictionEmptyMsg('TFRs')).toMatch(/Auto-checked .* — no active TFRs/);
    expect(_restrictionEmptyMsg('NOTAMs')).toMatch(/Auto-checked .* — no active NOTAMs/);
  });

  it('says "checking" while a check is in progress', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'checking' };
    expect(_restrictionEmptyMsg('TFRs')).toMatch(/Checking for TFRs/);
  });

  it('a failed leg reads UNKNOWN — never a reassuring "no active"', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'error' };
    S.sectionMeta.tfr = { status: 'error' };
    const msg = _restrictionEmptyMsg('TFRs');
    expect(msg).toMatch(/status UNKNOWN/);
    expect(msg).toMatch(/1800wxbrief/);
    expect(msg).not.toMatch(/no active/);
  });

  it('split outcome: live TFR leg says none, failed NOTAM leg says UNKNOWN', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    S.currentArea = {};
    S.autoCheck = { state: 'error' };
    S.sectionMeta.tfr = { status: 'live', updatedAt: Date.now() };
    S.sectionMeta.notam = { status: 'error' };
    expect(_restrictionEmptyMsg('TFRs')).toMatch(/no active TFRs/);
    expect(_restrictionEmptyMsg('NOTAMs')).toMatch(/status UNKNOWN/);
  });
});
