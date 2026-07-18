// Update-apply flow: REFRESH_SHELL messaging + install-settle helpers, and the
// sw.js message handler that re-pulls the app shell (the fix for the
// "Update Available" → reload → same old version modal loop).
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { S, _swRefreshShell, _swAwaitInstalled, applyUpdate } = require('../../sar-preflight.js');

describe('_swRefreshShell', () => {
  it('resolves true when the SW replies ok on the transferred port', async () => {
    const sw = {
      postMessage(msg, transfer) {
        expect(msg).toEqual({ type: 'REFRESH_SHELL' });
        transfer[0].postMessage({ ok: true });
      },
    };
    await expect(_swRefreshShell(sw, 2000)).resolves.toBe(true);
  });

  it('resolves false when the SW replies not-ok', async () => {
    const sw = { postMessage(msg, transfer) { transfer[0].postMessage({ ok: false }); } };
    await expect(_swRefreshShell(sw, 2000)).resolves.toBe(false);
  });

  it('resolves false on timeout (old SW without the handler)', async () => {
    const sw = { postMessage() { /* never replies */ } };
    await expect(_swRefreshShell(sw, 50)).resolves.toBe(false);
  });

  it('resolves false when postMessage throws', async () => {
    const sw = { postMessage() { throw new Error('gone'); } };
    await expect(_swRefreshShell(sw, 2000)).resolves.toBe(false);
  });
});

describe('_swAwaitInstalled', () => {
  it('resolves immediately when nothing is installing', async () => {
    await expect(_swAwaitInstalled({ installing: null }, 1000)).resolves.toBe(true);
  });

  it('resolves true when the installing worker reaches installed', async () => {
    const listeners = [];
    const sw = { state: 'installing', addEventListener: (t, f) => listeners.push(f) };
    const p = _swAwaitInstalled({ installing: sw }, 5000);
    sw.state = 'installed';
    listeners.forEach(f => f());
    await expect(p).resolves.toBe(true);
  });

  it('resolves false when the installing worker goes redundant', async () => {
    const listeners = [];
    const sw = { state: 'installing', addEventListener: (t, f) => listeners.push(f) };
    const p = _swAwaitInstalled({ installing: sw }, 5000);
    sw.state = 'redundant';
    listeners.forEach(f => f());
    await expect(p).resolves.toBe(false);
  });
});

describe('applyUpdate', () => {
  afterEach(() => { S._swReg = null; });

  it('refreshes the shell via the active SW and does NOT unregister', async () => {
    const unregister = vi.fn();
    const update = vi.fn().mockResolvedValue(undefined);
    S._swReg = {
      waiting: null, installing: null, update, unregister,
      active: { postMessage(msg, transfer) { transfer[0].postMessage({ ok: true }); } },
    };
    await applyUpdate();
    expect(update).toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('falls back to unregister when the active SW never replies', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    S._swReg = {
      waiting: null, installing: null,
      update: vi.fn().mockResolvedValue(undefined), unregister,
      active: { postMessage() { /* old SW: no REFRESH_SHELL handler */ } },
    };
    vi.useFakeTimers();
    const p = applyUpdate();
    await vi.advanceTimersByTimeAsync(13000);
    await p;
    vi.useRealTimers();
    expect(unregister).toHaveBeenCalled();
  });

  it('reloads without refresh/unregister when a new SW is already waiting', async () => {
    const unregister = vi.fn();
    const active = { postMessage: vi.fn() };
    S._swReg = { waiting: {}, installing: null, update: vi.fn(), unregister, active };
    await applyUpdate();
    expect(unregister).not.toHaveBeenCalled();
    expect(active.postMessage).not.toHaveBeenCalled();
  });
});

describe('sw.js REFRESH_SHELL handler', () => {
  it('re-fetches the app shell with cache:reload into the static cache and acks ok', async () => {
    // Capture the message listener at require time; stub Request/caches since
    // jsdom has neither (and Node's Request rejects the relative shell URLs).
    const listeners = {};
    const origAdd = self.addEventListener.bind(self);
    self.addEventListener = (type, fn) => { listeners[type] = listeners[type] || []; listeners[type].push(fn); };
    const origRequest = globalThis.Request;
    globalThis.Request = class { constructor(url, init) { this.url = url; this.init = init || {}; } };
    const added = [];
    let openedCache = null;
    globalThis.caches = {
      open: async (name) => { openedCache = name; return { addAll: async (reqs) => { added.push(...reqs); } }; },
    };
    try {
      const sw = require('../../sw.js');
      const msgHandlers = listeners['message'] || [];
      expect(msgHandlers.length).toBeGreaterThan(0);
      const replies = [];
      const waited = [];
      const event = {
        data: { type: 'REFRESH_SHELL' },
        ports: [{ postMessage: (m) => replies.push(m) }],
        waitUntil: (p) => waited.push(p),
      };
      msgHandlers.forEach(f => f(event));
      await Promise.all(waited);
      expect(openedCache).toBe(sw.CACHE_STATIC);
      expect(added.map(r => r.url)).toEqual(sw.APP_SHELL);
      expect(added.every(r => r.init.cache === 'reload')).toBe(true);
      expect(replies).toEqual([{ ok: true }]);
    } finally {
      self.addEventListener = origAdd;
      globalThis.Request = origRequest;
      delete globalThis.caches;
    }
  });
});
