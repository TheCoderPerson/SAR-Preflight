const { CHANGELOG_ENTRIES, CHANGELOG_URL } = require('../../sar-preflight-core.js');
const { SAR_VERSION } = require('../../version.js');

describe('CHANGELOG_ENTRIES', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(CHANGELOG_ENTRIES)).toBe(true);
    expect(CHANGELOG_ENTRIES.length).toBeGreaterThan(0);
  });

  it('each entry has a version, date, and a non-empty changes array of strings', () => {
    for (const e of CHANGELOG_ENTRIES) {
      expect(typeof e.version).toBe('string');
      expect(e.version.length).toBeGreaterThan(0);
      expect(typeof e.date).toBe('string');
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(e.changes)).toBe(true);
      expect(e.changes.length).toBeGreaterThan(0);
      e.changes.forEach(c => {
        expect(typeof c).toBe('string');
        expect(c.length).toBeGreaterThan(0);
      });
    }
  });

  it('the newest entry matches the current SAR_VERSION (keeps the changelog in sync with releases)', () => {
    expect(CHANGELOG_ENTRIES[0].version).toBe(SAR_VERSION);
  });

  it('version strings are unique', () => {
    const versions = CHANGELOG_ENTRIES.map(e => e.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('CHANGELOG_URL points at the GitHub repo', () => {
    expect(typeof CHANGELOG_URL).toBe('string');
    expect(CHANGELOG_URL).toMatch(/github\.com\/.+\/SAR-Preflight/);
  });
});
