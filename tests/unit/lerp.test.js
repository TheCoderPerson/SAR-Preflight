const { lerp } = require('../../sar-preflight-core.js');

describe('lerp(a, b, t)', () => {
  it('returns a when t=0', () => {
    expect(lerp(10, 20, 0)).toBe(10);
  });

  it('returns b when t=1', () => {
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it('returns midpoint when t=0.5', () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
  });

  it('handles t=0.25', () => {
    expect(lerp(0, 100, 0.25)).toBe(25);
  });

  it('handles t=0.75', () => {
    expect(lerp(0, 100, 0.75)).toBe(75);
  });

  it('works with negative range (a > b)', () => {
    expect(lerp(100, 0, 0.5)).toBe(50);
  });

  it('works when both a and b are negative', () => {
    expect(lerp(-20, -10, 0.5)).toBe(-15);
  });

  it('works with negative a and positive b', () => {
    expect(lerp(-50, 50, 0.5)).toBe(0);
  });

  it('works when a equals b', () => {
    expect(lerp(42, 42, 0.5)).toBe(42);
    expect(lerp(42, 42, 0)).toBe(42);
    expect(lerp(42, 42, 1)).toBe(42);
  });

  it('extrapolates below 0 (t < 0)', () => {
    expect(lerp(10, 20, -1)).toBe(0);
  });

  it('extrapolates above 1 (t > 1)', () => {
    expect(lerp(10, 20, 2)).toBe(30);
  });

  it('handles very small fractional t', () => {
    expect(lerp(0, 1000, 0.001)).toBeCloseTo(1, 5);
  });

  it('handles zero range with extrapolation', () => {
    expect(lerp(5, 5, 100)).toBe(5);
  });

  it('works with floating point a and b', () => {
    expect(lerp(1.5, 3.5, 0.5)).toBeCloseTo(2.5, 10);
  });

  it('works with very large numbers', () => {
    expect(lerp(0, 1e12, 0.5)).toBe(5e11);
  });
});
