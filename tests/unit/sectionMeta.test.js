const core = require('../../sar-preflight-core.js');
const { formatStamp, relAge, buildSectionMetaLine, rollupSources, metaToneClass } = core;

// Fixed reference: Jun 20 2026 17:45:00 UTC === 10:45 AM PDT (UTC-7)
const BASE = Date.UTC(2026, 5, 20, 17, 45, 0);
const TZ = 'America/Los_Angeles';
const MIN = 60 * 1000;

describe('formatStamp(ms, nowMs, tz)', () => {
  it('formats an absolute local time in the given zone', () => {
    expect(formatStamp(BASE, BASE, TZ)).toBe('Jun 20, 10:45 AM');
  });

  it('respects the timezone argument', () => {
    // Same instant, New York (EDT, UTC-4) -> 01:45 PM
    expect(formatStamp(BASE, BASE, 'America/New_York')).toBe('Jun 20, 01:45 PM');
  });

  it('returns an em-dash for null / NaN', () => {
    expect(formatStamp(null, BASE, TZ)).toBe('—');
    expect(formatStamp(undefined, BASE, TZ)).toBe('—');
    expect(formatStamp(NaN, BASE, TZ)).toBe('—');
  });
});

describe('relAge(ms, nowMs)', () => {
  it('buckets by minute / hour / day', () => {
    expect(relAge(BASE, BASE)).toBe('<1m');
    expect(relAge(BASE, BASE + 30 * 1000)).toBe('<1m');
    expect(relAge(BASE, BASE + 5 * MIN)).toBe('5m');
    expect(relAge(BASE, BASE + 2 * 60 * MIN)).toBe('2h');
    expect(relAge(BASE, BASE + 3 * 24 * 60 * MIN)).toBe('3d');
  });

  it('returns empty string for missing or future timestamps', () => {
    expect(relAge(null, BASE)).toBe('');
    expect(relAge(BASE, BASE - MIN)).toBe('');
  });
});

describe('buildSectionMetaLine(meta, nowMs, tz)', () => {
  it('never: not loaded, no update allowed', () => {
    const r = buildSectionMetaLine({}, BASE, TZ);
    expect(r).toMatchObject({ state: 'never', tone: 'muted', text: 'Not loaded', canUpdate: false });
  });

  it('loading takes precedence over everything', () => {
    const r = buildSectionMetaLine({ loading: true, status: 'live', updatedAt: BASE }, BASE, TZ);
    expect(r).toMatchObject({ state: 'loading', tone: 'muted', text: 'Updating…', canUpdate: false });
  });

  it('live: shows absolute time + relative age', () => {
    const r = buildSectionMetaLine({ status: 'live', updatedAt: BASE }, BASE + 3 * MIN, TZ);
    expect(r.state).toBe('live');
    expect(r.tone).toBe('live');
    expect(r.text).toBe('Updated Jun 20, 10:45 AM (3m ago)');
    expect(r.ageText).toBe('(3m ago)');
    expect(r.canUpdate).toBe(true);
  });

  it('cached: amber, shows the cached date/time', () => {
    const r = buildSectionMetaLine({ status: 'cached', cachedAt: BASE }, BASE + 37 * MIN, TZ);
    expect(r.state).toBe('cached');
    expect(r.tone).toBe('cached');
    expect(r.text).toBe('Cached Jun 20, 10:45 AM (37m ago)');
    expect(r.canUpdate).toBe(true);
  });

  it('error with prior data: keeps showing the last good timestamp', () => {
    const r = buildSectionMetaLine(
      { status: 'error', updatedAt: BASE, errorAt: BASE + 35 * MIN, error: 'HTTP 503' },
      BASE + 37 * MIN, TZ);
    expect(r.state).toBe('error');
    expect(r.tone).toBe('error');
    expect(r.text).toBe('⚠ Update failed (2m ago) — showing Jun 20, 10:45 AM data');
    expect(r.title).toBe('HTTP 503');
    expect(r.canUpdate).toBe(true);
  });

  it('error without any data: no data', () => {
    const r = buildSectionMetaLine({ status: 'error', errorAt: BASE }, BASE + 2 * MIN, TZ);
    expect(r.text).toBe('⚠ Update failed (2m ago) — no data');
  });

  it('error precedence: error tone even when a cached timestamp exists', () => {
    const r = buildSectionMetaLine(
      { status: 'error', cachedAt: BASE, errorAt: BASE + MIN }, BASE + 3 * MIN, TZ);
    expect(r.tone).toBe('error');
    expect(r.text).toContain('showing Jun 20, 10:45 AM data');
  });
});

describe('rollupSources(sources, nowMs)', () => {
  it('all live -> live, oldest updatedAt', () => {
    const r = rollupSources({
      wire: { status: 'live', updatedAt: BASE },
      dof: { status: 'live', updatedAt: BASE + MIN },
    }, BASE + 2 * MIN);
    expect(r.status).toBe('live');
    expect(r.updatedAt).toBe(BASE);
    expect(r.detail).toBe('wire live · dof live');
  });

  it('any cached -> cached (oldest cachedAt)', () => {
    const r = rollupSources({
      wire: { status: 'live', updatedAt: BASE },
      dof: { status: 'cached', cachedAt: BASE - MIN },
    }, BASE);
    expect(r.status).toBe('cached');
    expect(r.cachedAt).toBe(BASE - MIN);
  });

  it('any error -> error, surfaces a message and latest errorAt', () => {
    const r = rollupSources({
      wire: { status: 'error', error: 'boom', errorAt: BASE },
      dof: { status: 'live', updatedAt: BASE },
    }, BASE);
    expect(r.status).toBe('error');
    expect(r.error).toBe('boom');
    expect(r.updatedAt).toBe(BASE); // prior good data preserved for "showing ... data"
  });

  it('empty -> never', () => {
    expect(rollupSources({}, BASE)).toMatchObject({ status: 'never' });
  });
});

describe('metaToneClass(tone)', () => {
  it('maps each tone to a class', () => {
    expect(metaToneClass('live')).toBe('section-meta-live');
    expect(metaToneClass('cached')).toBe('section-meta-cached');
    expect(metaToneClass('error')).toBe('section-meta-error');
    expect(metaToneClass('muted')).toBe('section-meta-muted');
    expect(metaToneClass('whatever')).toBe('section-meta-muted');
  });
});
