const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { S, buildBriefingText, copyBriefing } = require('../../sar-preflight.js');

describe('buildBriefingText()', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="assessBadge">GO</span>
      <span id="assessText">All conditions nominal</span>
      <span id="areaCenter">38.6850, -120.9900</span>
      <span id="areaSize">2.50 km²</span>
      <span id="areaType">RECTANGLE</span>
      <div class="data-cell"><div class="data-label">Temperature</div><div class="data-value" id="wxTemp">72°F</div></div>
      <div class="data-cell"><div class="data-label">Feels Like</div><div class="data-value" id="wxFeels">70°F</div></div>
      <div class="data-cell"><div class="data-label">Dew Point</div><div class="data-value" id="wxDew">55°F</div></div>
      <div class="data-cell"><div class="data-label">Humidity</div><div class="data-value" id="wxHumidity">45%</div></div>
      <div class="data-cell"><div class="data-label">Pressure</div><div class="data-value" id="wxPressure">30.12 inHg</div></div>
      <div class="data-cell"><div class="data-label">Density Alt</div><div class="data-value" id="wxDensity">2,500 ft</div></div>
      <div class="data-cell"><div class="data-label">Visibility</div><div class="data-value" id="wxVis">10.0 mi</div></div>
      <div class="data-cell"><div class="data-label">Cloud Cover</div><div class="data-value" id="wxCloud">20%</div></div>
      <div class="data-cell"><div class="data-label">Cloud Ceiling</div><div class="data-value" id="wxCeiling">15,000+ ft</div></div>
      <div class="data-cell"><div class="data-label">Conditions</div><div class="data-value" id="wxConditions">Clear</div></div>
      <div class="data-cell"><div class="data-label">Precip Prob</div><div class="data-value" id="wxPrecip">5%</div></div>
      <div class="data-cell"><div class="data-label">Lightning Risk</div><div class="data-value" id="wxLightning">None</div></div>
      <div class="data-cell"><div class="data-label">UV Index</div><div class="data-value" id="wxUV">6.0</div></div>
      <div class="data-cell"><div class="data-label">Kp Index</div><div class="data-value" id="wxKp">2.0</div></div>
      <div class="data-cell"><div class="data-label">Icing Risk</div><div class="data-value" id="wxIcing">None</div></div>
      <div class="data-cell"><div class="data-label">Fire Danger</div><div class="data-value" id="wxFire">Low</div></div>
      <div class="data-cell"><div class="data-label">AQI (US)</div><div class="data-value" id="wxAQI">35</div></div>
      <div class="data-cell"><div class="data-label">Max Sustained</div><div class="data-value" id="windMax">8 mph</div></div>
      <div class="data-cell"><div class="data-label">Max Gust</div><div class="data-value" id="windGustMax">12 mph</div></div>
      <div class="data-cell"><div class="data-label">Prevailing Dir</div><div class="data-value" id="windDir">270° (W)</div></div>
      <div class="data-cell"><div class="data-label">Battery Impact</div><div class="data-value" id="windImpact">Minimal</div></div>
      <div class="data-cell"><div class="data-label">Primary Airspace</div><div class="data-value" id="airClass">Class G</div></div>
      <div class="data-cell"><div class="data-label">LAANC Available</div><div class="data-value" id="airLAANC">N/A</div></div>
      <div class="data-cell"><div class="data-label">LAANC Max Alt</div><div class="data-value" id="airLAANCAlt">400 ft AGL</div></div>
      <div class="data-cell"><div class="data-label">Nearest Airport</div><div class="data-value" id="airNearAirport">EDC</div></div>
      <div class="data-cell"><div class="data-label">Distance</div><div class="data-value" id="airNearDist">15 nm</div></div>
      <div class="data-cell"><div class="data-label">Min Elevation</div><div class="data-value" id="terrMin">1200 ft</div></div>
      <div class="data-cell"><div class="data-label">Max Elevation</div><div class="data-value" id="terrMax">1800 ft</div></div>
      <div class="data-cell"><div class="data-label">Elev Range</div><div class="data-value" id="terrRange">600 ft</div></div>
      <div class="data-cell"><div class="data-label">Center Elev</div><div class="data-value" id="terrLaunch">1500 ft</div></div>
      <div class="data-cell"><div class="data-label">Terrain Class</div><div class="data-value" id="terrClass">Moderate</div></div>
      <div class="data-cell"><div class="data-label">Elev Change/km</div><div class="data-value" id="terrSlope">120 ft</div></div>
      <div class="data-cell"><div class="data-label">Power Lines</div><div class="data-value" id="terrPower">3 segments</div></div>
      <div class="data-cell"><div class="data-label">Cell Towers</div><div class="data-value" id="terrTowers">2</div></div>
      <div class="data-cell"><div class="data-label">Vegetation</div><div class="data-value" id="terrVeg">Mixed forest</div></div>
      <div class="data-cell"><div class="data-label">Cell Coverage</div><div class="data-value" id="terrCell">Good</div></div>
      <div class="data-cell"><div class="data-label">Sunrise</div><div class="data-value" id="astSunrise">06:30</div></div>
      <div class="data-cell"><div class="data-label">Sunset</div><div class="data-value" id="astSunset">19:45</div></div>
      <div class="data-cell"><div class="data-label">Civil Twilight AM</div><div class="data-value" id="astTwilightAM">06:00</div></div>
      <div class="data-cell"><div class="data-label">Civil Twilight PM</div><div class="data-value" id="astTwilightPM">20:15</div></div>
      <div class="data-cell"><div class="data-label">Sun Azimuth</div><div class="data-value" id="astSunAz">180°</div></div>
      <div class="data-cell"><div class="data-label">Sun Elevation</div><div class="data-value" id="astSunEl">55°</div></div>
      <div class="data-cell"><div class="data-label">Moon Phase</div><div class="data-value" id="astMoonPhase">Waxing Gibbous</div></div>
      <div class="data-cell"><div class="data-label">Illumination</div><div class="data-value" id="astMoonIllum">75%</div></div>
      <div class="data-cell"><div class="data-label">Part 107 Daylight Window</div><div class="data-value" id="astDayWindow">06:00 - 20:15</div></div>
      <div class="data-cell"><div class="data-label">Mag Declination</div><div class="data-value" id="astMagDec">14° E</div></div>
      <div class="data-cell"><div class="data-label">Kp Index</div><div class="data-value" id="satKp">2.0</div></div>
      <div class="data-cell"><div class="data-label">GPS Accuracy</div><div class="data-value" id="satAccuracy">< 2m horizontal</div></div>
      <div class="data-cell"><div class="data-label">GNSS Assessment</div><div class="data-value" id="satAssessment">Nominal</div></div>
      <div class="data-cell"><div class="data-label">Temp Factor</div><div class="data-value" id="opsTempFactor">98%</div></div>
      <div class="data-cell"><div class="data-label">Alt Factor</div><div class="data-value" id="opsAltFactor">97%</div></div>
      <div class="data-cell"><div class="data-label">Wind Factor</div><div class="data-value" id="opsWindFactor">95%</div></div>
      <div class="data-cell"><div class="data-label">Est. Flight Time</div><div class="data-value" id="opsFlightTime">~34 min</div></div>
      <div class="data-cell"><div class="data-label">Effective Capacity</div><div class="data-value" id="opsCapacity">90% of nominal</div></div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('includes the header line', () => {
    const text = buildBriefingText();
    expect(text).toContain('=== SAR UAS PRE-FLIGHT BRIEFING ===');
  });

  it('includes a timestamp', () => {
    const text = buildBriefingText();
    expect(text).toContain('Generated:');
    // ISO timestamp pattern
    expect(text).toMatch(/Generated: \d{4}-\d{2}-\d{2}T/);
  });

  it('includes area info', () => {
    const text = buildBriefingText();
    expect(text).toContain('38.6850, -120.9900');
    expect(text).toContain('2.50 km');
    expect(text).toContain('RECTANGLE');
  });

  it('includes assessment badge and text', () => {
    const text = buildBriefingText();
    expect(text).toContain('ASSESSMENT: GO');
    expect(text).toContain('All conditions nominal');
  });

  it('includes WEATHER section with data', () => {
    const text = buildBriefingText();
    expect(text).toContain('--- WEATHER ---');
    expect(text).toContain('Temperature: 72°F');
    expect(text).toContain('Visibility: 10.0 mi');
    expect(text).toContain('AQI (US): 35');
  });

  it('includes WIND section', () => {
    const text = buildBriefingText();
    expect(text).toContain('--- WIND ---');
    expect(text).toContain('Max Sustained: 8 mph');
    expect(text).toContain('Max Gust: 12 mph');
  });

  it('includes AIRSPACE section', () => {
    const text = buildBriefingText();
    expect(text).toContain('--- AIRSPACE ---');
    expect(text).toContain('Primary Airspace: Class G');
  });

  it('includes TERRAIN section', () => {
    const text = buildBriefingText();
    expect(text).toContain('--- TERRAIN ---');
    expect(text).toContain('Min Elevation: 1200 ft');
    expect(text).toContain('Max Elevation: 1800 ft');
  });

  it('includes SUN/MOON section', () => {
    const text = buildBriefingText();
    expect(text).toContain('--- SUN/MOON ---');
    expect(text).toContain('Sunrise: 06:30');
    expect(text).toContain('Sunset: 19:45');
  });

  it('includes GNSS section', () => {
    const text = buildBriefingText();
    expect(text).toContain('--- GNSS ---');
    expect(text).toContain('GNSS Assessment: Nominal');
  });

  it('includes OPS section', () => {
    const text = buildBriefingText();
    expect(text).toContain('--- OPS ---');
    expect(text).toContain('Est. Flight Time: ~34 min');
    expect(text).toContain('Effective Capacity: 90% of nominal');
  });

  it('handles missing elements gracefully', () => {
    // Remove some elements
    document.getElementById('wxTemp').remove();
    document.getElementById('windMax').remove();
    const text = buildBriefingText();
    // Should not throw and should still contain other sections
    expect(text).toContain('--- WEATHER ---');
    expect(text).toContain('--- WIND ---');
    // wxTemp should not appear since element is gone
    expect(text).not.toContain('Temperature: 72°F');
  });
});

describe('copyBriefing()', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="btnCopy">COPY</button>
      <span id="assessBadge">GO</span>
      <span id="assessText">All conditions nominal</span>
      <span id="areaCenter">38.685, -120.99</span>
      <span id="areaSize">2 km²</span>
      <span id="areaType">CIRCLE</span>
    `;
    navigator.clipboard = { writeText: vi.fn(() => Promise.resolve()) };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing when no area is drawn', () => {
    S.currentArea = null;
    copyBriefing();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('copies text to clipboard when area exists', async () => {
    S.currentArea = { mock: true };
    copyBriefing();
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    const text = navigator.clipboard.writeText.mock.calls[0][0];
    expect(text).toContain('SAR UAS PRE-FLIGHT BRIEFING');
  });

  it('flashes button text to COPIED', async () => {
    S.currentArea = { mock: true };
    vi.useFakeTimers();
    copyBriefing();
    // Wait for the promise microtask
    await Promise.resolve();
    expect(document.getElementById('btnCopy').textContent).toBe('COPIED');
    vi.advanceTimersByTime(1500);
    expect(document.getElementById('btnCopy').textContent).toBe('COPY');
    vi.useRealTimers();
  });
});
