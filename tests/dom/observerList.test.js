const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

globalThis.L = {
  marker: () => ({ on() { return this; }, addTo() { return this; }, bindPopup() { return this; }, getLatLng() { return { lat: 0, lng: 0 }; } }),
  layerGroup: () => ({ _l: [], addLayer(x) { this._l.push(x); }, removeLayer(x) { this._l = this._l.filter(y => y !== x); }, clearLayers() { this._l = []; }, getLayers() { return this._l; }, addTo() { return this; } }),
  DomEvent: { stopPropagation() {} },
};

const { S, renderObserverList } = require('../../sar-preflight.js');

describe('renderObserverList', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="vsObserverList"></div>';
    S.viewsheds = [];
    S.activeViewshedId = null;
  });

  it('shows an empty hint when there are no observers', () => {
    renderObserverList();
    expect(document.getElementById('vsObserverList').textContent).toMatch(/No observers/i);
  });

  it('renders one row per record with the active row flagged and coverage variants', () => {
    S.viewsheds = [
      { id: 'a', name: 'Ridge', observer: { lat: 1, lng: 2 }, aglFt: 200, vlosFt: 2500, grid: {}, mask: new Uint8Array(1), coverage: 0.6, computedAt: 1 },
      { id: 'b', name: 'Pending', observer: { lat: 1, lng: 2 }, aglFt: 200, vlosFt: 2500, grid: null, mask: null, coverage: null, computedAt: 0 },
      { id: 'c', name: 'NoDem', observer: { lat: 1, lng: 2 }, aglFt: 200, vlosFt: 2500, grid: null, mask: null, coverage: null, computedAt: 5 },
    ];
    S.activeViewshedId = 'a';
    renderObserverList();
    const rows = document.querySelectorAll('#vsObserverList .vs-obs-row');
    expect(rows.length).toBe(3);
    expect(rows[0].classList.contains('active')).toBe(true);
    expect(rows[1].classList.contains('active')).toBe(false);
    expect(rows[0].querySelector('.vs-obs-name').textContent).toBe('Ridge');
    expect(rows[0].querySelector('.vs-obs-cov').textContent).toBe('60%');
    expect(rows[1].querySelector('.vs-obs-cov').textContent).toMatch(/pending/i);
    expect(rows[2].querySelector('.vs-obs-cov').textContent).toBe('no DEM');
    // Each row has Show / Recompute / Delete controls.
    expect(rows[0].querySelectorAll('.vs-obs-actions button').length).toBe(3);
  });
});
