const { encodeGeoTiffRGBA } = require('../../sar-preflight-raster.js');

// Minimal little-endian TIFF reader: returns { header, tags: Map(id -> {type,count,values}) }.
function readTiff(buf) {
  const dv = new DataView(buf);
  const LE = true;
  expect(dv.getUint8(0)).toBe(0x49); // 'I'
  expect(dv.getUint8(1)).toBe(0x49); // 'I'
  expect(dv.getUint16(2, LE)).toBe(42);
  const ifd = dv.getUint32(4, LE);
  const n = dv.getUint16(ifd, LE);
  const TSIZE = { 3: 2, 4: 4, 12: 8 };
  const readVals = (type, count, fieldOff) => {
    const size = TSIZE[type] * count;
    const base = size <= 4 ? fieldOff : dv.getUint32(fieldOff, LE);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (type === 3) out.push(dv.getUint16(base + i * 2, LE));
      else if (type === 4) out.push(dv.getUint32(base + i * 4, LE));
      else if (type === 12) out.push(dv.getFloat64(base + i * 8, LE));
    }
    return out;
  };
  const tags = new Map();
  for (let i = 0; i < n; i++) {
    const off = ifd + 2 + i * 12;
    const id = dv.getUint16(off, LE);
    const type = dv.getUint16(off + 2, LE);
    const count = dv.getUint32(off + 4, LE);
    tags.set(id, { type, count, values: readVals(type, count, off + 8) });
  }
  return { dv, ifd, tags, stripOffset: tags.get(273).values[0] };
}

describe('encodeGeoTiffRGBA', () => {
  const W = 2, H = 2;
  const bounds = { west: -120, east: -119, south: 38, north: 39 };
  // 2x2 RGBA, distinct pixels (row-major, top row first).
  const rgba = new Uint8ClampedArray([
    10, 20, 30, 255, 40, 50, 60, 200,
    70, 80, 90, 128, 11, 22, 33, 44,
  ]);

  it('writes a valid little-endian RGB(A) TIFF with the right dimensions', () => {
    const buf = encodeGeoTiffRGBA(rgba, W, H, bounds);
    const { tags } = readTiff(buf);
    expect(tags.get(256).values[0]).toBe(W);   // ImageWidth
    expect(tags.get(257).values[0]).toBe(H);   // ImageLength
    expect(tags.get(262).values[0]).toBe(2);   // Photometric = RGB
    expect(tags.get(277).values[0]).toBe(4);   // SamplesPerPixel
    expect(tags.get(259).values[0]).toBe(1);   // Compression = none
    expect(tags.get(258).values).toEqual([8, 8, 8, 8]); // BitsPerSample
    expect(tags.get(338).values[0]).toBe(2);   // ExtraSamples = unassociated alpha
  });

  it('georeferences to EPSG:4326 via tiepoint, pixel scale, and geokeys', () => {
    const buf = encodeGeoTiffRGBA(rgba, W, H, bounds);
    const { tags } = readTiff(buf);
    expect(tags.get(33922).values).toEqual([0, 0, 0, -120, 39, 0]); // tiepoint -> NW corner
    const scale = tags.get(33550).values;
    expect(scale[0]).toBeCloseTo(0.5, 10); // (east-west)/W
    expect(scale[1]).toBeCloseTo(0.5, 10); // (north-south)/H
    expect(scale[2]).toBe(0);
    const keys = tags.get(34735).values;
    expect(keys.slice(0, 4)).toEqual([1, 1, 0, 3]); // header + 3 keys
    expect(keys).toContain(4326);                   // GeographicTypeGeoKey value
    // GTModelTypeGeoKey (1024) = 2 (geographic)
    const k = keys.indexOf(1024);
    expect(keys[k + 3]).toBe(2);
  });

  it('round-trips the pixel buffer in the strip', () => {
    const buf = encodeGeoTiffRGBA(rgba, W, H, bounds);
    const { stripOffset } = readTiff(buf);
    const out = new Uint8Array(buf, stripOffset, W * H * 4);
    expect(Array.from(out)).toEqual(Array.from(rgba));
  });
});
