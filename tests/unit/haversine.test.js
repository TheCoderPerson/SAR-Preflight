const { haversine } = require('../../sar-preflight-core.js');

describe('haversine(lat1, lon1, lat2, lon2)', () => {
  describe('same point returns 0', () => {
    it('returns 0 for identical coordinates', () => {
      expect(haversine(38.685, -120.99, 38.685, -120.99)).toBe(0);
    });

    it('returns 0 at the equator', () => {
      expect(haversine(0, 0, 0, 0)).toBe(0);
    });

    it('returns 0 at the north pole', () => {
      expect(haversine(90, 0, 90, 0)).toBe(0);
    });
  });

  describe('1 degree at the equator ~111.19 km', () => {
    it('1 degree latitude at equator is approx 111.19 km', () => {
      const dist = haversine(0, 0, 1, 0);
      expect(dist).toBeCloseTo(111.19, 0);
    });

    it('1 degree longitude at equator is approx 111.19 km', () => {
      const dist = haversine(0, 0, 0, 1);
      expect(dist).toBeCloseTo(111.19, 0);
    });
  });

  describe('known real-world distances', () => {
    it('Placerville to Sacramento is approximately 72 km', () => {
      const dist = haversine(38.7243, -120.7533, 38.6954, -121.5908);
      expect(dist).toBeGreaterThan(65);
      expect(dist).toBeLessThan(80);
      expect(dist).toBeCloseTo(72, -1);
    });
  });

  describe('symmetry', () => {
    it('distance A->B equals distance B->A', () => {
      const ab = haversine(38.7243, -120.7533, 38.6954, -121.5908);
      const ba = haversine(38.6954, -121.5908, 38.7243, -120.7533);
      expect(ab).toBeCloseTo(ba, 10);
    });
  });

  describe('long distances', () => {
    it('antipodal points are approximately half the circumference', () => {
      const dist = haversine(0, 0, 0, 180);
      expect(dist).toBeCloseTo(20015, -1);
    });

    it('pole to pole is approximately half the circumference', () => {
      const dist = haversine(90, 0, -90, 0);
      expect(dist).toBeCloseTo(20015, -1);
    });
  });

  describe('short distances', () => {
    it('very small distance (0.001 degree latitude)', () => {
      const dist = haversine(38.685, -120.99, 38.686, -120.99);
      expect(dist).toBeGreaterThan(0.1);
      expect(dist).toBeLessThan(0.2);
    });
  });

  describe('across date line', () => {
    it('crossing 180/-180 longitude', () => {
      const dist = haversine(0, 179, 0, -179);
      expect(dist).toBeCloseTo(222.4, 0);
    });
  });

  describe('negative coordinates', () => {
    it('works in the southern hemisphere', () => {
      const dist = haversine(-33.868, 151.209, -37.813, 144.963);
      expect(dist).toBeGreaterThan(700);
      expect(dist).toBeLessThan(800);
    });
  });
});
