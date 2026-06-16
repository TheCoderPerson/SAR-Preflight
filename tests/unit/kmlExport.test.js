const core = require('../../sar-preflight-core.js');
const {
  kmlEscape, kmlCdata, kmlRingFromLatLng, kmlRingFromGeoJson,
  kmlPolygonPlacemark, kmlPointPlacemark, kmlLinePlacemark, kmlFolder, kmlDocument,
  kmlStyles, destPoint, sunArrowsKml, windArrowsKml,
} = core;

const countPlacemarks = (s) => (s.match(/<Placemark>/g) || []).length;
// Pull the shaft tip (2nd coord of the first <LineString>) out of an arrow placemark.
function firstLineTip(kml) {
  const m = kml.match(/<LineString><tessellate>1<\/tessellate><coordinates>([^<]+)<\/coordinates>/);
  if (!m) return null;
  const pts = m[1].trim().split(/\s+/).map(c => c.split(',').map(Number));
  return pts[pts.length - 1]; // [lng,lat,alt]
}

describe('KML primitives', () => {
  it('escapes XML metacharacters', () => {
    expect(kmlEscape('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  });

  it('wraps CDATA and neutralizes a literal "]]>"', () => {
    expect(kmlCdata('<b>hi</b>')).toBe('<![CDATA[<b>hi</b>]]>');
    expect(kmlCdata('a]]>b')).toContain(']]]]><![CDATA[>');
  });

  it('emits lng,lat,0 from [lat,lng] rings and auto-closes', () => {
    const out = kmlRingFromLatLng([[38.5, -120.5], [38.5, -120.6], [38.6, -120.6]]);
    const pts = out.split(' ');
    expect(pts[0]).toBe('-120.500000,38.500000,0');     // lng first
    expect(pts[pts.length - 1]).toBe(pts[0]);            // closed
    expect(pts.length).toBe(4);
  });

  it('emits lng,lat,0 from GeoJSON [lng,lat] rings and auto-closes', () => {
    const out = kmlRingFromGeoJson([[-120.5, 38.5], [-120.6, 38.5], [-120.6, 38.6]]);
    const pts = out.split(' ');
    expect(pts[0]).toBe('-120.500000,38.500000,0');
    expect(pts[pts.length - 1]).toBe(pts[0]);
  });

  it('builds a polygon placemark with an inner hole', () => {
    const outer = kmlRingFromLatLng([[38, -120], [38, -119], [39, -119], [39, -120]]);
    const hole = kmlRingFromLatLng([[38.4, -119.6], [38.4, -119.4], [38.6, -119.4]]);
    const pm = kmlPolygonPlacemark({ name: 'A&B', styleUrl: 'restrict', rings: [outer, hole], description: 'x' });
    expect(pm).toContain('<name>A&amp;B</name>');
    expect(pm).toContain('<styleUrl>#restrict</styleUrl>');
    expect(pm).toContain('<outerBoundaryIs>');
    expect(pm).toContain('<innerBoundaryIs>');
    expect(pm).toContain('<![CDATA[x]]>');
  });

  it('skips a polygon placemark with no rings', () => {
    expect(kmlPolygonPlacemark({ name: 'x', rings: [] })).toBe('');
  });

  it('builds point and line placemarks; line needs >= 2 points', () => {
    expect(kmlPointPlacemark({ name: 'P', lat: 38.5, lng: -120.5 })).toContain('<Point><coordinates>-120.500000,38.500000,0</coordinates></Point>');
    expect(kmlPointPlacemark({ name: 'P', lat: NaN, lng: -120 })).toBe('');
    expect(kmlLinePlacemark({ name: 'L', coords: [[38, -120], [38.1, -120.1]] })).toContain('<LineString>');
    expect(kmlLinePlacemark({ name: 'L', coords: [[38, -120]] })).toBe('');
  });

  it('wraps folders and a document, including styles', () => {
    const f = kmlFolder('F', '<Placemark/>', { description: 'note' });
    expect(f).toContain('<Folder><name>F</name>');
    expect(f).toContain('<![CDATA[note]]>');
    const doc = kmlDocument('Doc', kmlStyles(), f, 'disc');
    expect(doc).toContain('<?xml version="1.0"');
    expect(doc).toContain('<Style id="restrict">');
    expect(doc).toContain('<Style id="sunArrow">');
    expect(doc).toContain('<Folder><name>F</name>');
  });
});

describe('destPoint', () => {
  it('moves east for bearing 90 and north for bearing 0', () => {
    const [latE, lngE] = destPoint(38, -120, 90, 1000);
    expect(lngE).toBeGreaterThan(-120);
    expect(Math.abs(latE - 38)).toBeLessThan(1e-6);
    const [latN, lngN] = destPoint(38, -120, 0, 1000);
    expect(latN).toBeGreaterThan(38);
    expect(Math.abs(lngN + 120)).toBeLessThan(1e-6);
  });
});

describe('sun arrows', () => {
  // Deterministic sun: above the horizon on even local hours, below on odd.
  const dayOnEvenHour = (lat, lng, d) => ({ elevation: d.getHours() % 2 === 0 ? 20 : -5, azimuth: 90 });
  const times = ['2026-06-16T06:00', '2026-06-16T07:00', '2026-06-16T08:00', '2026-06-16T09:00'];

  it('omits hours when the sun is below the horizon and stamps each arrow with a time', () => {
    const inner = sunArrowsKml(38, -120, times, 38, -120, { lengthM: 1000, calcSunPosition: dayOnEvenHour });
    // Hours 06 and 08 are daylight -> two placemarks, each time-stamped.
    expect(countPlacemarks(inner)).toBe(2);
    expect((inner.match(/<TimeStamp>/g) || []).length).toBe(2);
    expect(inner).toContain('<styleUrl>#sunArrow</styleUrl>');
  });

  it('points the arrow toward the sun azimuth (east for AZ 90)', () => {
    const inner = sunArrowsKml(38, -120, ['2026-06-16T12:00'], 38, -120, {
      lengthM: 1000, calcSunPosition: () => ({ elevation: 30, azimuth: 90 }),
    });
    const tip = firstLineTip(inner);
    expect(tip[0]).toBeGreaterThan(-120); // tip is east of centre
  });
});

describe('wind arrows', () => {
  const times = ['2026-06-16T12:00'];
  it('points downwind (FROM 270 -> arrow toward the east) and labels the source bearing', () => {
    const inner = windArrowsKml(times, [270], [10], [15], 38, -120, { lengthM: 1000 });
    expect(countPlacemarks(inner)).toBe(1);
    expect(inner).toContain('FROM 270°');
    expect(inner).toContain('downwind');
    const tip = firstLineTip(inner);
    expect(tip[0]).toBeGreaterThan(-120); // downwind of a westerly is eastward
  });

  it('skips hours with no wind direction', () => {
    const inner = windArrowsKml(['t0', 't1'], [null, 90], [5, 5], [null, null], 38, -120, {});
    expect(countPlacemarks(inner)).toBe(1);
  });
});
