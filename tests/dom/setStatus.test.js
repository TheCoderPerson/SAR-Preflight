const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { setStatus } = require('../../sar-preflight.js');

describe('setStatus(id, type, text)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="wxStatus" class="fetch-status idle">IDLE</span>
      <span id="windStatus" class="fetch-status idle">IDLE</span>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('sets className to "fetch-status loading" for loading state', () => {
    setStatus('wxStatus', 'loading', 'Fetching...');
    const el = document.getElementById('wxStatus');
    expect(el.className).toBe('fetch-status loading');
  });

  it('sets textContent for loading state', () => {
    setStatus('wxStatus', 'loading', 'Fetching...');
    expect(document.getElementById('wxStatus').textContent).toBe('Fetching...');
  });

  it('sets className to "fetch-status live" for live state', () => {
    setStatus('wxStatus', 'live', 'LIVE');
    expect(document.getElementById('wxStatus').className).toBe('fetch-status live');
  });

  it('sets textContent for live state', () => {
    setStatus('wxStatus', 'live', 'LIVE');
    expect(document.getElementById('wxStatus').textContent).toBe('LIVE');
  });

  it('sets className to "fetch-status error" for error state', () => {
    setStatus('wxStatus', 'error', 'ERROR');
    expect(document.getElementById('wxStatus').className).toBe('fetch-status error');
  });

  it('sets textContent for error state', () => {
    setStatus('wxStatus', 'error', 'ERROR');
    expect(document.getElementById('wxStatus').textContent).toBe('ERROR');
  });

  it('replaces previous className entirely', () => {
    setStatus('wxStatus', 'loading', 'Fetching...');
    setStatus('wxStatus', 'live', 'LIVE');
    const el = document.getElementById('wxStatus');
    expect(el.className).toBe('fetch-status live');
    expect(el.className).not.toContain('loading');
  });

  it('works with custom type strings', () => {
    setStatus('wxStatus', 'manual', 'MANUAL');
    expect(document.getElementById('wxStatus').className).toBe('fetch-status manual');
    expect(document.getElementById('wxStatus').textContent).toBe('MANUAL');
  });

  it('works on different elements', () => {
    setStatus('wxStatus', 'live', 'LIVE');
    setStatus('windStatus', 'error', 'ERROR');
    expect(document.getElementById('wxStatus').className).toBe('fetch-status live');
    expect(document.getElementById('windStatus').className).toBe('fetch-status error');
  });

  it('handles missing element gracefully (no throw)', () => {
    expect(() => setStatus('nonexistent', 'live', 'LIVE')).not.toThrow();
  });

  it('does not create element when id is missing', () => {
    setStatus('nonexistent', 'live', 'LIVE');
    expect(document.getElementById('nonexistent')).toBeNull();
  });

  it('handles empty text string', () => {
    setStatus('wxStatus', 'live', '');
    expect(document.getElementById('wxStatus').textContent).toBe('');
    expect(document.getElementById('wxStatus').className).toBe('fetch-status live');
  });

  it('handles text with feature count', () => {
    setStatus('wxStatus', 'live', '42 FEATURES');
    expect(document.getElementById('wxStatus').textContent).toBe('42 FEATURES');
  });
});
