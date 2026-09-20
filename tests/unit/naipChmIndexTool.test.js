// tools/naip-chm-index/build.mjs — the CSV → per-block JSON index builder.
import { parseIndexRow, quarterQuadBounds, buildIndex } from '../../tools/naip-chm-index/build.mjs';

const HEADER = 'system:index,acquisition_date,chm_gcs_uri,chm_url,metadata_gcs_uri,metadata_url,quad_id,quarter,scale_factor,source_doqq,utm_zone,year,.geo';
const row = (doqq, quad, qq, zone, year) =>
  `${doqq}_chm,2022-07-21,gs://naip-chm-assets/x,http://rangeland.ntsg.umt.edu/x,gs://y,http://y,${quad},${qq},100.0,${doqq},${zone}.0,${year}.0,"{""type"":""Polygon"",""coordinates"":[[[-80.7,24.9],[-80.7,25.0]]]}"`;

describe('parseIndexRow', () => {
  it('parses a 60 cm single-date row (float zone/year, quoted .geo with commas)', () => {
    const r = parseIndexRow(row('m_3812001_ne_10_060_20220721', '3812001', 'ne', 10, 2022));
    expect(r).toMatchObject({ block: '38120', key: '01ne', value: '2022/10_060_20220721', year: 2022, zone: 10, quadId: '3812001', quarter: 'ne' });
  });

  it('keeps a two-date 30 cm tail verbatim and accepts the letter resolution code', () => {
    expect(parseIndexRow(row('m_2408002_ne_17_030_20230111_20230530', '2408002', 'ne', 17, 2023)).value).toBe('2023/17_030_20230111_20230530');
    expect(parseIndexRow(row('m_3411701_ne_11_h_20160703', '3411701', 'ne', 11, 2016)).value).toBe('2016/11_h_20160703');
  });

  it('returns null for the header, blanks and rows whose source_doqq does not match the quad', () => {
    expect(parseIndexRow(HEADER)).toBeNull();
    expect(parseIndexRow('')).toBeNull();
    expect(parseIndexRow(row('m_9999999_sw_10_060_20220721', '3812001', 'ne', 10, 2022))).toBeNull();
  });
});

describe('quarterQuadBounds', () => {
  it('matches the app-side numbering (row-major from the NW corner)', () => {
    expect(quarterQuadBounds('3812001', 'nw')).toEqual({ west: -121, south: 38.9375, east: -120.9375, north: 39 });
    expect(quarterQuadBounds('3812064', 'se')).toEqual({ west: -120.0625, south: 38, east: -120, north: 38.0625 });
  });
});

describe('buildIndex', () => {
  async function* lines(arr) { for (const l of arr) yield l; }

  it('groups by block, keeps the newest year for a duplicated quarter-quad, and honours a bbox', async () => {
    const built = await buildIndex({ lines: lines([
      HEADER,
      row('m_3812001_ne_10_060_20220721', '3812001', 'ne', 10, 2022),
      row('m_3812017_sw_10_060_20220709', '3812017', 'sw', 10, 2022),
      row('m_2408124_sw_17_060_20211207', '2408124', 'sw', 17, 2021),
      row('m_2408124_sw_17_030_20230110_20230530', '2408124', 'sw', 17, 2023),
    ]) });
    expect(built.rows).toBe(5);
    expect(built.kept).toBe(4);
    expect(built.skipped).toBe(0);
    expect([...built.blocks.keys()].sort()).toEqual(['24081', '38120']);
    expect(built.blocks.get('38120').get('17sw').value).toBe('2022/10_060_20220709');
    expect(built.blocks.get('24081').get('24sw').value).toBe('2023/17_030_20230110_20230530'); // 2023 beats 2021

    const ca = await buildIndex({ lines: lines([
      row('m_3812001_ne_10_060_20220721', '3812001', 'ne', 10, 2022),
      row('m_2408124_sw_17_060_20211207', '2408124', 'sw', 17, 2021),
    ]), bbox: { west: -125, south: 32, east: -114, north: 42 } });
    expect([...ca.blocks.keys()]).toEqual(['38120']);
  });
});
