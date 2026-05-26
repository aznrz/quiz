// Single source of truth for site/app name. Change ONE constant below — every
// user-facing label (browser tab title, hero h1, sidebar brand, login screen,
// footer) updates automatically on next load.
//
// Limitation: manifest.json (PWA name + short_name) is read once by the browser
// at PWA install — can't be changed at runtime. Update it manually if needed.

(function (global) {
  const SITE_NAME = 'Naruto Quiz';

  global.AppBranding = { SITE_NAME };

  function applyBranding() {
    try {
      document.title = SITE_NAME;
      document.querySelectorAll('[data-brand="name"]').forEach(el => {
        el.textContent = SITE_NAME;
      });
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyBranding);
  } else {
    applyBranding();
  }
})(typeof window !== 'undefined' ? window : globalThis);
