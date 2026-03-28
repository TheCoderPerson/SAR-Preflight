// ============================================================
// SAR Preflight — Offline & PWA Module
// IndexedDB caching, staleness tracking, connectivity, notifications
// ============================================================

const SAR_DB_NAME = 'sar-preflight-db';
const SAR_DB_VERSION = 2;

// TTL per endpoint in milliseconds
const ENDPOINT_TTL = {
  weather:    30 * 60 * 1000,       // 30 min
  aqi:        30 * 60 * 1000,       // 30 min
  kp:         60 * 60 * 1000,       // 1 hr
  elevation:  7 * 24 * 60 * 60000,  // 7 days
  sunrise:    24 * 60 * 60 * 1000,  // 24 hr
  overpass:   7 * 24 * 60 * 60000,  // 7 days
  airports:   7 * 24 * 60 * 60000,  // 7 days
  nws:        15 * 60 * 1000,       // 15 min
  radar_meta: 5 * 60 * 1000,        // 5 min
};

// --- IndexedDB Helpers ---

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAR_DB_NAME, SAR_DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('apiCache')) {
        const store = db.createObjectStore('apiCache', { keyPath: 'id' });
        store.createIndex('endpoint', 'endpoint', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains('tileRegions')) {
        db.createObjectStore('tileRegions', { keyPath: 'regionId' });
      }
      if (!db.objectStoreNames.contains('appState')) {
        db.createObjectStore('appState', { keyPath: 'key' });
      }
      // Version 2 stores
      if (!db.objectStoreNames.contains('sopProfiles')) {
        db.createObjectStore('sopProfiles', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('missionLogs')) {
        const ml = db.createObjectStore('missionLogs', { keyPath: 'id', autoIncrement: true });
        ml.createIndex('timestamp', 'timestamp', { unique: false });
        ml.createIndex('areaKey', 'areaKey', { unique: false });
      }
      if (!db.objectStoreNames.contains('auditTrail')) {
        const at = db.createObjectStore('auditTrail', { keyPath: 'id', autoIncrement: true });
        at.createIndex('timestamp', 'timestamp', { unique: false });
        at.createIndex('action', 'action', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function areaKey(lat, lng) {
  return `${lat.toFixed(3)}_${lng.toFixed(3)}`;
}

async function cacheApiResponse(endpoint, key, data) {
  try {
    const db = await openDB();
    const tx = db.transaction('apiCache', 'readwrite');
    tx.objectStore('apiCache').put({
      id: `${endpoint}_${key}`,
      endpoint,
      areaKey: key,
      data,
      timestamp: Date.now(),
    });
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('IndexedDB cache write failed:', e);
  }
}

async function getCachedApiResponse(endpoint, key) {
  try {
    const db = await openDB();
    const tx = db.transaction('apiCache', 'readonly');
    const req = tx.objectStore('apiCache').get(`${endpoint}_${key}`);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const record = req.result;
        if (!record) return resolve(null);
        const age = Date.now() - record.timestamp;
        const ttl = ENDPOINT_TTL[endpoint] || 30 * 60 * 1000;
        record.status = classifyStaleness(age, ttl);
        resolve(record);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('IndexedDB cache read failed:', e);
    return null;
  }
}

async function clearApiCache(endpoint) {
  try {
    const db = await openDB();
    const tx = db.transaction('apiCache', 'readwrite');
    const store = tx.objectStore('apiCache');
    if (endpoint) {
      const idx = store.index('endpoint');
      const req = idx.openCursor(IDBKeyRange.only(endpoint));
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    } else {
      store.clear();
    }
    return new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (e) {
    console.warn('IndexedDB cache clear failed:', e);
  }
}

// --- App State Persistence ---

async function saveAppState(key, value) {
  try {
    const db = await openDB();
    const tx = db.transaction('appState', 'readwrite');
    tx.objectStore('appState').put({ key, value, timestamp: Date.now() });
    return new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (e) {
    console.warn('AppState save failed:', e);
  }
}

async function getAppState(key) {
  try {
    const db = await openDB();
    const tx = db.transaction('appState', 'readonly');
    const req = tx.objectStore('appState').get(key);
    return new Promise(resolve => {
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

// --- Tile Region Tracking ---

async function saveTileRegion(regionId, metadata) {
  try {
    const db = await openDB();
    const tx = db.transaction('tileRegions', 'readwrite');
    tx.objectStore('tileRegions').put({ regionId, ...metadata, timestamp: Date.now() });
    return new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (e) {
    console.warn('Tile region save failed:', e);
  }
}

async function getTileRegions() {
  try {
    const db = await openDB();
    const tx = db.transaction('tileRegions', 'readonly');
    const req = tx.objectStore('tileRegions').getAll();
    return new Promise(resolve => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

async function deleteTileRegion(regionId) {
  try {
    const db = await openDB();
    const tx = db.transaction('tileRegions', 'readwrite');
    tx.objectStore('tileRegions').delete(regionId);
    return new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (e) {
    console.warn('Tile region delete failed:', e);
  }
}

// --- Staleness Classification ---

function classifyStaleness(ageMs, ttlMs) {
  if (ageMs <= ttlMs) return 'fresh';
  if (ageMs <= ttlMs * 4) return 'stale';
  return 'expired';
}

function formatAge(ms) {
  if (ms < 60000) return '<1m';
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

// --- Connectivity Monitoring ---

let _isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
let _lastDataTimestamp = null;

function initConnectivity() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', _onConnectivityChange);
  window.addEventListener('offline', _onConnectivityChange);
}

function _onConnectivityChange() {
  _isOnline = navigator.onLine;
  updateConnectivityUI();
  // On reconnect, offer to refresh stale data
  if (_isOnline && typeof S !== 'undefined' && S.currentArea && _lastDataTimestamp) {
    const age = Date.now() - _lastDataTimestamp;
    if (age > 5 * 60 * 1000) { // stale > 5 min
      showReconnectPrompt();
    }
  }
}

function isOnline() { return _isOnline; }

function setLastDataTimestamp(ts) { _lastDataTimestamp = ts; }

function updateConnectivityUI() {
  if (typeof document === 'undefined') return;
  const dot = document.getElementById('statusDot');
  const clockEl = document.getElementById('clockDisplay');
  if (!dot) return;

  if (!_isOnline) {
    dot.style.background = 'var(--accent-red)';
    dot.style.animation = 'none';
    if (_lastDataTimestamp) {
      const age = formatAge(Date.now() - _lastDataTimestamp);
      if (clockEl) clockEl.setAttribute('data-offline', `OFFLINE \u2014 CACHED ${age}`);
    }
  } else {
    dot.style.background = '';
    dot.style.animation = '';
    if (clockEl) clockEl.removeAttribute('data-offline');
  }
}

function showReconnectPrompt() {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById('assessmentBanner');
  if (!banner) return;
  const age = _lastDataTimestamp ? formatAge(Date.now() - _lastDataTimestamp) : '?';
  const existing = document.getElementById('reconnectPrompt');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'reconnectPrompt';
  div.style.cssText = 'padding:8px 16px;background:var(--bg-tertiary);border-bottom:1px solid var(--border);font-family:var(--font-mono);font-size:11px;color:var(--accent-cyan);display:flex;align-items:center;gap:8px;';
  div.innerHTML = `Connection restored \u2014 data is ${age} old. <button class="btn btn-primary" style="padding:3px 10px;font-size:10px;" onclick="refreshData();this.parentElement.remove();">Refresh</button>`;
  banner.parentElement.insertBefore(div, banner.nextSibling);
}

// --- Notification Manager ---

let _lastNotifyTime = 0;
const NOTIFY_COOLDOWN = 5 * 60 * 1000; // 5 min between notifications
const _notifiedConditions = {};

async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

function checkAndNotify(assessResult) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // only notify when backgrounded
  if (Date.now() - _lastNotifyTime < NOTIFY_COOLDOWN) return;

  const conditions = [];
  if (assessResult.level === 'NO-GO') {
    assessResult.issues.forEach(issue => {
      if (!_notifiedConditions[issue] || Date.now() - _notifiedConditions[issue] > 15 * 60 * 1000) {
        conditions.push(issue);
        _notifiedConditions[issue] = Date.now();
      }
    });
  }

  if (conditions.length > 0) {
    _lastNotifyTime = Date.now();
    new Notification('SAR Preflight: NO-GO', {
      body: conditions.join(', '),
      icon: './icons/icon-192.svg',
      tag: 'sar-threshold',
    });
  }
}

// --- SOP Profile CRUD ---

async function saveSopProfile(profile) {
  try {
    const db = await openDB();
    const tx = db.transaction('sopProfiles', 'readwrite');
    tx.objectStore('sopProfiles').put(profile);
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('SOP profile save failed:', e);
  }
}

async function getSopProfile(name) {
  try {
    const db = await openDB();
    const tx = db.transaction('sopProfiles', 'readonly');
    const req = tx.objectStore('sopProfiles').get(name);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('SOP profile get failed:', e);
    return null;
  }
}

async function getAllSopProfiles() {
  try {
    const db = await openDB();
    const tx = db.transaction('sopProfiles', 'readonly');
    const req = tx.objectStore('sopProfiles').getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('SOP profiles getAll failed:', e);
    return [];
  }
}

async function deleteSopProfile(name) {
  try {
    const db = await openDB();
    const tx = db.transaction('sopProfiles', 'readwrite');
    tx.objectStore('sopProfiles').delete(name);
    return new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (e) {
    console.warn('SOP profile delete failed:', e);
  }
}

// --- Mission Log CRUD ---

async function saveMissionLog(entry) {
  try {
    const db = await openDB();
    const tx = db.transaction('missionLogs', 'readwrite');
    const req = tx.objectStore('missionLogs').add(entry);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('Mission log save failed:', e);
    return null;
  }
}

async function getMissionLogs(limit) {
  try {
    const db = await openDB();
    const tx = db.transaction('missionLogs', 'readonly');
    const req = tx.objectStore('missionLogs').getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const results = (req.result || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        resolve(limit ? results.slice(0, limit) : results);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('Mission logs get failed:', e);
    return [];
  }
}

async function getMissionLog(id) {
  try {
    const db = await openDB();
    const tx = db.transaction('missionLogs', 'readonly');
    const req = tx.objectStore('missionLogs').get(id);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('Mission log get failed:', e);
    return null;
  }
}

async function deleteMissionLog(id) {
  try {
    const db = await openDB();
    const tx = db.transaction('missionLogs', 'readwrite');
    tx.objectStore('missionLogs').delete(id);
    return new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (e) {
    console.warn('Mission log delete failed:', e);
  }
}

// --- Audit Trail ---

function logAudit(action, details) {
  openDB().then(db => {
    const tx = db.transaction('auditTrail', 'readwrite');
    tx.objectStore('auditTrail').add({ action, details, timestamp: Date.now() });
  }).catch(e => {
    console.warn('Audit log failed:', e);
  });
}

async function getAuditTrail(limit) {
  try {
    const db = await openDB();
    const tx = db.transaction('auditTrail', 'readonly');
    const req = tx.objectStore('auditTrail').getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const results = (req.result || []).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        resolve(limit ? results.slice(0, limit) : results);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('Audit trail get failed:', e);
    return [];
  }
}

async function clearAuditTrail() {
  try {
    const db = await openDB();
    const tx = db.transaction('auditTrail', 'readwrite');
    tx.objectStore('auditTrail').clear();
    return new Promise(resolve => { tx.oncomplete = resolve; });
  } catch (e) {
    console.warn('Audit trail clear failed:', e);
  }
}

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SAR_DB_NAME, SAR_DB_VERSION, ENDPOINT_TTL,
    openDB, areaKey, cacheApiResponse, getCachedApiResponse, clearApiCache,
    saveAppState, getAppState,
    saveTileRegion, getTileRegions, deleteTileRegion,
    classifyStaleness, formatAge,
    initConnectivity, isOnline, setLastDataTimestamp, updateConnectivityUI,
    requestNotificationPermission, checkAndNotify,
    saveSopProfile, getSopProfile, getAllSopProfiles, deleteSopProfile,
    saveMissionLog, getMissionLogs, getMissionLog, deleteMissionLog,
    logAudit, getAuditTrail, clearAuditTrail,
  };
}
