// Update-apply flow: REFRESH_SHELL messaging, activation-settle helper,
// cache-version verification (the fix for the "Update Available" → reload →
// same old version modal loop), immediate UI feedback, and the sw.js side
// (cache-busted atomic shell refresh + SKIP_WAITING).
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };
globalThis.SAR_VERSION = '2026.08.01-d';

const {
  S, _swRefreshShell, _swAwaitActivated, _cachedShellVersion, _verifyShellFresh,
  _updateApplyStatus, applyUpdate,
} = require('../../sar-preflight.js');

const RUNNING = '2026.08.01-d';
const DEPLOYED = '2026.99.99';

function setBody() {
  document.body.innerHTML = `
    <div class="modal-overlay active" id="updateModal">
      <div id="updateModalSub"></div>
      <div id="updateModalBody"></div>
      <div id="updateModalStatus" style="display:none;"></div>
      <button id="updateModalLater">Later</button>
      <button id="updateModalApply">Reload &amp; Update</button>
    </div>
    <div id="assessmentBanner"></div>`;
}

// fetch stub for fetchLatestVersion (the ?cb= probe)
function mockLatest(version) {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).startsWith('version.js')) {
      if (version === null) return { ok: false };
      return { ok: true, text: async () => `var SAR_VERSION = '${version}';` };
    }
    return { ok: false };
  });
}

// caches stub for _cachedShellVersion: `holder.version` is what the cache's
// version.js currently reads as (mutable so a test can flip it mid-flow).
function stubCaches(version) {
  const holder = {
    version,
    match: vi.fn(async (key) => {
      if (key !== 'version.js' || holder.version == null) return undefined;
      return { text: async () => `var SAR_VERSION = '${holder.version}';` };
    }),
  };
  globalThis.caches = { match: holder.match };
  return holder;
}

afterEach(() => {
  S._swReg = null;
  S._updateApplying = false;
  delete globalThis.fetch;
  delete globalThis.caches;
  document.body.innerHTML = '';
});

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

// Worker stub whose statechange fires asynchronously after the listener
// attaches — mimics a real install settling while applyUpdate awaits.
function makeWorker(finalState) {
  const w = {
    state: 'installing',
    postMessage: vi.fn(),
    addEventListener(type, fn) {
      if (type !== 'statechange') return;
      setTimeout(() => { w.state = finalState; fn(); }, 0);
    },
  };
  return w;
}

describe('_swAwaitActivated', () => {
  it("resolves 'activated' immediately when nothing is installing or waiting", async () => {
    await expect(_swAwaitActivated({ installing: null, waiting: null }, 1000)).resolves.toBe('activated');
  });

  it("resolves 'activated' immediately when the worker already activated", async () => {
    const sw = { state: 'activated', addEventListener() {} };
    await expect(_swAwaitActivated({ installing: sw, waiting: null }, 1000)).resolves.toBe('activated');
  });

  it("resolves 'activated' when the installing worker reaches activated — NOT at installed", async () => {
    const listeners = [];
    const sw = { state: 'installing', addEventListener: (t, f) => listeners.push(f), postMessage: vi.fn() };
    const p = _swAwaitActivated({ installing: sw, waiting: null }, 5000);
    sw.state = 'installed';   // reloading here is the old wasted-cycle bug
    listeners.forEach(f => f());
    let settled = false;
    p.then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(settled).toBe(false);
    sw.state = 'activated';
    listeners.forEach(f => f());
    await expect(p).resolves.toBe('activated');
  });

  it("resolves 'redundant' when the installing worker fails", async () => {
    const sw = makeWorker('redundant');
    await expect(_swAwaitActivated({ installing: sw, waiting: null }, 5000)).resolves.toBe('redundant');
  });

  it("resolves 'timeout' when the install never settles", async () => {
    const sw = { state: 'installing', addEventListener() {} };
    await expect(_swAwaitActivated({ installing: sw, waiting: null }, 50)).resolves.toBe('timeout');
  });

  it('posts SKIP_WAITING to a waiting worker (stuck across a browser restart)', async () => {
    const sw = makeWorker('activated');
    await _swAwaitActivated({ installing: null, waiting: sw }, 5000);
    expect(sw.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });
});

describe('_cachedShellVersion / _verifyShellFresh', () => {
  it('reads the version out of the cached version.js', async () => {
    stubCaches(DEPLOYED);
    await expect(_cachedShellVersion()).resolves.toBe(DEPLOYED);
  });

  it('returns null when nothing is cached or caches is unavailable (file:// dist)', async () => {
    stubCaches(null);
    await expect(_cachedShellVersion()).resolves.toBe(null);
    delete globalThis.caches;
    await expect(_cachedShellVersion()).resolves.toBe(null);
  });

  it("verify: 'fresh' when the cache differs from the running version", async () => {
    stubCaches(DEPLOYED);
    await expect(_verifyShellFresh(DEPLOYED)).resolves.toBe('fresh');
  });

  it("verify: 'stale' when the cache still holds the running version", async () => {
    stubCaches(RUNNING);
    await expect(_verifyShellFresh(DEPLOYED)).resolves.toBe('stale');
  });

  it("verify: 'unknown' when latest is null (dist/offline) — cache never read", async () => {
    const holder = stubCaches(RUNNING);
    await expect(_verifyShellFresh(null)).resolves.toBe('unknown');
    expect(holder.match).not.toHaveBeenCalled();
  });

  it("verify: 'unknown' when latest equals running (phantom modal — nothing provable)", async () => {
    stubCaches(RUNNING);
    await expect(_verifyShellFresh(RUNNING)).resolves.toBe('unknown');
  });
});

describe('_updateApplyStatus', () => {
  beforeEach(setBody);

  it('shows the status line and disables both buttons while updating', () => {
    _updateApplyStatus('Downloading update…');
    const status = document.getElementById('updateModalStatus');
    expect(status.style.display).toBe('block');
    expect(status.textContent).toBe('Downloading update…');
    expect(document.getElementById('updateModalLater').disabled).toBe(true);
    const apply = document.getElementById('updateModalApply');
    expect(apply.disabled).toBe(true);
    expect(apply.textContent).toBe('Updating…');
  });

  it('failure re-enables the buttons and offers Try Again', () => {
    _updateApplyStatus('Downloading update…');
    _updateApplyStatus('Server still serving old version', { failed: true });
    expect(document.getElementById('updateModalLater').disabled).toBe(false);
    const apply = document.getElementById('updateModalApply');
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toBe('Try Again');
  });
});

describe('applyUpdate', () => {
  beforeEach(setBody);

  it('gives immediate synchronous feedback — before any network work settles', () => {
    mockLatest(DEPLOYED);
    S._swReg = {
      waiting: null, installing: null, update: vi.fn().mockResolvedValue(undefined),
      unregister: vi.fn(),
      active: { postMessage(msg, transfer) { transfer[0].postMessage({ ok: true }); } },
    };
    const p = applyUpdate(); // do not await — check the synchronous prefix
    const apply = document.getElementById('updateModalApply');
    expect(apply.disabled).toBe(true);
    expect(apply.textContent).toBe('Updating…');
    expect(document.getElementById('updateModalStatus').textContent).toContain('Checking');
    return p;
  });

  it('refreshes the shell via the active SW, verifies, reloads — and does NOT unregister', async () => {
    mockLatest(DEPLOYED);
    stubCaches(DEPLOYED); // refresh landed the new version
    const unregister = vi.fn();
    const update = vi.fn().mockResolvedValue(undefined);
    S._swReg = {
      waiting: null, installing: null, update, unregister,
      active: { postMessage(msg, transfer) { transfer[0].postMessage({ ok: true }); } },
    };
    await expect(applyUpdate()).resolves.toBe('reloaded');
    expect(update).toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('does NOT reload when the refreshed cache still holds the running version — retries once, then fails honestly', async () => {
    mockLatest(DEPLOYED);
    stubCaches(RUNNING); // the CDN edge keeps serving the old shell
    const unregister = vi.fn();
    const postMessage = vi.fn((msg, transfer) => { transfer[0].postMessage({ ok: true }); });
    S._swReg = {
      waiting: null, installing: null,
      update: vi.fn().mockResolvedValue(undefined), unregister,
      active: { postMessage },
    };
    await expect(applyUpdate()).resolves.toBe('stale');
    expect(postMessage).toHaveBeenCalledTimes(2); // initial + one retry
    expect(unregister).not.toHaveBeenCalled();
    expect(document.getElementById('updateModalStatus').textContent).toContain('still serving');
    const apply = document.getElementById('updateModalApply');
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toBe('Try Again');
    expect(S._updateApplying).toBe(false); // Try Again must actually work
  });

  it('skips verification when the deployed version is unknown (dist/offline) and reloads as before', async () => {
    mockLatest(null);
    const holder = stubCaches(RUNNING);
    S._swReg = {
      waiting: null, installing: null,
      update: vi.fn().mockResolvedValue(undefined), unregister: vi.fn(),
      active: { postMessage(msg, transfer) { transfer[0].postMessage({ ok: true }); } },
    };
    await expect(applyUpdate()).resolves.toBe('reloaded');
    expect(holder.match).not.toHaveBeenCalled();
  });

  it('falls back to unregister when the active SW never replies (old deployed SW)', async () => {
    mockLatest(null);
    const unregister = vi.fn().mockResolvedValue(true);
    S._swReg = {
      waiting: null, installing: null,
      update: vi.fn().mockResolvedValue(undefined), unregister,
      active: { postMessage() { /* old SW: no REFRESH_SHELL handler */ } },
    };
    vi.useFakeTimers();
    const p = applyUpdate();
    await vi.advanceTimersByTimeAsync(31000);
    await expect(p).resolves.toBe('unregistered');
    vi.useRealTimers();
    expect(unregister).toHaveBeenCalled();
  });

  it('new SW installing: waits for ACTIVATION, verifies, then reloads', async () => {
    mockLatest(DEPLOYED);
    stubCaches(DEPLOYED); // new SW's install precached the new shell
    const installing = makeWorker('activated');
    S._swReg = { waiting: null, installing, update: vi.fn(), unregister: vi.fn(), active: null };
    await expect(applyUpdate()).resolves.toBe('reloaded');
  });

  it('new SW installing, timeout: fails honestly instead of reloading into the old version', async () => {
    mockLatest(DEPLOYED);
    const installing = { state: 'installing', addEventListener() {}, postMessage: vi.fn() };
    S._swReg = { waiting: null, installing, update: vi.fn(), unregister: vi.fn(), active: null };
    vi.useFakeTimers();
    const p = applyUpdate();
    await vi.advanceTimersByTimeAsync(31000);
    await expect(p).resolves.toBe('timeout');
    vi.useRealTimers();
    expect(S._swReg.unregister).not.toHaveBeenCalled();
    expect(document.getElementById('updateModalApply').disabled).toBe(false);
    expect(S._updateApplying).toBe(false);
  });

  it('repairs a stale install precache via the new SW\'s REFRESH_SHELL (bootstrap from old sw.js)', async () => {
    mockLatest(DEPLOYED);
    const holder = stubCaches(RUNNING); // old SW's install raced a stale edge
    const installing = makeWorker('activated');
    const active = {
      postMessage: vi.fn((msg, transfer) => {
        holder.version = DEPLOYED; // the fixed SW's cache-busted refresh lands the real bytes
        transfer[0].postMessage({ ok: true });
      }),
    };
    S._swReg = { waiting: null, installing, update: vi.fn(), unregister: vi.fn(), active };
    await expect(applyUpdate()).resolves.toBe('reloaded');
    expect(active.postMessage).toHaveBeenCalledTimes(1);
  });

  it('is re-entry safe: a second click while applying resolves busy and does nothing', async () => {
    mockLatest(DEPLOYED);
    S._updateApplying = true;
    const update = vi.fn();
    S._swReg = { waiting: null, installing: null, update, unregister: vi.fn(), active: null };
    await expect(applyUpdate()).resolves.toBe('busy');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('sw.js refreshAppShell + message handlers', () => {
  // Load sw.js ONCE for the whole describe (require caches CJS modules, so a
  // reload would capture no listeners). The handlers resolve fetch/caches/
  // self.skipWaiting at call time, so per-test stubs still take effect.
  let listeners = null, swMod = null, origRequest;

  function loadSwOnce() {
    if (swMod) return;
    listeners = {};
    const origAdd = self.addEventListener.bind(self);
    self.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
    try {
      swMod = require('../../sw.js');
    } finally {
      self.addEventListener = origAdd;
    }
  }

  beforeEach(() => {
    origRequest = globalThis.Request;
    // jsdom has no Request, and Node's rejects the relative shell URLs.
    globalThis.Request = class { constructor(url, init) { this.url = url; this.init = init || {}; } };
    loadSwOnce();
  });
  afterEach(() => {
    globalThis.Request = origRequest;
    delete globalThis.caches;
    delete globalThis.fetch;
    delete self.skipWaiting;
  });

  async function fireRefreshShell() {
    const replies = [];
    const waited = [];
    const event = {
      data: { type: 'REFRESH_SHELL' },
      ports: [{ postMessage: (m) => replies.push(m) }],
      waitUntil: (p) => waited.push(p.catch(() => {})),
    };
    (listeners['message'] || []).forEach(f => f(event));
    await Promise.all(waited);
    return replies;
  }

  it('fetches every shell file cache-busted past the CDN edge, commits under the clean URLs, acks ok', async () => {
    const fetched = [];
    globalThis.fetch = vi.fn(async (req) => { fetched.push(req); return { status: 200 }; });
    const puts = [];
    let openedCache = null;
    globalThis.caches = {
      open: async (name) => { openedCache = name; return { put: async (req, resp) => { puts.push(req.url); } }; },
    };
    const replies = await fireRefreshShell();
    expect(fetched.length).toBe(swMod.APP_SHELL.length);
    // Unique ?swr= query on every request — `cache:'reload'` alone only
    // bypasses the browser cache; the edge (GitHub Pages, max-age=600) keys
    // on the full URL and would happily re-serve the OLD bytes without it.
    for (const req of fetched) {
      expect(req.url).toContain('swr=');
      expect(req.init.cache).toBe('reload');
    }
    expect(puts.sort()).toEqual([...swMod.APP_SHELL].sort()); // committed under the CLEAN urls
    expect(openedCache).toBe(swMod.CACHE_STATIC);
    expect(replies).toEqual([{ ok: true }]);
  });

  it('is atomic: one failed file → NOTHING is committed and the ack is not-ok (no mixed old/new shell)', async () => {
    globalThis.fetch = vi.fn(async (req) =>
      String(req.url).includes('sar-preflight.js') ? { status: 404 } : { status: 200 });
    const puts = [];
    globalThis.caches = { open: async () => ({ put: async (req) => { puts.push(req.url); } }) };
    const replies = await fireRefreshShell();
    expect(puts.length).toBe(0);
    expect(replies).toEqual([{ ok: false }]);
  });

  it('SKIP_WAITING message calls skipWaiting()', () => {
    self.skipWaiting = vi.fn();
    (listeners['message'] || []).forEach(f => f({ data: { type: 'SKIP_WAITING' } }));
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it('precaches sar-preflight-charts.js with the rest of the shell', () => {
    expect(swMod.APP_SHELL).toContain('./sar-preflight-charts.js');
  });
});
