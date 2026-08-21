const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { S, sendFeedback, openFeedback, closeFeedback, DEFAULT_DATA_PROXY } = require('../../sar-preflight.js');

function setBody() {
  document.body.innerHTML = `
    <div class="modal-overlay" id="feedbackModal">
      <textarea id="fbMessage"></textarea>
      <input id="fbContact" type="text" />
      <button id="btnSendFeedback">Send</button>
      <span id="fbStatus"></span>
    </div>
    <span id="proxyWarn" style="display:none;"></span>
    <span id="fetchActivity" style="display:none;"></span>
    <div id="statusDot"></div>`;
}

const okRes = () => ({ ok: true, status: 200, headers: { get: () => null } });
const errRes = (status) => ({ ok: false, status, headers: { get: () => null } });

describe('openFeedback / closeFeedback', () => {
  beforeEach(() => setBody());
  afterEach(() => { document.body.innerHTML = ''; });

  it('opens the modal and clears a stale status', () => {
    document.getElementById('fbStatus').textContent = 'Sent — thank you!';
    openFeedback();
    expect(document.getElementById('feedbackModal').classList.contains('active')).toBe(true);
    expect(document.getElementById('fbStatus').textContent).toBe('');
  });

  it('closes the modal', () => {
    openFeedback();
    closeFeedback();
    expect(document.getElementById('feedbackModal').classList.contains('active')).toBe(false);
  });

  it('tolerates a missing modal (dist page variants)', () => {
    document.body.innerHTML = '';
    expect(() => { openFeedback(); closeFeedback(); }).not.toThrow();
  });
});

describe('sendFeedback', () => {
  beforeEach(() => { setBody(); S._activeFetches = {}; localStorage.removeItem('sar_canopy_proxy'); });
  afterEach(() => {
    document.body.innerHTML = '';
    delete globalThis.fetch;
    localStorage.removeItem('sar_canopy_proxy');
  });

  it('does nothing but prompt when the message is empty', async () => {
    const calls = [];
    globalThis.fetch = (...a) => { calls.push(a); return Promise.resolve(okRes()); };
    await sendFeedback();
    expect(calls.length).toBe(0);
    expect(document.getElementById('fbStatus').textContent).toMatch(/message/i);
  });

  it('POSTs message + contact + version to <proxy>/feedback and clears the textarea', async () => {
    const calls = [];
    globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return Promise.resolve(okRes()); };
    document.getElementById('fbMessage').value = '  The viewshed rocks  ';
    document.getElementById('fbContact').value = 'KJ6ABC';
    await sendFeedback();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DEFAULT_DATA_PROXY + '/feedback');
    expect(calls[0].opts.method).toBe('POST');
    const body = JSON.parse(calls[0].opts.body);
    expect(body.message).toBe('The viewshed rocks'); // trimmed
    expect(body.contact).toBe('KJ6ABC');
    expect(typeof body.ua).toBe('string');
    expect(document.getElementById('fbMessage').value).toBe('');   // cleared on success
    expect(document.getElementById('fbContact').value).toBe('KJ6ABC'); // kept for a follow-up
    expect(document.getElementById('fbStatus').textContent).toMatch(/sent/i);
    expect(document.getElementById('btnSendFeedback').disabled).toBe(false);
  });

  it('uses a custom proxy base when one is configured', async () => {
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
    const calls = [];
    globalThis.fetch = (url) => { calls.push(url); return Promise.resolve(okRes()); };
    document.getElementById('fbMessage').value = 'hi';
    await sendFeedback();
    expect(calls[0]).toBe('https://x.workers.dev/feedback');
  });

  it('reports an unconfigured proxy (503) without clearing the message', async () => {
    globalThis.fetch = () => Promise.resolve(errRes(503));
    document.getElementById('fbMessage').value = 'hello';
    await sendFeedback();
    expect(document.getElementById('fbStatus').textContent).toMatch(/not set up/i);
    expect(document.getElementById('fbMessage').value).toBe('hello'); // preserved for retry
  });

  it('reports a rate limit (429) and preserves the message', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 429, headers: { get: (h) => (h === 'Retry-After' ? '60' : null) } });
    document.getElementById('fbMessage').value = 'hello';
    await sendFeedback();
    expect(document.getElementById('fbStatus').textContent).toMatch(/rate limit/i);
    expect(document.getElementById('fbMessage').value).toBe('hello');
  });

  it('handles a network failure and re-enables the button', async () => {
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    document.getElementById('fbMessage').value = 'hello';
    await sendFeedback();
    expect(document.getElementById('fbStatus').textContent).toMatch(/failed/i);
    expect(document.getElementById('fbMessage').value).toBe('hello');
    expect(document.getElementById('btnSendFeedback').disabled).toBe(false);
  });
});
