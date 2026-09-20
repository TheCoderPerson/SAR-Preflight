// Data-proxy canopy routes: /chm2/ serves CHMv2 (z10 quadkeys) and /chm/ keeps
// serving the v1 tiles so older cached app builds keep loading canopy.
import { resolveTarget } from '../../tools/canopy-proxy/worker.js';

const u = (p) => new URL('https://proxy.example' + p);

describe('resolveTarget canopy routes', () => {
  it('/chm2/{quadkey}.tif → CHMv2 upstream', () => {
    const r = resolveTarget(u('/chm2/0230102111.tif'));
    expect(r.target).toBe('https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm/0230102111.tif');
  });

  it('/chm/{quadkey}.tif still → v1 upstream (legacy builds)', () => {
    const r = resolveTarget(u('/chm/023010211.tif'));
    expect(r.target).toBe('https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/023010211.tif');
  });

  it('rejects an empty /chm2/ path', () => {
    expect(resolveTarget(u('/chm2/'))).toBeNull();
  });

  it('other prefixes are unaffected', () => {
    expect(resolveTarget(u('/tfr/download/x.xml')).target).toBe('https://tfr.faa.gov/download/x.xml');
  });
});

// /naipchm/ serves the NAIP-CHM canopy+structure COGs (Univ. of Montana). The
// route is shape-checked: only the dataset's own asset paths may pass through.
describe('resolveTarget /naipchm/ route', () => {
  it('maps a quarter-quad COG path to the rangeland.ntsg.umt.edu upstream', () => {
    const r = resolveTarget(u('/naipchm/2022/10/m_3812001_ne_10_060_20220721_chm.tif'));
    expect(r.target).toBe('https://rangeland.ntsg.umt.edu/data/naip-chm/2022/10/m_3812001_ne_10_060_20220721_chm.tif');
    expect(r.cacheTtl).toBe(604800);
  });

  it('accepts two-date 30 cm names and the manifest JSON', () => {
    expect(resolveTarget(u('/naipchm/2023/17/m_2408002_ne_17_030_20230111_20230530_chm.tif')).target)
      .toBe('https://rangeland.ntsg.umt.edu/data/naip-chm/2023/17/m_2408002_ne_17_030_20230111_20230530_chm.tif');
    expect(resolveTarget(u('/naipchm/2022/10/m_3812001_ne_10_060_20220721_chm_manifest.json')).target)
      .toMatch(/_chm_manifest\.json$/);
  });

  it('rejects anything that is not a dataset asset path', () => {
    expect(resolveTarget(u('/naipchm/'))).toBeNull();
    expect(resolveTarget(u('/naipchm/index.csv'))).toBeNull();
    expect(resolveTarget(u('/naipchm/2022/10/'))).toBeNull();
    expect(resolveTarget(u('/naipchm/2022/10/../../README'))).toBeNull();
    expect(resolveTarget(u('/naipchm/inference-resources/conditioning-data/climate_pca.tif'))).toBeNull();
  });
});
