#!/usr/bin/env node
/**
 * Gas Tracker — local server (PWA v0.6, corrected server-side architecture).
 *
 * Responsibilities:
 *   1. Serve the static PWA (index.html, sw.js, manifest, icons, data/, dashboard/).
 *   2. GET /api/prices — SERVER-SIDE fetch to the Régie de l'énergie public API,
 *      normalize the response, cache last-good in memory, return prices to the page.
 *      Server-side fetch avoids browser CORS and keeps any key off the client.
 *   3. GET /config.js — inject the browser Google Maps key from env into the page
 *      WITHOUT committing the raw secret to source.
 *
 * Zero dependencies — Node 18+ global fetch / built-in http only. Localhost deploy:
 *   GOOGLE_MAPS_API_KEY_WEB=... node server.mjs   (then open http://localhost:5173)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 5173);

// ============================================================================
// CONFIG — 1-line swaps. Real values come from env; committed defaults are safe.
// ============================================================================
// RnD is confirming the exact Régie de l'énergie PUBLIC endpoint (URL + params +
// response fields) in parallel. Until then this is a clearly-labeled PLACEHOLDER;
// dropping the real URL here (or via env) is a 1-line change. It is the ONLY
// runtime price source — the gen-prices.py fixture is offline dev data, never used here.
const REGIE_API_URL =
  process.env.REGIE_API_URL ||
  "https://PLACEHOLDER.regie-energie.qc.ca/api/essence/prix"; // TODO(RnD): real endpoint
// Browser Maps key (referrer-restricted). Injected to the client via /config.js.
// NEVER hardcode the raw key in committed source — env only; empty => map shows
// a graceful "key missing" state instead of failing.
const GOOGLE_MAPS_API_KEY_WEB = process.env.GOOGLE_MAPS_API_KEY_WEB || "";
const FETCH_TIMEOUT_MS = Number(process.env.REGIE_TIMEOUT_MS || 6000);

// ============================================================================
// DEV SEED — NOT the runtime source. A tiny bootstrap (real Québec stations with
// real lat/lng) so the localhost demo + map + stale badge are exercisable BEFORE
// RnD delivers REGIE_API_URL. Served only when the live fetch fails and there is
// no last-good yet; always reported as stale + source "dev-seed".
// ============================================================================
const SEED = {
  region: "Québec City",
  seedAsOf: "2026-06-01T12:00:00-04:00",
  regionalAvg: { regular: 163.4, super: 181.2, diesel: 172.0 },
  stations: [
    { brand: "Costco",       name: "Costco Gas Québec",       region: "Québec City", lat: 46.8569, lng: -71.2901, prices: { regular: 158.9, super: 176.9, diesel: 167.4 } },
    { brand: "Petro-Canada", name: "Petro-Canada Charest",    region: "Québec City", lat: 46.8003, lng: -71.2741, prices: { regular: 161.9, super: 179.9, diesel: 170.9 } },
    { brand: "Esso",         name: "Esso Sainte-Foy",         region: "Québec City", lat: 46.7805, lng: -71.2918, prices: { regular: 163.4, super: 181.9, diesel: 172.4 } },
    { brand: "Shell",        name: "Shell Lebourgneuf",       region: "Québec City", lat: 46.8602, lng: -71.3104, prices: { regular: 164.9, super: 183.9, diesel: 173.9 } },
    { brand: "Ultramar",     name: "Ultramar Henri-IV",       region: "Québec City", lat: 46.8112, lng: -71.2807, prices: { regular: 165.9, super: 184.9, diesel: 174.9 } },
    { brand: "Couche-Tard",  name: "Couche-Tard Charlesbourg", region: "Québec City", lat: 46.8589, lng: -71.2589, prices: { regular: 162.9, super: 180.9, diesel: 171.4 } }
  ]
};

// In-memory last-good cache (survives transient upstream hiccups, not restarts).
let lastGood = null;

const FUELS = ["regular", "super", "diesel"];

function computeRegionalAvg(stations) {
  const avg = {};
  FUELS.forEach((f) => {
    const vals = stations.map((s) => s.prices && s.prices[f]).filter((v) => typeof v === "number");
    avg[f] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  });
  return avg;
}

/**
 * Normalize the Régie de l'énergie response into the app's shape.
 * RnD: the exact upstream field names are TBD — adjust the mapping below once the
 * real schema is confirmed. Written defensively so a partial/unexpected payload
 * throws (→ falls back to last-good/seed) rather than rendering garbage.
 */
function normalizeRegie(raw) {
  const records = Array.isArray(raw) ? raw : Array.isArray(raw && raw.stations) ? raw.stations
    : Array.isArray(raw && raw.data) ? raw.data : null;
  if (!records || !records.length) throw new Error("unrecognized Régie payload shape");
  const stations = records.map((r) => {
    const lat = Number(r.lat ?? r.latitude ?? r.y);
    const lng = Number(r.lng ?? r.lon ?? r.longitude ?? r.x);
    return {
      brand: String(r.brand ?? r.banniere ?? r.marque ?? "Unknown"),
      name: String(r.name ?? r.nom ?? r.station ?? r.brand ?? "Station"),
      region: String(r.region ?? r.region_admin ?? r.ville ?? "Québec"),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      prices: {
        regular: num(r.regular ?? r.ordinaire ?? r.price ?? r.prix),
        super: num(r.super ?? r.premium ?? r.superieur),
        diesel: num(r.diesel)
      }
    };
  }).filter((s) => typeof s.prices.regular === "number");
  if (!stations.length) throw new Error("Régie payload had no usable price rows");
  return { region: stations[0].region, stations, regionalAvg: computeRegionalAvg(stations) };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }

/** Returns { stale, source, lastUpdated, region, regionalAvg, stations[], error? }. */
async function getPrices() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(REGIE_API_URL, { signal: ctrl.signal, headers: { accept: "application/json" } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error("upstream HTTP " + res.status);
    const data = normalizeRegie(await res.json());
    lastGood = { ...data, lastUpdated: new Date().toISOString() };
    return { ...lastGood, stale: false, source: "regie" };
  } catch (err) {
    const reason = String((err && err.message) || err);
    if (lastGood) {
      return { ...lastGood, stale: true, source: "last-good", error: reason };
    }
    // No last-good yet → labeled dev seed so the local demo isn't blank.
    return {
      region: SEED.region,
      regionalAvg: SEED.regionalAvg,
      stations: SEED.stations,
      lastUpdated: SEED.seedAsOf,
      stale: true,
      source: "dev-seed",
      error: reason
    };
  }
}

// ---- static file serving ----------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon"
};

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/") pathname = "/index.html";
  // cleanUrls: allow /dashboard -> /dashboard/index.html
  if (!extname(pathname)) {
    const asDir = join(ROOT, normalize(pathname), "index.html");
    if (await exists(asDir)) pathname = join(pathname, "index.html");
    else pathname += ".html";
  }
  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT + sep) && filePath !== join(ROOT, "index.html")) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const headers = { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" };
    if (extname(filePath) === ".html" || filePath.endsWith("sw.js")) {
      headers["Cache-Control"] = "no-cache";
    }
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}
async function exists(p) { try { await readFile(p); return true; } catch { return false; } }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET") { res.writeHead(405).end("Method not allowed"); return; }

  if (url.pathname === "/api/prices") {
    const payload = await getPrices();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }).end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === "/config.js") {
    // Browser config — key injected from env, never committed.
    const cfg = { googleMapsApiKey: GOOGLE_MAPS_API_KEY_WEB, pollMs: 60000 };
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    }).end("window.APP_CONFIG = " + JSON.stringify(cfg) + ";");
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ok: true, regieConfigured: !REGIE_API_URL.includes("PLACEHOLDER") }));
    return;
  }
  await serveStatic(req, res);
});

server.listen(PORT, () => {
  const regieReady = !REGIE_API_URL.includes("PLACEHOLDER");
  console.log("Gas Tracker server  → http://localhost:" + PORT);
  console.log("  Régie endpoint   : " + REGIE_API_URL + (regieReady ? "" : "  (PLACEHOLDER — RnD TBD)"));
  console.log("  Maps key (web)   : " + (GOOGLE_MAPS_API_KEY_WEB ? "set via env" : "MISSING (map shows key-missing state)"));
});

export { normalizeRegie, computeRegionalAvg, getPrices };
