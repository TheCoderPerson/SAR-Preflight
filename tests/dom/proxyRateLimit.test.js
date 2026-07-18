const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { S, notifyProxyRateLimited, _proxyFetch, DEFAULT_DATA_PROXY } = require('../../sar-preflight.js');

function setBody() {
  document.body.innerHTML = `
    <span id="proxyWarn" style="display:none;"></span>
    <span id="fetchActivity" style="display:none;"></span>
    <div id="statusDot"></div>`;
}

describe('notifyProxyRateLimited', () => {
  beforeEach(() => { vi.useFakeTimers(); setBody(); S._activeFetches = {}; });
  afterEach(() => {
    if (S._proxyWarnTimer) { clearTimeout(S._proxyWarnTimer); S._proxyWarnTimer = null; }
    vi.useRealTimers(); document.body.innerHTML = '';
  });

  it('shows the PROXY LIMIT badge + amber dot, then auto-clears after Retry-After', () => {
    notifyProxyRateLimited(30);
    const warn = document.getElementById('proxyWarn');
    expect(warn.style.display).toBe('');
    expect(warn.textContent).toContain('PROXY LIMIT');
    expect(warn.title).toMatch(/rate limit/i);
    expect(document.getElementById('statusDot').style.background).toContain('amber');
    vi.advanceTimersByTime(31000);
    expect(warn.style.display).toBe('none');
    expect(warn.textContent).toBe('');
  });

  it('defaults to ~60 s when no Retry-After value is given', () => {
    notifyProxyRateLimited(NaN);
    vi.advanceTimersByTime(59000);
    expect(document.getElementById('proxyWarn').style.display).toBe('');
    vi.advanceTimersByTime(2000);
    expect(document.getElementById('proxyWarn').style.display).toBe('none');
  });

  it('re-triggering resets the clear timer', () => {
    notifyProxyRateLimited(60);
    vi.advanceTimersByTime(45000);
    notifyProxyRateLimited(60);
    vi.advanceTimersByTime(45000); // 90 s after first, 45 s after second
    expect(document.getElementById('proxyWarn').style.display).toBe('');
    vi.advanceTimersByTime(16000);
    expect(document.getElementById('proxyWarn').style.display).toBe('none');
  });
});

describe('_proxyFetch', () => {
  beforeEach(() => { vi.useFakeTimers(); setBody(); S._activeFetches = {}; localStorage.removeItem('sar_canopy_proxy'); });
  afterEach(() => {
    if (S._proxyWarnTimer) { clearTimeout(S._proxyWarnTimer); S._proxyWarnTimer = null; }
    vi.useRealTimers(); document.body.innerHTML = ''; delete globalThis.fetch;
    localStorage.removeItem('sar_canopy_proxy');
  });

  const res429 = () => ({ status: 429, headers: { get: (h) => (h === 'Retry-After' ? '45' : null) } });

  it('flags the status bar on a 429 from the (default) proxy base', async () => {
    globalThis.fetch = () => Promise.resolve(res429());
    const res = await _proxyFetch(DEFAULT_DATA_PROXY + '/notam?lat=1&lng=2&radius=20');
    expect(res.status).toBe(429); // response passes through so callers handle it
    expect(document.getElementById('proxyWarn').textContent).toContain('PROXY LIMIT');
  });

  it('flags a 429 from a custom proxy base too', async () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    globalThis.fetch = () => Promise.resolve(res429());
    await _proxyFetch('https://x.workers.dev/tfr/geoserver/TFR/ows?x=1');
    expect(document.getElementById('proxyWarn').textContent).toContain('PROXY LIMIT');
  });

  it('does NOT flag a 429 from a non-proxy URL', async () => {
    globalThis.fetch = () => Promise.resolve(res429());
    await _proxyFetch('https://api.adsb.lol/v2/lat/1/lon/2/dist/16');
    expect(document.getElementById('proxyWarn').style.display).toBe('none');
  });

  it('passes non-429 responses through untouched', async () => {
    const ok = { status: 200, ok: true, headers: { get: () => null } };
    globalThis.fetch = () => Promise.resolve(ok);
    const res = await _proxyFetch(DEFAULT_DATA_PROXY + '/chm/x.tif');
    expect(res).toBe(ok);
    expect(document.getElementById('proxyWarn').style.display).toBe('none');
  });
});
