const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { S, _adsbAttemptUrls, ADSB_APIS, DEFAULT_DATA_PROXY } = require('../../sar-preflight.js');

describe('_adsbAttemptUrls (ADS-B fetch ordering)', () => {
  beforeEach(() => { S._adsbApiIndex = 0; localStorage.removeItem('sar_canopy_proxy'); });
  afterEach(() => localStorage.removeItem('sar_canopy_proxy'));

  it('uses the built-in default proxy first when no custom proxy is set', () => {
    const list = _adsbAttemptUrls('38.6850', '-120.9900', 16);
    expect(list).toHaveLength(ADSB_APIS.length + 1);
    expect(list[0].proxy).toBe(true);
    expect(list[0].url).toBe(DEFAULT_DATA_PROXY + '/adsb?lat=38.6850&lon=-120.9900&dist=16');
    expect(list.slice(1).every(a => !a.proxy)).toBe(true);
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
    // list[0] is the proxy; the direct-provider rotation starts at list[1]
    expect(list[1].name).toBe(ADSB_APIS[1].name);
  });
});

describe('ADS-B provider list', () => {
  it('no longer includes airplanes.live (403 to every unregistered client)', () => {
    expect(ADSB_APIS.map(a => a.name)).toEqual(['adsb.fi', 'adsb.lol']);
  });
});

describe('adsbProxyFailureSummary (proxy /adsb 502 body)', () => {
  const { adsbProxyFailureSummary } = core;
  it('names each provider and why it failed', () => {
    expect(adsbProxyFailureSummary({ error: 'all ADS-B providers failed', providers: [
      { name: 'adsb.fi', status: 403, detail: 'Forbidden' },
      { name: 'adsb.lol', status: 0, detail: 'timeout' },
    ] })).toBe('adsb.fi HTTP 403, adsb.lol timeout');
  });
  it('is empty for an older Worker body without providers, or no body', () => {
    expect(adsbProxyFailureSummary({ error: 'all ADS-B providers failed', ac: [] })).toBe('');
    expect(adsbProxyFailureSummary(null)).toBe('');
  });
});
