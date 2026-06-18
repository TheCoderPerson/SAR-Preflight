// Raster-overlay display-size cap — detaches the canopy/viewshed image overlay
// when it would be stretched beyond MAX_OVERLAY_DISPLAY_PX on screen (the iOS
// compositing-memory crash at deep zoom), and re-attaches it when zoomed out.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { S, _applyOverlayZoomCap, _hideOverlaysForZoom } = require('../../sar-preflight.js');

// A fake Leaflet imageOverlay + map whose latLngToContainerPoint yields a
// configurable on-screen size (S.map._px) for the overlay bounds.
function makeOverlay() {
  const o = { _bounds: { getNorthEast: () => ({ __ne: true }), getSouthWest: () => ({ __sw: true }) } };
  o.addTo = (map) => { map._onMap.add(o); return o; };
  return o;
}
function makeMap() {
  return {
    _onMap: new Set(),
    _px: 0,
    hasLayer(l) { return this._onMap.has(l); },
    removeLayer(l) { this._onMap.delete(l); },
    addLayer(l) { this._onMap.add(l); },
    latLngToContainerPoint(p) { return p && p.__ne ? { x: this._px, y: this._px } : { x: 0, y: 0 }; },
  };
}

describe('raster overlay display-size cap', () => {
  let canopy;
  beforeEach(() => {
    S.map = makeMap();
    S.mapLayers = {};
    canopy = makeOverlay();
    S.mapLayers.canopy = canopy;
    S._overlayWanted = { canopy: true, viewshed: false };
  });

  it('keeps the overlay attached when within the pixel budget', () => {
    S.map._px = 1421;            // ~z13, well under 4096
    S.map._onMap.add(canopy);    // currently shown
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(true);
  });

  it('detaches the overlay when stretched beyond the budget', () => {
    S.map._px = 75119;           // the z18.7 monster from the crash trace
    S.map._onMap.add(canopy);
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(false);
  });

  it('re-attaches when zoomed back within budget', () => {
    S.map._px = 75119;
    S.map._onMap.add(canopy);
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(false);
    S.map._px = 710;             // zoomed back out
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(true);
  });

  it('does not touch an overlay the user turned off (not wanted)', () => {
    S._overlayWanted.canopy = false;
    S.map._px = 710;             // within budget, but not wanted
    _applyOverlayZoomCap();
    expect(S.map.hasLayer(canopy)).toBe(false);
  });

  it('_hideOverlaysForZoom detaches a wanted, on-map overlay during a zoom gesture', () => {
    S.map._onMap.add(canopy);
    _hideOverlaysForZoom();
    expect(S.map.hasLayer(canopy)).toBe(false);
  });
});
