// buildAutoCheckDisplay / buildRestrictionEmptyMsg — the fail-safe display
// resolvers for the live TFR/NOTAM auto-check. Core invariants:
//   - CHECKED/green ONLY on state 'ok'.
//   - Every error-state detail names 1800wxbrief.com.
//   - A failed check never yields reassuring "no active …" text.
const { buildAutoCheckDisplay, buildRestrictionEmptyMsg } = require('../../sar-preflight-core.js');

const TZ = 'America/Los_Angeles';
const NOW = Date.parse('2026-08-30T21:00:00Z'); // 2:00 PM PDT

const base = { proxySet: true, hasArea: true, online: true, tfrCount: 0, notamCount: 0, tfr: null, notam: null, manualImport: null };

describe('buildAutoCheckDisplay', () => {
  it('OFF without a proxy — still points at an official briefing', () => {
    const d = buildAutoCheckDisplay({ ...base, proxySet: false }, NOW, TZ);
    expect(d.badge).toBe('OFF');
    expect(d.colorToken).toBe('muted');
    expect(d.showBtn).toBe(false);
    expect(d.detail).toMatch(/manual import/);
    expect(d.detail).toMatch(/1800wxbrief\.com/);
  });

  it('READY with proxy but no area', () => {
    const d = buildAutoCheckDisplay({ ...base, hasArea: false }, NOW, TZ);
    expect(d.badge).toBe('READY');
    expect(d.colorToken).toBe('cyan');
  });

  it('CHECKING while in flight', () => {
    const d = buildAutoCheckDisplay({ ...base, state: 'checking' }, NOW, TZ);
    expect(d.badge).toBe('CHECKING…');
    expect(d.badgeCls).toBe('fetch-status loading');
  });

  it('ok: green CHECKED with per-source fetched stamps and counts', () => {
    const d = buildAutoCheckDisplay({
      ...base, state: 'ok', tfrCount: 2, notamCount: 37,
      tfr: { status: 'live', updatedAt: NOW - 2 * 60000 },
      notam: { status: 'live', updatedAt: NOW - 10 * 60000 },
    }, NOW, TZ);
    expect(d.badge).toBe('CHECKED');
    expect(d.colorToken).toBe('green');
    expect(d.detail).toMatch(/TFRs fetched Aug 30, 01:58 PM \(2m ago\)/);
    expect(d.detail).toMatch(/NOTAMs fetched .* \(10m ago\)/);
    expect(d.detail).toMatch(/2 TFRs • 37 NOTAMs in\/near this area\./);
    expect(d.detail).toMatch(/Advisory/);
  });

  it('ok with zero results keeps the "no active TFRs or NOTAMs" copy', () => {
    const d = buildAutoCheckDisplay({
      ...base, state: 'ok',
      tfr: { status: 'live', updatedAt: NOW }, notam: { status: 'live', updatedAt: NOW },
    }, NOW, TZ);
    expect(d.detail).toMatch(/no active TFRs or NOTAMs in this area\./);
  });

  it('the age text advances as nowMs advances', () => {
    const inp = { ...base, state: 'ok', tfr: { status: 'live', updatedAt: NOW - 60000 }, notam: null };
    const d1 = buildAutoCheckDisplay(inp, NOW, TZ);
    const d2 = buildAutoCheckDisplay(inp, NOW + 10 * 60000, TZ);
    expect(d1.detail).toMatch(/\(1m ago\)/);
    expect(d2.detail).toMatch(/\(11m ago\)/);
  });

  it('error with no data at all: loud UNAVAILABLE + wxbrief', () => {
    const d = buildAutoCheckDisplay({ ...base, state: 'error' }, NOW, TZ);
    expect(d.badge).toBe('FAILED');
    expect(d.colorToken).toBe('red');
    expect(d.detail).toMatch(/UNAVAILABLE/);
    expect(d.detail).toMatch(/cannot be verified/);
    expect(d.detail).toMatch(/1800wxbrief\.com/);
  });

  it('error with prior data: per-source STALE fragments + wxbrief, badge stays FAILED', () => {
    const d = buildAutoCheckDisplay({
      ...base, state: 'error', tfrCount: 1,
      tfr: { status: 'error', updatedAt: NOW - 3 * 3600000 },
      notam: { status: 'live', updatedAt: NOW - 5 * 60000 },
    }, NOW, TZ);
    expect(d.badge).toBe('FAILED');
    expect(d.detail).toMatch(/TFR check FAILED — showing .* data \(3h old\), treat as STALE/);
    expect(d.detail).toMatch(/NOTAMs fetched/);
    expect(d.detail).toMatch(/Do not treat missing items as "none"/);
    expect(d.detail).toMatch(/1800wxbrief\.com/);
  });

  it('error while offline gets the Offline prefix and re-check suffix', () => {
    const d = buildAutoCheckDisplay({ ...base, state: 'error', online: false }, NOW, TZ);
    expect(d.detail).toMatch(/^Offline\. /);
    expect(d.detail).toMatch(/Re-check when back online\.$/);
    expect(d.detail).toMatch(/1800wxbrief\.com/);
  });

  it('INVARIANT: CHECKED/green appears only on state ok', () => {
    for (const state of ['idle', 'checking', 'error', undefined]) {
      const d = buildAutoCheckDisplay({
        ...base, state, tfrCount: 5, notamCount: 5,
        tfr: { status: 'cached', cachedAt: NOW - 60000 },
        notam: { status: 'cached', cachedAt: NOW - 60000 },
      }, NOW, TZ);
      expect(d.badge).not.toBe('CHECKED');
      expect(d.colorToken).not.toBe('green');
    }
  });
});

describe('buildRestrictionEmptyMsg', () => {
  const b = { kind: 'TFRs', proxySet: true, hasArea: true, state: 'error', srcStatus: 'never', atMs: null };

  it('manual fallback strings without proxy / area / after idle', () => {
    expect(buildRestrictionEmptyMsg({ ...b, proxySet: false }, NOW, TZ)).toMatch(/No TFR file imported/);
    expect(buildRestrictionEmptyMsg({ ...b, kind: 'NOTAMs', hasArea: false }, NOW, TZ)).toMatch(/No NOTAMs parsed yet\./);
    expect(buildRestrictionEmptyMsg({ ...b, state: 'idle' }, NOW, TZ)).toMatch(/No TFR file imported/);
  });

  it('checking', () => {
    expect(buildRestrictionEmptyMsg({ ...b, state: 'checking' }, NOW, TZ)).toBe('Checking for TFRs…');
  });

  it('live: stamped "no active" line', () => {
    const msg = buildRestrictionEmptyMsg({ ...b, state: 'ok', srcStatus: 'live', atMs: NOW - 2 * 60000 }, NOW, TZ);
    expect(msg).toMatch(/^Auto-checked Aug 30, 01:58 PM \(2m ago\) — no active TFRs in this area\.$/);
  });

  it('cached: explicit re-check nudge', () => {
    const msg = buildRestrictionEmptyMsg({ ...b, state: 'ok', srcStatus: 'cached', atMs: NOW - 30 * 60000 }, NOW, TZ);
    expect(msg).toMatch(/Cached data from .* shows no TFRs — re-check before flight\./);
  });

  it('error/never: UNKNOWN, not "none"', () => {
    for (const srcStatus of ['error', 'never']) {
      const msg = buildRestrictionEmptyMsg({ ...b, srcStatus }, NOW, TZ);
      expect(msg).toMatch(/TFR check FAILED — status UNKNOWN, not "none"/);
      expect(msg).toMatch(/1800wxbrief\.com/);
    }
  });

  it('INVARIANT: a failed check never returns "no active"', () => {
    for (const srcStatus of ['error', 'never']) {
      for (const kind of ['TFRs', 'NOTAMs']) {
        const msg = buildRestrictionEmptyMsg({ ...b, kind, srcStatus, atMs: NOW - 60000 }, NOW, TZ);
        expect(msg).not.toMatch(/no active/);
      }
    }
  });
});
