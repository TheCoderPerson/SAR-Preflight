const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

globalThis.L = {
  marker: () => ({ on() { return this; }, addTo() { return this; }, bindPopup() { return this; }, getLatLng() { return { lat: 0, lng: 0 }; } }),
  layerGroup: () => ({ _l: [], addLayer(x) { this._l.push(x); }, removeLayer() {}, clearLayers() { this._l = []; }, getLayers() { return this._l; }, addTo() { return this; } }),
  DomEvent: { stopPropagation() {} },
};

const { _observerPopupHtml } = require('../../sar-preflight.js');

// Mid-latitude observer: the sun crosses the 0–30° glare band every day of
// the year, so the glare advisory is always present for this location.
const baseRec = () => ({
  name: 'Ridge', observer: { lat: 38.7, lng: -120.9 }, aglFt: 200, vlosFt: 2500,
  coverage: 0.8, computedAt: 1, grid: {}, mask: new Uint8Array(1), backdrop: null,
});

describe('_observerPopupHtml advisories', () => {
  it('includes today\'s sun-glare windows with times and bearing ranges', () => {
    const html = _observerPopupHtml(baseRec());
    expect(html).toContain('Glare risk today');
    expect(html).toMatch(/\d{2}:\d{2}–\d{2}:\d{2} brg \d{3}°–\d{3}°/);
    expect(html).toContain('near-overhead passes can glare any time');
  });

  it('flags terrain-backdrop sectors above the threshold as a compass range', () => {
    const rec = baseRec();
    rec.backdrop = new Array(16).fill(0);
    rec.backdrop[4] = 0.9; rec.backdrop[5] = 0.7; // E, ESE mostly below the skyline
    const html = _observerPopupHtml(rec);
    expect(html).toContain('Terrain backdrop toward E–ESE');
    expect(html).toContain('drone below skyline');
  });

  it('omits the backdrop line when no sector crosses the threshold', () => {
    const rec = baseRec();
    rec.backdrop = new Array(16).fill(0.2); // some low-angle terrain but mostly sky
    expect(_observerPopupHtml(rec)).not.toContain('Terrain backdrop');
  });

  it('omits the backdrop line when the analysis was not computed', () => {
    expect(_observerPopupHtml(baseRec())).not.toContain('Terrain backdrop');
  });

  it('says so explicitly when terrain shields all low sun (deep canyon)', () => {
    const rec = baseRec();
    rec.horizon = { stepDeg: 3, angles: new Array(120).fill(45) }; // 45° walls all around
    const html = _observerPopupHtml(rec);
    expect(html).toContain('No low-sun glare today — surrounding terrain hides the sun');
    expect(html).not.toContain('Glare risk today');
  });
});
