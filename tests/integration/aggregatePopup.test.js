const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// ---- Minimal Leaflet mock sufficient for the aggregation hit-testing ----
class MockPoint {
  constructor(x, y) { this.x = x; this.y = y; }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y); }
}
// Linear "projection": 1 degree = 1000 px (sign flips lat so north is up)
const project = ll => new MockPoint(ll.lng * 1000, -ll.lat * 1000);

class MockLayer {
  constructor() { this._events = {}; this._popup = null; }
  on(t, f) { (this._events[t] = this._events[t] || []).push(f); return this; }
  off() { return this; }
  bindPopup(c) { this._popup = { getContent: () => c }; return this; }
  getPopup() { return this._popup; }
}
function bboxContains(rings, ll) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  rings.flat().forEach(p => {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  });
  return ll.lat >= minLat && ll.lat <= maxLat && ll.lng >= minLng && ll.lng <= maxLng;
}
class MockPolygon extends MockLayer {
  constructor(rings, popup) { super(); this._rings = rings; if (popup) this.bindPopup(popup); }
  getLatLngs() { return this._rings; }
  getBounds() { return { contains: ll => bboxContains(this._rings, ll) }; }
}
class MockCircleMarker extends MockLayer {
  constructor(latlng, radius, popup) { super(); this._ll = latlng; this._r = radius; if (popup) this.bindPopup(popup); }
  getLatLng() { return this._ll; }
  getRadius() { return this._r; }
}
class MockGroup {
  constructor(layers) { this._layers = layers; }
  getLayers() { return this._layers; }
}

globalThis.L = {
  Point: MockPoint,
  point: (x, y) => new MockPoint(x, y),
  Polygon: MockPolygon,
  Polyline: class {}, // nothing in these tests is a bare polyline
  CircleMarker: MockCircleMarker,
  Circle: class {},
  Marker: class {},
  DomEvent: { stopPropagation: () => {} },
  popup: (opts) => ({
    _opts: opts, _latlng: null, _content: null,
    setLatLng(ll) { this._latlng = ll; return this; },
    setContent(c) { this._content = c; return this; },
    openOn() { this._open = true; return this; },
    update() { return this; },
  }),
};

const { S, collectFeaturesAt, openAggregatePopup, aggPopupStep, renderAggregatePopup, wirePopupAggregation } = require('../../sar-preflight.js');

const LL = (lat, lng) => ({ lat, lng });
const ring = (cLat, cLng, d) => [LL(cLat - d, cLng - d), LL(cLat - d, cLng + d), LL(cLat + d, cLng + d), LL(cLat + d, cLng - d)];

describe('collectFeaturesAt aggregates overlapping features', () => {
  const click = LL(38.7, -120.99);

  beforeEach(() => {
    S.map = {
      latLngToLayerPoint: project,
      hasLayer: () => true,
      distance: (a, b) => Math.hypot(a.lat - b.lat, a.lng - b.lng) * 111000,
    };
    // Class airspace polygon containing the click, an obstacle marker AT the click,
    // and a second airspace polygon far away that should NOT match.
    const airspaceHit = new MockPolygon([ring(38.7, -120.99, 0.1)], 'Class D — Mather');
    const airspaceMiss = new MockPolygon([ring(40.0, -119.0, 0.1)], 'Class C — Reno');
    const obstacle = new MockCircleMarker(click, 5, 'TOWER 328 ft AGL');
    S.mapLayers = {
      satellite: {}, // skipped (base layer)
      faa_class_airspace: new MockGroup([airspaceHit, airspaceMiss]),
      faa_obstacles: new MockGroup([obstacle]),
    };
    S._aggPopup = { items: [], index: 0, popup: null };
  });

  it('returns every feature under the click, excluding non-overlapping ones', () => {
    const hits = collectFeaturesAt(click);
    expect(hits.length).toBe(2);
    const contents = hits.map(h => h.content);
    expect(contents).toContain('Class D — Mather');
    expect(contents).toContain('TOWER 328 ft AGL');
    expect(contents).not.toContain('Class C — Reno');
  });

  it('sorts hits by priority (airspace before obstacle)', () => {
    const hits = collectFeaturesAt(click);
    expect(hits[0].label).toBe('Class Airspace');
    expect(hits[1].label).toBe('Obstacle');
  });

  it('skips layers that are toggled off the map', () => {
    S.map.hasLayer = g => g !== S.mapLayers.faa_obstacles; // obstacle layer hidden
    const hits = collectFeaturesAt(click);
    expect(hits.length).toBe(1);
    expect(hits[0].label).toBe('Class Airspace');
  });

  it('returns nothing when the click is outside every feature', () => {
    expect(collectFeaturesAt(LL(10, 10)).length).toBe(0);
  });

  it('collapses exact-duplicate popups (e.g. tiered airspace segments)', () => {
    // Two overlapping polygons with IDENTICAL popup content should count once
    const segA = new MockPolygon([ring(38.7, -120.99, 0.1)], 'Class D — Mather');
    const segB = new MockPolygon([ring(38.7, -120.99, 0.12)], 'Class D — Mather');
    S.mapLayers = { faa_class_airspace: new MockGroup([segA, segB]) };
    const hits = collectFeaturesAt(click);
    expect(hits.length).toBe(1);
  });
});

describe('aggregate popup rendering + pagination', () => {
  const click = LL(38.7, -120.99);
  beforeEach(() => {
    S.map = { latLngToLayerPoint: project, hasLayer: () => true, distance: () => 0 };
    const a = new MockPolygon([ring(38.7, -120.99, 0.1)], 'AIRSPACE');
    const o = new MockCircleMarker(click, 5, 'OBSTACLE');
    S.mapLayers = { faa_class_airspace: new MockGroup([a]), faa_obstacles: new MockGroup([o]) };
    S._aggPopup = { items: [], index: 0, popup: null };
  });

  it('opens a popup showing the first of N features with an "1 / N" indicator', () => {
    openAggregatePopup(click);
    expect(S._aggPopup.items.length).toBe(2);
    const html = S._aggPopup.popup._content;
    expect(html).toContain('1 / 2');
    expect(html).toContain('AIRSPACE');
    expect(html).toContain('aggPopupStep(1)');
    expect(html).toContain('aggPopupStep(-1)');
  });

  it('cycles forward and wraps around with aggPopupStep', () => {
    openAggregatePopup(click);
    aggPopupStep(1);
    expect(S._aggPopup.index).toBe(1);
    expect(S._aggPopup.popup._content).toContain('2 / 2');
    expect(S._aggPopup.popup._content).toContain('OBSTACLE');
    aggPopupStep(1); // wrap back to first
    expect(S._aggPopup.index).toBe(0);
    expect(S._aggPopup.popup._content).toContain('1 / 2');
  });

  it('cycles backward from the first item to the last', () => {
    openAggregatePopup(click);
    aggPopupStep(-1);
    expect(S._aggPopup.index).toBe(1);
  });

  it('does not open a popup when nothing is under the click', () => {
    S._aggPopup.popup = null;
    openAggregatePopup(LL(0, 0));
    expect(S._aggPopup.popup).toBeNull();
  });

  it('ignores clicks that originate inside the popup (pager arrows do not re-aggregate)', () => {
    // Pre-load a popup that is already paged to item 3
    S._aggPopup.items = [{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }];
    S._aggPopup.index = 3;
    const popupEl = document.createElement('div');
    popupEl.className = 'leaflet-popup';
    const arrow = document.createElement('button');
    popupEl.appendChild(arrow);
    document.body.appendChild(popupEl);
    // A click whose DOM target is the arrow button (inside .leaflet-popup) must be ignored,
    // even though the latlng would otherwise hit features and reset the pager to index 0.
    openAggregatePopup(click, { originalEvent: { target: arrow } });
    expect(S._aggPopup.index).toBe(3); // unchanged — handler bailed out
    document.body.removeChild(popupEl);
  });
});

describe('wirePopupAggregation', () => {
  it('wires popup-bearing features once and suppresses re-wiring', () => {
    S.map = { latLngToLayerPoint: project, hasLayer: () => true };
    const a = new MockPolygon([ring(38.7, -120.99, 0.1)], 'AIRSPACE');
    const spy = vi.spyOn(a, 'on');
    S.mapLayers = { faa_class_airspace: new MockGroup([a]) };
    wirePopupAggregation();
    wirePopupAggregation(); // second pass must be a no-op for already-wired features
    expect(a._aggWired).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
