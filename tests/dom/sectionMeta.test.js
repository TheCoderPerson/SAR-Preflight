const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = {
  map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() },
  Draw: { Event: {} }, FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({ addTo: vi.fn(function () { return this; }), clearLayers: vi.fn(), addLayer: vi.fn() })),
};

const { S, markSection, renderSectionMeta, updateSection, SECTION_DEFS } = require('../../sar-preflight.js');

describe('renderSectionMeta(key)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="section-meta" id="meta_wx"></div>
      <div class="section-meta" id="meta_vis"></div>
      <div class="section-meta" id="meta_solar"></div>
      <div class="section-meta" id="meta_obstacles"></div>
    `;
    S.sectionMeta = {};
    S.areaCenter = null;
    S.areaBounds = null;
    S.map = {};
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('renders "Not loaded" with a disabled UPDATE button before any fetch', () => {
    renderSectionMeta('weather');
    const el = document.getElementById('meta_wx');
    expect(el.querySelector('.section-updated').textContent).toBe('Not loaded');
    const btn = el.querySelector('.section-update');
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });

  it('shows "Updated …" and enables the button once area + live data exist', () => {
    S.areaCenter = { lat: 38.7, lng: -120.9 };
    markSection('weather', { status: 'live', updatedAt: Date.now() });
    const el = document.getElementById('meta_wx');
    expect(el.querySelector('.section-updated').textContent).toMatch(/^Updated /);
    expect(el.className).toContain('section-meta-live');
    expect(el.querySelector('.section-update').disabled).toBe(false);
  });

  it('sibling line shares the owner timestamp and has no button', () => {
    S.areaCenter = { lat: 38.7, lng: -120.9 };
    markSection('weather', { status: 'live', updatedAt: Date.now() });
    const owner = document.getElementById('meta_wx');
    const sibling = document.getElementById('meta_vis');
    expect(sibling.querySelector('.section-updated').textContent)
      .toBe(owner.querySelector('.section-updated').textContent);
    expect(sibling.querySelector('.section-update')).toBeNull();
  });

  it('keeps the button disabled when no area is drawn, even with live data', () => {
    S.areaCenter = null;
    markSection('weather', { status: 'live', updatedAt: Date.now() });
    expect(document.getElementById('meta_wx').querySelector('.section-update').disabled).toBe(true);
  });

  it('error state shows a red line that still allows UPDATE', () => {
    S.areaCenter = { lat: 38.7, lng: -120.9 };
    markSection('weather', { status: 'error', error: 'HTTP 503' });
    const el = document.getElementById('meta_wx');
    expect(el.className).toContain('section-meta-error');
    expect(el.querySelector('.section-updated').textContent).toContain('failed');
    expect(el.querySelector('.section-update').disabled).toBe(false);
  });

  it('obstacles rollup: a cached sub-source makes the header amber', () => {
    S.areaCenter = { lat: 38.7, lng: -120.9 };
    markSection('obstacles', { source: 'dof', status: 'live', updatedAt: Date.now() });
    markSection('obstacles', { source: 'wire', status: 'cached', cachedAt: Date.now() - 60000 });
    markSection('obstacles', { source: 'protected', status: 'live', updatedAt: Date.now() });
    expect(document.getElementById('meta_obstacles').className).toContain('section-meta-cached');
  });
});

describe('updateSection(key)', () => {
  beforeEach(() => {
    document.body.innerHTML = `<div class="section-meta" id="meta_solar"></div>`;
    S.sectionMeta = {};
    S.areaCenter = { lat: 38.7, lng: -120.9 };
    S.areaBounds = {};
    S.map = {};
  });
  afterEach(() => { document.body.innerHTML = ''; });

  it('disables the button while loading, calls the fetch once, then re-enables', async () => {
    let resolveFetch;
    const fetchSpy = vi.fn(() => new Promise(r => { resolveFetch = r; }));
    const orig = SECTION_DEFS.solar.fetch;
    SECTION_DEFS.solar.fetch = fetchSpy;
    try {
      const p = updateSection('solar');
      const btn = () => document.getElementById('meta_solar').querySelector('.section-update');
      expect(btn().disabled).toBe(true);
      expect(btn().textContent).toBe('…');
      // Re-entrant call while loading is a no-op
      updateSection('solar');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      resolveFetch();
      await p;
      expect(btn().textContent).toBe('UPDATE');
    } finally {
      SECTION_DEFS.solar.fetch = orig;
    }
  });

  it('does nothing when no area is drawn', async () => {
    S.areaCenter = null;
    const fetchSpy = vi.fn();
    const orig = SECTION_DEFS.solar.fetch;
    SECTION_DEFS.solar.fetch = fetchSpy;
    try {
      await updateSection('solar');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      SECTION_DEFS.solar.fetch = orig;
    }
  });
});
