const { utmToLatLng, parseAngleFlexible, parseCoordinateInput } = require('../../sar-preflight-core.js');

// The four sample inputs all describe the SAME point (from the feature spec):
//   UTM 10S 0706918E 4295806N ≡ DD 38.78673, -120.61770
//   ≡ DDM 38°47.204', -120°37.062' ≡ DMS 38°47'12", -120°37'04"

describe('utmToLatLng', () => {
  it('converts the spec vector to its DD equivalent', () => {
    const ll = utmToLatLng(10, 'S', 706918, 4295806);
    expect(ll.lat).toBeCloseTo(38.78673, 4);
    expect(ll.lng).toBeCloseTo(-120.61770, 4);
  });

  it('easting 500000 lands exactly on the zone central meridian', () => {
    expect(utmToLatLng(10, 'S', 500000, 4295806).lng).toBeCloseTo(-123, 9); // zone 10 CM
    expect(utmToLatLng(56, 'H', 500000, 6252266).lng).toBeCloseTo(153, 9);  // zone 56 CM
  });

  it('band letters C–M give southern-hemisphere latitudes', () => {
    expect(utmToLatLng(56, 'H', 334873, 6252266).lat).toBeLessThan(0);  // Sydney-ish
    expect(utmToLatLng(10, 'S', 706918, 4295806).lat).toBeGreaterThan(0);
  });

  it('rejects invalid zone, band, and out-of-range easting/northing', () => {
    expect(utmToLatLng(0, 'S', 706918, 4295806)).toBeNull();
    expect(utmToLatLng(61, 'S', 706918, 4295806)).toBeNull();
    expect(utmToLatLng(10, 'I', 706918, 4295806)).toBeNull(); // I is not a band
    expect(utmToLatLng(10, 'O', 706918, 4295806)).toBeNull(); // O is not a band
    expect(utmToLatLng(10, 'S', 50000, 4295806)).toBeNull();  // easting too small
    expect(utmToLatLng(10, 'S', 706918, 11000000)).toBeNull();
  });
});

describe('parseAngleFlexible', () => {
  it('parses DD', () => {
    expect(parseAngleFlexible('38.78673')).toEqual({ value: 38.78673, parts: 1 });
    expect(parseAngleFlexible('-120.61770').value).toBeCloseTo(-120.6177, 9);
  });

  it('parses DDM with and without symbols', () => {
    expect(parseAngleFlexible("38°47.204'").value).toBeCloseTo(38.7867333, 6);
    expect(parseAngleFlexible('38 47.204').value).toBeCloseTo(38.7867333, 6);
    expect(parseAngleFlexible("-120°37.062'").value).toBeCloseTo(-120.6177, 6);
    expect(parseAngleFlexible('-120 37.062').value).toBeCloseTo(-120.6177, 6);
  });

  it('parses DMS with and without symbols (incl. unicode marks)', () => {
    expect(parseAngleFlexible('38°47\'12"').value).toBeCloseTo(38.7866667, 6);
    expect(parseAngleFlexible('38 47 12').value).toBeCloseTo(38.7866667, 6);
    expect(parseAngleFlexible('-120°37\'04"').value).toBeCloseTo(-120.6177778, 6);
    expect(parseAngleFlexible('38°47′12″').value).toBeCloseTo(38.7866667, 6);
  });

  it('hemisphere letters set the sign (leading or trailing)', () => {
    expect(parseAngleFlexible('N38 47.204').value).toBeCloseTo(38.7867333, 6);
    expect(parseAngleFlexible('W120 37.062').value).toBeCloseTo(-120.6177, 6);
    expect(parseAngleFlexible('120 37.062W').value).toBeCloseTo(-120.6177, 6);
    expect(parseAngleFlexible('38 47 12S').value).toBeCloseTo(-38.7866667, 6);
  });

  it('rejects malformed angles', () => {
    expect(parseAngleFlexible('')).toBeNull();
    expect(parseAngleFlexible('abc')).toBeNull();
    expect(parseAngleFlexible('38 75')).toBeNull();       // minutes >= 60
    expect(parseAngleFlexible('38 47 75')).toBeNull();    // seconds >= 60
    expect(parseAngleFlexible('38.5 30')).toBeNull();     // fractional degrees + minutes
    expect(parseAngleFlexible('38 47.5 12')).toBeNull();  // fractional minutes + seconds
    expect(parseAngleFlexible('1 2 3 4')).toBeNull();     // too many components
  });
});

describe('parseCoordinateInput', () => {
  const P = { lat: 38.78673, lng: -120.61770 };
  const expectNear = (r, digits) => {
    expect(r).not.toBeNull();
    expect(r.lat).toBeCloseTo(P.lat, digits != null ? digits : 3);
    expect(r.lng).toBeCloseTo(P.lng, digits != null ? digits : 3);
  };

  it('accepts all four spec formats and they agree on the point', () => {
    const dd = parseCoordinateInput('38.78673, -120.61770');
    const ddm = parseCoordinateInput("38°47.204', -120°37.062'");
    const dms = parseCoordinateInput('38°47\'12", -120°37\'04"');
    const utm = parseCoordinateInput('10S 0706918E 4295806N');
    [dd, ddm, dms, utm].forEach(r => expectNear(r));
    expect(dd.format).toBe('DD');
    expect(ddm.format).toBe('DDM');
    expect(dms.format).toBe('DMS');
    expect(utm.format).toBe('UTM');
  });

  it('accepts the symbol-free DDM and DMS forms', () => {
    expectNear(parseCoordinateInput('38 47.204, -120 37.062'));
    expectNear(parseCoordinateInput('38 47 12, -120 37 04'));
  });

  it('radius is optional — null without one, parsed with one ("m" suffix ok)', () => {
    expect(parseCoordinateInput('38.78673, -120.61770').radiusM).toBeNull();
    expect(parseCoordinateInput('38.78673, -120.61770, 2000').radiusM).toBe(2000);
    expect(parseCoordinateInput('38 47 12, -120 37 04, 1500m').radiusM).toBe(1500);
    expect(parseCoordinateInput('10S 706918 4295806').radiusM).toBeNull();
    expect(parseCoordinateInput('10S 706918 4295806, 2000').radiusM).toBe(2000);
    expect(parseCoordinateInput('10S 706918 4295806 2000').radiusM).toBe(2000);
  });

  it('UTM works without E/N letters and with comma separators', () => {
    expectNear(parseCoordinateInput('10S 706918 4295806'));
    expectNear(parseCoordinateInput('10 S 706918E, 4295806N'));
  });

  it('rejects unparseable input', () => {
    expect(parseCoordinateInput('')).toBeNull();
    expect(parseCoordinateInput('38.78673')).toBeNull();               // no longitude
    expect(parseCoordinateInput('95, -120')).toBeNull();               // |lat| > 90
    expect(parseCoordinateInput('38.7, -190')).toBeNull();             // |lng| > 180
    expect(parseCoordinateInput('38.7, -120.6, abc')).toBeNull();      // bad radius
    expect(parseCoordinateInput('10Z 706918 4295806')).toBeNull();     // bad band
    expect(parseCoordinateInput('hello world')).toBeNull();
  });
});

// The "Go To" box routes on this function alone: a non-null result is applied
// synchronously with no network call, and ONLY a null sends the text to the
// geocoder. These cases pin that boundary in both directions, because a
// regression either way is silent — a name swallowed as coordinates would jump
// the map somewhere arbitrary, and a coordinate leaked to the geocoder would
// break offline coordinate entry and burn rate-limit budget.
describe('coordinate-vs-place routing boundary', () => {
  it('still parses every coordinate format, so these never reach the network', () => {
    for (const s of [
      '38.78673, -120.61770',
      '38.78673, -120.61770, 2000',
      "38°47.204', -120°37.062'",
      '38 47 12, -120 37 04',
      '10S 0706918E 4295806N',
      '10S 0706918E 4295806N, 2000',
      '38.78673 N, 120.61770 W',
    ]) {
      expect(parseCoordinateInput(s)).not.toBeNull();
    }
  });

  it('returns null for place names and addresses, routing them to search', () => {
    for (const s of [
      'Jenkinson Lake',
      'Mount Baldy',
      'Pyramid Peak',
      'Desolation Wilderness',
      'Sly Park',
      '7020 Talmage Ct, El Dorado Hills, CA 95762',
      '2850 Fairlane Ct, Placerville, CA 95667',
      'Ice House Road',
      'Highway 50',
      'Placerville, CA',
      'Union Valley Reservoir',
    ]) {
      expect(parseCoordinateInput(s)).toBeNull();
    }
  });

  it('does not mistake a comma-separated place for a coordinate pair', () => {
    // Two comma segments is the DD shape, but neither half is an angle.
    expect(parseCoordinateInput('Placerville, California')).toBeNull();
    expect(parseCoordinateInput('Sly Park, CA')).toBeNull();
    // Three segments is the DD+radius shape.
    expect(parseCoordinateInput('El Dorado Hills, CA, 95762')).toBeNull();
  });
});
