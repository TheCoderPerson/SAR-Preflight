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
