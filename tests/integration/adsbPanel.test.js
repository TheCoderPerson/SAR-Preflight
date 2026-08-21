// Selected-aircraft panel: a single map-anchored popup that survives the
// 5 s marker rebuilds, follows its plane, shows SIGNAL LOST when the hex
// drops out of the feed, and closes on X / click-away / layer off / stop.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

const mkPopup = (opts) => ({
  options: opts || {},
  _events: {},
  _open: false,
  _latlng: null,
  _content: null,
  on(t, f) { (this._events[t] = this._events[t] || []).push(f); return this; },
  fire(t) { (this._events[t] || []).forEach(f => f()); return this; },
  setLatLng(ll) { this._latlng = ll; return this; },
  setContent(c) { this._content = c; return this; },
  openOn() { this._open = true; return this; },
  getElement() { return null; },
});

globalThis.L = {
  point: (x, y) => ({ x, y }),
  popup: mkPopup,
  DomEvent: { disableClickPropagation: () => {}, stopPropagation: () => {} },
};

const {
  S, _adsbPanelHtml, openAdsbPanel, closeAdsbPanel, refreshAdsbPanel,
  stopAdsbPolling, ADSB_PANEL_LOST_MS, AGG_SKIP_LAYERS, AGG_LAYER_META,
} = require('../../sar-preflight.js');

const AC = {
  hex: 'a1b2c3', flight: 'N123SR', reg: 'N123SR', type: 'C182',
  lat: 38.70, lon: -120.99, alt_baro: 5500, alt_geom: 5600, groundElevFt: 1500,
  agl: 4000, gs: 110, track: 270, baro_rate: -300, squawk: '1200',
  emergency: 'none', seen: 2.5, seen_pos: 1.1, distNm: 3.4,
};

let aircraftLayerOnMap;
beforeEach(() => {
  document.body.innerHTML = ''; // no .draw-btn.active — clicks are not draw-tool input
  aircraftLayerOnMap = true;
  S.mapLayers = { adsb_aircraft: { id: 'group' } };
  S.map = {
    hasLayer: (x) => (x === S.mapLayers.adsb_aircraft ? aircraftLayerOnMap : !!(x && x._open)),
    closePopup: (p) => { if (p) { p._open = false; p.fire('remove'); } },
  };
  S.adsbAircraft = [AC];
  S._adsbSel = { hex: null, popup: null, lostAt: null, lastAc: null };
  S._adsbPollTimer = null;
});

describe('_adsbPanelHtml', () => {
  it('carries the aircraft data plus a live data-age footer', () => {
    const html = _adsbPanelHtml(AC);
    expect(html).toContain('N123SR');
    expect(html).toContain('data age: 3s'); // 2.5 rounds to 3
    expect(html).not.toContain('SIGNAL LOST');
  });
  it('shows the SIGNAL LOST banner iff lostSecs is given', () => {
    const html = _adsbPanelHtml(AC, 12);
    expect(html).toContain('SIGNAL LOST');
    expect(html).toContain('12s ago');
    expect(html).not.toContain('data age');
  });
});

describe('aggregation opt-out', () => {
  it('plane markers are excluded from the aggregated popup system', () => {
    expect(AGG_SKIP_LAYERS.has('adsb_aircraft')).toBe(true);
    expect(AGG_LAYER_META.adsb_aircraft).toBeUndefined();
  });
});

describe('open / refresh / close lifecycle', () => {
  it('openAdsbPanel selects the hex and opens the popup at the plane', () => {
    openAdsbPanel(AC);
    expect(S._adsbSel.hex).toBe('a1b2c3');
    expect(S._adsbSel.popup._open).toBe(true);
    expect(S._adsbSel.popup._latlng).toEqual([38.70, -120.99]);
    expect(S._adsbSel.popup._content).toContain('N123SR');
    // live re-anchoring must never pan the map after the initial open
    expect(S._adsbSel.popup.options.autoPan).toBe(false);
  });

  it('refreshAdsbPanel follows the plane with fresh data across rebuilds', () => {
    openAdsbPanel(AC);
    S.adsbAircraft = [{ ...AC, lat: 38.71, lon: -121.00, agl: 4200, seen: 0.4 }];
    refreshAdsbPanel();
    expect(S._adsbSel.popup._latlng).toEqual([38.71, -121.00]);
    expect(S._adsbSel.popup._content).toContain('data age: 0s');
    expect(S._adsbSel.popup._open).toBe(true);
  });

  it('hex missing → SIGNAL LOST banner, then auto-close past the threshold', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(100000);
    openAdsbPanel(AC);
    S.adsbAircraft = []; // plane left the feed
    refreshAdsbPanel(); // first miss stamps lostAt
    expect(S._adsbSel.lostAt).toBe(100000);
    expect(S._adsbSel.popup._content).toContain('SIGNAL LOST');
    now.mockReturnValue(100000 + 15000);
    refreshAdsbPanel();
    expect(S._adsbSel.popup._content).toContain('15s ago');
    expect(S._adsbSel.popup._open).toBe(true);
    now.mockReturnValue(100000 + ADSB_PANEL_LOST_MS);
    refreshAdsbPanel();
    expect(S._adsbSel.popup._open).toBe(false);
    expect(S._adsbSel.hex).toBeNull();
    now.mockRestore();
  });

  it('reacquiring the hex after a lost stretch resumes live updates', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(100000);
    openAdsbPanel(AC);
    S.adsbAircraft = [];
    refreshAdsbPanel();
    expect(S._adsbSel.lostAt).not.toBeNull();
    S.adsbAircraft = [{ ...AC, seen: 1 }];
    refreshAdsbPanel();
    expect(S._adsbSel.lostAt).toBeNull();
    expect(S._adsbSel.popup._content).not.toContain('SIGNAL LOST');
    now.mockRestore();
  });

  it('popup removal (X / click-away / displacement) clears the selection', () => {
    openAdsbPanel(AC);
    S.map.closePopup(S._adsbSel.popup); // Leaflet fires 'remove' on any of those paths
    expect(S._adsbSel.hex).toBeNull();
  });

  it('aircraft layer off the map closes the panel on the next refresh', () => {
    openAdsbPanel(AC);
    aircraftLayerOnMap = false;
    refreshAdsbPanel();
    expect(S._adsbSel.popup._open).toBe(false);
    expect(S._adsbSel.hex).toBeNull();
  });

  it('stopAdsbPolling closes the panel and clears the selection', () => {
    openAdsbPanel(AC);
    S.mapLayers.adsb_aircraft.clearLayers = () => {};
    S.mapLayers.adsb_trails = { clearLayers: () => {} };
    stopAdsbPolling();
    expect(S._adsbSel.hex).toBeNull();
    expect(S._adsbSel.popup._open).toBe(false);
  });

  it('a draw tool being active suppresses the plane click', () => {
    document.body.innerHTML = '<button class="draw-btn active"></button>';
    openAdsbPanel(AC);
    expect(S._adsbSel.hex).toBeNull();
    expect(S._adsbSel.popup).toBeNull();
  });
});
