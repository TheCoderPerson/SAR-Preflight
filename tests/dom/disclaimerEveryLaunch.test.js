// The disclaimer shows on EVERY launch — an earlier acceptance never skips it —
// and the app cannot be entered until its acknowledgment box is checked.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {}, getLayers: () => [] }) };
const { S, checkDisclaimer, showDisclaimer, acceptDisclaimer, onDisclaimerAckChange, DISCLAIMER_VERSION } = require('../../sar-preflight.js');

const modal = () => document.getElementById('disclaimerModal');
const box = () => document.getElementById('disclaimerAck');
const btn = () => document.getElementById('disclaimerAcceptBtn');

beforeEach(() => {
  document.body.innerHTML = `<div class="modal-overlay" id="disclaimerModal">
    <input type="checkbox" id="disclaimerAck"><button id="disclaimerAcceptBtn" disabled>Accept</button></div>`;
  S._disclaimerAcked = false;
  localStorage.clear();
});

describe('disclaimer on every launch', () => {
  it('shows even when this version was accepted before', () => {
    localStorage.setItem('sar_disclaimer_version', DISCLAIMER_VERSION);
    checkDisclaimer();
    expect(modal().classList.contains('active')).toBe(true);
    expect(box().checked).toBe(false);
    expect(btn().disabled).toBe(true);
  });

  it('cannot be accepted without the acknowledgment box', () => {
    checkDisclaimer();
    acceptDisclaimer();
    expect(modal().classList.contains('active')).toBe(true);
    expect(localStorage.getItem('sar_disclaimer_version')).toBeNull();
  });

  it('checking the box enables Accept, which closes it and records the acceptance', () => {
    checkDisclaimer();
    box().checked = true;
    onDisclaimerAckChange();
    expect(btn().disabled).toBe(false);
    acceptDisclaimer();
    expect(modal().classList.contains('active')).toBe(false);
    expect(localStorage.getItem('sar_disclaimer_version')).toBe(DISCLAIMER_VERSION);
    expect(localStorage.getItem('sar_disclaimer_accepted_at')).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('re-reading it later in the same session keeps the acknowledgment', () => {
    checkDisclaimer();
    box().checked = true; acceptDisclaimer();
    showDisclaimer();
    expect(box().checked).toBe(true);
    expect(btn().disabled).toBe(false);
    // The next launch asks again.
    checkDisclaimer();
    expect(box().checked).toBe(false);
  });
});
