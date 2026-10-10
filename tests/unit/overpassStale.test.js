// Overpass answers built on out-of-date map data (osm3s.timestamp_osm_base):
// a mirror was found serving OpenStreetMap three months old (Oct 2026).
const { overpassDataTimestamp, overpassDataIsStale, OVERPASS_STALE_MAX_MS,
  buildSectionMetaLine, rollupSources } = require('../../sar-preflight-core.js');

const NOW = Date.parse('2026-10-09T20:00:00Z');
const base = iso => ({ elements: [], osm3s: { timestamp_osm_base: iso } });

describe('overpassDataTimestamp / overpassDataIsStale', () => {
  it('reads the server data timestamp', () => {
    expect(overpassDataTimestamp(base('2026-07-15T15:22:01Z'))).toBe(Date.parse('2026-07-15T15:22:01Z'));
  });
  it('an answer older than the limit is stale; a current one is not', () => {
    expect(overpassDataIsStale(base('2026-07-15T15:22:01Z'), NOW)).toBe(true);
    expect(overpassDataIsStale(base('2026-10-09T19:58:00Z'), NOW)).toBe(false);
    expect(overpassDataIsStale(base(new Date(NOW - OVERPASS_STALE_MAX_MS + 60000).toISOString()), NOW)).toBe(false);
  });
  it('an answer with no timestamp is not judged stale', () => {
    expect(overpassDataTimestamp({ elements: [] })).toBeNull();
    expect(overpassDataIsStale({ elements: [] }, NOW)).toBe(false);
    expect(overpassDataIsStale(base('not a date'), NOW)).toBe(false);
  });
});

describe('freshness line for out-of-date OSM data', () => {
  const asOf = Date.parse('2026-07-15T12:00:00Z');
  it('says what the date is instead of "Cached"', () => {
    const line = buildSectionMetaLine({ status: 'cached', cachedAt: asOf, cachedLabel: 'OSM data from', error: 'why' }, NOW, 'UTC');
    expect(line.text).toMatch(/^OSM data from Jul 15/);
    expect(line.tone).toBe('cached');
    expect(line.title).toBe('why');
  });
  it('a rollup carries the label and note of its oldest cached piece', () => {
    const r = rollupSources({
      wire: { status: 'cached', cachedAt: asOf, cachedLabel: 'OSM data from', error: 'old map data' },
      dof: { status: 'live', updatedAt: NOW },
    }, NOW);
    const line = buildSectionMetaLine(r, NOW, 'UTC');
    expect(line.text).toMatch(/^OSM data from Jul 15/);
    expect(line.title).toBe('old map data');
  });
  it('a plain cached rollup still reads "Cached"', () => {
    const r = rollupSources({ wire: { status: 'cached', cachedAt: asOf } }, NOW);
    expect(buildSectionMetaLine(r, NOW, 'UTC').text).toMatch(/^Cached /);
  });
});
