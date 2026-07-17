const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };
globalThis.SAR_VERSION = '2026.07.17-b';

const { S, showUpdateModal, dismissUpdateModal, acceptDisclaimer, checkDeployedVersion, fetchLatestVersion } = require('../../sar-preflight.js');

const NEW_MD = [
  '# Changelog', '',
  '## v2026.07.20 — 2026-07-20', '',
  '- Shiny new feature', '- Important fix', '',
  '## v2026.07.17-b — 2026-07-17', '',
  '- Old change', '',
].join('\n');

function setBody(disclaimerActive) {
  document.body.innerHTML = `
    <div class="modal-overlay${disclaimerActive ? ' active' : ''}" id="disclaimerModal"></div>
    <div class="modal-overlay" id="updateModal">
      <div id="updateModalSub"></div>
      <div id="updateModalBody"></div>
    </div>
    <div id="assessmentBanner"></div>`;
}

function mockFetch() {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).startsWith('version.js')) {
      return { ok: true, text: async () => "var SAR_VERSION = '2026.07.20';" };
    }
    if (String(url).startsWith('CHANGELOG.md')) {
      return { ok: true, text: async () => NEW_MD };
    }
    return { ok: false };
  });
}

describe('showUpdateModal', () => {
  beforeEach(() => {
    setBody(false);
    S._updateModalShown = false;
    S._pendingUpdateModal = false;
    S._pendingWhatsNew = false;
    mockFetch();
  });
  afterEach(() => { document.body.innerHTML = ''; delete globalThis.fetch; });

  it('opens the modal with the deployed version and its changelog entries', async () => {
    await showUpdateModal();
    const modal = document.getElementById('updateModal');
    expect(modal.classList.contains('active')).toBe(true);
    expect(document.getElementById('updateModalSub').textContent).toContain('v2026.07.17-b');
    expect(document.getElementById('updateModalSub').textContent).toContain('v2026.07.20');
    const body = document.getElementById('updateModalBody').innerHTML;
    expect(body).toContain('Shiny new feature');
    expect(body).toContain('Important fix');
    expect(body).not.toContain('Old change'); // only entries NEWER than the running version
  });

  it('also shows the persistent thin banner as a fallback', async () => {
    await showUpdateModal();
    expect(document.getElementById('swUpdateBanner')).toBeTruthy();
  });

  it('dismissUpdateModal closes the modal but leaves the banner', async () => {
    await showUpdateModal();
    dismissUpdateModal();
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(false);
    expect(document.getElementById('swUpdateBanner')).toBeTruthy();
  });

  it('auto-discovery shows the modal only once per session; force bypasses', async () => {
    await showUpdateModal();
    dismissUpdateModal();
    await showUpdateModal(); // second auto trigger — stays dismissed
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(false);
    await showUpdateModal(true); // manual Config check — reopens
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(true);
  });

  it('shows a fallback message when the changelog fetch fails (offline)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    await showUpdateModal();
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(true);
    expect(document.getElementById('updateModalBody').textContent).toContain('unavailable');
  });

  it('defers behind the disclaimer modal, then shows after acceptance', async () => {
    setBody(true);
    await showUpdateModal();
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(false);
    expect(S._pendingUpdateModal).toBe(true);
    acceptDisclaimer();
    await new Promise(r => setTimeout(r, 0)); // let the deferred async modal render
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(true);
  });
});

describe('checkDeployedVersion (active check — catches version.js-only deploys)', () => {
  beforeEach(() => {
    setBody(false);
    S._updateModalShown = false;
    S._pendingUpdateModal = false;
    S._lastVersionCheck = 0;
    mockFetch();
  });
  afterEach(() => { document.body.innerHTML = ''; delete globalThis.fetch; });

  it('shows the update modal when the deployed version differs from the running one', async () => {
    await checkDeployedVersion();
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(true);
  });

  it('does nothing when the deployed version matches', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => "var SAR_VERSION = '2026.07.17-b';" }));
    await checkDeployedVersion();
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(false);
    expect(document.getElementById('swUpdateBanner')).toBeFalsy();
  });

  it('does nothing when the version fetch fails (offline)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
    await checkDeployedVersion();
    expect(document.getElementById('updateModal').classList.contains('active')).toBe(false);
  });

  it('throttles repeat checks within the session window', async () => {
    await checkDeployedVersion();
    const calls = globalThis.fetch.mock.calls.length;
    await checkDeployedVersion(); // within throttle window — no new fetch
    expect(globalThis.fetch.mock.calls.length).toBe(calls);
  });
});
