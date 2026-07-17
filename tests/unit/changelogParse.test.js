const { parseChangelogMd, CHANGELOG_ENTRIES } = require('../../sar-preflight-core.js');

// Mirror of the CHANGELOG.md generator in build.js.
function generateMd(entries) {
  const md = [
    '# Changelog', '',
    'All notable changes to the SAR UAS Pre-Flight Intelligence Tool, newest first.',
    '',
    '> Generated from `CHANGELOG_ENTRIES` in `sar-preflight-core.js` by `build.js` — edit there, not here.',
    '',
  ];
  for (const e of entries) {
    md.push(`## v${e.version} — ${e.date}`, '');
    for (const c of e.changes) md.push(`- ${c}`);
    md.push('');
  }
  return md.join('\n');
}

const SAMPLE = [
  { version: '2026.07.20-b', date: '2026-07-20', changes: ['Newest change A', 'Newest change B'] },
  { version: '2026.07.20', date: '2026-07-20', changes: ['Middle change'] },
  { version: '2026.07.17-b', date: '2026-07-17', changes: ['Old change'] },
];

describe('parseChangelogMd', () => {
  it('round-trips the build.js CHANGELOG.md format', () => {
    const parsed = parseChangelogMd(generateMd(SAMPLE), null);
    expect(parsed).toEqual(SAMPLE);
  });

  it('round-trips the real CHANGELOG_ENTRIES', () => {
    const parsed = parseChangelogMd(generateMd(CHANGELOG_ENTRIES), null);
    expect(parsed).toEqual(CHANGELOG_ENTRIES);
  });

  it('stops at sinceVersion (exclusive) — returns only newer entries', () => {
    const parsed = parseChangelogMd(generateMd(SAMPLE), '2026.07.17-b');
    expect(parsed.map(e => e.version)).toEqual(['2026.07.20-b', '2026.07.20']);
    expect(parsed[0].changes).toEqual(['Newest change A', 'Newest change B']);
  });

  it('returns everything when sinceVersion is not found (running version very old)', () => {
    const parsed = parseChangelogMd(generateMd(SAMPLE), '2020.01.01');
    expect(parsed).toHaveLength(3);
  });

  it('returns an empty list when sinceVersion is the newest entry (already up to date)', () => {
    expect(parseChangelogMd(generateMd(SAMPLE), '2026.07.20-b')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const parsed = parseChangelogMd(generateMd(SAMPLE).replace(/\n/g, '\r\n'), '2026.07.17-b');
    expect(parsed).toHaveLength(2);
    expect(parsed[1].changes).toEqual(['Middle change']);
  });

  it('tolerates empty/garbage input', () => {
    expect(parseChangelogMd('', null)).toEqual([]);
    expect(parseChangelogMd(null, 'x')).toEqual([]);
    expect(parseChangelogMd('# Changelog\n\nprose only, no headers\n- stray item before any header', null)).toEqual([]);
  });
});
