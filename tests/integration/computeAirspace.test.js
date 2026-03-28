const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { computeAirspace, S } = require('../../sar-preflight.js');

// Inline test airports for dynamic airport system
const TEST_AIRPORTS = [
  { icao: 'KSMF', name: 'Sacramento International', type: 'large_airport', lat: 38.6954, lng: -121.5908, elevation_ft: 27, municipality: 'Sacramento' },
  { icao: 'KSAC', name: 'Sacramento Executive', type: 'medium_airport', lat: 38.5125, lng: -121.4935, elevation_ft: 24, municipality: 'Sacramento' },
  { icao: 'KMCC', name: 'McClellan Airfield', type: 'medium_airport', lat: 38.6676, lng: -121.4008, elevation_ft: 77, municipality: 'McClellan' },
  { icao: 'KPVF', name: 'Placerville Airport', type: 'small_airport', lat: 38.7243, lng: -120.7533, elevation_ft: 2585, municipality: 'Placerville' },
  { icao: 'KTRK', name: 'Truckee-Tahoe Airport', type: 'small_airport', lat: 39.3200, lng: -120.1396, elevation_ft: 5900, municipality: 'Truckee' },
  { icao: 'O61', name: 'Cameron Airpark', type: 'small_airport', lat: 38.6838, lng: -120.9871, elevation_ft: 1286, municipality: 'Cameron Park' },
  { icao: 'CA23', name: 'UC Davis Medical Center Heliport', type: 'heliport', lat: 38.5530, lng: -121.4560, elevation_ft: 50, municipality: 'Sacramento' },
  { icao: 'CA68', name: 'Marshall Medical Center Heliport', type: 'heliport', lat: 38.7340, lng: -120.7890, elevation_ft: 1860, municipality: 'Placerville' },
];

describe('computeAirspace(lat, lng)', () => {
  beforeEach(() => {
    S.nearbyAirports = TEST_AIRPORTS;
    document.body.innerHTML = `
      <span id="airClass"></span>
      <span id="airLAANC"></span>
      <span id="airLAANCAlt"></span>
      <span id="airNearAirport"></span>
      <span id="airNearDist"></span>
      <span id="airHeliports"></span>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('point near Placerville airport (KPVF)', () => {
    // KPVF is at 38.7243, -120.7533
    // A point very close: 38.724, -120.753 should be within 9.26 km
    const lat = 38.724;
    const lng = -120.753;

    it('classifies as Class E surface for small airport', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airClass').textContent;
      expect(text).toContain('Class E');
      expect(text).toContain('KPVF');
    });

    it('sets airClass color to green for uncontrolled small airport', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airClass').classList.contains('green')).toBe(true);
    });

    it('LAANC shows N/A for Class E (uncontrolled)', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airLAANC').textContent;
      expect(text).toContain('N/A');
    });

    it('sets LAANC color to green for uncontrolled', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airLAANC').classList.contains('green')).toBe(true);
    });

    it('shows 400 ft AGL for LAANC altitude near small airport', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airLAANCAlt').textContent).toBe('400 ft AGL');
    });

    it('identifies KPVF as nearest airport', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airNearAirport').textContent;
      expect(text).toContain('KPVF');
      expect(text).toContain('Placerville');
    });

    it('shows very small distance to nearest airport', () => {
      computeAirspace(lat, lng);
      const distText = document.getElementById('airNearDist').textContent;
      const nm = parseFloat(distText);
      expect(nm).toBeLessThan(1);
    });

    it('sets near distance color to red (within 9.26 km)', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airNearDist').classList.contains('red')).toBe(true);
    });
  });

  describe('point near Sacramento Intl (large airport)', () => {
    // KSMF is at 38.6954, -121.5908
    const lat = 38.70;
    const lng = -121.59;

    it('classifies as Class B for large airport proximity', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airClass').textContent;
      expect(text).toContain('Class B');
      expect(text).toContain('KSMF');
    });

    it('sets airClass color to amber for controlled airspace', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airClass').classList.contains('amber')).toBe(true);
    });

    it('requires LAANC authorization', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airLAANC').textContent;
      expect(text).toContain('required');
    });

    it('shows "Check grid cell" for LAANC altitude', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airLAANCAlt').textContent).toBe('Check grid cell');
    });
  });

  describe('point near McClellan (medium airport)', () => {
    // KMCC is at 38.6676, -121.4008
    const lat = 38.67;
    const lng = -121.40;

    it('classifies as Class D for medium airport proximity', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airClass').textContent;
      expect(text).toContain('Class D');
      expect(text).toContain('KMCC');
    });

    it('sets airClass color to amber for controlled airspace', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airClass').classList.contains('amber')).toBe(true);
    });
  });

  describe('point far from all airports — Class G', () => {
    // A point roughly between airports but far enough from all
    const lat = 38.5;
    const lng = -121.0;

    it('classifies as Class G uncontrolled airspace', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airClass').textContent;
      expect(text).toContain('Class G');
      expect(text).toContain('Uncontrolled');
    });

    it('sets airClass color to green for uncontrolled', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airClass').classList.contains('green')).toBe(true);
    });

    it('LAANC shows N/A for Class G', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airLAANC').textContent).toContain('N/A');
    });

    it('sets LAANC color to green', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airLAANC').classList.contains('green')).toBe(true);
    });

    it('shows 400 ft AGL for LAANC altitude in Class G', () => {
      computeAirspace(lat, lng);
      expect(document.getElementById('airLAANCAlt').textContent).toBe('400 ft AGL');
    });

    it('still identifies a nearest airport', () => {
      computeAirspace(lat, lng);
      const text = document.getElementById('airNearAirport').textContent;
      expect(text).toBeTruthy();
      // Should contain an ICAO/FAA code (e.g., KPVF or O61)
      expect(text).toMatch(/[A-Z0-9]{2,4}/);
    });

    it('distance is more than 5 nm (> 9.26 km)', () => {
      computeAirspace(lat, lng);
      const distText = document.getElementById('airNearDist').textContent;
      const nm = parseFloat(distText);
      expect(nm).toBeGreaterThan(5);
    });
  });

  describe('nearest airport identification', () => {
    it('identifies KPVF for a point closest to Placerville', () => {
      computeAirspace(38.73, -120.76);
      expect(document.getElementById('airNearAirport').textContent).toContain('KPVF');
    });

    it('identifies KSMF for a point closest to Sacramento Intl', () => {
      // KSMF is at 38.6954, -121.5908
      computeAirspace(38.70, -121.59);
      expect(document.getElementById('airNearAirport').textContent).toContain('KSMF');
    });

    it('identifies KSAC for a point closest to Sacramento Exec', () => {
      // KSAC is at 38.5125, -121.4935
      computeAirspace(38.51, -121.49);
      expect(document.getElementById('airNearAirport').textContent).toContain('KSAC');
    });

    it('identifies KTRK for a point closest to Truckee', () => {
      // KTRK is at 39.3200, -120.1396
      computeAirspace(39.32, -120.14);
      expect(document.getElementById('airNearAirport').textContent).toContain('KTRK');
    });
  });

  describe('distance display format', () => {
    it('distance is displayed in nm with one decimal place', () => {
      computeAirspace(38.5, -121.0);
      const distText = document.getElementById('airNearDist').textContent;
      expect(distText).toMatch(/^\d+\.\d\s*nm$/);
    });
  });

  describe('distance color coding', () => {
    it('red when within 9.26 km (5 nm) of an airport', () => {
      // Very close to KPVF
      computeAirspace(38.724, -120.753);
      expect(document.getElementById('airNearDist').classList.contains('red')).toBe(true);
    });

    it('green when far from all airports (> 18.52 km / 10 nm)', () => {
      // Far enough from all airports
      computeAirspace(38.5, -121.0);
      const el = document.getElementById('airNearDist');
      // Distance must be > 10 nm for green
      const nm = parseFloat(el.textContent);
      if (nm > 10) {
        expect(el.classList.contains('green')).toBe(true);
      } else {
        expect(el.classList.contains('amber')).toBe(true);
      }
    });
  });

  describe('heliports info', () => {
    it('shows heliport data or none-within-range message', () => {
      computeAirspace(38.5, -121.0);
      const text = document.getElementById('airHeliports').textContent;
      // Should either show nearby heliports with ICAOs or "None within range"
      expect(text.length).toBeGreaterThan(0);
      expect(text === 'None within range' || text.match(/\d+ nearby/)).toBeTruthy();
    });

    it('shows nearby heliports count for Sacramento area', () => {
      // Sacramento area has many hospital heliports
      computeAirspace(38.56, -121.46);
      const text = document.getElementById('airHeliports').textContent;
      expect(text).toContain('nearby');
    });
  });
});
