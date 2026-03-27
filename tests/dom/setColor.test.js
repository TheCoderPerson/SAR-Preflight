const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { setColor } = require('../../sar-preflight.js');

describe('setColor(id, level)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <span id="indicator" class="existing-class"></span>
      <span id="precolored" class="red"></span>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('adds "green" class to the element', () => {
    setColor('indicator', 'green');
    expect(document.getElementById('indicator').classList.contains('green')).toBe(true);
  });

  it('adds "amber" class to the element', () => {
    setColor('indicator', 'amber');
    expect(document.getElementById('indicator').classList.contains('amber')).toBe(true);
  });

  it('adds "red" class to the element', () => {
    setColor('indicator', 'red');
    expect(document.getElementById('indicator').classList.contains('red')).toBe(true);
  });

  it('adds "cyan" class to the element', () => {
    setColor('indicator', 'cyan');
    expect(document.getElementById('indicator').classList.contains('cyan')).toBe(true);
  });

  it('removes amber, red, cyan when setting green', () => {
    const el = document.getElementById('indicator');
    el.classList.add('amber', 'red', 'cyan');
    setColor('indicator', 'green');
    expect(el.classList.contains('green')).toBe(true);
    expect(el.classList.contains('amber')).toBe(false);
    expect(el.classList.contains('red')).toBe(false);
    expect(el.classList.contains('cyan')).toBe(false);
  });

  it('removes green, amber, cyan when setting red', () => {
    const el = document.getElementById('indicator');
    el.classList.add('green', 'amber', 'cyan');
    setColor('indicator', 'red');
    expect(el.classList.contains('red')).toBe(true);
    expect(el.classList.contains('green')).toBe(false);
    expect(el.classList.contains('amber')).toBe(false);
    expect(el.classList.contains('cyan')).toBe(false);
  });

  it('switches from red to green correctly', () => {
    setColor('precolored', 'green');
    const el = document.getElementById('precolored');
    expect(el.classList.contains('green')).toBe(true);
    expect(el.classList.contains('red')).toBe(false);
  });

  it('switches from green to amber correctly', () => {
    setColor('indicator', 'green');
    setColor('indicator', 'amber');
    const el = document.getElementById('indicator');
    expect(el.classList.contains('amber')).toBe(true);
    expect(el.classList.contains('green')).toBe(false);
  });

  it('preserves non-color classes', () => {
    setColor('indicator', 'green');
    expect(document.getElementById('indicator').classList.contains('existing-class')).toBe(true);
  });

  it('graceful on missing element (no throw)', () => {
    expect(() => setColor('nonexistent', 'green')).not.toThrow();
  });

  it('does not create element when id is missing', () => {
    setColor('nonexistent', 'red');
    expect(document.getElementById('nonexistent')).toBeNull();
  });

  it('can be called multiple times in sequence', () => {
    setColor('indicator', 'green');
    setColor('indicator', 'red');
    setColor('indicator', 'amber');
    const el = document.getElementById('indicator');
    expect(el.classList.contains('amber')).toBe(true);
    expect(el.classList.contains('green')).toBe(false);
    expect(el.classList.contains('red')).toBe(false);
  });
});
