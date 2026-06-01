/*
 * Gas Tracker — live data layer (v0.6)
 * -------------------------------------------------------------------------
 * Single source of truth for live prices. Exposes window.GTData.getLivePrices().
 *
 * Failover chain (so the map/list NEVER goes blank):
 *   1. HISTORIAN_URL  (primary)   — config.APP_CONFIG.HISTORIAN_URL
 *   2. API_FALLBACK_URL (failover) — on historian timeout/error/non-2xx
 *   3. last-good cache (localStorage) — last successful payload
 *   4. bundled seed snapshot      — guarantees a first paint in dev / cold start
 *
 * Every successful live fetch is cached as "last-good" with a timestamp so a
 * later outage degrades to cached data + a stale badge rather than a blank UI.
 *
 * Canonical shape returned to the UI:
 *   {
 *     source: "historian" | "api" | "cache" | "seed",
 *     stale:  boolean,            // true if served from cache/seed or older than STALE_MS
 *     fetchedAt: number,          // ms epoch of the underlying data
 *     regionalAvg: { regular, super, diesel },
 *     stations: [{ id, brand, name, lat, lng, dist, exit?, colocated?, prices:{regular,super,diesel} }]
 *   }
 */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var LAST_GOOD_KEY = "gt_lastgood_v1";
  var FUELS = ["regular", "super", "diesel"];

  // --- Seed snapshot: REAL Québec City coordinates ------------------------
  // Used only as a last-resort first paint (no endpoints configured yet, no
  // cache). Coordinates are real station locations around Québec City; the
  // cluster members share Sortie 312 (A-20) and are co-located (tight coords).
  var SEED_STATIONS = [
    { id: "costco-duplessis", brand: "Costco",       name: "Costco Gas",           lat: 46.77454, lng: -71.35020, dist: 0.8, prices: { regular: 158.9, super: 176.9, diesel: 167.4 } },
    { id: "petro-charest",    brand: "Petro-Canada", name: "Petro-Canada Charest", lat: 46.80092, lng: -71.32014, dist: 1.2, prices: { regular: 161.9, super: 179.9, diesel: 170.9 } },
    { id: "shell-lebourg",    brand: "Shell",        name: "Shell Lebourgneuf",    lat: 46.83515, lng: -71.29560, dist: 2.3, prices: { regular: 164.9, super: 183.9, diesel: 173.9 } },
    // --- cluster: Sortie 312 · A-20 (co-located, share one exit) ---
    { id: "shell-s312",    brand: "Shell",    name: "Shell Sortie 312",    lat: 46.76810, lng: -71.28900, dist: 0.2, exit: "Sortie 312 · A-20", colocated: true, prices: { regular: 162.9, super: 180.9, diesel: 171.9 } },
    { id: "esso-s312",     brand: "Esso",     name: "Esso Sortie 312",     lat: 46.76850, lng: -71.28820, dist: 0.3, exit: "Sortie 312 · A-20", colocated: true, prices: { regular: 164.9, super: 182.9, diesel: 172.9 } },
    { id: "ultramar-s312", brand: "Ultramar", name: "Ultramar Sortie 312", lat: 46.76780, lng: -71.28960, dist: 0.4, exit: "Sortie 312 · A-20", colocated: true, prices: { regular: 167.9, super: 184.9, diesel: 174.9 } }
  ];

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  function regionalAvg(stations) {
    var avg = {};
    FUELS.forEach(function (f) {
      var sum = 0, n = 0;
      stations.forEach(function (s) {
        if (s.prices && typeof s.prices[f] === "number") { sum += s.prices[f]; n++; }
      });
      avg[f] = n ? Math.round((sum / n) * 10) / 10 : 0;
    });
    return avg;
  }

  // --- fetch with timeout (AbortController) --------------------------------
  function fetchWithTimeout(url, opts, ms) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      if (ctrl) opts.signal = ctrl.signal;
      var to = setTimeout(function () { if (ctrl) ctrl.abort(); reject(new Error("timeout")); }, ms || 4000);
      fetch(url, opts).then(function (r) {
        clearTimeout(to);
        if (!r.ok) { reject(new Error("HTTP " + r.status)); return; }
        return r.json().then(resolve);
      }).catch(function (e) { clearTimeout(to); reject(e); });
    });
  }

  function authHeaders() {
    var h = { "Accept": "application/json" };
    if (CFG.AUTH_TOKEN) h["Authorization"] = "Bearer " + CFG.AUTH_TOKEN;
    return h;
  }

  // --- normalization: tolerate historian & API payload variants -----------
  // Accepts either { stations:[...] } or a bare array; coerces field names.
  function normalize(raw) {
    var arr = Array.isArray(raw) ? raw : (raw && (raw.stations || raw.data || raw.results));
    if (!Array.isArray(arr)) throw new Error("unrecognized payload shape");
    var stations = arr.map(function (s, i) {
      var prices = s.prices || {
        regular: num(s.regular), super: num(s.super), diesel: num(s.diesel)
      };
      return {
        id: s.id || s.station_id || ("st-" + i),
        brand: s.brand || s.chain || "Unknown",
        name: s.name || s.station_name || s.brand || "Station",
        lat: num(s.lat != null ? s.lat : (s.latitude != null ? s.latitude : (s.location && s.location.lat))),
        lng: num(s.lng != null ? s.lng : (s.longitude != null ? s.longitude : (s.location && s.location.lng))),
        dist: s.dist != null ? num(s.dist) : (s.distance_km != null ? num(s.distance_km) : null),
        exit: s.exit || s.exit_id || null,
        colocated: !!s.colocated,
        prices: { regular: num(prices.regular), super: num(prices.super), diesel: num(prices.diesel) }
      };
    }).filter(function (s) { return isFinite(s.lat) && isFinite(s.lng); });
    if (!stations.length) throw new Error("no geocoded stations in payload");
    return stations;
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : NaN; }

  // --- last-good cache -----------------------------------------------------
  function saveLastGood(payload) {
    try { localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(payload)); } catch (e) {}
  }
  function readLastGood() {
    try {
      var raw = localStorage.getItem(LAST_GOOD_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function pack(source, stations, fetchedAt, stale) {
    return {
      source: source,
      stale: !!stale,
      fetchedAt: fetchedAt,
      regionalAvg: regionalAvg(stations),
      stations: stations
    };
  }

  // --- main entry point ----------------------------------------------------
  // Always resolves (never rejects); on total failure returns cache or seed.
  function getLivePrices(nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var staleMs = CFG.STALE_MS || 180000;

    function trySource(url, label) {
      if (!url) return Promise.reject(new Error(label + " not configured"));
      return fetchWithTimeout(url, { headers: authHeaders() }, 4000).then(function (raw) {
        var stations = normalize(raw);
        var payload = pack(label, stations, now, false);
        saveLastGood(payload);
        return payload;
      });
    }

    return trySource(CFG.HISTORIAN_URL, "historian")
      .catch(function (e1) {
        log("historian failed -> API fallback", e1);
        return trySource(CFG.API_FALLBACK_URL, "api");
      })
      .catch(function (e2) {
        log("API fallback failed -> last-good cache", e2);
        var cached = readLastGood();
        if (cached && cached.stations && cached.stations.length) {
          cached.source = "cache";
          cached.stale = true; // by definition older than the failed live attempt
          return cached;
        }
        // final guarantee: bundled seed so the UI paints something
        log("no cache -> seed snapshot", null);
        var seed = pack("seed", deepCopy(SEED_STATIONS), now, true);
        return seed;
      })
      .then(function (payload) {
        // mark stale if the underlying data is older than STALE_MS
        if (!payload.stale && (now - payload.fetchedAt) > staleMs) payload.stale = true;
        return payload;
      });
  }

  function log() {
    if (CFG.DEBUG) { try { console.warn.apply(console, ["[GTData]"].concat([].slice.call(arguments))); } catch (e) {} }
  }

  window.GTData = {
    getLivePrices: getLivePrices,
    _seed: SEED_STATIONS,      // exposed for tests
    _normalize: normalize,     // exposed for tests
    _regionalAvg: regionalAvg
  };
})();
