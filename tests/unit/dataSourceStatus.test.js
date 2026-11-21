const { httpStatusMeaning, describeSourceError, dataSourceRowState, dataSourceAdvisories } = require('../../sar-preflight-core.js');

describe('httpStatusMeaning', () => {
  it('names common statuses and falls back to the status class', () => {
    expect(httpStatusMeaning(429)).toMatch(/^rate limited/);
    expect(httpStatusMeaning(503)).toMatch(/^service unavailable/);
    expect(httpStatusMeaning(418)).toBe('request refused');
    expect(httpStatusMeaning(599)).toBe('server error');
    expect(httpStatusMeaning('x')).toBeNull();
  });
});

describe('describeSourceError', () => {
  it('annotates every HTTP code and heads with the first', () => {
    const d = describeSourceError('3DEP HTTP 504; Open-Meteo elevation HTTP 502');
    expect(d.headline).toBe('Gateway timeout');
    expect(d.detail).toBe('3DEP HTTP 504 (gateway timeout); Open-Meteo elevation HTTP 502 (bad gateway)');
    expect(d.codes).toEqual([504, 502]);
  });
  it('uses a separate numeric status', () => {
    expect(describeSourceError('request failed', 429).headline).toBe('Rate limited');
  });
  it('explains failures that carry no status', () => {
    expect(describeSourceError('no answer within 20 s').headline).toMatch(/^Timed out/);
    expect(describeSourceError('TypeError: Failed to fetch').headline).toMatch(/^Network error/);
    expect(describeSourceError('Fire perimeters incomplete — page 3 failed').headline).toMatch(/^Incomplete/);
    expect(describeSourceError('TFR response malformed').headline).toMatch(/^Bad answer/);
    expect(describeSourceError('').headline).toBe('Failed');
  });
  it('METAR: stations that answered without the data, or only an old report', () => {
    expect(describeSourceError('No nearby airport station reported a usable ceiling/visibility observation (KXYZ: HTTP 503; BENC1: no sky condition or visibility reported)').headline)
      .toMatch(/^No usable report/);
    expect(describeSourceError('Latest KAUN observation is 3.5 h old — no current METAR').headline).toMatch(/^Out of date/);
  });
  it('inside parentheses uses a dash instead of nesting', () => {
    expect(describeSourceError('Overpass: all mirrors failed (HTTP 504)').detail)
      .toBe('Overpass: all mirrors failed (HTTP 504 — gateway timeout)');
  });
  it('does not annotate a code twice', () => {
    expect(describeSourceError('HTTP 503 (busy)').detail).toBe('HTTP 503 (busy)');
  });
});

describe('dataSourceRowState', () => {
  const now = Date.now();
  it('error beats every success record; an in-flight retry beats the error', () => {
    const err = { message: 'HTTP 503', timestamp: now };
    expect(dataSourceRowState({ error: err, meta: { status: 'live', updatedAt: now } }).state).toBe('error');
    expect(dataSourceRowState({ error: err, active: true }).state).toBe('updating');
  });
  it('reads live / cached / error section records', () => {
    expect(dataSourceRowState({ meta: { status: 'live', updatedAt: 5 } })).toEqual({ state: 'ok', at: 5 });
    expect(dataSourceRowState({ meta: { status: 'cached', cachedAt: 7 } })).toEqual({ state: 'cached', at: 7 });
    expect(dataSourceRowState({ meta: { status: 'error', error: 'x', errorAt: 9 } }).state).toBe('error');
    expect(dataSourceRowState({ meta: { status: 'never' } }).state).toBe('waiting');
  });
  it('a background poll keeps its last state; its first poll still shows updating', () => {
    expect(dataSourceRowState({ active: true, poll: true, okAt: 3 }).state).toBe('ok');
    expect(dataSourceRowState({ active: true, poll: true }).state).toBe('updating');
  });
});

describe('dataSourceAdvisories', () => {
  it('lists errors then updating, skipping banner:false rows', () => {
    expect(dataSourceAdvisories([
      { name: 'Weather', state: 'updating' },
      { name: 'TFR', state: 'error', message: 'TFR HTTP 403' },
      { name: 'Response Time', state: 'error', message: 'x', banner: false },
      { name: 'Smoke', state: 'ok' },
    ])).toEqual(['Data source errors: TFR (access refused)', 'Data sources updating: Weather']);
    expect(dataSourceAdvisories([{ name: 'Smoke', state: 'ok' }])).toEqual([]);
  });
});
