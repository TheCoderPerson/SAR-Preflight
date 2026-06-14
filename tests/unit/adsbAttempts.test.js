const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { S, _adsbAttemptUrls, ADSB_APIS } = require('../../sar-preflight.js');

describe('_adsbAttemptUrls (ADS-B fetch ordering)', () => {
  beforeEach(() => { S._adsbApiIndex = 0; localStorage.removeItem('sar_canopy_proxy'); });
  afterEach(() => localStorage.removeItem('sar_canopy_proxy'));

  it('uses only the direct providers when no proxy is set', () => {
    const list = _adsbAttemptUrls('38.6850', '-120.9900', 16);
    expect(list).toHaveLength(ADSB_APIS.length);
    expect(list.some(a => a.proxy)).toBe(false);
    expect(list[0].url).toContain('adsb');
  });

  it('puts the proxy /adsb route first when a proxy is configured', () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    const list = _adsbAttemptUrls('38.6850', '-120.9900', 16);
    expect(list).toHaveLength(ADSB_APIS.length + 1);
    expect(list[0].proxy).toBe(true);
    expect(list[0].url).toBe('https://x.workers.dev/adsb?lat=38.6850&lon=-120.9900&dist=16');
    // direct providers remain as fallback after the proxy
    expect(list.slice(1).every(a => !a.proxy)).toBe(true);
  });

  it('rotates the direct providers by S._adsbApiIndex', () => {
    S._adsbApiIndex = 1;
    const list = _adsbAttemptUrls('38.68', '-120.99', 16);
    expect(list[0].name).toBe(ADSB_APIS[1].name);
  });
});
