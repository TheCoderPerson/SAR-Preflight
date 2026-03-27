const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Minimal Leaflet mock
const mockTileLayer = (opts) => ({
  options: { opacity: opts?.opacity ?? 0 },
  setOpacity: vi.fn(function(v) { this.options.opacity = v; }),
  addTo: vi.fn(function() { return this; }),
  remove: vi.fn(),
});

globalThis.L = {
  map: vi.fn(),
  tileLayer: vi.fn((url, opts) => mockTileLayer(opts)),
  control: { zoom: vi.fn() },
  Draw: { Event: {} },
  FeatureGroup: vi.fn(),
  layerGroup: vi.fn(() => ({
    addTo: vi.fn(function() { return this; }),
    clearLayers: vi.fn(),
    addLayer: vi.fn(),
    getLayers: vi.fn(() => []),
  })),
};

const {
  radarToggle, radarStep, updateRadarTime, S,
} = require('../../sar-preflight.js');

describe('Radar Animation Functions', () => {
  let radarPlayBtn, radarTimeEl;

  beforeEach(() => {
    vi.useFakeTimers();

    radarPlayBtn = document.createElement('button');
    radarPlayBtn.id = 'radarPlayBtn';
    document.body.appendChild(radarPlayBtn);

    radarTimeEl = document.createElement('span');
    radarTimeEl.id = 'radarTime';
    document.body.appendChild(radarTimeEl);

    // Create mock radar layers
    const frames = [
      { time: Math.floor(Date.now() / 1000) - 600, path: '/v2/radar/frame1' },
      { time: Math.floor(Date.now() / 1000) - 300, path: '/v2/radar/frame2' },
      { time: Math.floor(Date.now() / 1000), path: '/v2/radar/frame3' },
    ];

    const layers = frames.map(() => {
      const layer = mockTileLayer({ opacity: 0 });
      return layer;
    });

    // Mock S.map
    S.map = {
      hasLayer: vi.fn(() => true),
      addLayer: vi.fn(),
      removeLayer: vi.fn(),
    };

    S.radarAnim = {
      playing: false,
      index: 2, // start at last frame
      layers: layers,
      interval: null,
      frames: frames,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    S.radarAnim = null;
    S.map = null;
  });

  describe('radarStep(dir)', () => {
    it('steps forward by 1', () => {
      S.radarAnim.index = 0;
      radarStep(1);
      expect(S.radarAnim.index).toBe(1);
    });

    it('steps backward by 1', () => {
      S.radarAnim.index = 2;
      radarStep(-1);
      expect(S.radarAnim.index).toBe(1);
    });

    it('wraps around forward', () => {
      S.radarAnim.index = 2;
      radarStep(1);
      expect(S.radarAnim.index).toBe(0);
    });

    it('wraps around backward', () => {
      S.radarAnim.index = 0;
      radarStep(-1);
      expect(S.radarAnim.index).toBe(2);
    });

    it('hides old frame and shows new frame', () => {
      S.radarAnim.index = 1;
      radarStep(1);
      expect(S.radarAnim.layers[1].setOpacity).toHaveBeenCalledWith(0);
      expect(S.radarAnim.layers[2].setOpacity).toHaveBeenCalledWith(0.5);
    });

    it('does nothing if radarAnim is null', () => {
      S.radarAnim = null;
      expect(() => radarStep(1)).not.toThrow();
    });

    it('does nothing if layers is empty', () => {
      S.radarAnim.layers = [];
      expect(() => radarStep(1)).not.toThrow();
    });
  });

  describe('radarToggle()', () => {
    it('starts playback when not playing', () => {
      S.radarAnim.playing = false;
      radarToggle();
      expect(S.radarAnim.playing).toBe(true);
      expect(S.radarAnim.interval).not.toBeNull();
    });

    it('stops playback when playing', () => {
      S.radarAnim.playing = false;
      radarToggle(); // start
      expect(S.radarAnim.playing).toBe(true);
      radarToggle(); // stop
      expect(S.radarAnim.playing).toBe(false);
      expect(S.radarAnim.interval).toBeNull();
    });

    it('updates play button to pause symbol when playing', () => {
      S.radarAnim.playing = false;
      radarToggle();
      // innerHTML decodes entities to unicode: &#9646; -> \u2586 (but innerHTML returns the rendered chars)
      expect(radarPlayBtn.innerHTML).toContain('\u25AE');
    });

    it('updates play button to play symbol when paused', () => {
      S.radarAnim.playing = false;
      radarToggle(); // start
      radarToggle(); // stop
      expect(radarPlayBtn.innerHTML).toContain('\u25B6');
    });

    it('steps through frames when interval fires', () => {
      S.radarAnim.playing = false;
      S.radarAnim.index = 0;
      radarToggle();
      vi.advanceTimersByTime(800);
      expect(S.radarAnim.index).toBe(1);
      vi.advanceTimersByTime(800);
      expect(S.radarAnim.index).toBe(2);
    });

    it('does nothing if radarAnim is null', () => {
      S.radarAnim = null;
      expect(() => radarToggle()).not.toThrow();
    });
  });

  describe('updateRadarTime()', () => {
    it('displays formatted time of current frame', () => {
      updateRadarTime();
      expect(radarTimeEl.textContent).not.toBe('--');
      expect(radarTimeEl.textContent).toMatch(/\d+:\d+/);
    });

    it('shows -- when radarAnim is null', () => {
      S.radarAnim = null;
      updateRadarTime();
      expect(radarTimeEl.textContent).toBe('--');
    });

    it('shows -- when frames is missing', () => {
      S.radarAnim.frames = null;
      updateRadarTime();
      expect(radarTimeEl.textContent).toBe('--');
    });

    it('shows -- when element is missing', () => {
      document.body.innerHTML = '';
      expect(() => updateRadarTime()).not.toThrow();
    });
  });
});
