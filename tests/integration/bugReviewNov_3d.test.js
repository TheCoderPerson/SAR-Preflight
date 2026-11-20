// H9 (Nov 2026 bug review): every sync3d() restyles the 3D map with
// setStyle(…, {diff:true}); build3dStyle() does not list the custom 'vert3d'
// layer, so MapLibre removes it and _ensureVert3dLayer re-adds it, re-running
// onAdd. Without onRemove / onAdd cleanup each sync leaked 8 GL buffers,
// 3 programs and 6 shaders (radar playback syncs every 800 ms).
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { _vert3dMakeLayer } = require('../../sar-preflight.js');

// Fake WebGL context that tracks live objects.
function fakeGl() {
  let n = 0;
  const live = { buffer: new Set(), program: new Set(), shader: new Set() };
  const mk = kind => { const o = { kind, id: ++n }; live[kind].add(o); return o; };
  return {
    live,
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2,
    createShader: () => mk('shader'),
    shaderSource() {}, compileShader() {},
    createProgram: () => mk('program'),
    attachShader() {}, detachShader() {}, linkProgram() {},
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    createBuffer: () => mk('buffer'),
    getExtension: () => null,
    deleteBuffer: o => live.buffer.delete(o),
    deleteProgram: o => live.program.delete(o),
    deleteShader: o => live.shader.delete(o),
  };
}

describe('H9 vert3d custom layer frees its GL objects', () => {
  it('releases shaders right after linking', () => {
    const gl = fakeGl();
    _vert3dMakeLayer().onAdd(null, gl);
    expect(gl.live.shader.size).toBe(0);
    expect(gl.live.program.size).toBe(3);
    expect(gl.live.buffer.size).toBe(8);
  });

  it('onRemove deletes every buffer and program it created', () => {
    const gl = fakeGl();
    const layer = _vert3dMakeLayer();
    layer.onAdd(null, gl);
    layer.onRemove(null, gl);
    expect(gl.live.buffer.size).toBe(0);
    expect(gl.live.program.size).toBe(0);
  });

  it('repeated remove/re-add (one per sync3d) does not accumulate GL objects', () => {
    const gl = fakeGl();
    const layer = _vert3dMakeLayer();
    for (let i = 0; i < 50; i++) { layer.onAdd(null, gl); layer.onRemove(null, gl); }
    layer.onAdd(null, gl);
    expect(gl.live.buffer.size).toBe(8);
    expect(gl.live.program.size).toBe(3);
    expect(gl.live.shader.size).toBe(0);
  });

  it('a re-add without onRemove still frees the previous set', () => {
    const gl = fakeGl();
    const layer = _vert3dMakeLayer();
    layer.onAdd(null, gl);
    layer.onAdd(null, gl);
    expect(gl.live.buffer.size).toBe(8);
    expect(gl.live.program.size).toBe(3);
  });

  it('never deletes objects through a different (new map) context', () => {
    const gl1 = fakeGl(), gl2 = fakeGl();
    const layer = _vert3dMakeLayer();
    layer.onAdd(null, gl1);
    const del = vi.spyOn(gl2, 'deleteBuffer');
    layer.onAdd(null, gl2); // a fresh 3D map: the old context is gone
    expect(del).not.toHaveBeenCalled();
    expect(gl2.live.buffer.size).toBe(8);
  });
});
