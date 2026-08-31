const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Theme functions only touch document, localStorage, and (optionally) S.map.
globalThis.L = { layerGroup: () => ({ addTo() { return this; } }) };

const { S, getStoredTheme, applyTheme, cycleTheme } = require('../../sar-preflight.js');

beforeEach(() => {
  try { localStorage.clear(); } catch (e) { /* ignore */ }
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '<button id="themeToggle">☾ DARK</button>';
  S.map = null;
});

describe('map theme toggle', () => {
  it('defaults to dark when nothing is stored', () => {
    expect(getStoredTheme()).toBe('dark');
  });

  it('applyTheme(light) sets the attribute, persists, and updates the button', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('sar_theme')).toBe('light');
    expect(document.getElementById('themeToggle').textContent).toBe('☀ LIGHT');
    expect(getStoredTheme()).toBe('light');
  });

  it('applyTheme(light-map) keeps a distinct attribute (palette stays dark)', () => {
    applyTheme('light-map');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light-map');
    expect(document.getElementById('themeToggle').textContent).toBe('◐ LIGHT MAP');
  });

  it('falls back to dark for an invalid value', () => {
    applyTheme('neon');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(getStoredTheme()).toBe('dark');
  });

  it('cycleTheme advances dark -> light-map -> light -> dark', () => {
    applyTheme('dark');
    cycleTheme();
    expect(getStoredTheme()).toBe('light-map');
    cycleTheme();
    expect(getStoredTheme()).toBe('light');
    cycleTheme();
    expect(getStoredTheme()).toBe('dark');
  });

  it('swaps the basemap and pins it below overlays via a fixed z-index', () => {
    const added = [];
    const zCalls = { dark: [], light: [] };
    S.mapLayers.basemap_dark = { setZIndex(z) { zCalls.dark.push(z); } };
    S.mapLayers.basemap_light = { setZIndex(z) { zCalls.light.push(z); } };
    S.map = {
      hasLayer: () => false,
      addLayer: (l) => added.push(l),
      removeLayer: () => {},
    };
    applyTheme('light');
    expect(added).toContain(S.mapLayers.basemap_light);
    expect(added).not.toContain(S.mapLayers.basemap_dark);
    // Fixed negative z-index keeps the basemap beneath toggled base overlays.
    expect(zCalls.light).toContain(-1);
  });

  it('pins a base+labels layer-group basemap at -2/-1 (Esri canvas pair)', () => {
    // The Esri canvas basemap is an L.layerGroup (no setZIndex of its own):
    // applyTheme must walk its members — base first at -2, labels at -1.
    const zCalls = [];
    const member = () => ({ setZIndex(z) { zCalls.push(z); } });
    S.mapLayers.basemap_dark = { eachLayer(fn) { [member(), member()].forEach(fn); } };
    S.mapLayers.basemap_light = { eachLayer() {} };
    S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
    applyTheme('dark');
    expect(zCalls).toEqual([-2, -1]);
  });
});
