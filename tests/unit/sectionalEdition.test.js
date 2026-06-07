const { parseSectionalEdition, currentSectionalCycle } = require('../../sar-preflight-core.js');

describe('parseSectionalEdition(description)', () => {
  it('extracts the YYYY-MM-DD stamp from the FAA service description', () => {
    const desc = 'Updated with the latest charts on 2026-05-13 16:18:39.073216';
    expect(parseSectionalEdition(desc)).toBe('2026-05-13');
  });

  it('extracts a bare date string', () => {
    expect(parseSectionalEdition('2026-03-19')).toBe('2026-03-19');
  });

  it('returns the first date when several are present', () => {
    expect(parseSectionalEdition('effective 2026-05-13, next 2026-07-08')).toBe('2026-05-13');
  });

  it('returns null when no date is present', () => {
    expect(parseSectionalEdition('VFR Sectional')).toBeNull();
  });

  it('returns null for non-string / empty input', () => {
    expect(parseSectionalEdition(null)).toBeNull();
    expect(parseSectionalEdition(undefined)).toBeNull();
    expect(parseSectionalEdition(42)).toBeNull();
    expect(parseSectionalEdition('')).toBeNull();
  });
});

describe('currentSectionalCycle(todayISO)', () => {
  it('returns the anchor edition on its effective date', () => {
    expect(currentSectionalCycle('2026-05-13')).toBe('2026-05-13');
  });

  it('stays on the current edition mid-cycle (before the next rollover)', () => {
    expect(currentSectionalCycle('2026-06-07')).toBe('2026-05-13');
    expect(currentSectionalCycle('2026-07-07')).toBe('2026-05-13');
  });

  it('rolls over to the next edition exactly 56 days later', () => {
    expect(currentSectionalCycle('2026-07-08')).toBe('2026-07-08');
    expect(currentSectionalCycle('2026-08-01')).toBe('2026-07-08');
  });

  it('returns the prior edition for dates before the anchor', () => {
    // 2026-05-13 minus 56 days = 2026-03-18
    expect(currentSectionalCycle('2026-05-12')).toBe('2026-03-18');
  });

  it('accepts a full ISO timestamp', () => {
    expect(currentSectionalCycle('2026-06-07T14:30:00Z')).toBe('2026-05-13');
  });

  it('falls back to the anchor on unparseable input', () => {
    expect(currentSectionalCycle('not-a-date')).toBe('2026-05-13');
  });

  it('cycles are 56 days apart', () => {
    const a = currentSectionalCycle('2026-07-08');
    const b = currentSectionalCycle('2026-05-13');
    const days = (Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;
    expect(days).toBe(56);
  });
});
