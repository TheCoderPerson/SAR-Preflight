// Diagnostics module — crash tracing, breadcrumb ring buffer, memory estimate,
// and on-device panel. Verifies the logic that lets us trace an iOS crash with
// no Mac attached.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
globalThis.L = { layerGroup: () => ({ addLayer() {}, clearLayers() {}, getLayers: () => [], addTo() { return this; } }) };

const { Diag } = require('../../sar-preflight.js');

function resetDiag() {
  localStorage.clear();
  Diag._crumbs = [];
  Diag._lastCrash = null;
  Diag._throttle = {};
  Diag.mem = { liveKb: 0, leakedKb: 0, peakKb: 0, byKind: {} };
  Diag.enabled = true;
  Diag.sessionId = null;
  Diag.startedAt = 0;
}

describe('Diag breadcrumbs', () => {
  beforeEach(resetDiag);

  it('note() writes a synchronous crumb to localStorage (survives a kill)', () => {
    Diag.note('test.op', { x: 1 });
    const stored = JSON.parse(localStorage.getItem(Diag.CRUMB_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0].op).toBe('test.op');
    expect(stored[0].d).toEqual({ x: 1 });
    expect(typeof stored[0].t).toBe('number');
  });

  it('ring buffer caps at MAX_CRUMBS', () => {
    for (let i = 0; i < Diag.MAX_CRUMBS + 50; i++) Diag.note('op' + i);
    expect(Diag._crumbs.length).toBe(Diag.MAX_CRUMBS);
    // oldest dropped, newest retained
    expect(Diag._crumbs[Diag._crumbs.length - 1].op).toBe('op' + (Diag.MAX_CRUMBS + 49));
  });

  it('noteThrottled() suppresses repeats within the window', () => {
    const orig = Diag._now;
    let now = 1_000_000; // realistic epoch-scale time so the first call fires
    Diag._now = () => now;
    try {
      Diag.noteThrottled('tile', 1500); // delta huge → fires
      Diag.noteThrottled('tile', 1500); // same instant → suppressed
      now += 1000;                        // +1000ms < 1500 window → suppressed
      Diag.noteThrottled('tile', 1500);
      now += 1000;                        // now +2000ms from last fire → fires
      Diag.noteThrottled('tile', 1500);
      expect(Diag._crumbs.filter(c => c.op === 'tile')).toHaveLength(2);
    } finally {
      Diag._now = orig;
    }
  });
});

describe('Diag memory estimate', () => {
  beforeEach(resetDiag);

  it('alloc/free track live bytes; leak is monotonic', () => {
    Diag.alloc('mask', 256 * 1024);
    expect(Diag.totalKb()).toBeCloseTo(256, 5);
    Diag.free('mask', 256 * 1024);
    expect(Diag.totalKb()).toBeCloseTo(0, 5);
    Diag.leak('blob', 512 * 1024);
    Diag.free('blob', 512 * 1024); // free must NOT reduce the leaked pool
    expect(Diag.mem.leakedKb).toBeCloseTo(512, 5);
  });

  it('peak high-water mark is retained after frees', () => {
    Diag.alloc('a', 4 * 1024 * 1024);
    Diag.free('a', 4 * 1024 * 1024);
    expect(Diag.mem.peakKb).toBeCloseTo(4096, 1);
    expect(Diag.mem.liveKb).toBeCloseTo(0, 5);
  });

  it('heap estimate is stamped into each crumb', () => {
    Diag.leak('blob', 1024 * 1024);
    Diag.note('after.leak');
    const last = Diag._crumbs[Diag._crumbs.length - 1];
    expect(last.heap).toBeCloseTo(1024, 0);
    expect(last.leak).toBeCloseTo(1024, 0);
  });
});

describe('Diag crash detection', () => {
  beforeEach(resetDiag);

  it('flags an ungraceful previous session and snapshots its trail', () => {
    // Simulate a session that died mid-viewshed without a clean pagehide.
    localStorage.setItem(Diag.SESSION_KEY, JSON.stringify({ id: 'old', startedAt: 1, cleanExit: false, peakKb: 90000 }));
    localStorage.setItem(Diag.CRUMB_KEY, JSON.stringify([
      { t: 1, op: 'app.start', heap: 10 },
      { t: 2, op: 'viewshed.start', heap: 40000 },
    ]));
    Diag.init();
    expect(Diag._lastCrash).toBeTruthy();
    expect(Diag._lastCrash.lastOp).toBe('viewshed.start');
    expect(Diag._lastCrash.session.peakKb).toBe(90000);
    // a fresh session is started, marked not-clean
    const sess = JSON.parse(localStorage.getItem(Diag.SESSION_KEY));
    expect(sess.cleanExit).toBe(false);
    expect(sess.id).not.toBe('old');
  });

  it('does NOT flag a cleanly-exited previous session', () => {
    localStorage.setItem(Diag.SESSION_KEY, JSON.stringify({ id: 'old', startedAt: 1, cleanExit: true }));
    localStorage.setItem(Diag.CRUMB_KEY, '[]');
    Diag.init();
    expect(Diag._lastCrash).toBeFalsy();
  });
});

describe('Diag report + panel', () => {
  beforeEach(() => { resetDiag(); document.body.innerHTML = ''; });

  it('report() includes the crash banner and breadcrumbs', () => {
    localStorage.setItem(Diag.SESSION_KEY, JSON.stringify({ id: 'old', startedAt: 1, cleanExit: false, peakKb: 80000, lastTotalKb: 75000 }));
    localStorage.setItem(Diag.CRUMB_KEY, JSON.stringify([{ t: 1, op: 'map.move', heap: 50000, d: { z: 14 } }]));
    Diag.init();
    const txt = Diag.report();
    expect(txt).toMatch(/PREVIOUS SESSION ENDED UNGRACEFULLY/);
    expect(txt).toMatch(/LAST OP BEFORE IT DIED: map\.move/);
    expect(txt).toMatch(/CURRENT SESSION breadcrumbs/);
  });

  it('showPanel() builds the overlay and hidePanel() removes it', () => {
    Diag.showPanel();
    expect(document.getElementById('sarDiagOverlay')).toBeTruthy();
    expect(document.getElementById('sarDiagReport').value).toMatch(/SAR DIAGNOSTICS/);
    Diag.hidePanel();
    expect(document.getElementById('sarDiagOverlay')).toBeFalsy();
  });
});
