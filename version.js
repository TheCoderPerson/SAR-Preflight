// Single source of truth for the app version.
// Bump this on every release — sw.js imports this file, so changing the
// value automatically invalidates the service worker cache AND is detected
// by the browser as a new service worker on next update check.
// Format: YYYY.MM.DD-<letter>  (letter increments for multiple releases same day)
// Uses `var` (not const) so that when build.js inlines this file inside an
// `if` block in dist/sw.js, the binding is hoisted to script scope instead
// of being trapped inside the block.
var SAR_VERSION = '2026.04.13-b';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SAR_VERSION };
}

// Populate the on-page version labels directly from this file so the display
// is guaranteed even if startApp() throws for any reason downstream.
if (typeof document !== 'undefined') {
  var _sarPopulateVersion = function () {
    var hdr = document.getElementById('appVersionLabel');
    if (hdr) hdr.textContent = 'v' + SAR_VERSION;
    var cfg = document.getElementById('appVersionDisplay');
    if (cfg) cfg.textContent = 'v' + SAR_VERSION;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _sarPopulateVersion, { once: true });
  } else {
    _sarPopulateVersion();
  }
}
