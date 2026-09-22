// BUG-07 regression: the single-file build must still ship every file the
// inlined app fetches at runtime (version.js, the NAIP-CHM index, CHANGELOG.md),
// so a dist-only host can answer the update check and NAIP canopy lookups.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

describe('build.js output contract', () => {
  let out;
  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'sar-build-'));
    execFileSync(process.execPath, [path.join(ROOT, 'build.js')], {
      cwd: ROOT, env: { ...process.env, SAR_BUILD_OUT: out }, stdio: 'pipe',
    });
  }, 60000);
  afterAll(() => { if (out) fs.rmSync(out, { recursive: true, force: true }); });

  it('emits version.js with the source version', () => {
    const { SAR_VERSION } = require(path.join(ROOT, 'version.js'));
    const v = fs.readFileSync(path.join(out, 'version.js'), 'utf8');
    expect(v).toContain(`SAR_VERSION = '${SAR_VERSION}'`);
  });

  it('emits the full NAIP-CHM block index tree', () => {
    const src = fs.readdirSync(path.join(ROOT, 'data', 'naipchm')).sort();
    const dst = fs.readdirSync(path.join(out, 'data', 'naipchm')).sort();
    expect(dst).toEqual(src);
    const block = JSON.parse(fs.readFileSync(path.join(out, 'data', 'naipchm', '38120.json'), 'utf8'));
    expect(block.e && typeof block.e).toBe('object');
    expect(Object.keys(block.e).length).toBeGreaterThan(0);
  });

  it('emits CHANGELOG.md for the update prompt', () => {
    expect(fs.readFileSync(path.join(out, 'CHANGELOG.md'), 'utf8')).toMatch(/^# Changelog/);
  });

  it('lists version.js in the dist service-worker app shell', () => {
    const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    expect(sw).toMatch(/const APP_SHELL = \[[^\]]*'\.\/version\.js'/);
  });

  it('the inline script is not cut short by a "</script" inside the code', () => {
    const html = fs.readFileSync(path.join(out, 'sar-preflight.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const app = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
    // Functions from the end of sar-preflight.js — a truncated script still
    // parses, so presence (not parsing) is what proves it is complete.
    expect(app).toContain('function _naipIndexForBlock');
    expect(app).toContain('function fetchCanopyRaster');
    const srcLines = fs.readFileSync(path.join(ROOT, 'sar-preflight.js'), 'utf8').split(/\r?\n/);
    const cjs = srcLines.findIndex(l => /\/\/\s*---\s*CJS export/.test(l));
    const lastCode = srcLines.slice(0, cjs).map(l => l.trim()).filter(Boolean).pop();
    expect(app).toContain(lastCode.replace(/<\/script/gi, '<\\/script'));
  });

  it('dist HTML inline script and dist sw.js still parse', () => {
    const html = fs.readFileSync(path.join(out, 'sar-preflight.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const app = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
    expect(app.length).toBeGreaterThan(100000);
    expect(() => new Function(app)).not.toThrow();
    expect(() => new Function(fs.readFileSync(path.join(out, 'sw.js'), 'utf8'))).not.toThrow();
  });
});
