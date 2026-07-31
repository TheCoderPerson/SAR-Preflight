const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

class MockGroup {
  constructor() { this._layers = []; }
  getLayers() { return this._layers.slice(); }
  addLayer(l) { this._layers.push(l); }
  clearLayers() { this._layers.length = 0; }
  addTo() { return this; }
}
globalThis.L = {
  Polygon: class {}, Polyline: class {}, Marker: class {}, Circle: class {}, CircleMarker: class {},
  layerGroup: () => new MockGroup(),
  circle: (ll, opts) => ({ _ll: ll, options: opts, getBounds: () => [[0, 0], [1, 1]], bindPopup() { return this; }, bindTooltip() { return this; }, on() {}, off() {} }),
  geoJSON: () => ({ bindPopup() { return this; }, on() {}, off() {} }),
};

const app = require('../../sar-preflight.js');
const {
  S, enterCoords, closeCoordSearch, onCoordSearchKey,
  _syncCoordRadiusRow, _coordSearchRadiusM, _renderGeocodeResults,
  _highlightGeocodeRow, _setGeocodeBusy,
} = app;

const FX = require('../fixtures/nominatim-search.json');

const MODAL_HTML = `
  <button id="drawCoords"></button>
  <div class="modal-overlay" id="coordSearchModal">
    <input type="text" id="coordSearchInput">
    <div id="coordSearchStatus" class="fetch-status"></div>
    <div id="coordSearchResults"></div>
    <input type="checkbox" id="coordSearchAreaChk">
    <input type="number" id="coordSearchRadius" value="2000" disabled>
    <button id="coordSearchBtn">GO</button>
  </div>`;

const modal = () => document.getElementById('coordSearchModal');
const input = () => document.getElementById('coordSearchInput');
const rows = () => document.querySelectorAll('#coordSearchResults .geo-result');

let fetchCalls;

beforeEach(() => {
  document.body.innerHTML = MODAL_HTML;
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => FX.mountBaldy };
  };
  globalThis.isOnline = () => true;
  S.map = {
    getCenter: () => ({ lat: 38.685, lng: -120.99 }),
    getZoom: () => 11, setView: () => {}, fitBounds: () => {},
    hasLayer: () => true, addLayer: () => {}, removeLayer: () => {}, on: () => {}, off: () => {},
  };
  S.drawnItems = new MockGroup();
  S.deviceFix = null;
  S._geocodeResults = []; S._geocodeSel = -1; S._geocodeGen = 0;
  S._geocodeAbort = null; S._geocodeLastAt = 0; S._geocodeMemo = null;
});

afterEach(() => {
  document.body.innerHTML = '';
  S.map = null; S.drawnItems = null;
  delete globalThis.fetch;
  delete globalThis.isOnline;
});

describe('modal open / close', () => {
  it('opens the modal, clears prior state and focuses the input', () => {
    input().value = 'stale text';
    S._geocodeResults = [{ name: 'stale' }];
    document.getElementById('coordSearchResults').innerHTML = '<div class="geo-result"></div>';

    enterCoords();

    expect(modal().classList.contains('active')).toBe(true);
    expect(input().value).toBe('');
    expect(S._geocodeResults).toEqual([]);
    expect(S._geocodeSel).toBe(-1);
    expect(rows()).toHaveLength(0);
    expect(document.activeElement).toBe(input());
  });

  it('shows which reference point distances will be measured from', () => {
    enterCoords();
    expect(document.getElementById('coordSearchStatus').textContent).toContain('map center');
  });

  it('closes on close, and bumps the generation so an in-flight search cannot repaint', () => {
    enterCoords();
    const gen0 = S._geocodeGen;
    closeCoordSearch();
    expect(modal().classList.contains('active')).toBe(false);
    expect(S._geocodeGen).toBeGreaterThan(gen0);
  });

  it('aborts an in-flight request on close', () => {
    let aborted = false;
    S._geocodeAbort = { abort: () => { aborted = true; } };
    closeCoordSearch();
    expect(aborted).toBe(true);
    expect(S._geocodeAbort).toBeNull();
  });

  it('survives being called with the modal markup absent', () => {
    document.body.innerHTML = '';
    expect(() => enterCoords()).not.toThrow();
    expect(() => closeCoordSearch()).not.toThrow();
  });
});

describe('keyboard handling', () => {
  it('Escape closes the modal', () => {
    enterCoords();
    onCoordSearchKey({ key: 'Escape', preventDefault() {} });
    expect(modal().classList.contains('active')).toBe(false);
  });

  it('a plain character keystroke NEVER fires a request (provider forbids autocomplete)', () => {
    enterCoords();
    input().value = 'J';
    for (const key of ['J', 'e', 'n', 'k', ' ', 'Backspace', 'Shift', 'a', '5']) {
      onCoordSearchKey({ key, preventDefault() {} });
    }
    expect(fetchCalls).toEqual([]);
  });

  it('no input/keyup listener on the box can trigger a request either', () => {
    enterCoords();
    input().value = 'Jenkinson';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    input().dispatchEvent(new Event('keyup', { bubbles: true }));
    input().dispatchEvent(new Event('change', { bubbles: true }));
    expect(fetchCalls).toEqual([]);
  });

  it('Enter with no highlighted row runs the search', async () => {
    enterCoords();
    input().value = 'Mount Baldy';
    onCoordSearchKey({ key: 'Enter', preventDefault() {} });
    await new Promise(r => setTimeout(r, 0));
    expect(fetchCalls).toHaveLength(1);
  });

  it('arrow keys move the highlight, wrapping at both ends', () => {
    S._geocodeResults = rankGeocodeResults(normalizeGeocodeResults(FX.mountBaldy), { lat: 38.685, lng: -120.99 });
    _renderGeocodeResults(S._geocodeResults, { query: 'Mount Baldy' });
    const n = S._geocodeResults.length;
    expect(n).toBe(4);

    onCoordSearchKey({ key: 'ArrowDown', preventDefault() {} });
    expect(S._geocodeSel).toBe(0);
    expect(rows()[0].classList.contains('sel')).toBe(true);

    onCoordSearchKey({ key: 'ArrowDown', preventDefault() {} });
    expect(S._geocodeSel).toBe(1);
    expect(rows()[0].classList.contains('sel')).toBe(false);
    expect(rows()[1].classList.contains('sel')).toBe(true);

    // Wrap forward off the end...
    for (let i = 0; i < 3; i++) onCoordSearchKey({ key: 'ArrowDown', preventDefault() {} });
    expect(S._geocodeSel).toBe(0);
    // ...and backward off the start.
    onCoordSearchKey({ key: 'ArrowUp', preventDefault() {} });
    expect(S._geocodeSel).toBe(n - 1);
  });

  it('Enter with a highlighted row picks it instead of re-searching', () => {
    S._geocodeResults = rankGeocodeResults(normalizeGeocodeResults(FX.jenkinsonLake), { lat: 38.685, lng: -120.99 });
    _renderGeocodeResults(S._geocodeResults, { query: 'Jenkinson Lake' });
    S._geocodeSel = 0;
    modal().classList.add('active');
    onCoordSearchKey({ key: 'Enter', preventDefault() {} });
    expect(fetchCalls).toEqual([]);                    // picked, not re-searched
    expect(modal().classList.contains('active')).toBe(false);
  });

  it('arrows are a no-op with no results, and a null event does not throw', () => {
    S._geocodeResults = [];
    onCoordSearchKey({ key: 'ArrowDown', preventDefault() {} });
    expect(S._geocodeSel).toBe(-1);
    expect(() => onCoordSearchKey(null)).not.toThrow();
  });
});

describe('op-area radius row', () => {
  it('the radius box is disabled until the checkbox is on', () => {
    const chk = document.getElementById('coordSearchAreaChk');
    const rad = document.getElementById('coordSearchRadius');
    _syncCoordRadiusRow();
    expect(rad.disabled).toBe(true);
    expect(_coordSearchRadiusM()).toBeNull();

    chk.checked = true;
    _syncCoordRadiusRow();
    expect(rad.disabled).toBe(false);
    expect(_coordSearchRadiusM()).toBe(2000);
  });

  it('rejects a non-positive or non-numeric radius rather than building a broken area', () => {
    const chk = document.getElementById('coordSearchAreaChk');
    const rad = document.getElementById('coordSearchRadius');
    chk.checked = true;
    for (const v of ['0', '-5', 'abc', '']) {
      rad.value = v;
      expect(_coordSearchRadiusM()).toBeNull();
    }
    rad.value = '750';
    expect(_coordSearchRadiusM()).toBe(750);
  });

  it('reopening the modal resets the radius row to its disabled state', () => {
    const chk = document.getElementById('coordSearchAreaChk');
    chk.checked = false;
    enterCoords();
    expect(document.getElementById('coordSearchRadius').disabled).toBe(true);
  });
});

describe('busy state', () => {
  it('disables the GO button while a search runs and restores it after', () => {
    const btn = document.getElementById('coordSearchBtn');
    _setGeocodeBusy(true);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('…');
    _setGeocodeBusy(false);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('GO');
  });
});

describe('_renderGeocodeResults', () => {
  it('renders one clickable row per result', () => {
    const recs = rankGeocodeResults(normalizeGeocodeResults(FX.mountBaldy), { lat: 38.685, lng: -120.99 });
    _renderGeocodeResults(recs, { query: 'Mount Baldy' });
    const r = rows();
    expect(r).toHaveLength(4);
    r.forEach(el => {
      expect(el.getAttribute('role')).toBe('button');
      expect(typeof el.onclick).toBe('function');
    });
  });

  it('replaces prior rows rather than appending to them', () => {
    const recs = rankGeocodeResults(normalizeGeocodeResults(FX.mountBaldy), { lat: 38.685, lng: -120.99 });
    _renderGeocodeResults(recs, { query: 'Mount Baldy' });
    _renderGeocodeResults(rankGeocodeResults(normalizeGeocodeResults(FX.jenkinsonLake), null), { query: 'Jenkinson Lake' });
    expect(rows()).toHaveLength(1);
  });

  it('_highlightGeocodeRow is safe when the list is gone', () => {
    document.body.innerHTML = '';
    expect(() => _highlightGeocodeRow()).not.toThrow();
    expect(() => _renderGeocodeResults([], {})).not.toThrow();
  });
});
