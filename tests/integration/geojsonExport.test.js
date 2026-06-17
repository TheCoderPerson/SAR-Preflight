const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// ---- Minimal Leaflet mock with real classes so `instanceof` works ----
class MockGroup { constructor(layers) { this._layers = layers; } getLayers() { return this._layers; } }
class MPolyline {
  constructor(latlngs, popup) { this._ll = latlngs; this._p = { getContent: () => popup }; }
  getLatLngs() { return this._ll; }
  getPopup() { return this._p; }
}
class MPolygon extends MPolyline {}
class MMarker {
  constructor(ll, popup) { this._ll = ll; this._p = { getContent: () => popup }; }
  getLatLng() { return this._ll; }
  getPopup() { return this._p; }
}
globalThis.L = { Polygon: MPolygon, Polyline: MPolyline, Marker: MMarker, Circle: class {}, CircleMarker: class {} };

const app = require('../../sar-preflight.js');
const {
  S, collectExportFolderGroups, folderGroupsToGeoJsonFeatures, recordToGeoJsonFeature,
  doExportGeoJson, _uuid,
} = app;

const LL = (lat, lng) => ({ lat, lng });

// Capture Blob payloads handed to the downloader. jsdom's Blob has no .text(), so
// stub the constructor to record its parts + type (and stub createObjectURL).
function captureBlobs(fn) {
  const blobs = [];
  const realBlob = globalThis.Blob;
  const realCreate = globalThis.URL.createObjectURL;
  globalThis.Blob = class { constructor(parts, opts) { this.type = (opts || {}).type; this.text = () => Promise.resolve((parts || []).join('')); blobs.push(this); } };
  globalThis.URL.createObjectURL = () => 'blob:x';
  globalThis.URL.revokeObjectURL = () => {};
  try { fn(); } finally { globalThis.Blob = realBlob; globalThis.URL.createObjectURL = realCreate; }
  return blobs;
}

beforeEach(() => {
  S.map = { hasLayer: () => true, distance: () => 1500 };
  S.mapLayers = {};
  S.areaCenter = LL(38.7, -120.99);
  S.areaType = 'CIRCLE';
  S.currentArea = { getRadius: () => 1500 };
  S.viewsheds = [];
  S.activeViewshedId = null;
  S.importedNotams = [];
  S.tfrs = [];
  S.nearbyAirports = [];
  document.body.innerHTML = '';
});

describe('_uuid', () => {
  it('produces distinct RFC-4122-shaped ids', () => {
    const a = _uuid(), b = _uuid();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe('collectExportFolderGroups + folderGroupsToGeoJsonFeatures', () => {
  beforeEach(() => {
    S.mapLayers.faa_obstacles = new MockGroup([new L.Marker(LL(38.7, -120.99), '<b>Tower</b> 200 ft AGL')]);
    S.mapLayers.wire_power_line = new MockGroup([new L.Polyline([LL(38.70, -121.00), LL(38.71, -121.01)], 'Power line 115kV')]);
    S.mapLayers.faa_class_airspace = new MockGroup([new L.Polygon([[LL(38.6, -121.0), LL(38.6, -120.9), LL(38.7, -120.9)]], 'Class D')]);
  });

  it('groups visible layers into folder records by label', () => {
    const groups = collectExportFolderGroups(null);
    const labels = groups.map(g => g.label);
    expect(labels).toContain('Obstacle');
    expect(labels).toContain('Class Airspace');
    const obstacle = groups.find(g => g.label === 'Obstacle');
    expect(obstacle.features[0].kind).toBe('point');
  });

  it('emits one Folder feature per group with member features referencing its id', () => {
    const feats = folderGroupsToGeoJsonFeatures(collectExportFolderGroups(null), _uuid);
    const folders = feats.filter(f => f.properties.class === 'Folder');
    const objects = feats.filter(f => f.properties.class !== 'Folder');
    expect(folders.length).toBeGreaterThanOrEqual(3);
    // every object's folderId points at a real folder feature
    const folderIds = new Set(folders.map(f => f.id));
    expect(objects.length).toBeGreaterThan(0);
    objects.forEach(o => expect(folderIds.has(o.properties.folderId)).toBe(true));
    // geometry classes: point -> Marker, line/polygon -> Shape
    expect(objects.some(o => o.properties.class === 'Marker' && o.geometry.type === 'Point')).toBe(true);
    expect(objects.some(o => o.properties.class === 'Shape' && o.geometry.type === 'LineString')).toBe(true);
    expect(objects.some(o => o.properties.class === 'Shape' && o.geometry.type === 'Polygon')).toBe(true);
  });

  it('strips popup HTML to plain text in descriptions', () => {
    const feats = folderGroupsToGeoJsonFeatures(collectExportFolderGroups(new Set(['faa_obstacles'])), _uuid);
    const marker = feats.find(f => f.properties.class === 'Marker');
    expect(marker.properties.title).toBe('Tower 200 ft AGL');
    expect(marker.properties.description).not.toContain('<b>');
  });

  it('honours a selected-keys filter', () => {
    const feats = folderGroupsToGeoJsonFeatures(collectExportFolderGroups(new Set(['faa_class_airspace'])), _uuid);
    expect(feats.some(f => f.properties.title === 'Class Airspace' || f.geometry?.type === 'Polygon')).toBe(true);
    expect(feats.some(f => f.geometry?.type === 'Point')).toBe(false); // obstacle excluded
  });
});

describe('doExportGeoJson', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="exportModal" class="modal-overlay active"></div>' +
      '<input type="checkbox" id="expOpsArea" checked>' +
      '<input type="checkbox" id="expWxData" checked>' +
      '<input type="checkbox" id="expCanopyTiff"><input type="checkbox" id="expCanopyKmz">' +
      '<input type="checkbox" id="expViewshedTiff"><input type="checkbox" id="expViewshedKmz">';
    S.mapLayers.faa_obstacles = new MockGroup([new L.Marker(LL(38.7, -120.99), 'Tower 200 ft AGL')]);
  });

  it('writes a FeatureCollection blob with folder integrity', async () => {
    const blobs = captureBlobs(() => doExportGeoJson());
    expect(blobs.length).toBe(1);
    expect(blobs[0].type).toBe('application/geo+json');
    const fc = JSON.parse(await blobs[0].text());
    expect(fc.type).toBe('FeatureCollection');
    const folders = fc.features.filter(f => f.properties.class === 'Folder');
    const labels = folders.map(f => f.properties.title);
    expect(labels).toContain('Operational Area'); // ops polygon folder
    expect(labels).toContain('Info');             // data-summary markers grouped here
    expect(labels).toContain('Obstacle');         // visible layer
    // Operational area is a closed polygon
    const ops = fc.features.find(f => f.properties.title === 'CIRCLE Search Area');
    expect(ops.geometry.type).toBe('Polygon');
    const ring = ops.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Every non-folder feature references an existing folder
    const folderIds = new Set(folders.map(f => f.id));
    fc.features.filter(f => f.properties.class !== 'Folder')
      .forEach(f => expect(folderIds.has(f.properties.folderId)).toBe(true));
  });
});
