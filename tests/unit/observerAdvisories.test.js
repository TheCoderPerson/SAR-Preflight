const { sunGlareWindows, formatSectorRanges, glareMaxElevation, GLARE_CONE_DEG } = require('../../sar-preflight-core.js');
const { computeBackdropSectors, computeHorizonProfile, observerKmlDescription, makeGrid, latLngToCell } = require('../../sar-preflight-raster.js');

describe('sunGlareWindows', () => {
  // Local midnight PDT for a fixed summer day at the default map center.
  const day = new Date('2026-07-20T07:00:00Z');
  const LAT = 38.7, LNG = -120.9;

  it('finds a morning (east) and an evening (west) low-sun window', () => {
    const w = sunGlareWindows(LAT, LNG, day);
    expect(w.length).toBe(2);
    expect(w[0].start.getTime()).toBeLessThan(w[0].end.getTime());
    expect(w[0].azStart).toBeGreaterThan(45);   // morning sun rises in the NE–E
    expect(w[0].azStart).toBeLessThan(110);
    expect(w[1].azEnd).toBeGreaterThan(250);    // evening sun sets in the W–NW
    expect(w[1].azEnd).toBeLessThan(315);
  });

  it('maxElDeg 90 collapses to a single sunrise-to-sunset window', () => {
    const w = sunGlareWindows(LAT, LNG, day, { maxElDeg: 90 });
    expect(w.length).toBe(1);
  });

  it('returns [] for an invalid start date', () => {
    expect(sunGlareWindows(LAT, LNG, 'not a date')).toEqual([]);
  });

  it('a terrain horizon blocking the east kills the morning window but not the evening', () => {
    // 120 bins of 3°; a 35° ridge across the whole eastern half — higher than
    // the 30° glare ceiling, so the sun is never both visible and low there.
    const angles = new Array(120).fill(-90);
    for (let b = Math.round(30 / 3); b <= Math.round(150 / 3); b++) angles[b] = 35;
    const masked = sunGlareWindows(LAT, LNG, day, { horizon: { stepDeg: 3, angles } });
    const open = sunGlareWindows(LAT, LNG, day);
    expect(open.length).toBe(2);
    expect(masked.length).toBe(1);                    // evening only
    expect(masked[0].azStart).toBeGreaterThan(180);   // west-side window survives
  });

  it('a low eastern ridge delays the morning window start', () => {
    const angles = new Array(120).fill(-90);
    for (let b = Math.round(30 / 3); b <= Math.round(150 / 3); b++) angles[b] = 10; // sun hidden until 10° up
    const masked = sunGlareWindows(LAT, LNG, day, { horizon: { stepDeg: 3, angles } });
    const open = sunGlareWindows(LAT, LNG, day);
    expect(masked.length).toBe(2);
    expect(masked[0].start.getTime()).toBeGreaterThan(open[0].start.getTime());
    expect(masked[1].end.getTime()).toBe(open[1].end.getTime()); // west end untouched
  });
});

describe('glareMaxElevation', () => {
  const ftM = ft => ft * 0.3048;

  it('default profile (200 ft AGL / 2500 ft VLOS) lands near the classic 30°', () => {
    // atan(61 m / (0.316 × 762 m)) ≈ 14.2° + 15° cone ≈ 29°
    expect(glareMaxElevation(ftM(200), ftM(2500))).toBeCloseTo(14.2 + GLARE_CONE_DEG, 0);
  });

  it('rises with AGL and falls with VLOS range (drone appears higher/lower)', () => {
    const base = glareMaxElevation(ftM(200), ftM(2500));
    expect(glareMaxElevation(ftM(400), ftM(2500))).toBeGreaterThan(base);
    expect(glareMaxElevation(ftM(200), ftM(5000))).toBeLessThan(base);
  });

  it('clamps to 20–60° and falls back to 30 on bad input', () => {
    expect(glareMaxElevation(ftM(5), ftM(5000))).toBe(20);   // implausibly low profile
    expect(glareMaxElevation(ftM(400), ftM(300))).toBe(60);  // near-overhead-only flying
    expect(glareMaxElevation(0, 0)).toBe(30);
    expect(glareMaxElevation(NaN, ftM(2500))).toBe(30);
  });
});

describe('formatSectorRanges', () => {
  const flags = idx => { const f = new Array(16).fill(false); idx.forEach(i => { f[i] = true; }); return f; };

  it('empty / none → empty string', () => {
    expect(formatSectorRanges([])).toBe('');
    expect(formatSectorRanges(new Array(16).fill(false))).toBe('');
  });

  it('all sectors → "all directions"', () => {
    expect(formatSectorRanges(new Array(16).fill(true))).toBe('all directions');
  });

  it('a contiguous run renders as a range, a single sector as its name', () => {
    expect(formatSectorRanges(flags([2, 3, 4]))).toBe('NE–E');
    expect(formatSectorRanges(flags([8]))).toBe('S');
  });

  it('handles wraparound through north and disjoint runs', () => {
    expect(formatSectorRanges(flags([15, 0, 1]))).toBe('NNW–NNE');
    expect(formatSectorRanges(flags([2, 3, 4, 8]))).toBe('NE–E, S');
  });
});

describe('computeBackdropSectors', () => {
  // 1.6 km grid, 10 m cells, flat ground at 0 m; observer at the center.
  const mk = () => {
    const grid = makeGrid(38.7, -120.9, 800, 10);
    const n = grid.rows * grid.cols;
    const obs = latLngToCell(grid, 38.7, -120.9);
    return { grid, n, obs, dem: new Float32Array(n), dsm: new Float32Array(n) };
  };

  it('flat terrain → sky backdrop everywhere (all fractions 0)', () => {
    const { grid, obs, dem, dsm } = mk();
    const fr = computeBackdropSectors({ grid, dem, dsm, obsCol: obs.col, obsRow: obs.row, aglM: 60, vlosRangeM: 700 });
    expect(fr.length).toBe(16);
    expect(Math.max(...fr)).toBe(0);
  });

  it('a tall wall east of the observer backdrops the east sector only', () => {
    const { grid, obs, dem, dsm } = mk();
    for (let row = 0; row < grid.rows; row++) {
      for (let col = grid.cols - 8; col < grid.cols; col++) dsm[row * grid.cols + col] = 1000;
    }
    const fr = computeBackdropSectors({ grid, dem, dsm, obsCol: obs.col, obsRow: obs.row, aglM: 60, vlosRangeM: 700 });
    expect(fr[4]).toBeGreaterThan(0.5);  // sector 4 = East — drone below the wall's skyline
    expect(fr[12]).toBe(0);              // sector 12 = West — open sky
    expect(fr[0]).toBe(0);               // North ray never crosses the wall
  });

  it('returns null when the observer ground elevation is unknown', () => {
    const { grid, obs, dem, dsm } = mk();
    dem[obs.row * grid.cols + obs.col] = NaN;
    expect(computeBackdropSectors({ grid, dem, dsm, obsCol: obs.col, obsRow: obs.row, aglM: 60, vlosRangeM: 700 })).toBeNull();
  });

  it('a far-horizon seed backdrops flat terrain against a mountain beyond the grid', () => {
    const { grid, obs, dem, dsm } = mk();
    const far = new Array(16).fill(-90);
    far[12] = 40; // 40° skyline west of the grid edge (mountainside past VLOS)
    const fr = computeBackdropSectors({ grid, dem, dsm, obsCol: obs.col, obsRow: obs.row, aglM: 60, vlosRangeM: 700, farHorizonDeg: far });
    // Drone at 60 m AGL appears below 40° beyond ~70 m out → most of the ray.
    expect(fr[12]).toBeGreaterThan(0.5);
    expect(fr[4]).toBe(0); // east unaffected
  });

  it('with a viewshed mask, only positions where the drone is visible count', () => {
    const { grid, obs, dem, dsm, n } = mk();
    const far = new Array(16).fill(-90);
    far[12] = 40;
    // Drone only visible within ~60 m of the observer (close-in, high-angle).
    const mask = new Uint8Array(n);
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const dc = (col - obs.col) * grid.resM, dr = (row - obs.row) * grid.resM;
        if (Math.hypot(dc, dr) <= 60) mask[row * grid.cols + col] = 1;
      }
    }
    const fr = computeBackdropSectors({ grid, dem, dsm, obsCol: obs.col, obsRow: obs.row, aglM: 60, vlosRangeM: 700, farHorizonDeg: far, mask });
    // The visible positions all sit ABOVE the 40° far skyline → sky backdrop.
    expect(fr[12]).toBe(0);
  });
});

describe('computeHorizonProfile', () => {
  it('flat terrain → horizon at or below eye level in every bin', () => {
    const grid = makeGrid(38.7, -120.9, 2000, 40);
    const dem = new Float32Array(grid.rows * grid.cols);
    const hor = computeHorizonProfile(grid, dem, 38.7, -120.9);
    expect(hor.stepDeg).toBe(3);
    expect(hor.angles.length).toBe(120);
    expect(Math.max(...hor.angles)).toBeLessThanOrEqual(0);
  });

  it('a tall eastern ridge raises only the eastern horizon bins', () => {
    const grid = makeGrid(38.7, -120.9, 2000, 40);
    const dem = new Float32Array(grid.rows * grid.cols);
    for (let row = 0; row < grid.rows; row++) {
      for (let col = grid.cols - 6; col < grid.cols; col++) dem[row * grid.cols + col] = 800;
    }
    const hor = computeHorizonProfile(grid, dem, 38.7, -120.9);
    expect(hor.angles[Math.round(90 / 3)]).toBeGreaterThan(15); // east: atan(800/~1900 m)
    expect(hor.angles[Math.round(270 / 3)]).toBeLessThanOrEqual(0); // west stays flat
  });

  it('returns null when the observer ground is unknown', () => {
    const grid = makeGrid(38.7, -120.9, 2000, 40);
    const dem = new Float32Array(grid.rows * grid.cols).fill(NaN);
    expect(computeHorizonProfile(grid, dem, 38.7, -120.9)).toBeNull();
  });

  it('minDistM ignores terrain nearer than the cutoff (beyond-grid skyline)', () => {
    const grid = makeGrid(38.7, -120.9, 2000, 40);
    const dem = new Float32Array(grid.rows * grid.cols);
    // Tall wall ~300 m east of the observer — inside a 800 m cutoff.
    const wallCol = latLngToCell(grid, 38.7, -120.9 + 300 / grid.mPerDegLng).col;
    for (let row = 0; row < grid.rows; row++) {
      for (let col = wallCol; col < wallCol + 3; col++) dem[row * grid.cols + col] = 500;
    }
    const near = computeHorizonProfile(grid, dem, 38.7, -120.9);
    const beyond = computeHorizonProfile(grid, dem, 38.7, -120.9, undefined, 3, 800);
    const eastBin = Math.round(90 / 3);
    expect(near.angles[eastBin]).toBeGreaterThan(30);       // wall dominates
    expect(beyond.angles[eastBin]).toBeLessThanOrEqual(0);  // wall skipped
  });
});

describe('observerKmlDescription advisories', () => {
  const rec = {
    name: 'LZ-1', observer: { lat: 38.7, lng: -120.9 }, aglFt: 200, vlosFt: 2500,
    grid: {}, mask: new Uint8Array(1), coverage: 0.73, demSource: '3DEP ~3 m', computedAt: 0,
  };
  it('includes glare and backdrop lines when supplied', () => {
    const desc = observerKmlDescription(rec, { glareText: '06:10–08:30 brg 050°–100°', backdropText: 'NE–E' });
    expect(desc).toContain('Sun glare (export day): 06:10–08:30 brg 050°–100°');
    expect(desc).toContain('Terrain backdrop toward NE–E');
  });
  it('omits them without extras', () => {
    const desc = observerKmlDescription(rec);
    expect(desc).not.toContain('Sun glare');
    expect(desc).not.toContain('Terrain backdrop');
  });
});
