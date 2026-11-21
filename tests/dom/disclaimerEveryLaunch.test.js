// The disclaimer shows on EVERY launch — an earlier acceptance never skips it —
// and the app cannot be entered until its acknowledgment box is checked.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {}, getLayers: () => [] }) };
const { S, checkDisclaimer, showDisclaimer, acceptDisclaimer, onDisclaimerAckChange, DISCLAIMER_VERSION,
  DISCLAIMER_REPROMPT_MS, disclaimerRepromptDue, maybeRepromptDisclaimer } = require('../../sar-preflight.js');

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

  it('comes back 30 minutes after the last acceptance, not before', () => {
    checkDisclaimer();
    box().checked = true; acceptDisclaimer();
    const t0 = Date.now();
    expect(maybeRepromptDisclaimer(t0 + DISCLAIMER_REPROMPT_MS - 60000)).toBe(false);
    expect(modal().classList.contains('active')).toBe(false);
    expect(maybeRepromptDisclaimer(t0 + DISCLAIMER_REPROMPT_MS + 1000)).toBe(true);
    expect(modal().classList.contains('active')).toBe(true);
    expect(box().checked).toBe(false);          // a new acknowledgment is needed
    expect(btn().disabled).toBe(true);
    // Already showing: no second prompt.
    expect(maybeRepromptDisclaimer(t0 + 2 * DISCLAIMER_REPROMPT_MS)).toBe(false);
  });

  it('a newer acceptance in another tab restarts the 30 minutes', () => {
    checkDisclaimer();
    box().checked = true; acceptDisclaimer();
    const later = Date.now() + 25 * 60000;
    localStorage.setItem('sar_disclaimer_accepted_at', new Date(later).toISOString());
    expect(disclaimerRepromptDue(later + 20 * 60000)).toBe(false);
    expect(disclaimerRepromptDue(later + DISCLAIMER_REPROMPT_MS)).toBe(true);
  });

  it('waits while the page is hidden and asks on return', () => {
    checkDisclaimer();
    box().checked = true; acceptDisclaimer();
    S._disclaimerAckedAt = Date.now() - DISCLAIMER_REPROMPT_MS - 1000;
    localStorage.removeItem('sar_disclaimer_accepted_at');
    const vis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      expect(maybeRepromptDisclaimer()).toBe(false);
    } finally {
      delete document.visibilityState;
      if (vis) Object.defineProperty(Document.prototype, 'visibilityState', vis);
    }
    expect(maybeRepromptDisclaimer()).toBe(true);
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
