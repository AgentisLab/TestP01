/*
 * Gas Tracker — runtime configuration (v0.6)
 * -------------------------------------------------------------------------
 * This file is loaded BEFORE the app and exposes window.APP_CONFIG.
 *
 * SECURITY: This committed copy holds SAFE PLACEHOLDERS ONLY. The real
 * values (Google Maps browser key, historian/API endpoints, auth token) are
 * injected at BUILD time by scripts/gen-config.mjs, which reads Vercel
 * environment variables and OVERWRITES this file in the deploy output.
 *   -> Never commit the raw GOOGLE_MAPS_API_KEY_WEB or AUTH_TOKEN here.
 *
 * GOOGLE_MAPS_API_KEY_WEB is a referrer-restricted browser key (Alex's dev
 * key, held by Ops as a GitHub/Vercel secret). It is safe to ship to the
 * client *once injected*, because HTTP-referrer restrictions bind it to our
 * origin. The empty placeholder below makes local checkouts render a graceful
 * "map key not configured" state instead of breaking.
 */
window.APP_CONFIG = Object.assign(
  {
    // --- Live data layer (dataSource.js) ---
    HISTORIAN_URL: "",      // primary source: historian latest-prices endpoint
    API_FALLBACK_URL: "",   // failover: direct source API
    AUTH_TOKEN: "",         // bearer token for historian/API (build-injected)

    // --- Live map layer (Google Maps JS API) ---
    GOOGLE_MAPS_API_KEY_WEB: "", // referrer-restricted browser key (build-injected)
    MAP_CENTER: { lat: 46.8065, lng: -71.2451 }, // Québec City
    MAP_ZOOM: 12,

    // --- Polling / freshness ---
    POLL_MS: 60000,   // live refresh cadence (60s)
    STALE_MS: 180000  // data older than this is flagged "stale"
  },
  // allow an earlier inline override (e.g. test harness) to win
  window.APP_CONFIG || {}
);
