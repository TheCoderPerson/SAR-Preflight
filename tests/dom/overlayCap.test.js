// Raster-overlay display-size cap — on memory-constrained mobile it detaches
// the canopy/viewshed image overlay when stretched beyond MAX_OVERLAY_DISPLAY_PX
// (the iOS compositing-memory crash at deep zoom) and re-attaches when zoomed
// out. On desktop it must NOT hide overlays (no memory ceiling).
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
// L.Browser.mobile drives _isConstrained(); default to constrained (mobile).
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }), Browser: { mobile: true } };

const { S, _applyOverlayZoomCap, _hideOverlaysForZoom, _isConstrained } = require('../../sar-preflight.js');

function makeOverlay() {
  const o = { _bounds: { getNorthEast: () => ({ __ne: true }), getSouthWest: () => ({ __sw: true }) } };
  o.addTo = (map) => { map._onMap.add(o); return o; };
  return o;
}
function makeMap() {
  return {
    _onMap: new Set(), _px: 0,
    hasLayer(l) { return this._onMap.has(l); },
    removeLayer(l) { this._onMap.delete(l); },
    addLayer(l) { this._onMap.add(l); },
    latLngToContainerPoint(p) { return p && p.__ne ? { x: this._px, y: this._px } : { x: 0, y: 0 }; },
  };
}

describe('raster overlay display-size cap (mobile/constrained)', () => {
  let canopy;
  beforeEach(() => {
    globalThis.L.Browser.mobile = true; // constrained
    S.map = makeMap();
    S.mapLayers = {};
    canopy = makeOverlay();
    S.mapLayers.canopy = canopy;
    S._overlayWanted = { canopy: true, viewshed: false };
  });

  it('reports constrained', () => { expect(_isConstrained()).toBe(true); });

  it('keeps the overlay attached when within the pixel budget', () => {
    S.map._px = 1421; S.map._onMap.add(canopy);
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(true);
  });

  it('detaches the overlay when stretched beyond the budget', () => {
    S.map._px = 75119; S.map._onMap.add(canopy);
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(false);
  });

  it('re-attaches when zoomed back within budget', () => {
    S.map._px = 75119; S.map._onMap.add(canopy);
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(false);
    S.map._px = 710;
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(true);
  });

  it('does not touch an overlay the user turned off (not wanted)', () => {
    S._overlayWanted.canopy = false;
    S.map._px = 710;
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(false);
  });

  it('_hideOverlaysForZoom detaches a wanted, on-map overlay during a zoom gesture', () => {
    S.map._onMap.add(canopy);
    _hideOverlaysForZoom();
    expect(S.map.hasLayer(canopy)).toBe(false);
  });
});

describe('raster overlay cap disabled on desktop', () => {
  let canopy;
  beforeEach(() => {
    globalThis.L.Browser.mobile = false; // desktop / unconstrained
    S.map = makeMap();
    S.mapLayers = {};
    canopy = makeOverlay();
    S.mapLayers.canopy = canopy;
    S._overlayWanted = { canopy: true, viewshed: false };
  });

  it('reports not constrained', () => { expect(_isConstrained()).toBe(false); });

  it('does NOT hide an oversized overlay on desktop (stays visible at deep zoom)', () => {
    S.map._px = 75119; S.map._onMap.add(canopy);
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(true);
  });

  it('_hideOverlaysForZoom is a no-op on desktop', () => {
    S.map._onMap.add(canopy);
    _hideOverlaysForZoom();
    expect(S.map.hasLayer(canopy)).toBe(true);
  });
});
