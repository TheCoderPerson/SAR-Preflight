const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

globalThis.L = { map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn() };

const { switchTab, S } = require('../../sar-preflight.js');

describe('switchTab(tab)', () => {
  beforeEach(() => {
    // Reset S.currentArea and S.activeTab
    S.currentArea = null;
    S.activeTab = 'wx';

    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();

    document.body.innerHTML = `
      <div id="tabNav">
        <button class="tab-btn" data-tab="wx">Weather</button>
        <button class="tab-btn" data-tab="wind">Wind</button>
        <button class="tab-btn" data-tab="terrain">Terrain</button>
        <button class="tab-btn" data-tab="airspace">Airspace</button>
        <button class="tab-btn" data-tab="astro">Astro</button>
        <button class="tab-btn" data-tab="ops">Ops</button>
      </div>
      <div id="tab-wx" class="tab-panel" style="display: none;">Weather Panel</div>
      <div id="tab-wind" class="tab-panel" style="display: none;">Wind Panel</div>
      <div id="tab-terrain" class="tab-panel" style="display: none;">Terrain Panel</div>
      <div id="tab-airspace" class="tab-panel" style="display: none;">Airspace Panel</div>
      <div id="tab-astro" class="tab-panel" style="display: none;">Astro Panel</div>
      <div id="tab-ops" class="tab-panel" style="display: none;">Ops Panel</div>
      <div id="noAreaState" style="display: none;">No area selected</div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('updates S.activeTab to the given tab name', () => {
    switchTab('wind');
    expect(S.activeTab).toBe('wind');
  });

  it('activates the correct tab button', () => {
    switchTab('terrain');
    const btn = document.querySelector('.tab-btn[data-tab="terrain"]');
    expect(btn.classList.contains('active')).toBe(true);
  });

  it('deactivates all other tab buttons', () => {
    // First activate wx
    switchTab('wx');
    // Then switch to wind
    switchTab('wind');
    const wxBtn = document.querySelector('.tab-btn[data-tab="wx"]');
    const windBtn = document.querySelector('.tab-btn[data-tab="wind"]');
    expect(wxBtn.classList.contains('active')).toBe(false);
    expect(windBtn.classList.contains('active')).toBe(true);
  });

  it('shows the correct panel', () => {
    switchTab('airspace');
    const panel = document.getElementById('tab-airspace');
    expect(panel.style.display).toBe('');
  });

  it('hides all other panels', () => {
    switchTab('airspace');
    const wxPanel = document.getElementById('tab-wx');
    const windPanel = document.getElementById('tab-wind');
    const terrainPanel = document.getElementById('tab-terrain');
    expect(wxPanel.style.display).toBe('none');
    expect(windPanel.style.display).toBe('none');
    expect(terrainPanel.style.display).toBe('none');
  });

  it('shows noAreaState when no area is selected (S.currentArea is null)', () => {
    S.currentArea = null;
    switchTab('wx');
    expect(document.getElementById('noAreaState').style.display).toBe('');
  });

  it('hides noAreaState when area is selected', () => {
    S.currentArea = { some: 'layer' };
    switchTab('wx');
    expect(document.getElementById('noAreaState').style.display).toBe('none');
  });

  it('switching tabs with area selected hides noAreaState', () => {
    S.currentArea = { some: 'layer' };
    switchTab('wind');
    switchTab('terrain');
    expect(document.getElementById('noAreaState').style.display).toBe('none');
  });

  it('switches through all tabs correctly', () => {
    const tabs = ['wx', 'wind', 'terrain', 'airspace', 'astro', 'ops'];
    tabs.forEach(tab => {
      switchTab(tab);
      expect(S.activeTab).toBe(tab);
      const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
      expect(btn.classList.contains('active')).toBe(true);
      expect(document.getElementById(`tab-${tab}`).style.display).toBe('');

      // All other panels hidden
      tabs.filter(t => t !== tab).forEach(other => {
        expect(document.getElementById(`tab-${other}`).style.display).toBe('none');
      });
    });
  });

  it('only one tab button is active at a time', () => {
    switchTab('ops');
    const activeButtons = document.querySelectorAll('.tab-btn.active');
    expect(activeButtons.length).toBe(1);
    expect(activeButtons[0].dataset.tab).toBe('ops');
  });

  it('only one panel is visible at a time (when area exists)', () => {
    S.currentArea = { some: 'layer' };
    switchTab('astro');
    const panels = document.querySelectorAll('.tab-panel');
    const visible = Array.from(panels).filter(p => p.style.display !== 'none');
    expect(visible.length).toBe(1);
    expect(visible[0].id).toBe('tab-astro');
  });
});
