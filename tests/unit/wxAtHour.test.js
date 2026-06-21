const { wxAtHour } = require('../../sar-preflight-core.js');

// ============================================================
// wxAtHour(hourly, idx, current)
// Builds a per-hour weather snapshot shaped like the Open-Meteo `current` object.
// ============================================================

const CURRENT = {
  temperature_2m: 70, dew_point_2m: 50, apparent_temperature: 68,
  relative_humidity_2m: 40, surface_pressure: 1010, visibility: 16000,
  uv_index: 5, cloud_cover: 20, weather_code: 1, precipitation_probability: 10,
  wind_speed_10m: 8, wind_direction_10m: 270, wind_gusts_10m: 12, is_day: 1,
};

const HOURLY = {
  time: ['2026-06-20T00:00', '2026-06-20T01:00', '2026-06-20T02:00'],
  temperature_2m: [71, 80, 90],
  dew_point_2m: [50, 55, 60],
  wind_speed_10m: [9, 20, 35],
  wind_direction_10m: [270, 280, 300],
  wind_gusts_10m: [13, 28, 45],
  surface_pressure: [1011, 1008, 1005],
  cloud_cover: [25, 60, 95],
  weather_code: [1, 3, 95],
  // intentionally NO visibility / uv_index / humidity arrays here
};

describe('wxAtHour(hourly, idx, current)', () => {
  it('returns the current object (with metadata) when hourly is absent', () => {
    const snap = wxAtHour(null, 0, CURRENT);
    expect(snap.temperature_2m).toBe(70);
    expect(snap._isNow).toBe(true);
    expect(snap._idx).toBe(0);
    expect(snap._time).toBeNull();
  });

  it('returns the current object when hourly has an empty time array', () => {
    const snap = wxAtHour({ time: [] }, 3, CURRENT);
    expect(snap.temperature_2m).toBe(70);
    expect(snap._isNow).toBe(true);
  });

  it('idx 0 takes hour-0 values for fields present in hourly', () => {
    const snap = wxAtHour(HOURLY, 0, CURRENT);
    expect(snap.temperature_2m).toBe(71);
    expect(snap.wind_speed_10m).toBe(9);
    expect(snap._isNow).toBe(true);
    expect(snap._idx).toBe(0);
    expect(snap._time).toBe('2026-06-20T00:00');
  });

  it('idx k takes the k-th hourly value', () => {
    const snap = wxAtHour(HOURLY, 2, CURRENT);
    expect(snap.temperature_2m).toBe(90);
    expect(snap.wind_speed_10m).toBe(35);
    expect(snap.weather_code).toBe(95);
    expect(snap._isNow).toBe(false);
    expect(snap._idx).toBe(2);
    expect(snap._time).toBe('2026-06-20T02:00');
  });

  it('falls back to current for fields with no hourly array', () => {
    const snap = wxAtHour(HOURLY, 2, CURRENT);
    // visibility/uv_index/relative_humidity have no hourly arrays -> current value
    expect(snap.visibility).toBe(16000);
    expect(snap.uv_index).toBe(5);
    expect(snap.relative_humidity_2m).toBe(40);
  });

  it('clamps idx above the available range to the last hour', () => {
    const snap = wxAtHour(HOURLY, 99, CURRENT);
    expect(snap._idx).toBe(2);
    expect(snap.temperature_2m).toBe(90);
  });

  it('clamps negative idx to 0', () => {
    const snap = wxAtHour(HOURLY, -5, CURRENT);
    expect(snap._idx).toBe(0);
    expect(snap.temperature_2m).toBe(71);
  });

  it('never exposes more than 24 hours', () => {
    const longTime = [];
    const longTemps = [];
    for (let i = 0; i < 48; i++) { longTime.push('t' + i); longTemps.push(i); }
    const snap = wxAtHour({ time: longTime, temperature_2m: longTemps }, 47, {});
    expect(snap._idx).toBe(23); // clamped to min(24, len)-1
  });

  it('skips null hourly entries and falls back to current for that field', () => {
    const hourly = { time: ['a', 'b'], temperature_2m: [null, 75] };
    const snap0 = wxAtHour(hourly, 0, { temperature_2m: 60 });
    expect(snap0.temperature_2m).toBe(60); // hour-0 was null -> current
    const snap1 = wxAtHour(hourly, 1, { temperature_2m: 60 });
    expect(snap1.temperature_2m).toBe(75);
  });

  it('does not mutate the current object', () => {
    const cur = { temperature_2m: 70 };
    wxAtHour(HOURLY, 1, cur);
    expect(cur.temperature_2m).toBe(70);
    expect(cur._idx).toBeUndefined();
  });
});
