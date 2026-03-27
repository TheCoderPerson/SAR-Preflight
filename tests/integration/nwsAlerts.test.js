const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Minimal Leaflet mock
globalThis.L = {
  map: vi.fn(),
  tileLayer: vi.fn(),
  control: { zoom: vi.fn() },
  Draw: { Event: {} },
  FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({
    addTo: vi.fn(function() { return this; }),
    clearLayers: vi.fn(),
    addLayer: vi.fn(),
    getLayers: vi.fn(() => []),
  })),
  geoJSON: vi.fn(() => ({
    bindPopup: vi.fn(function() { return this; }),
  })),
};

const {
  fetchNWSAlerts, renderNWSAlertCards, S,
} = require('../../sar-preflight.js');

// --- Mock NWS API response ---
const MOCK_NWS_RESPONSE_WITH_ALERTS = {
  features: [
    {
      id: 'urn:oid:2.49.0.1.840.0.alert1',
      properties: {
        id: 'alert-001',
        event: 'Red Flag Warning',
        severity: 'Severe',
        urgency: 'Immediate',
        headline: 'Red Flag Warning issued for El Dorado County',
        description: 'Critical fire weather conditions expected. Winds 25-35 mph with humidity below 10%.',
        instruction: 'Avoid outdoor burning.',
        onset: '2025-07-15T10:00:00-07:00',
        expires: '2025-07-16T20:00:00-07:00',
        senderName: 'NWS Sacramento',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-121.0, 38.5], [-120.5, 38.5], [-120.5, 39.0], [-121.0, 39.0], [-121.0, 38.5]]],
      },
    },
    {
      id: 'urn:oid:2.49.0.1.840.0.alert2',
      properties: {
        id: 'alert-002',
        event: 'Heat Advisory',
        severity: 'Moderate',
        urgency: 'Expected',
        headline: 'Heat Advisory for Sacramento Valley',
        description: 'Temperatures expected to reach 105-110F.',
        instruction: 'Stay hydrated.',
        onset: '2025-07-15T12:00:00-07:00',
        expires: '2025-07-17T21:00:00-07:00',
        senderName: 'NWS Sacramento',
      },
      geometry: null,
    },
  ],
};

const MOCK_NWS_RESPONSE_NO_ALERTS = {
  features: [],
};

describe('fetchNWSAlerts()', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="alertStatus"></span>
      <div id="alertSection" style="display:none;">
        <div id="alertList"></div>
      </div>
      <div id="layerList"></div>
      <input id="cfgMaxWind" type="number" value="27" />
      <span id="assessBadge" class="assessment-badge">--</span>
      <span id="assessText">--</span>
    `;
    S.nwsAlerts = [];
    S.mapLayers = {};
    S.wireHazardCounts = {};
    S.map = { hasLayer: vi.fn(() => true) };
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('with alerts in response', () => {
    beforeEach(() => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_NWS_RESPONSE_WITH_ALERTS),
      });
    });

    it('stores parsed alerts in S.nwsAlerts', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(S.nwsAlerts).toHaveLength(2);
    });

    it('parses alert properties correctly', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      const first = S.nwsAlerts[0];
      expect(first.event).toBe('Red Flag Warning');
      expect(first.severity).toBe('Severe');
      expect(first.urgency).toBe('Immediate');
      expect(first.headline).toContain('Red Flag Warning');
      expect(first.senderName).toBe('NWS Sacramento');
    });

    it('preserves geometry when present', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(S.nwsAlerts[0].geometry).not.toBeNull();
      expect(S.nwsAlerts[0].geometry.type).toBe('Polygon');
    });

    it('handles null geometry', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(S.nwsAlerts[1].geometry).toBeNull();
    });

    it('sets status to ALERTS count', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      const status = document.getElementById('alertStatus');
      expect(status.textContent).toBe('2 ALERTS');
      expect(status.className).toContain('live');
    });

    it('makes alertSection visible', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      const section = document.getElementById('alertSection');
      expect(section.style.display).toBe('');
    });

    it('renders alert cards in alertList', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      const list = document.getElementById('alertList');
      const cards = list.querySelectorAll('.notam-card');
      expect(cards.length).toBe(2);
    });

    it('sends correct User-Agent header', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.weather.gov/alerts/active'),
        expect.objectContaining({
          headers: { 'User-Agent': '(SAR-Preflight-Tool, contact@edsar.org)' },
        })
      );
    });

    it('uses correct point parameter format', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.weather.gov/alerts/active?point=38.69,-120.99',
        expect.any(Object)
      );
    });
  });

  describe('with no alerts', () => {
    beforeEach(() => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_NWS_RESPONSE_NO_ALERTS),
      });
    });

    it('S.nwsAlerts is empty array', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(S.nwsAlerts).toHaveLength(0);
    });

    it('sets status to CLEAR', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      const status = document.getElementById('alertStatus');
      expect(status.textContent).toBe('CLEAR');
    });

    it('shows green "no active alerts" card', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      const list = document.getElementById('alertList');
      expect(list.textContent).toContain('NO ACTIVE ALERTS');
    });
  });

  describe('with fetch error', () => {
    beforeEach(() => {
      globalThis.fetch.mockRejectedValue(new Error('Network error'));
    });

    it('sets S.nwsAlerts to empty array on error', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(S.nwsAlerts).toHaveLength(0);
    });

    it('sets status to ERROR', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      const status = document.getElementById('alertStatus');
      expect(status.textContent).toBe('ERROR');
      expect(status.className).toContain('error');
    });
  });

  describe('with HTTP error response', () => {
    beforeEach(() => {
      globalThis.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
    });

    it('handles non-ok HTTP response', async () => {
      await fetchNWSAlerts(38.69, -120.99);
      expect(S.nwsAlerts).toHaveLength(0);
      const status = document.getElementById('alertStatus');
      expect(status.textContent).toBe('ERROR');
    });
  });
});

describe('renderNWSAlertCards()', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="alertSection" style="display:none;">
        <div id="alertList"></div>
      </div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows green badge when no alerts', () => {
    S.nwsAlerts = [];
    renderNWSAlertCards();
    const list = document.getElementById('alertList');
    expect(list.textContent).toContain('NO ACTIVE ALERTS');
    expect(list.innerHTML).toContain('accent-green');
  });

  it('renders severe alert with red styling', () => {
    S.nwsAlerts = [{
      event: 'Tornado Warning',
      severity: 'Extreme',
      urgency: 'Immediate',
      headline: 'Tornado Warning issued',
      description: 'Tornado spotted.',
      onset: '2025-07-15T10:00:00-07:00',
      expires: '2025-07-15T11:00:00-07:00',
      senderName: 'NWS',
    }];
    renderNWSAlertCards();
    const list = document.getElementById('alertList');
    expect(list.innerHTML).toContain('accent-red');
    expect(list.textContent).toContain('Tornado Warning');
    expect(list.textContent).toContain('Extreme');
  });

  it('renders moderate alert with amber styling', () => {
    S.nwsAlerts = [{
      event: 'Heat Advisory',
      severity: 'Moderate',
      urgency: 'Expected',
      headline: 'Heat advisory',
      description: 'Hot temps.',
      onset: null,
      expires: null,
      senderName: 'NWS',
    }];
    renderNWSAlertCards();
    const list = document.getElementById('alertList');
    expect(list.innerHTML).toContain('accent-amber');
    expect(list.textContent).toContain('Heat Advisory');
  });

  it('renders minor alert with cyan styling', () => {
    S.nwsAlerts = [{
      event: 'Special Weather Statement',
      severity: 'Minor',
      urgency: 'Expected',
      headline: 'Brief statement',
      description: 'Minor weather event.',
      onset: null,
      expires: null,
      senderName: 'NWS',
    }];
    renderNWSAlertCards();
    const list = document.getElementById('alertList');
    expect(list.innerHTML).toContain('accent-cyan');
  });

  it('truncates long descriptions', () => {
    const longDesc = 'A'.repeat(500);
    S.nwsAlerts = [{
      event: 'Test',
      severity: 'Minor',
      urgency: 'Expected',
      headline: '',
      description: longDesc,
      onset: null,
      expires: null,
      senderName: 'NWS',
    }];
    renderNWSAlertCards();
    const list = document.getElementById('alertList');
    // The card should contain the truncated description plus '...'
    expect(list.textContent).toContain('...');
  });

  it('makes section visible', () => {
    S.nwsAlerts = [];
    renderNWSAlertCards();
    expect(document.getElementById('alertSection').style.display).toBe('');
  });
});

describe('NWS alerts integration with computeAssessment', () => {
  const { computeAssessment } = require('../../sar-preflight.js');

  beforeEach(() => {
    document.body.innerHTML = `
      <input id="cfgMaxWind" type="number" value="27" />
      <span id="assessBadge" class="assessment-badge">--</span>
      <span id="assessText">--</span>
    `;
    S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
    S.wind = { maxWind: 5, maxGust: 8 };
    S.elev = { center: 2000 };
    S.nwsAlerts = [];
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('GO when no NWS alerts and conditions nominal', () => {
    S.nwsAlerts = [];
    computeAssessment();
    expect(document.getElementById('assessBadge').textContent).toBe('GO');
  });

  it('NO-GO when severe NWS alert present', () => {
    S.nwsAlerts = [{ event: 'Red Flag Warning', severity: 'Severe' }];
    computeAssessment();
    expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
    expect(document.getElementById('assessText').textContent).toContain('Red Flag Warning');
  });

  it('NO-GO when extreme NWS alert present', () => {
    S.nwsAlerts = [{ event: 'Tornado Warning', severity: 'Extreme' }];
    computeAssessment();
    expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
    expect(document.getElementById('assessText').textContent).toContain('Tornado Warning');
  });

  it('CAUTION when moderate NWS alert present with otherwise GO conditions', () => {
    S.nwsAlerts = [{ event: 'Heat Advisory', severity: 'Moderate' }];
    computeAssessment();
    expect(document.getElementById('assessBadge').textContent).toBe('CAUTION');
    expect(document.getElementById('assessText').textContent).toContain('Heat Advisory');
  });

  it('remains NO-GO when both severe alert and weather NO-GO', () => {
    S.wx = { visibility: 500, temperature_2m: 65, precipitation_probability: 80, weather_code: 95 };
    S.wind = { maxWind: 35, maxGust: 40 };
    S.nwsAlerts = [{ event: 'Red Flag Warning', severity: 'Severe' }];
    computeAssessment();
    expect(document.getElementById('assessBadge').textContent).toBe('NO-GO');
  });

  it('multiple alerts listed in text', () => {
    S.nwsAlerts = [
      { event: 'Red Flag Warning', severity: 'Severe' },
      { event: 'Wind Advisory', severity: 'Severe' },
    ];
    computeAssessment();
    const text = document.getElementById('assessText').textContent;
    expect(text).toContain('Red Flag Warning');
    expect(text).toContain('Wind Advisory');
  });
});
