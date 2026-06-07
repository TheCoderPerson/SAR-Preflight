const { parseNotamText, geolocateNotam } = require('../../sar-preflight-core.js');

const TEST_AIRPORTS = [
  { icao: 'KPVF', name: 'Placerville Airport', lat: 38.7243, lng: -120.7533 },
  { icao: 'KSMF', name: 'Sacramento International', lat: 38.6954, lng: -121.5908 },
];

describe('parseNotamText()', () => {
  it('returns empty for blank input', () => {
    expect(parseNotamText('').notams).toEqual([]);
    expect(parseNotamText(null).notams).toEqual([]);
  });

  it('parses an ICAO-format NOTAM record', () => {
    const text = `A) KPVF B) 2606061200 C) 2606080700
E) RWY 05/23 CLSD DUE TO CONSTRUCTION
F) SFC G) 400FT AGL`;
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(1);
    const n = notams[0];
    expect(n.location).toBe('KPVF');
    expect(n.effectiveStart).toBe('2026-06-06T12:00:00Z');
    expect(n.effectiveEnd).toBe('2026-06-08T07:00:00Z');
    expect(n.lowerAlt).toBe('SFC');
    expect(n.upperAlt).toBe('400FT AGL');
  });

  it('parses an FAA domestic (!) NOTAM and its id', () => {
    const text = `!SAC 06/123 PVF RWY 05/23 CLSD`;
    const { notams } = parseNotamText(text);
    expect(notams[0].id).toBe('06/123');
    expect(notams[0].location).toBe('SAC');
    expect(notams[0].type).toBe('FDC/domestic');
  });

  it('splits multiple blank-line-separated records', () => {
    const text = `A) KPVF E) first\n\nA) KSMF E) second`;
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(2);
  });

  it('extracts embedded DMS coordinates when present', () => {
    const text = `!FDC 1/2345 PART 1 OF 1\nE) AREA 474800N1200100W`;
    const { notams } = parseNotamText(text);
    expect(notams[0].lat).toBeCloseTo(47.8, 3);
    expect(notams[0].lng).toBeCloseTo(-120.0166, 3);
  });

  it('segments multiple ICAO-paren NOTAMs without blank-line separators', () => {
    const text =
      '(A1234/26 NOTAMN Q) ZOA A) KPVF B) 2606061200 C) 2606080700 E) RWY 05/23 CLSD)\n' +
      '(A5678/26 NOTAMN Q) ZOA A) KSMF B) 2606061200 C) 2606080700 E) TWY A CLSD)';
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(2);
    expect(notams[0].id).toBe('A1234/26');
    expect(notams[0].location).toBe('KPVF');
    expect(notams[1].id).toBe('A5678/26');
  });

  it('strips copied-page furniture (page numbers, URLs, timestamps)', () => {
    const text =
      '6/7/2026, 2:14 PM NOTAM Search\n' +
      'https://notams.aim.faa.gov/notamSearch/\n' +
      '!SAC 06/123 PVF RWY 05/23 CLSD\n' +
      'Page 1 of 1';
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(1);
    expect(notams[0].id).toBe('06/123');
    // furniture must not be mistaken for its own NOTAM record
    expect(notams.every(n => n.id !== '(unparsed)')).toBe(true);
  });

  it('captures NOTAM type from NOTAMN/NOTAMR/NOTAMC token', () => {
    const { notams } = parseNotamText('(A1234/26 NOTAMR A) KPVF E) replaces prior)');
    expect(notams[0].type).toBe('NOTAMR');
  });

  it('parses a real domestic UAS area NOTAM into a polygon with altitude + time window', () => {
    const text = '!OAK 01/090 ZOA AIRSPACE UAS WI AN AREA DEFINED AS 413715N1182425W (21.8NM SSE E85) ' +
      '412345N1180328W (31.5NM NNW WMC) 405645N1180509W (12.8NM W WMC) 403943N1182446W (30.7NM SW WMC) ' +
      'TO 404847N1191428W (51NM E O39) TO 405803N1193923W (34NM NE O39) TO 412342N1185857W (37.5NM SW E85) ' +
      '413306N1184004W (24NM S E85) 413724N1183508W (20NM S E85) TO POINT OF ORIGIN SFC-2000FT AGL 2601121600-2608220400';
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(1);
    const n = notams[0];
    expect(n.id).toBe('01/090');
    expect(n.location).toBe('OAK');
    expect(n.type).toBe('FDC/domestic');
    // 9 listed vertices + closing vertex = 10
    expect(n.polygons.length).toBe(1);
    expect(n.polygons[0].length).toBe(10);
    expect(n.polygons[0][0][0]).toBeCloseTo(41.6208, 3);   // 413715N
    expect(n.polygons[0][0][1]).toBeCloseTo(-118.4069, 3); // 1182425W
    // ring is closed
    expect(n.polygons[0][0]).toEqual(n.polygons[0][9]);
    expect(n.lowerAlt).toBe('SFC AGL');
    expect(n.upperAlt).toBe('2000FT AGL');
    expect(n.effectiveStart).toBe('2026-01-12T16:00:00Z');
    expect(n.effectiveEnd).toBe('2026-08-22T04:00:00Z');
    // centroid set for reference
    expect(n.lat).toBeGreaterThan(40);
    expect(n.lat).toBeLessThan(42);
  });

  it('parses a circular domestic NOTAM (radius + decimal-second center) into a polygon', () => {
    const text = '!OAK 04/186 ZOA AIRSPACE UAS WI AN AREA DEFINED AS 5NM RADIUS OF\n' +
      ' 382948.90N1201252.70W (25.4NM SW M45) SFC-400FT AGL DLY 0000-2359\n' +
      ' 2604160000-2612042359';
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(1);
    const n = notams[0];
    expect(n.id).toBe('04/186');
    expect(n.location).toBe('OAK');
    // 5 NM circle tessellated to a polygon ring
    expect(n.polygons.length).toBe(1);
    expect(n.polygons[0].length).toBeGreaterThan(20);
    // center from decimal-second DMS
    expect(n.lat).toBeCloseTo(38.4969, 3);
    expect(n.lng).toBeCloseTo(-120.2146, 3);
    expect(n.lowerAlt).toBe('SFC AGL');
    expect(n.upperAlt).toBe('400FT AGL');
    expect(n.effectiveStart).toBe('2026-04-16T00:00:00Z');
    expect(n.effectiveEnd).toBe('2026-12-04T23:59:00Z');
  });

  it('parses the FAA NOTAM Search WEB-DISPLAY list into separate records', () => {
    const text = [
      '  Digital NOTAM  MCCNumber: 6/9738 Class: ProcedureStart Date UTC: 04/08/2026 1836End Date UTC: PERM',
      'IAP MC CLELLAN AIRFIELD, SACRAMENTO, CA. ILS OR LOC RWY 16, ORIG-E...',
      '    ZOANumber: 01/239 Class: AirspaceStart Date UTC: 01/23/2026 1600End Date UTC: 01/01/2027 0400',
      'AIRSPACE AEROBATIC ACFT WI AN AREA DEFINED AS 3NM RADIUS OF 383900N1220148W (7.5NM WSW O41) SFC-5000FT DLY 1600-0400 2601231600-2701010400',
      '    MCCNumber: 03/012 Class: ObstructionStart Date UTC: 03/18/2026 0739End Date UTC: 07/18/2026 2359',
      'OBST TOWER LGT (ASR 1026718) 384422.00N1211258.00W (9.6NM ENE MCC) 492.1FT (227.0FT AGL) U/S 2603180739-2607182359',
    ].join('\n');
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(3);
    const byId = Object.fromEntries(notams.map(n => [n.id, n]));
    expect(byId['6/9738'].location).toBe('MCC');
    expect(byId['6/9738'].type).toBe('Procedure');
    expect(byId['6/9738'].effectiveStart).toBe('2026-04-08T18:36:00Z');
    expect(byId['6/9738'].effectiveEnd).toBeNull(); // PERM -> no end
    // radius airspace NOTAM -> tessellated polygon
    expect(byId['01/239'].type).toBe('Airspace');
    expect(byId['01/239'].polygons.length).toBe(1);
    // single-coordinate obstruction -> point
    expect(byId['03/012'].polygons.length).toBe(0);
    expect(byId['03/012'].lat).toBeCloseTo(38.7394, 2);
  });

  it('captures a leading un-headed NOTAM tail from a mid-list paste', () => {
    const text = 'TWY J CLSD 2003171826-PERM\n  Digital NOTAM  MCCNumber: 6/9738 Class: ProcedureStart Date UTC: 04/08/2026 1836End Date UTC: PERM\nIAP MC CLELLAN AIRFIELD';
    const { notams } = parseNotamText(text);
    expect(notams.length).toBe(2); // orphan tail + 6/9738
    expect(notams[0].body).toContain('TWY J CLSD');
    expect(notams[1].id).toBe('6/9738');
  });
});

describe('geolocateNotam()', () => {
  it('keeps existing embedded coordinates', () => {
    const n = { location: 'KPVF', lat: 10, lng: 20 };
    geolocateNotam(n, TEST_AIRPORTS);
    expect(n.lat).toBe(10);
  });
  it('resolves coordinates from the live airports list by ICAO', () => {
    const n = { location: 'KPVF', lat: null, lng: null };
    geolocateNotam(n, TEST_AIRPORTS);
    expect(n.lat).toBeCloseTo(38.7243, 4);
    expect(n.lng).toBeCloseTo(-120.7533, 4);
  });
  it('falls back to the static reference table', () => {
    const n = { location: 'KSFO', lat: null, lng: null };
    geolocateNotam(n, []);
    expect(n.lat).toBeCloseTo(37.6213, 3);
  });
  it('leaves coordinates null when unresolvable', () => {
    const n = { location: 'ZZZZ', lat: null, lng: null };
    geolocateNotam(n, TEST_AIRPORTS);
    expect(n.lat).toBeNull();
  });
});
