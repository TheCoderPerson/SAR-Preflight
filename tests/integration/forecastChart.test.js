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
};

const { renderForecastChart, S } = require('../../sar-preflight.js');

describe('renderForecastChart(hourlyData)', () => {
  let forecastSection, forecastChart;

  beforeEach(() => {
    forecastSection = document.createElement('div');
    forecastSection.id = 'forecastSection';
    forecastSection.style.display = 'none';
    document.body.appendChild(forecastSection);

    forecastChart = document.createElement('div');
    forecastChart.id = 'forecastChart';
    forecastSection.appendChild(forecastChart);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function makeHourlyData(n) {
    const now = new Date();
    const times = [];
    const temps = [];
    const winds = [];
    const precips = [];
    const gusts = [];
    const clouds = [];
    const codes = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getTime() + i * 3600000);
      times.push(d.toISOString());
      temps.push(50 + Math.sin(i / 4) * 15);
      winds.push(5 + i * 0.5);
      precips.push(i < 6 ? 0 : 30);
      gusts.push(8 + i * 0.5);
      clouds.push(20);
      codes.push(0);
    }
    return { time: times, temperature_2m: temps, wind_speed_10m: winds,
             precipitation_probability: precips, wind_gusts_10m: gusts,
             cloud_cover: clouds, weather_code: codes };
  }

  it('hides section when no data', () => {
    renderForecastChart(null);
    expect(forecastSection.style.display).toBe('none');
  });

  it('hides section when time array is empty', () => {
    renderForecastChart({ time: [], temperature_2m: [], wind_speed_10m: [], precipitation_probability: [] });
    expect(forecastSection.style.display).toBe('none');
  });

  it('shows section and renders SVG with valid data', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    expect(forecastSection.style.display).toBe('');
    expect(forecastChart.innerHTML).toContain('<svg');
    expect(forecastChart.innerHTML).toContain('viewBox');
  });

  it('renders temperature polyline with cyan color', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    expect(forecastChart.innerHTML).toContain('var(--accent-cyan)');
    expect(forecastChart.innerHTML).toContain('polyline');
  });

  it('renders wind polyline with amber color', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    expect(forecastChart.innerHTML).toContain('var(--accent-amber)');
  });

  it('renders precipitation bars with blue fill', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    expect(forecastChart.innerHTML).toContain('var(--accent-blue)');
  });

  it('renders x-axis labels', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    // Should have labels every 3 hours
    const textMatches = forecastChart.innerHTML.match(/<text[^>]*text-anchor="middle"[^>]*fill="var\(--text-muted\)"/g);
    expect(textMatches).not.toBeNull();
    expect(textMatches.length).toBeGreaterThanOrEqual(4);
  });

  it('renders NOW marker when current time is in range', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    expect(forecastChart.innerHTML).toContain('NOW');
  });

  it('renders legend items', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    expect(forecastChart.innerHTML).toContain('Temp');
    expect(forecastChart.innerHTML).toContain('Wind');
    expect(forecastChart.innerHTML).toContain('Precip%');
  });

  it('limits to 24 data points even with more', () => {
    const data = makeHourlyData(48);
    renderForecastChart(data);
    expect(forecastSection.style.display).toBe('');
    expect(forecastChart.innerHTML).toContain('<svg');
  });

  it('handles data with fewer than 24 points', () => {
    const data = makeHourlyData(6);
    renderForecastChart(data);
    expect(forecastSection.style.display).toBe('');
    expect(forecastChart.innerHTML).toContain('<svg');
  });

  it('renders y-axis temp labels', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    // Should have degree symbols in y-axis
    const svg = forecastChart.innerHTML;
    expect(svg).toMatch(/\d+\u00b0/);
  });

  it('renders y-axis wind label', () => {
    const data = makeHourlyData(24);
    renderForecastChart(data);
    expect(forecastChart.innerHTML).toContain('mph');
  });

  it('does not render if container elements are missing', () => {
    document.body.innerHTML = '';
    renderForecastChart(makeHourlyData(24));
    // Should not throw and no side effects
  });

  describe('prop icing bands', () => {
    function makeHourlyWithIcing(tempSeq, dewSeq) {
      const now = new Date();
      const n = tempSeq.length;
      const times = [], winds = [], precips = [], gusts = [], clouds = [], codes = [];
      for (let i = 0; i < n; i++) {
        times.push(new Date(now.getTime() + i * 3600000).toISOString());
        winds.push(5); precips.push(0); gusts.push(8); clouds.push(20); codes.push(0);
      }
      return {
        time: times, temperature_2m: tempSeq, dew_point_2m: dewSeq,
        wind_speed_10m: winds, precipitation_probability: precips,
        wind_gusts_10m: gusts, cloud_cover: clouds, weather_code: codes,
      };
    }

    // Band rects are disambiguated from the legend swatch by their opacity
    // (bands use 0.15 / 0.22; the legend swatch uses 0.4).
    const CAUTION_BAND = 'fill="#4db8ff" opacity="0.15"';
    const NOGO_BAND = 'fill="#ff4d4d" opacity="0.22"';

    it('no icing bands when dew_point_2m field is absent (backwards compat)', () => {
      const data = makeHourlyData(24);
      renderForecastChart(data);
      expect(forecastChart.innerHTML).not.toContain(CAUTION_BAND);
      expect(forecastChart.innerHTML).not.toContain(NOGO_BAND);
    });

    it('draws blue CAUTION bands for cold+saturated hours', () => {
      // 24 hours: first 6 warm/dry, middle 6 cold+saturated, rest warm
      const temps = [], dews = [];
      for (let i = 0; i < 24; i++) {
        if (i >= 6 && i < 12) { temps.push(38); dews.push(35); }
        else { temps.push(65); dews.push(45); }
      }
      renderForecastChart(makeHourlyWithIcing(temps, dews));
      expect(forecastChart.innerHTML).toContain(CAUTION_BAND);
      expect(forecastChart.innerHTML).toContain('pointer-events="none"');
    });

    it('draws red NO-GO bands for freezing+saturated hours', () => {
      const temps = [], dews = [];
      for (let i = 0; i < 24; i++) {
        if (i >= 4 && i < 10) { temps.push(28); dews.push(26); }
        else { temps.push(55); dews.push(40); }
      }
      renderForecastChart(makeHourlyWithIcing(temps, dews));
      expect(forecastChart.innerHTML).toContain(NOGO_BAND);
    });

    it('legend includes Icing entry', () => {
      const data = makeHourlyData(24);
      renderForecastChart(data);
      expect(forecastChart.innerHTML).toContain('>Icing<');
    });

    it('tooltip has fc-tip-ice element', () => {
      const data = makeHourlyData(24);
      renderForecastChart(data);
      expect(forecastChart.innerHTML).toContain('id="fc-tip-ice"');
    });

    it('all-clear forecast produces zero band rects', () => {
      const temps = new Array(24).fill(65);
      const dews = new Array(24).fill(45);
      renderForecastChart(makeHourlyWithIcing(temps, dews));
      expect(forecastChart.innerHTML).not.toContain(CAUTION_BAND);
      expect(forecastChart.innerHTML).not.toContain(NOGO_BAND);
    });
  });
});
