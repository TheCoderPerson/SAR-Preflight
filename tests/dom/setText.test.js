const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { setText } = require('../../sar-preflight.js');

describe('setText(id, val)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="target">original</span>
      <span id="empty"></span>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sets textContent of an existing element', () => {
    setText('target', 'Hello World');
    expect(document.getElementById('target').textContent).toBe('Hello World');
  });

  it('overwrites previous textContent', () => {
    setText('target', 'first');
    expect(document.getElementById('target').textContent).toBe('first');
    setText('target', 'second');
    expect(document.getElementById('target').textContent).toBe('second');
  });

  it('handles numeric values converted to string', () => {
    setText('target', 42);
    expect(document.getElementById('target').textContent).toBe('42');
  });

  it('handles empty string', () => {
    setText('target', '');
    expect(document.getElementById('target').textContent).toBe('');
  });

  it('sets textContent on an already-empty element', () => {
    setText('empty', 'now filled');
    expect(document.getElementById('empty').textContent).toBe('now filled');
  });

  it('no-ops for a missing element (does not throw)', () => {
    expect(() => setText('nonexistent', 'value')).not.toThrow();
  });

  it('does not create a new element when id is missing', () => {
    setText('nonexistent', 'value');
    expect(document.getElementById('nonexistent')).toBeNull();
  });

  it('does not affect other elements', () => {
    setText('target', 'changed');
    expect(document.getElementById('empty').textContent).toBe('');
  });

  it('handles undefined value (DOM converts to empty string)', () => {
    setText('target', undefined);
    // DOM textContent setter converts undefined to ''
    expect(document.getElementById('target').textContent).toBe('');
  });

  it('handles null value (DOM converts to empty string)', () => {
    setText('target', null);
    // DOM textContent setter converts null to ''
    expect(document.getElementById('target').textContent).toBe('');
  });
});
