// Single source of truth for the app version.
// Bump this on every release — sw.js imports this file, so changing the
// value automatically invalidates the service worker cache AND is detected
// by the browser as a new service worker on next update check.
// Format: YYYY.MM.DD-<letter>  (letter increments for multiple releases same day)
// Uses `var` (not const) so that when build.js inlines this file inside an
// `if` block in dist/sw.js, the binding is hoisted to script scope instead
// of being trapped inside the block.
var SAR_VERSION = '2026.04.13-a';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SAR_VERSION };
}
