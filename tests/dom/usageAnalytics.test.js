const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Analytics helpers only touch localStorage, navigator, and document.
globalThis.L = { layerGroup: () => ({ addTo() { return this; } }) };

const {
  analyticsOptedOut,
  setAnalyticsOptOut,
  _shouldLoadAnalytics,
  initUsageAnalytics,
} = require('../../sar-preflight.js');

beforeEach(() => {
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  // Reset any DNT/GPC fakes between tests
  try { delete navigator.globalPrivacyControl; } catch (e) { /* ignore */ }
});

describe('usage analytics — opt-out signals', () => {
  it('is opted IN by default', () => {
    expect(analyticsOptedOut()).toBe(false);
  });

  it('honors the in-app opt-out flag and clears it again', () => {
    setAnalyticsOptOut(true);
    expect(localStorage.getItem('sar_analytics_optout')).toBe('1');
    expect(analyticsOptedOut()).toBe(true);

    setAnalyticsOptOut(false);
    expect(localStorage.getItem('sar_analytics_optout')).toBe(null);
    expect(analyticsOptedOut()).toBe(false);
  });

  it('honors Global Privacy Control', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    expect(analyticsOptedOut()).toBe(true);
  });
});

describe('usage analytics — load decision (privacy guards)', () => {
  const ENV = { protocol: 'https:', hostname: 'thecoderperson.github.io', online: true, optedOut: false };
  const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef';

  it('loads only when a token is set, online, on https, and not opted out', () => {
    expect(_shouldLoadAnalytics(TOKEN, ENV)).toBe(true);
  });

  it('never loads without a token (off by default in source)', () => {
    expect(_shouldLoadAnalytics('', ENV)).toBe(false);
    expect(_shouldLoadAnalytics(null, ENV)).toBe(false);
  });

  it('never loads on file:// (the offline single-file field build)', () => {
    expect(_shouldLoadAnalytics(TOKEN, { ...ENV, protocol: 'file:' })).toBe(false);
  });

  it('never loads offline', () => {
    expect(_shouldLoadAnalytics(TOKEN, { ...ENV, online: false })).toBe(false);
  });

  it('never loads when opted out / DNT / GPC', () => {
    expect(_shouldLoadAnalytics(TOKEN, { ...ENV, optedOut: true })).toBe(false);
  });

  it('keeps local dev out of the numbers', () => {
    for (const hostname of ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'mybox.local']) {
      expect(_shouldLoadAnalytics(TOKEN, { ...ENV, hostname })).toBe(false);
    }
  });

  it('allows both deploy hosts (GitHub Pages + Cloudflare Pages)', () => {
    expect(_shouldLoadAnalytics(TOKEN, { ...ENV, hostname: 'thecoderperson.github.io' })).toBe(true);
    expect(_shouldLoadAnalytics(TOKEN, { ...ENV, hostname: 'sar-preflight-dev.pages.dev' })).toBe(true);
  });
});

describe('usage analytics — initUsageAnalytics', () => {
  it('never throws and injects no beacon when opted out (deterministic regardless of token/host)', () => {
    setAnalyticsOptOut(true);
    document.head.innerHTML = '';
    expect(() => initUsageAnalytics()).not.toThrow();
    expect(document.querySelector('script[src*="cloudflareinsights"]')).toBe(null);
    setAnalyticsOptOut(false);
  });
});
