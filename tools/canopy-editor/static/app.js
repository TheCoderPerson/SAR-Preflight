/* Canopy Update Tool — frontend.
   Vanilla JS + Leaflet 1.9.4 + leaflet.draw 1.0.4 (same pins as the main app). */
'use strict';

const S = {
  aoiId: null,
  aoiBounds: null,      // L.latLngBounds of the snapped mosaic
  scene: null,          // selected Sentinel-2 item id
  ops: [],
  drawer: null,         // active L.Draw handler
  drawKind: null,       // 'aoi' | 'edit' | 'shadow'
};

// --- Map ---------------------------------------------------------------------
const map = L.map('map', { zoomControl: true }).setView([38.63, -120.54], 12);
L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Esri World Imagery' }
).addTo(map);

const layers = {
  canopy: null,   // L.imageOverlay
  s2: null,
  ndvi: null,
  goes: null,     // L.tileLayer (GIBS)
  goesFire: null,
};
const aoiRect = L.rectangle([[0, 0], [0, 0]], {
  color: '#06b6d4', weight: 1.5, fill: false, dashArray: '4 4',
});
const opsLayer = L.featureGroup().addTo(map);

const $ = id => document.getElementById(id);
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.display = 'none'; }, ms);
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try {
      const j = await res.json();
      msg = j.error || j.detail || msg;
    } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// --- Drawing -----------------------------------------------------------------
function startDraw(kind, handler, btn) {
  if (S.drawer) { S.drawer.disable(); document.querySelectorAll('button.active').forEach(b => b.classList.remove('active')); }
  S.drawKind = kind;
  S.drawer = handler;
  handler.enable();
  if (btn) btn.classList.add('active');
}
map.on(L.Draw.Event.CREATED, e => {
  document.querySelectorAll('button.active').forEach(b => b.classList.remove('active'));
  const kind = S.drawKind;
  S.drawKind = null;
  S.drawer = null;
  if (kind === 'aoi') onAoiDrawn(e.layer);
  else if (kind === 'edit') onEditDrawn(e.layer);
  else if (kind === 'shadow') onShadowDrawn(e.layer);
});

$('btn-draw-aoi').onclick = ev =>
  startDraw('aoi', new L.Draw.Rectangle(map, { shapeOptions: { color: '#06b6d4', weight: 1.5 } }), ev.target);
$('btn-draw-poly').onclick = ev => {
  if (!S.aoiId) return toast('Load an AOI first');
  startDraw('edit', new L.Draw.Polygon(map, { shapeOptions: { color: '#f59e0b', weight: 2 } }), ev.target);
};
$('btn-draw-shadow').onclick = ev => {
  if (!S.aoiId) return toast('Load an AOI first');
  startDraw('shadow', new L.Draw.Polyline(map, { shapeOptions: { color: '#f43f5e', weight: 2 } }), ev.target);
};

// --- AOI ---------------------------------------------------------------------
async function loadAoi(bbox) {
  $('aoi-status').textContent = 'Fetching canopy tiles from Meta S3… (first load of an area can take a minute)';
  try {
    const meta = await api('/api/aoi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox }),
    });
    S.aoiId = meta.aoi_id;
    S.ops = meta.ops || [];
    const b = meta.bounds;
    S.aoiBounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    aoiRect.setBounds(S.aoiBounds).addTo(map);
    map.fitBounds(S.aoiBounds);
    let txt = `AOI ${meta.aoi_id} — ${meta.width}×${meta.height} px @ ${meta.res_m.toFixed(2)} m` +
      `\nTiles: ${meta.tiles_loaded.length}/${meta.quadkeys.length} loaded`;
    if (meta.warnings) txt += '\n⚠ ' + meta.warnings.join('\n⚠ ');
    $('aoi-status').textContent = txt;
    refreshCanopy();
    renderOps();
    ['panel-layers', 'panel-scenes', 'panel-edits'].forEach(id => { $(id).open = true; });
  } catch (e) {
    $('aoi-status').textContent = '✗ ' + e.message;
  }
}
function onAoiDrawn(layer) {
  const b = layer.getBounds();
  loadAoi([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
}
$('btn-bbox').onclick = () => {
  const parts = $('bbox-input').value.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return toast('bbox must be west,south,east,north');
  loadAoi(parts);
};

// --- Layers ------------------------------------------------------------------
function setOverlay(key, url, opacityInput, on) {
  if (layers[key]) { map.removeLayer(layers[key]); layers[key] = null; }
  if (!on || !url || !S.aoiBounds) return;
  layers[key] = L.imageOverlay(url, S.aoiBounds, { opacity: opacityInput.value / 100 }).addTo(map);
}
function refreshCanopy() {
  if (!S.aoiId) return;
  const edited = $('canopy-which').value;
  const url = `/api/canopy.png?aoi_id=${S.aoiId}&edited=${edited}&t=${Date.now()}`;
  setOverlay('canopy', url, $('op-canopy'), $('lyr-canopy').checked);
}
function refreshS2() {
  if (!S.aoiId || !S.scene) return setOverlay('s2', null);
  setOverlay('s2', `/api/s2/preview.png?aoi_id=${S.aoiId}&item=${S.scene}`, $('op-s2'), $('lyr-s2').checked);
}
function refreshNdvi() {
  if (!S.aoiId || !S.scene) return setOverlay('ndvi', null);
  const th = $('ndvi-threshold').value;
  setOverlay('ndvi', `/api/s2/ndvi.png?aoi_id=${S.aoiId}&item=${S.scene}&threshold=${th}`, $('op-ndvi'), $('lyr-ndvi').checked);
}
$('lyr-canopy').onchange = refreshCanopy;
$('canopy-which').onchange = refreshCanopy;
$('op-canopy').oninput = () => layers.canopy && layers.canopy.setOpacity($('op-canopy').value / 100);
$('lyr-s2').onchange = refreshS2;
$('op-s2').oninput = () => layers.s2 && layers.s2.setOpacity($('op-s2').value / 100);
$('lyr-ndvi').onchange = refreshNdvi;
$('op-ndvi').oninput = () => layers.ndvi && layers.ndvi.setOpacity($('op-ndvi').value / 100);
let ndviDebounce = null;
$('ndvi-threshold').oninput = () => {
  $('ndvi-val').textContent = Number($('ndvi-threshold').value).toFixed(2);
  clearTimeout(ndviDebounce);
  ndviDebounce = setTimeout(refreshNdvi, 350);
};

// --- GOES via NASA GIBS (frontend-only; ~10-min cadence, ~20-min latency) -----
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
function goesLayerName(kind) {
  const sat = $('goes-sat').value === 'GOES-East' ? 'GOES-East' : 'GOES-West';
  return kind === 'fire' ? `${sat}_ABI_Fire_Temperature` : `${sat}_ABI_GeoColor`;
}
function fillGoesTimes() {
  const sel = $('goes-time');
  sel.innerHTML = '';
  const now = new Date(Date.now() - 25 * 60000); // allow GIBS ingest latency
  now.setUTCMinutes(Math.floor(now.getUTCMinutes() / 10) * 10, 0, 0);
  for (let i = 0; i < 18; i++) {
    const t = new Date(now.getTime() - i * 10 * 60000);
    const iso = t.toISOString().replace(/\.\d+Z$/, 'Z');
    const opt = document.createElement('option');
    opt.value = iso;
    opt.textContent = iso.slice(11, 16) + 'Z' + (i === 0 ? ' (latest)' : '');
    sel.appendChild(opt);
  }
}
function refreshGoes() {
  ['goes', 'goesFire'].forEach(k => { if (layers[k]) { map.removeLayer(layers[k]); layers[k] = null; } });
  const time = $('goes-time').value;
  if (!time) return;
  const mk = (name, ext, opacity) => L.tileLayer(
    `${GIBS}/${name}/default/${time}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.${ext}`,
    { maxNativeZoom: 8, maxZoom: 19, opacity, attribution: 'NASA GIBS / NOAA GOES' }
  ).addTo(map);
  if ($('lyr-goes').checked) layers.goes = mk(goesLayerName('geocolor'), 'jpg', 0.8);
  if ($('lyr-goes-fire').checked) layers.goesFire = mk(goesLayerName('fire'), 'png', 0.9);
}
fillGoesTimes();
['lyr-goes', 'lyr-goes-fire', 'goes-sat', 'goes-time'].forEach(id => { $(id).onchange = refreshGoes; });

// --- Sentinel-2 scenes ---------------------------------------------------------
(function initDates() {
  const today = new Date(), past = new Date(Date.now() - 90 * 86400000);
  $('s2-end').value = today.toISOString().slice(0, 10);
  $('s2-start').value = past.toISOString().slice(0, 10);
})();
$('btn-scenes').onclick = async () => {
  if (!S.aoiId) return toast('Load an AOI first');
  $('scene-list').textContent = 'Searching Earth Search…';
  try {
    const r = await api(`/api/s2/scenes?aoi_id=${S.aoiId}&start=${$('s2-start').value}&end=${$('s2-end').value}&max_cloud=${$('s2-cloud').value}`);
    const list = $('scene-list');
    list.innerHTML = '';
    if (!r.scenes.length) { list.textContent = 'No scenes — widen dates or raise the cloud limit.'; return; }
    r.scenes.forEach(s => {
      const div = document.createElement('div');
      div.className = 'scene';
      div.innerHTML = `<b>${s.datetime.slice(0, 10)}</b> ${s.datetime.slice(11, 16)}Z · cloud ${s.cloud == null ? '?' : s.cloud.toFixed(0)}% · sun el ${s.sun_elevation == null ? '?' : s.sun_elevation.toFixed(0)}°`;
      div.title = s.id;
      div.onclick = () => selectScene(s, div);
      list.appendChild(div);
    });
  } catch (e) {
    $('scene-list').textContent = '✗ ' + e.message;
  }
};
function selectScene(s, div) {
  document.querySelectorAll('.scene.sel').forEach(el => el.classList.remove('sel'));
  div.classList.add('sel');
  S.scene = s.id;
  S.sceneMeta = s;
  $('lyr-s2').checked = true;
  toast(`Scene ${s.id.slice(0, 30)}… loading preview`);
  refreshS2();
  if ($('lyr-ndvi').checked) refreshNdvi();
}

// --- Edits --------------------------------------------------------------------
$('edit-mode').onchange = () => {
  $('height-row').style.display = $('edit-mode').value === 'set_height' ? '' : 'none';
};
async function onEditDrawn(layer) {
  const mode = $('edit-mode').value;
  const params = {};
  if (mode === 'set_height') params.height_m = Number($('edit-height').value);
  if (mode === 'clear_nonveg') {
    if (!S.scene) return toast('clear-NDVI needs a selected Sentinel-2 scene (panel 3)');
    params.item = S.scene;
    params.ndvi_threshold = Number($('ndvi-threshold').value);
  }
  toast('Applying edit…');
  try {
    const op = await api('/api/edits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aoi_id: S.aoiId, type: mode, geometry: layer.toGeoJSON().geometry, params }),
    });
    S.ops.push(op);
    renderOps();
    refreshCanopy();
    toast(`Edit #${op.id}: ${op.pixels_changed.toLocaleString()} px changed`);
  } catch (e) {
    toast('✗ ' + e.message, 6000);
  }
}
$('btn-undo').onclick = async () => {
  if (!S.aoiId || !S.ops.length) return;
  try {
    await api('/api/edits/undo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aoi_id: S.aoiId }),
    });
    S.ops.pop();
    renderOps();
    refreshCanopy();
  } catch (e) { toast('✗ ' + e.message); }
};
function renderOps() {
  const list = $('op-list');
  list.innerHTML = '';
  opsLayer.clearLayers();
  S.ops.forEach(op => {
    L.geoJSON(op.geometry, { style: { color: '#f59e0b', weight: 1.5, fillOpacity: 0.04 } }).addTo(opsLayer);
    const div = document.createElement('div');
    div.className = 'op';
    const label = op.type === 'set_height' ? `set ${op.params.height_m} m`
      : op.type === 'clear_nonveg' ? `clear NDVI<${op.params.ndvi_threshold}` : 'clear';
    div.innerHTML = `<span>#${op.id} ${label} · ${op.pixels_changed.toLocaleString()} px</span>`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.onclick = async () => {
      try {
        await api(`/api/edits/${op.id}?aoi_id=${S.aoiId}`, { method: 'DELETE' });
        S.ops = S.ops.filter(o => o.id !== op.id);
        renderOps();
        refreshCanopy();
      } catch (e) { toast('✗ ' + e.message); }
    };
    div.appendChild(del);
    list.appendChild(div);
  });
}

// --- Shadow -------------------------------------------------------------------
async function onShadowDrawn(layer) {
  const body = { aoi_id: S.aoiId, line: layer.toGeoJSON().geometry };
  if (S.scene) body.item = S.scene;
  else if ($('shadow-time').value) body.datetime = $('shadow-time').value;
  else return toast('Pick a Sentinel-2 scene or enter a UTC time');
  try {
    const r = await api('/api/shadow', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const el = $('shadow-result');
    el.innerHTML =
      `<b class="ok">≈ ${r.height_m} m tall</b> (±${r.quantization_m} m quantization)\n` +
      `shadow ${r.length_m} m · sun el ${r.sun_elevation}° az ${r.sun_azimuth}°\n` +
      `${r.source}\n` +
      r.warnings.map(w => `<span class="warn">⚠ ${w}</span>`).join('\n');
    const btn = document.createElement('button');
    btn.textContent = `Use ${r.height_m} m as set-height`;
    btn.onclick = () => {
      $('edit-mode').value = 'set_height';
      $('edit-mode').onchange();
      $('edit-height').value = r.height_m;
      $('panel-edits').open = true;
      toast('Now draw the polygon to paint with this height');
    };
    el.appendChild(document.createElement('br'));
    el.appendChild(btn);
    setTimeout(() => map.removeLayer(layer), 8000);
  } catch (e) {
    $('shadow-result').textContent = '✗ ' + e.message;
  }
}

// --- Export -------------------------------------------------------------------
$('btn-export').onclick = async () => {
  if (!S.aoiId) return toast('Load an AOI first');
  const perQk = $('exp-quadkey').checked;
  $('export-result').textContent = perQk
    ? 'Exporting… per-quadkey mode downloads each touched source tile once — this can take several minutes.'
    : 'Exporting…';
  try {
    const r = await api('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aoi_id: S.aoiId, per_quadkey: perQk }),
    });
    let txt = 'Mosaic: ' + r.mosaic;
    if (r.tiles) {
      txt += r.tiles.length
        ? '\n' + r.tiles.map(t => `Tile ${t.quadkey}: ${t.pixels_changed.toLocaleString()} px patched → ${t.path}`).join('\n')
        : '\nNo tiles patched (no edits touch a tile).';
    }
    $('export-result').textContent = txt;
  } catch (e) {
    $('export-result').textContent = '✗ ' + e.message;
  }
};
