// Imagery vegetation classification — pure functions (sar-preflight-raster.js).
//
// This feature turns satellite imagery into canopy edits, and canopy height
// feeds the VLOS viewshed. The errors are NOT symmetric: too much canopy
// shrinks the predicted viewshed (safe), too little inflates it (unsafe). The
// assertions below therefore care much more about what the classifier REFUSES
// to do than about what it does — above all, that a shadowed ("unknown") cell
// is never a delete candidate at any slider setting.
const {
  makeGrid, tileXYBounds,
  imageryMetresPerPixel, imageryZoomForBBox, tileMosaicBounds, analysisLatticeFor,
  vegGreenScore, makeVegAccumulator, accumulateVegTile, finalizeVegAccumulator,
  vegCandidateMask, vegMaskToRGBA,
  maskDilate, maskErode, maskOpen, maskClose, filterMaskMinArea, maskClipToPolygon,
  maskDownsample, packBitMask, bitMaskGet, countMask, cellsToHectares,
  makeCanopyMaskOp, canopyMaskOpValid, canopyApplyMask, canopyRevertDiff,
  canopyOpBBox, canopyApplyOps, canopyOpBytes, canopyOpsBytes,
  VEG_SCORE_T0, VEG_SCORE_HI, VEG_SCORE_LO, VEG_DEL_MIN_FRAC, VEG_LEAN_MARGIN_M,
  vegScoreThresholdForSens, reclaimShadowInVeg, VEG_SHADOW_RECLAIM_FRAC,
} = require('../../sar-preflight-raster.js');
const { pointInPolygon } = require('../../sar-preflight-core.js');

// Representative Sierra-foothill surfaces in summer imagery.
const CONIFER = [60, 80, 45];
const OAK = [85, 105, 65];
const DRY_GRASS = [210, 180, 120];   // annual grass, gold — the hard negative
const DIRT = [190, 165, 130];
const ASPHALT = [140, 140, 140];
const SHADOW = [12, 14, 10];

describe('vegGreenScore', () => {
  it('separates trees from California dry grass at the default threshold', () => {
    expect(vegGreenScore(...CONIFER)).toBeGreaterThan(VEG_SCORE_T0);
    expect(vegGreenScore(...OAK)).toBeGreaterThan(VEG_SCORE_T0);
    expect(vegGreenScore(...DRY_GRASS)).toBeLessThan(VEG_SCORE_T0);
    expect(vegGreenScore(...DIRT)).toBeLessThan(VEG_SCORE_T0);
  });

  // This is the whole reason the blue term is down-weighted to 0.35. Plain
  // Excess Green reduces to 3g-1 (monotone in g alone) and reads dry grass's
  // large BLUE deficit as greenness; the RED excess is what actually separates
  // them. If someone "simplifies" the default back to 1, this fails.
  it('full-weight Excess Green misclassifies dry grass, the default does not', () => {
    expect(vegGreenScore(...DRY_GRASS, 1)).toBeGreaterThan(VEG_SCORE_T0);
    expect(vegGreenScore(...DRY_GRASS)).toBeLessThan(0);
  });

  it('blueWeight 1 reproduces normalized Excess Green (3g - 1) exactly', () => {
    const [R, G, B] = CONIFER;
    const g = G / (R + G + B);
    expect(vegGreenScore(R, G, B, 1)).toBeCloseTo(3 * g - 1, 12);
  });

  it('scores any neutral gray as exactly 0 at every blue weight', () => {
    for (const w of [0, 0.35, 1]) {
      expect(vegGreenScore(...ASPHALT, w)).toBe(0);
      expect(vegGreenScore(30, 30, 30, w)).toBe(0);
    }
  });

  it('returns 0 rather than NaN for a black pixel', () => {
    expect(vegGreenScore(0, 0, 0)).toBe(0);
  });
});

describe('vegScoreThresholdForSens', () => {
  // The centre must BE the calibrated default, so a freshly opened preview is
  // the tuned behaviour and the slider only means "more"/"less" than it.
  it('pins the slider centre to the calibrated default in both directions', () => {
    expect(vegScoreThresholdForSens(50, 'add')).toBeCloseTo(VEG_SCORE_T0, 12);
    expect(vegScoreThresholdForSens(50, 'del')).toBeCloseTo(VEG_SCORE_T0, 12);
  });

  // Higher must always do MORE of the current operation. Because the threshold
  // moves the greenness cut, that requires inverting for CUT — mapping both
  // directions the same way made dragging to max cut LESS.
  it('is monotone in "more effect" for ADD', () => {
    // More painting = lower threshold as the slider rises.
    expect(vegScoreThresholdForSens(100, 'add')).toBeLessThan(vegScoreThresholdForSens(50, 'add'));
    expect(vegScoreThresholdForSens(50, 'add')).toBeLessThan(vegScoreThresholdForSens(0, 'add'));
  });

  it('is monotone in "more effect" for CUT — the opposite threshold direction', () => {
    // More cutting = HIGHER threshold (less counts as vegetation to protect).
    expect(vegScoreThresholdForSens(100, 'del')).toBeGreaterThan(vegScoreThresholdForSens(50, 'del'));
    expect(vegScoreThresholdForSens(50, 'del')).toBeGreaterThan(vegScoreThresholdForSens(0, 'del'));
  });

  it('spans the full range and clamps out-of-range input', () => {
    expect(vegScoreThresholdForSens(0, 'add')).toBeCloseTo(VEG_SCORE_HI, 12);
    expect(vegScoreThresholdForSens(100, 'add')).toBeCloseTo(VEG_SCORE_LO, 12);
    expect(vegScoreThresholdForSens(-40, 'add')).toBeCloseTo(VEG_SCORE_HI, 12);
    expect(vegScoreThresholdForSens(999, 'add')).toBeCloseTo(VEG_SCORE_LO, 12);
  });
});

describe('imageryZoomForBBox', () => {
  const bbox = { west: -120.99, east: -120.985, south: 38.685, north: 38.689 };

  it('picks a zoom fine enough for the canopy cell size', () => {
    const sel = imageryZoomForBBox(bbox, 3, { maxTiles: 64 });
    expect(sel.z).toBe(18);
    expect(imageryMetresPerPixel(sel.z, 38.687)).toBeLessThanOrEqual(3 / 4);
  });

  it('never fetches deeper than what is already on screen', () => {
    expect(imageryZoomForBBox(bbox, 3, { maxTiles: 64, preferZ: 17 }).z).toBe(17);
    // ...but preferZ must not push below the pooling floor or the min zoom.
    expect(imageryZoomForBBox(bbox, 3, { maxTiles: 64, preferZ: 9 }).z).toBe(18);
  });

  // Sampling AT the analysis zoom gives pool 1 — one imagery pixel per analysis
  // cell — which silently degenerates every per-cell fraction: darkFrac goes
  // binary, so one shaded pixel condemns a whole cell. Measured over real
  // conifer forest that marked ~42% of the area unjudgeable.
  it('always samples at least one zoom below the analysis lattice', () => {
    // A coarse canopy grid would otherwise be "satisfied" by the z16 lattice.
    expect(imageryZoomForBBox(bbox, 20, { maxTiles: 64 }).z).toBeGreaterThanOrEqual(17);
    expect(imageryZoomForBBox(bbox, 20, { maxTiles: 64, preferZ: 16 }).z).toBeGreaterThanOrEqual(17);
    const sel = imageryZoomForBBox(bbox, 20, { maxTiles: 64, preferZ: 16 });
    const lat = analysisLatticeFor(tileMosaicBounds(sel.x0, sel.y0, sel.x1, sel.y1, sel.z));
    expect(lat.pool).toBeGreaterThanOrEqual(2);      // >= 4 pixels per analysis cell
  });

  it('steps down until the tile count fits the budget', () => {
    const tight = imageryZoomForBBox(bbox, 3, { maxTiles: 4 });
    const loose = imageryZoomForBBox(bbox, 3, { maxTiles: 64 });
    expect(tight.z).toBeLessThan(loose.z);
    expect(tight.tiles).toBeLessThanOrEqual(4);
  });

  it('returns null when even the minimum zoom is over budget', () => {
    expect(imageryZoomForBBox({ west: -122, east: -119, south: 37, north: 40 }, 3, { maxTiles: 64 })).toBeNull();
  });

  it('reports ~1.86 m per pixel at z16 in El Dorado County', () => {
    expect(imageryMetresPerPixel(16, 38.7)).toBeCloseTo(1.864, 2);
  });
});

describe('tileMosaicBounds', () => {
  const sel = imageryZoomForBBox(
    { west: -120.99, east: -120.985, south: 38.685, north: 38.689 }, 3, { maxTiles: 64 });

  it('agrees exactly with the corner tiles', () => {
    const m = tileMosaicBounds(sel.x0, sel.y0, sel.x1, sel.y1, sel.z);
    const nw = tileXYBounds(sel.x0, sel.y0, sel.z);
    const se = tileXYBounds(sel.x1, sel.y1, sel.z);
    expect(m.west).toBeCloseTo(nw.west, 12);
    expect(m.north).toBeCloseTo(nw.north, 12);
    expect(m.east).toBeCloseTo(se.east, 12);
    expect(m.south).toBeCloseTo(se.south, 12);
  });

  it('spans exactly one tile of Mercator metres per tile', () => {
    const m = tileMosaicBounds(sel.x0, sel.y0, sel.x1, sel.y1, sel.z);
    const perTile = (m.mercEast - m.mercWest) / (sel.x1 - sel.x0 + 1);
    expect(perTile).toBeCloseTo(m.mercPerPx * 256, 6);
    expect(m.pxW).toBe((sel.x1 - sel.x0 + 1) * 256);
  });

  it('yields a z16-aligned analysis lattice with integral dimensions', () => {
    const m = tileMosaicBounds(sel.x0, sel.y0, sel.x1, sel.y1, sel.z);
    const lat = analysisLatticeFor(m);
    expect(lat.pool).toBe(Math.pow(2, m.z - 16));
    expect(Number.isInteger(lat.rows)).toBe(true);
    expect(Number.isInteger(lat.cols)).toBe(true);
    // Finer than WORK_RES_M — the finest grid any op ever replays onto.
    expect(lat.resM).toBeLessThan(3);
  });
});

// A synthetic z18 tile: west half conifer, east half dry grass, the top quarter
// in deep shadow. pool 4 => a 4x4 analysis lattice.
function synthTile(opts) {
  opts = opts || {};
  const TW = 16, TH = 16;
  const rgba = new Uint8ClampedArray(TW * TH * 4);
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      const o = (y * TW + x) * 4;
      let c = x < TW / 2 ? CONIFER : DRY_GRASS;
      if (y < 4) c = SHADOW;
      if (opts.paint) c = opts.paint(x, y) || c;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
      rgba[o + 3] = opts.alpha ? opts.alpha(x, y) : 255;
    }
  }
  return { rgba, TW, TH, pool: 4, rows: 4, cols: 4 };
}

function synthPlanes(opts) {
  const t = synthTile(opts);
  const acc = makeVegAccumulator(t.rows, t.cols);
  accumulateVegTile(acc, t.rgba, t.TW, t.TH, t.pool, 0, 0);
  // radius 1 keeps the texture neighbourhood inside these tiny 4x4 fixtures.
  return finalizeVegAccumulator(acc, Object.assign({ textureRadiusCells: 1 }, opts));
}

const BOUNDS = { west: -121, east: -120.99, south: 38.68, north: 38.69 };
const baseOpts = { bounds: BOUNDS, morphR: 0, insideFn: pointInPolygon };

describe('accumulateVegTile / finalizeVegAccumulator', () => {
  it('counts dark pixels for coverage but never lets them drag the score', () => {
    const planes = synthPlanes();
    expect(planes.darkFrac[0]).toBe(255);        // all-shadow cell
    expect(planes.darkFrac[planes.cols]).toBe(0);
    expect(planes.cover[0]).toBe(1);             // covered, just unjudgeable
    // The lit conifer cell scores well above neutral (128).
    expect(planes.score[planes.cols]).toBeGreaterThan(128);
    // The lit dry-grass cell scores at or below neutral.
    expect(planes.score[planes.cols + 3]).toBeLessThanOrEqual(128);
  });

  it('skips fully transparent pixels entirely — a missing tile is not evidence', () => {
    const planes = synthPlanes({ alpha: () => 0 });
    expect(planes.cover.every(v => v === 0)).toBe(true);
    const r = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'del' }));
    expect(r.cells).toBe(0);   // nothing deleted where there is no imagery
  });

  it('reports the number of pixels it consumed', () => {
    const t = synthTile();
    const acc = makeVegAccumulator(t.rows, t.cols);
    expect(accumulateVegTile(acc, t.rgba, t.TW, t.TH, t.pool, 0, 0)).toBe(t.TW * t.TH);
  });
});

describe('vegCandidateMask', () => {
  const planes = synthPlanes();
  const cols = planes.cols;

  it('classifies trees, grass and shadow into three distinct classes', () => {
    const add = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'add', textureGate: false }));
    expect(add.unknown[0]).toBe(1);              // shadow row => unknown
    expect(add.mask[cols + 0]).toBe(1);          // conifer => veg
    expect(add.mask[cols + 3]).toBe(0);          // dry grass => bare
  });

  it('never paints unknown ground out in the open', () => {
    const add = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'add', textureGate: false }));
    for (let c = 0; c < cols; c++) expect(add.mask[c]).toBe(0);
  });

  // Shadow ENCLOSED by canopy is cast by the very trees around it, so the
  // closing step reclaims it: painting it is physically right and errs toward
  // more canopy. Closing cannot grow a boundary, so open ground stays unpainted
  // (asserted above). Without this, real stands come out moth-eaten.
  // Measured over real dense conifer: 84% of the cells the darkness gate
  // rejects have NO lit pixel at all, so no per-cell rule can rescue them and
  // ADD refused to paint exactly the dense stands it was most needed for —
  // while happily painting sunlit grass. A dark region bounded by canopy is
  // that canopy's own shadow.
  it('reclaims a large dark region bounded by canopy, at any size', () => {
    const N = 12;
    const veg = new Uint8Array(N * N).fill(1);
    const unknown = new Uint8Array(N * N);
    for (let y = 3; y <= 8; y++) for (let x = 3; x <= 8; x++) {   // 6x6 dark core
      unknown[y * N + x] = 1; veg[y * N + x] = 0;
    }
    const got = reclaimShadowInVeg(veg, unknown, N, N);
    expect(countMask(got)).toBe(36);          // the whole region, not just its rim
  });

  it('leaves an isolated dark blob in the open alone', () => {
    const N = 12;
    const veg = new Uint8Array(N * N);        // no vegetation anywhere
    const unknown = new Uint8Array(N * N);
    for (let y = 4; y <= 7; y++) for (let x = 4; x <= 7; x++) unknown[y * N + x] = 1;
    expect(countMask(reclaimShadowInVeg(veg, unknown, N, N))).toBe(0);
  });

  it('leaves a region only half-bounded by canopy alone', () => {
    const N = 12;
    const veg = new Uint8Array(N * N);
    const unknown = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < 5; x++) veg[y * N + x] = 1;            // canopy to the west only
      for (let x = 5; x <= 6; x++) unknown[y * N + x] = 1;       // dark strip between
    }
    expect(countMask(reclaimShadowInVeg(veg, unknown, N, N))).toBe(0);
  });

  it('reclaims a shadow hole enclosed by vegetation', () => {
    // 5x5 of conifer with one shadow pixel dead centre, at pool 1.
    const TW = 5, TH = 5;
    const rgba = new Uint8ClampedArray(TW * TH * 4);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const o = (y * TW + x) * 4;
      const c = (x === 2 && y === 2) ? SHADOW : CONIFER;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
    }
    const acc = makeVegAccumulator(TH, TW);
    accumulateVegTile(acc, rgba, TW, TH, 1, 0, 0);
    const p = finalizeVegAccumulator(acc);
    const opts = { bounds: BOUNDS, morphR: 1, textureGate: false, insideFn: pointInPolygon };
    const add = vegCandidateMask(p, Object.assign({}, opts, { direction: 'add' }));
    expect(add.mask[2 * TW + 2]).toBe(1);      // painted as the canopy's own shadow
    // ...and no longer counted as "skipped": it WAS judged, just by context
    // rather than by colour, so reporting it as unjudged would understate the
    // coverage the operator is approving.
    expect(add.unknown[2 * TW + 2]).toBe(0);
    // And it is never a CUT candidate, enclosed or not.
    const cut = vegCandidateMask(p, Object.assign({}, opts, { direction: 'del' }));
    expect(cut.mask[2 * TW + 2]).toBe(0);
  });

  // THE safety invariant. A shadowed cell may hide a real stand; deleting it
  // would make the viewshed predict more visibility than exists. No slider
  // position, in either direction, may ever select one.
  it('never makes an unknown cell a CUT candidate at ANY sensitivity', () => {
    for (let s = 0; s <= 100; s++) {
      const scoreT = VEG_SCORE_HI - (s / 100) * (VEG_SCORE_HI - VEG_SCORE_LO);
      const cut = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'del', scoreT }));
      for (let c = 0; c < cols; c++) {
        expect(cut.mask[c]).toBe(0);
      }
    }
  });

  it('cuts bare ground but spares vegetation', () => {
    const cut = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'del' }));
    expect(cut.mask[cols + 3]).toBe(1);          // dry grass => delete
    expect(cut.mask[cols + 0]).toBe(0);          // conifer => spared
  });

  it('re-thresholds from the same planes without resampling', () => {
    // Needs a surface that actually sits BETWEEN the slider endpoints. Dull
    // olive scores ~0.098: selected at the loose end, rejected at the strict
    // end. (An earlier version of this test leaned on dry grass passing at the
    // loose end, which only worked while the bottom of the slider was low
    // enough to paint bare ground — the bug that made max sensitivity paint
    // grass while dense canopy went untouched.)
    const MARGINAL = [100, 120, 90];
    expect(vegGreenScore(...MARGINAL)).toBeGreaterThan(VEG_SCORE_LO);
    expect(vegGreenScore(...MARGINAL)).toBeLessThan(VEG_SCORE_HI);
    const p = synthPlanes({ paint: (x, y) => (y >= 4 ? MARGINAL : null) });
    const o = Object.assign({}, baseOpts, { direction: 'add', textureGate: false });
    const strict = vegCandidateMask(p, Object.assign({}, o, { scoreT: VEG_SCORE_HI }));
    const loose = vegCandidateMask(p, Object.assign({}, o, { scoreT: VEG_SCORE_LO }));
    expect(loose.cells).toBeGreaterThan(strict.cells);
  });

  it('is deterministic — equal options give a byte-identical mask', () => {
    const a = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'add' }));
    const b = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'add' }));
    expect(Array.from(a.mask)).toEqual(Array.from(b.mask));
  });

  // A flat green field is pasture or a crop, not a crown. ADD should shed it;
  // CUT must NOT, or the field gets deleted instead of protected.
  it('the texture gate rejects flat green when adding but not when cutting', () => {
    const flat = synthPlanes({ paint: () => [95, 140, 70] });   // uniform green, zero texture
    const gated = vegCandidateMask(flat, Object.assign({}, baseOpts, { direction: 'add', textureGate: true }));
    const ungated = vegCandidateMask(flat, Object.assign({}, baseOpts, { direction: 'add', textureGate: false }));
    expect(ungated.cells).toBeGreaterThan(0);
    expect(gated.cells).toBe(0);
    // CUT ignores the gate entirely, so the flat green stays protected.
    const cut = vegCandidateMask(flat, Object.assign({}, baseOpts, { direction: 'del', textureGate: true }));
    expect(cut.cells).toBe(0);
  });

  it('the lean margin, when enabled, protects ground near a green cell', () => {
    const bare = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'del', leanCells: 0 }));
    const leaned = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'del', leanCells: 2 }));
    expect(leaned.cells).toBeLessThan(bare.cells);
  });

  // Measured on real scattered-conifer meadow: a 6 m isotropic dilation around
  // every crown AND every shadow cell merged into near-total coverage and threw
  // away 81% of genuinely bare ground, so CUT could not clear an empty meadow.
  it('ships the lean margin OFF by default', () => {
    expect(VEG_LEAN_MARGIN_M).toBe(0);
  });

  it('clips to the drawn polygon', () => {
    const mid = (BOUNDS.north + BOUNDS.south) / 2;
    const north = [[BOUNDS.north, BOUNDS.west], [BOUNDS.north, BOUNDS.east], [mid, BOUNDS.east], [mid, BOUNDS.west]];
    const all = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'del' }));
    const clipped = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'del', poly: north }));
    expect(clipped.cells).toBeLessThan(all.cells);
  });

  // The analysis lattice spans the whole tile mosaic, which is larger than the
  // drawn area. If the unknown plane is not clipped too, the preview dithers
  // ground the operator never drew over and the "N skipped" count reports the
  // mosaic instead of the job.
  it('clips the unknown plane and the reported counts to the polygon', () => {
    const mid = (BOUNDS.north + BOUNDS.south) / 2;
    const south = [[mid, BOUNDS.west], [mid, BOUNDS.east], [BOUNDS.south, BOUNDS.east], [BOUNDS.south, BOUNDS.west]];
    const all = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'add' }));
    const clipped = vegCandidateMask(planes, Object.assign({}, baseOpts, { direction: 'add', poly: south }));
    // The shadow row is in the NORTH half, so clipping to the south drops it.
    expect(all.unknownCells).toBeGreaterThan(0);
    expect(clipped.unknownCells).toBe(0);
    expect(countMask(clipped.unknown)).toBe(0);
    // Reported coverage is also the drawn area, not the whole lattice.
    expect(clipped.coverCells).toBeLessThan(all.coverCells);
    expect(clipped.unknownCells + clipped.coverCells).toBeLessThanOrEqual(planes.rows * planes.cols);
  });
});

describe('mask morphology', () => {
  const rows = 7, cols = 7;
  const speck = () => { const m = new Uint8Array(rows * cols); m[3 * cols + 3] = 1; return m; };
  const holed = () => {
    const m = new Uint8Array(rows * cols);
    for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) m[y * cols + x] = 1;
    m[3 * cols + 3] = 0;
    return m;
  };

  it('open removes an isolated speck', () => {
    expect(countMask(maskOpen(speck(), rows, cols, 1))).toBe(0);
  });

  it('close fills a one-cell hole', () => {
    expect(maskClose(holed(), rows, cols, 1)[3 * cols + 3]).toBe(1);
  });

  it('open is idempotent', () => {
    const once = maskOpen(holed(), rows, cols, 1);
    expect(Array.from(maskOpen(once, rows, cols, 1))).toEqual(Array.from(once));
  });

  it('radius 0 is a pass-through copy, not an alias', () => {
    const m = speck();
    const d = maskDilate(m, rows, cols, 0);
    expect(Array.from(d)).toEqual(Array.from(m));
    expect(d).not.toBe(m);
  });

  it('erode does not chew a rim off the region border', () => {
    const full = new Uint8Array(rows * cols).fill(1);
    expect(countMask(maskErode(full, rows, cols, 1))).toBe(rows * cols);
  });

  it('filterMaskMinArea drops components below the floor and keeps the rest', () => {
    const m = holed();
    m[0] = 1;                                    // a 1-cell component in the corner
    const r = filterMaskMinArea(m, rows, cols, 5);
    expect(r.removed).toBe(1);
    expect(r.kept).toBe(1);
    expect(r.mask[0]).toBe(0);
    expect(r.mask[2 * cols + 2]).toBe(1);
  });
});

describe('bit packing and downsampling', () => {
  it('round-trips a mask whose length is not a multiple of 8', () => {
    const n = 21;
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = i % 3 === 0 ? 1 : 0;
    const packed = packBitMask(m, n);
    expect(packed.length).toBe(Math.ceil(n / 8));
    for (let i = 0; i < n; i++) expect(bitMaskGet(packed, i)).toBe(m[i]);
  });

  // Coarsening for the storage cap must never flip an edit toward LESS canopy.
  it('OR-pools when adding and AND-pools when deleting', () => {
    const m = new Uint8Array(16);   // 4x4, one cell set
    m[0] = 1;
    expect(countMask(maskDownsample(m, 4, 4, BOUNDS, 2, 'or').mask)).toBe(1);
    expect(countMask(maskDownsample(m, 4, 4, BOUNDS, 2, 'and').mask)).toBe(0);
  });

  it('extends the bounds when dimensions do not divide evenly', () => {
    const m = new Uint8Array(9);    // 3x3 downsampled by 2 -> 2x2 covering 4x4
    const d = maskDownsample(m, 3, 3, BOUNDS, 2, 'or');
    expect(d.cols).toBe(2);
    expect(d.bounds.west).toBe(BOUNDS.west);
    expect(d.bounds.east).toBeGreaterThan(BOUNDS.east);
    expect(d.bounds.south).toBeLessThan(BOUNDS.south);
  });
});

describe('maskClipToPolygon', () => {
  it('keeps only cells whose centre is inside the ring', () => {
    const cols = 8, rows = 8;
    const m = new Uint8Array(cols * rows).fill(1);
    const mid = (BOUNDS.north + BOUNDS.south) / 2;
    const north = [[BOUNDS.north, BOUNDS.west], [BOUNDS.north, BOUNDS.east], [mid, BOUNDS.east], [mid, BOUNDS.west]];
    const out = maskClipToPolygon(m, cols, rows, BOUNDS, north, pointInPolygon);
    const frac = countMask(out) / (cols * rows);
    expect(frac).toBeGreaterThan(0.4);
    expect(frac).toBeLessThan(0.6);
  });

  it('returns an empty mask for a degenerate ring', () => {
    const m = new Uint8Array(16).fill(1);
    expect(countMask(maskClipToPolygon(m, 4, 4, BOUNDS, [[0, 0], [1, 1]], pointInPolygon))).toBe(0);
  });
});

describe('makeCanopyMaskOp', () => {
  const half = () => {
    const m = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) m[y * 64 + x] = 1;
    return m;
  };
  const spec = extra => Object.assign({
    mask: half(), cols: 64, rows: 64, bounds: BOUNDS, mode: 'add', hM: 12.345, z: 18,
  }, extra);

  it('bakes a valid op with fill semantics by default', () => {
    const { op } = makeCanopyMaskOp(spec());
    expect(op.t).toBe('mask');
    expect(op.hMode).toBe('fill');
    expect(op.hM).toBe(12.35);              // rounded to cm, like the brush op
    expect(op.minFrac).toBe(0);             // OR pool
    expect(canopyMaskOpValid(op)).toBe(true);
  });

  it('uses majority pooling for the delete direction', () => {
    const { op } = makeCanopyMaskOp(spec({ mode: 'del', hM: undefined }));
    expect(op.minFrac).toBe(VEG_DEL_MIN_FRAC);
    expect(op.hM).toBeUndefined();
    expect(canopyMaskOpValid(op)).toBe(true);
  });

  // minFrac is written into every op at bake time, so changing the default
  // must not retroactively alter the meaning of an already-saved edit.
  it('honours an explicit minFrac so saved ops keep their own pooling rule', () => {
    const { op } = makeCanopyMaskOp(spec({ mode: 'del', hM: undefined, minFrac: 1 }));
    expect(op.minFrac).toBe(1);
  });

  it('returns null when nothing is selected', () => {
    expect(makeCanopyMaskOp(spec({ mask: new Uint8Array(64 * 64) }))).toBeNull();
  });

  it('coarsens rather than failing when over the storage cap', () => {
    const r = makeCanopyMaskOp(spec({ maxCells: 1024 }));
    expect(r.coarsened).toBeGreaterThan(0);
    expect(r.cols * r.rows).toBeLessThanOrEqual(1024);
    expect(canopyMaskOpValid(r.op)).toBe(true);
    // The NW corner is a tile-lattice anchor and must not drift while coarsening.
    expect(r.op.srcBounds.west).toBe(BOUNDS.west);
    expect(r.op.srcBounds.north).toBe(BOUNDS.north);
  });

  it('packs to 1 bit per cell', () => {
    const { op } = makeCanopyMaskOp(spec());
    expect(op.data.length).toBe(Math.ceil(64 * 64 / 8));
  });
});

describe('canopyMaskOpValid', () => {
  const { op } = makeCanopyMaskOp({
    mask: new Uint8Array(64).fill(1), cols: 8, rows: 8, bounds: BOUNDS, mode: 'add', hM: 10,
  });

  // A truncated op must be SKIPPED, never thrown from: canopyApplyOps runs
  // inside one try/catch, so a single bad op would otherwise silently disable
  // EVERY saved edit.
  it('rejects structurally broken ops instead of trusting them', () => {
    expect(canopyMaskOpValid(Object.assign({}, op, { data: new Uint8Array(1) }))).toBe(false);
    expect(canopyMaskOpValid(Object.assign({}, op, { srcBounds: null }))).toBe(false);
    expect(canopyMaskOpValid(Object.assign({}, op, { srcCols: 0 }))).toBe(false);
    expect(canopyMaskOpValid(Object.assign({}, op, { mode: 'sideways' }))).toBe(false);
    expect(canopyMaskOpValid(Object.assign({}, op, { hM: 0 }))).toBe(false);
    expect(canopyMaskOpValid({ t: 'paint', pts: [] })).toBe(false);
  });

  it('accepts a well-formed op', () => {
    expect(canopyMaskOpValid(op)).toBe(true);
  });
});

describe('canopyApplyMask', () => {
  const grid = makeGrid(38.7, -120.99, 250, 3);      // 3 m cells — the finest replay grid
  const gb = grid.bounds;
  const westHalf = () => {
    const m = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) m[y * 64 + x] = 1;
    return m;
  };
  const addOp = makeCanopyMaskOp({
    mask: westHalf(), cols: 64, rows: 64, bounds: gb, mode: 'add', hM: 12,
  }).op;
  const flat = v => new Float32Array(grid.rows * grid.cols).fill(v);

  it('fills gaps but preserves a measured height', () => {
    const f = flat(0);
    f[0] = 30;                                        // measured tall tree, NW corner
    canopyApplyMask(grid, f, addOp);
    expect(f[0]).toBe(30);
    expect(f[grid.cols * 2 + 2]).toBeCloseTo(12, 4);
  });

  it("hMode 'set' raises but still never lowers", () => {
    const f = flat(0);
    f[0] = 30;
    canopyApplyMask(grid, f, Object.assign({}, addOp, { hMode: 'set' }));
    expect(f[0]).toBe(30);
    expect(f[grid.cols * 2 + 2]).toBeCloseTo(12, 4);
  });

  it('leaves cells outside the mask alone', () => {
    const f = flat(0);
    canopyApplyMask(grid, f, addOp);
    expect(f[grid.cols * 2 + (grid.cols - 2)]).toBe(0);
  });

  it('returns a dense rect diff that reverts exactly', () => {
    const f = flat(0);
    f[0] = 30;
    const before = Array.from(f);
    const d = canopyApplyMask(grid, f, addOp);
    expect(d.rect).toBeTruthy();
    expect(d.oldValues.length).toBe(d.rect.rows * d.rect.cols);
    expect(d.changed).toBeGreaterThan(0);
    canopyRevertDiff(f, d, grid.cols);
    expect(Array.from(f)).toEqual(before);
  });

  it('deletes only cells that actually hold a tree', () => {
    const delOp = makeCanopyMaskOp({
      mask: new Uint8Array(64 * 64).fill(1), cols: 64, rows: 64, bounds: gb, mode: 'del',
    }).op;
    const f = flat(0);
    f[0] = 20;
    const d = canopyApplyMask(grid, f, delOp);
    expect(f[0]).toBe(0);
    expect(d.changed).toBe(1);                       // the empty cells were skipped
  });

  it('returns null for a mask that misses the grid entirely', () => {
    const far = makeCanopyMaskOp({
      mask: new Uint8Array(64).fill(1), cols: 8, rows: 8, mode: 'add', hM: 5,
      bounds: { west: 10, east: 10.01, south: 45, north: 45.01 },
    }).op;
    expect(canopyApplyMask(grid, flat(0), far)).toBeNull();
  });

  // Replay pooling must err toward MORE canopy in both directions.
  describe('pooling bias', () => {
    const coarse = makeGrid(38.7, -120.99, 250, 20);  // cells far larger than the mask
    it('OR pooling paints a coarse cell from a single green sub-pixel', () => {
      const one = new Uint8Array(64 * 64); one[0] = 1;
      const op = makeCanopyMaskOp({ mask: one, cols: 64, rows: 64, bounds: coarse.bounds, mode: 'add', hM: 9 }).op;
      const f = new Float32Array(coarse.rows * coarse.cols);
      canopyApplyMask(coarse, f, op);
      expect(countMask(f.map(v => (v > 0 ? 1 : 0)))).toBeGreaterThanOrEqual(1);
    });

    // Unanimity (minFrac 1) sounded safe but cleared only 29% of ground the
    // operator had already reviewed and approved — one vegetated sub-pixel
    // anywhere in a ~21-cell window spared the whole cell. A majority rule
    // tracks the reviewed area without overshooting it.
    it('majority pooling clears a coarse cell that is mostly bare', () => {
      const allButOne = new Uint8Array(64 * 64).fill(1); allButOne[0] = 0;
      const op = makeCanopyMaskOp({ mask: allButOne, cols: 64, rows: 64, bounds: coarse.bounds, mode: 'del' }).op;
      const f = new Float32Array(coarse.rows * coarse.cols).fill(5);
      canopyApplyMask(coarse, f, op);
      expect(f[0]).toBe(0);
    });

    it('majority pooling spares a coarse cell that is mostly vegetated', () => {
      const mask = new Uint8Array(64 * 64);
      mask[0] = 1;                       // a lone bare sub-pixel in a vegetated cell
      const op = makeCanopyMaskOp({ mask, cols: 64, rows: 64, bounds: coarse.bounds, mode: 'del' }).op;
      const f = new Float32Array(coarse.rows * coarse.cols).fill(5);
      canopyApplyMask(coarse, f, op);
      expect(f[0]).toBe(5);
    });

    it('an op saved with minFrac 1 still pools unanimously', () => {
      const allButOne = new Uint8Array(64 * 64).fill(1); allButOne[0] = 0;
      const op = makeCanopyMaskOp({ mask: allButOne, cols: 64, rows: 64, bounds: coarse.bounds, mode: 'del', minFrac: 1 }).op;
      const f = new Float32Array(coarse.rows * coarse.cols).fill(5);
      canopyApplyMask(coarse, f, op);
      expect(f[0]).toBe(5);
    });
  });
});

describe('mask ops in the op log', () => {
  const grid3 = makeGrid(38.7, -120.99, 250, 3);
  const grid10 = makeGrid(38.7, -120.99, 250, 10);
  const westHalf = () => {
    const m = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) m[y * 64 + x] = 1;
    return m;
  };
  const op = makeCanopyMaskOp({
    mask: westHalf(), cols: 64, rows: 64, bounds: grid3.bounds, mode: 'add', hM: 12,
  }).op;
  const painted = (g, f) => f.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) / (g.rows * g.cols);

  it('replays to the same ground coverage on a 3 m and a 10 m grid', () => {
    const f3 = new Float32Array(grid3.rows * grid3.cols);
    const f10 = new Float32Array(grid10.rows * grid10.cols);
    expect(canopyApplyOps(grid3, f3, [op], pointInPolygon)).toBe(1);
    expect(canopyApplyOps(grid10, f10, [op], pointInPolygon)).toBe(1);
    expect(painted(grid3, f3)).toBeCloseTo(painted(grid10, f10), 1);
  });

  it('exposes the mask extent as the op bbox', () => {
    expect(canopyOpBBox(op).west).toBe(op.srcBounds.west);
    expect(canopyOpBBox(op).north).toBe(op.srcBounds.north);
  });

  it('culls a malformed mask op instead of applying it', () => {
    expect(canopyOpBBox({ t: 'mask', mode: 'add' })).toBeNull();
    const f = new Float32Array(grid3.rows * grid3.cols);
    expect(canopyApplyOps(grid3, f, [{ t: 'mask', mode: 'add' }], pointInPolygon)).toBe(0);
  });

  // Forward compatibility: a build that predates a future op type must skip it
  // and keep applying its neighbours, never crash or corrupt the raster. This
  // is exactly how an older cached build survives a log containing mask ops.
  it('skips an unknown op type but still applies the ops around it', () => {
    const f = new Float32Array(grid3.rows * grid3.cols);
    const n = canopyApplyOps(grid3, f, [{ t: 'from-the-future' }, op], pointInPolygon);
    expect(n).toBe(1);
    expect(f[grid3.cols * 2 + 2]).toBeCloseTo(12, 4);
  });

  it('accounts for the packed payload in the byte budget', () => {
    expect(canopyOpBytes(op)).toBeGreaterThanOrEqual(op.data.length);
    expect(canopyOpsBytes([op, op])).toBe(2 * canopyOpBytes(op));
    expect(canopyOpsBytes([])).toBe(0);
    // A brush op stays cheap — the byte budget must not punish ordinary edits.
    expect(canopyOpBytes({ t: 'paint', pts: [[1, 2], [3, 4]], rM: 10, hM: 12 })).toBeLessThan(200);
  });
});

describe('vegMaskToRGBA', () => {
  it('uses distinct colours per direction and dithers the unknown cells', () => {
    const mask = new Uint8Array([1, 0, 0, 0]);
    const unknown = new Uint8Array([0, 1, 1, 0]);
    const addPx = vegMaskToRGBA(mask, unknown, 2, 2, 'add');
    const delPx = vegMaskToRGBA(mask, unknown, 2, 2, 'del');
    expect([addPx[0], addPx[1], addPx[2]]).toEqual([34, 211, 238]);   // cyan
    expect([delPx[0], delPx[1], delPx[2]]).toEqual([239, 68, 68]);    // red
    // Cell 1 is (x=1,y=0): odd parity, so the amber checker paints it.
    expect(addPx[4 + 3]).toBeGreaterThan(0);
    // Cell 2 is (x=0,y=1): also odd parity.
    expect(addPx[8 + 3]).toBeGreaterThan(0);
  });
});

describe('cellsToHectares', () => {
  it('converts cell counts to ground area', () => {
    expect(cellsToHectares(100, 3)).toBeCloseTo(0.09, 12);
    expect(cellsToHectares(0, 1.86)).toBe(0);
  });
});
