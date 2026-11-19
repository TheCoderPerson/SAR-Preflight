// Open-Meteo answers lengths in the unit system the request selects. The area
// forecast is requested with precipitation_unit=inch, which makes `visibility`
// and `freezing_level_height` FEET — the app read them as metres until
// v2026.11.18-c. The numbers below are a live answer for one point
// (38.845, -120.235, 2026-11-18): imperial 1968.504 ft / 6200.788 ft, metric
// 600 m / 1890 m.
const {
  OPEN_METEO_LENGTH_FIELDS, openMeteoLengthToMeters, normalizeOpenMeteoLengths, freezingLevelRisk,
} = require('../../sar-preflight-core.js');

describe('openMeteoLengthToMeters', () => {
  it('converts feet to metres', () => {
    expect(openMeteoLengthToMeters(1968.504, 'ft')).toBeCloseTo(600, 3);
    expect(openMeteoLengthToMeters(6200.788, 'ft')).toBeCloseTo(1890, 2);
    expect(openMeteoLengthToMeters(5280, 'feet')).toBeCloseTo(1609.344, 6);
  });

  it('passes metres through', () => {
    expect(openMeteoLengthToMeters(600, 'm')).toBe(600);
    expect(openMeteoLengthToMeters(1890, 'Meters')).toBe(1890);
  });

  it('reads a missing unit as the API default, metres', () => {
    expect(openMeteoLengthToMeters(16000, undefined)).toBe(16000);
    expect(openMeteoLengthToMeters(16000, null)).toBe(16000);
  });

  it('keeps a reported zero (dense fog is a value, not "missing")', () => {
    expect(openMeteoLengthToMeters(0, 'ft')).toBe(0);
    expect(openMeteoLengthToMeters(0, 'm')).toBe(0);
  });

  it('returns null for an unknown unit rather than guessing', () => {
    expect(openMeteoLengthToMeters(3, 'km')).toBeNull();
    expect(openMeteoLengthToMeters(2, 'mi')).toBeNull();
    expect(openMeteoLengthToMeters(600, '')).toBeNull();
  });

  it('returns null for a missing or non-numeric value', () => {
    expect(openMeteoLengthToMeters(null, 'ft')).toBeNull();
    expect(openMeteoLengthToMeters(undefined, 'm')).toBeNull();
    expect(openMeteoLengthToMeters('abc', 'ft')).toBeNull();
    expect(openMeteoLengthToMeters(NaN, 'm')).toBeNull();
  });
});

describe('normalizeOpenMeteoLengths', () => {
  const imperial = () => ({
    latitude: 38.853683, longitude: -120.25562, elevation: 2118, timezone: 'America/Los_Angeles',
    current_units: { temperature_2m: '°F', visibility: 'ft' },
    current: { temperature_2m: 29.5, visibility: 1968.504 },
    hourly_units: { temperature_2m: '°F', visibility: 'ft', freezing_level_height: 'ft' },
    hourly: {
      time: [1795056000, 1795059600, 1795063200],
      temperature_2m: [29.3, 29.6, 29.5],
      visibility: [984.252, 2624.672, null],
      freezing_level_height: [6200.788, 6266.405, 6266.405],
    },
  });

  it('covers exactly the two length fields the forecast request returns', () => {
    expect(OPEN_METEO_LENGTH_FIELDS).toEqual(['visibility', 'freezing_level_height']);
  });

  it('converts current and hourly values to metres', () => {
    const n = normalizeOpenMeteoLengths(imperial());
    expect(n.current.visibility).toBeCloseTo(600, 3);
    expect(n.hourly.visibility[0]).toBeCloseTo(300, 3);
    expect(n.hourly.visibility[1]).toBeCloseTo(800, 3);
    expect(n.hourly.freezing_level_height[0]).toBeCloseTo(1890, 2);
    expect(n.hourly.freezing_level_height[1]).toBeCloseTo(1910, 2);
  });

  it('keeps a missing hour missing', () => {
    expect(normalizeOpenMeteoLengths(imperial()).hourly.visibility[2]).toBeNull();
  });

  it('leaves every other field and the unit of other fields alone', () => {
    const n = normalizeOpenMeteoLengths(imperial());
    expect(n.current.temperature_2m).toBe(29.5);
    expect(n.hourly.temperature_2m).toEqual([29.3, 29.6, 29.5]);
    expect(n.hourly.time).toEqual([1795056000, 1795059600, 1795063200]);
    expect(n.current_units.temperature_2m).toBe('°F');
    expect(n.elevation).toBe(2118);
    expect(n.timezone).toBe('America/Los_Angeles');
  });

  it('records the new unit, so a second pass changes nothing', () => {
    const once = normalizeOpenMeteoLengths(imperial());
    expect(once.current_units.visibility).toBe('m');
    expect(once.hourly_units.visibility).toBe('m');
    expect(once.hourly_units.freezing_level_height).toBe('m');
    const twice = normalizeOpenMeteoLengths(once);
    expect(twice.current.visibility).toBe(once.current.visibility);
    expect(twice.hourly.freezing_level_height).toEqual(once.hourly.freezing_level_height);
  });

  it('does not modify the body it was given (the raw body is what gets cached)', () => {
    const raw = imperial();
    normalizeOpenMeteoLengths(raw);
    expect(raw.current.visibility).toBe(1968.504);
    expect(raw.hourly.visibility).toEqual([984.252, 2624.672, null]);
    expect(raw.current_units.visibility).toBe('ft');
    expect(raw.hourly_units.freezing_level_height).toBe('ft');
  });

  it('a metric body comes through with the same numbers', () => {
    const n = normalizeOpenMeteoLengths({
      current_units: { visibility: 'm' }, current: { visibility: 600 },
      hourly_units: { visibility: 'm', freezing_level_height: 'm' },
      hourly: { visibility: [300, 800], freezing_level_height: [1890, 1910] },
    });
    expect(n.current.visibility).toBe(600);
    expect(n.hourly.visibility).toEqual([300, 800]);
    expect(n.hourly.freezing_level_height).toEqual([1890, 1910]);
  });

  it('a body with no unit blocks is read as metres', () => {
    const n = normalizeOpenMeteoLengths({ current: { visibility: 16000, temperature_2m: 65 } });
    expect(n.current.visibility).toBe(16000);
    expect(n.current.temperature_2m).toBe(65);
  });

  it('an unknown unit yields null, never a guessed number', () => {
    const n = normalizeOpenMeteoLengths({
      current_units: { visibility: 'km' }, current: { visibility: 0.6 },
      hourly_units: { freezing_level_height: 'yd' }, hourly: { freezing_level_height: [2067] },
    });
    expect(n.current.visibility).toBeNull();
    expect(n.hourly.freezing_level_height).toEqual([null]);
  });

  it('does not add a field the body did not have', () => {
    const n = normalizeOpenMeteoLengths({ current: { temperature_2m: 65 }, hourly: { time: [1] } });
    expect('visibility' in n.current).toBe(false);
    expect('freezing_level_height' in n.hourly).toBe(false);
  });

  it('passes through anything that is not a forecast object', () => {
    expect(normalizeOpenMeteoLengths(null)).toBeNull();
    expect(normalizeOpenMeteoLengths(undefined)).toBeUndefined();
    const arr = [{ current: { visibility: 5 } }];
    expect(normalizeOpenMeteoLengths(arr)).toBe(arr);
  });

  it('the converted freezing level trips the advisory the feet value hid', () => {
    const n = normalizeOpenMeteoLengths(imperial());
    // Launch at 6,956 ft, 0 °C level at 6,201 ft: at/below the launch elevation.
    const risk = freezingLevelRisk(n.hourly.freezing_level_height[0], 6956, 400);
    expect(risk).not.toBeNull();
    expect(risk.freezingLevelFt).toBe(6201);
    // The same number read as metres put the level at 20,344 ft — no advisory.
    expect(freezingLevelRisk(6200.788, 6956, 400)).toBeNull();
  });
});
