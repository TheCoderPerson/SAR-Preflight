const {
  makeViewshedRecord, viewshedFilenameSlug, uniqueViewshedName, observerKmlDescription,
} = require('../../sar-preflight-raster.js');
const { KML_STYLE_DEFS, kmlStyles } = require('../../sar-preflight-core.js');

describe('makeViewshedRecord', () => {
  it('normalizes a record and defaults missing fields', () => {
    const r = makeViewshedRecord({ id: 'vs_1', observer: { lat: 38.7, lng: -120.9 } });
    expect(r.id).toBe('vs_1');
    expect(r.observer).toEqual({ lat: 38.7, lng: -120.9 });
    expect(r.aglFt).toBe(200);
    expect(r.vlosFt).toBe(2500);
    expect(r.grid).toBeNull();
    expect(r.mask).toBeNull();
    expect(r.coverage).toBeNull();
    expect(r.visible).toBe(true); // new observers show immediately
    expect(r.buildingCount).toBeNull(); // buildings not included until a compute stamps them
  });

  it('keeps a persisted buildingCount (including 0)', () => {
    expect(makeViewshedRecord({ id: 'x', observer: { lat: 1, lng: 2 }, buildingCount: 37 }).buildingCount).toBe(37);
    expect(makeViewshedRecord({ id: 'x', observer: { lat: 1, lng: 2 }, buildingCount: 0 }).buildingCount).toBe(0);
  });

  it('keeps a persisted visible:false (toggled-off viewshed)', () => {
    const r = makeViewshedRecord({ id: 'x', observer: { lat: 1, lng: 2 }, visible: false });
    expect(r.visible).toBe(false);
  });

  it('coerces mask to Uint8Array and keeps supplied params', () => {
    const r = makeViewshedRecord({ id: 'x', observer: { lat: 1, lng: 2 }, aglFt: 300, vlosFt: 3000, mask: [0, 1, 1, 0], coverage: 0.5 });
    expect(r.mask).toBeInstanceOf(Uint8Array);
    expect(Array.from(r.mask)).toEqual([0, 1, 1, 0]);
    expect(r.aglFt).toBe(300);
    expect(r.vlosFt).toBe(3000);
    expect(r.coverage).toBe(0.5);
  });

  it('returns null when the observer is invalid', () => {
    expect(makeViewshedRecord({ id: 'x', observer: { lat: NaN, lng: 2 } })).toBeNull();
    expect(makeViewshedRecord({ id: 'x' })).toBeNull();
  });
});

describe('viewshedFilenameSlug', () => {
  it('makes a filesystem-safe slug', () => {
    expect(viewshedFilenameSlug('Ridge Top #2')).toBe('Ridge_Top_2');
    expect(viewshedFilenameSlug('  a / b  ')).toBe('a_b');
    expect(viewshedFilenameSlug('')).toBe('observer');
    expect(viewshedFilenameSlug(null)).toBe('observer');
    expect(viewshedFilenameSlug('x'.repeat(60)).length).toBe(40);
  });
});

describe('uniqueViewshedName', () => {
  it('returns the base when free and suffixes on collision', () => {
    expect(uniqueViewshedName('Ridge', [])).toBe('Ridge');
    expect(uniqueViewshedName('Ridge', ['Ridge'])).toBe('Ridge (2)');
    expect(uniqueViewshedName('Ridge', new Set(['Ridge', 'Ridge (2)']))).toBe('Ridge (3)');
    expect(uniqueViewshedName('', [])).toBe('Observer');
  });
});

describe('observerKmlDescription', () => {
  it('renders plain-text fields with coverage', () => {
    const desc = observerKmlDescription({
      name: 'LZ-1', observer: { lat: 38.7, lng: -120.9 }, aglFt: 200, vlosFt: 2500,
      grid: {}, mask: new Uint8Array(1), coverage: 0.73, demSource: '3DEP ~3 m', canopySource: 'Meta 1 m', computedAt: 0,
    });
    expect(desc).toContain('Observer: LZ-1');
    expect(desc).toContain('Location: 38.70000, -120.90000');
    expect(desc).toContain('Drone AGL: 200 ft');
    expect(desc).toContain('VLOS range: 2500 ft');
    expect(desc).toContain('73% of VLOS visible');
    expect(desc).not.toMatch(/[<>]/); // plain text
  });

  it('marks not-yet-computed observers', () => {
    const desc = observerKmlDescription({ name: 'X', observer: { lat: 1, lng: 2 }, aglFt: 200, vlosFt: 2500 });
    expect(desc).toContain('Viewshed: not computed');
  });
});

describe('observer KML style', () => {
  it('defines an observer style that kmlStyles() emits', () => {
    expect(KML_STYLE_DEFS.observer).toBeTruthy();
    expect(kmlStyles()).toContain('<Style id="observer">');
  });

  it('defines a filled viewshed polygon style that kmlStyles() emits', () => {
    expect(KML_STYLE_DEFS.viewshed).toBeTruthy();
    expect(KML_STYLE_DEFS.viewshed.fill).toBeTruthy();
    expect(kmlStyles()).toContain('<Style id="viewshed">');
  });
});
