const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = {
  map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} },
  FeatureGroup: vi.fn(), latLng: (a, b) => ({ lat: a, lng: b }), latLngBounds: () => ({}),
};

const { SECTION_DEFS, markSection, S } = require('../../sar-preflight.js');

describe('section-meta (last-updated + UPDATE) for the new data downloads', () => {
  const keys = ['groundAccess', 'publicLands', 'water', 'hospitals'];
  const ids = { groundAccess: 'meta_ground', publicLands: 'meta_land', water: 'meta_water', hospitals: 'meta_hospitals' };

  beforeEach(() => {
    document.body.innerHTML = keys.map(k => `<div class="section-meta" id="${ids[k]}"></div>`).join('');
    S.areaCenter = { lat: 38.7, lng: -120.8 };
    S.sectionMeta = {};
  });
  afterEach(() => { document.body.innerHTML = ''; S.areaCenter = null; S.sectionMeta = {}; });

  it('defines a SECTION_DEFS entry with a fetch + an UPDATE line for every new download', () => {
    keys.forEach(k => {
      expect(SECTION_DEFS[k]).toBeTruthy();
      expect(typeof SECTION_DEFS[k].fetch).toBe('function');
      expect(SECTION_DEFS[k].lines.some(l => l.button)).toBe(true);
    });
  });

  it('renders a freshness line + an enabled UPDATE button when marked live (area drawn)', () => {
    keys.forEach(k => {
      markSection(k, { status: 'live', updatedAt: Date.now(), error: null });
      const el = document.getElementById(ids[k]);
      expect(el.querySelector('.section-updated')).toBeTruthy();
      const btn = el.querySelector('button.section-update');
      expect(btn).toBeTruthy();
      expect(btn.textContent).toBe('UPDATE');
      expect(btn.disabled).toBe(false);
    });
  });

  it('disables the UPDATE button when no operational area is drawn', () => {
    S.areaCenter = null;
    markSection('water', { status: 'live', updatedAt: Date.now() });
    const btn = document.getElementById('meta_water').querySelector('button.section-update');
    expect(btn.disabled).toBe(true);
  });

  it('uses the error tone for the no-proxy / failed case', () => {
    markSection('publicLands', { status: 'error', error: 'Needs data proxy (Config)' });
    expect(document.getElementById('meta_land').className).toContain('section-meta-error');
  });

  it('shows cached tone after a cache fallback', () => {
    markSection('groundAccess', { status: 'cached', cachedAt: Date.now() - 60000, error: null });
    expect(document.getElementById('meta_ground').className).toContain('section-meta-cached');
  });
});
