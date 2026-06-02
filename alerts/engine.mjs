/**
 * Price-alert trigger engine — PURE, dependency-free, runtime-agnostic.
 *
 * This module decides WHICH alerts should fire given a price snapshot. It does no
 * I/O, no push-sending, no DB — so it runs identically in three homes:
 *   1. TestP01 server.mjs (local dev + the verification harness in this repo), and
 *   2. the Ops historian poller (the recommended PROD home — call evaluate() after
 *      each 15-min ingest with the freshest Neon snapshot), and
 *   3. a Vercel cron function, if that path is chosen instead.
 * Because it is pure, the prod-runtime decision (open with CIO) changes NOTHING here.
 *
 * Snapshot shape == exactly what GET /api/prices already returns, so the engine is
 * decoupled from the price SOURCE (Régie / historian /v1 / poller) and from the
 * still-disputed physical DB schema (task-39c9e7da). Whoever produces the snapshot
 * owns the column mapping; the engine only sees the normalized contract below.
 *
 *   snapshot = {
 *     region, lastUpdated, stale, source,
 *     regionalAvg: { regular, super, diesel },          // ¢/L
 *     stations: [{ brand, name, region, lat, lng, prices: { regular, super, diesel } }]
 *   }
 *
 * PRIVACY (Law 25): the engine NEVER receives user location. Threshold alerts are
 * evaluated fully server-side. Geofence alerts are split: the server selects cheap
 * CANDIDATE stations (price below local average by a delta) and hands their coords
 * to the device; the final "am I within radius?" check happens client-side in the
 * service worker, so precise location stays on-device.
 */

export const FUELS = ['regular', 'super', 'diesel'];

/** Stable, source-independent station id derived from identity fields. */
export function stationKey(s) {
  const raw = `${s.brand || ''}|${s.name || ''}|${s.region || ''}`.toLowerCase();
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (Québec → quebec)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function priceOf(station, fuel) {
  const v = station && station.prices ? station.prices[fuel] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** True if `station` is in `alert`'s scope. scope: 'all' | 'favorites' | string[] of station keys. */
function inScope(alert, station) {
  const scope = alert.scope ?? 'all';
  if (scope === 'all') return true;
  if (scope === 'favorites') {
    const brands = (alert.brands || []).map((b) => String(b).toLowerCase());
    return brands.length === 0 || brands.includes(String(station.brand || '').toLowerCase());
  }
  if (Array.isArray(scope)) return scope.includes(stationKey(station));
  return true;
}

/**
 * THRESHOLD: stations within scope whose price for the alert's fuel is at/below target.
 * Returns matches sorted cheapest-first. Pure.
 */
export function evaluateThreshold(alert, snapshot) {
  const fuel = alert.fuel || 'regular';
  const target = Number(alert.targetCents);
  if (!Number.isFinite(target)) return [];
  return (snapshot.stations || [])
    .filter((s) => inScope(alert, s))
    .map((s) => ({ station: s, price: priceOf(s, fuel) }))
    .filter((m) => m.price != null && m.price <= target)
    .sort((a, b) => a.price - b.price)
    .map((m) => ({
      stationKey: stationKey(m.station),
      brand: m.station.brand,
      name: m.station.name,
      lat: m.station.lat,
      lng: m.station.lng,
      fuel,
      price: m.price,
      target,
    }));
}

/**
 * GEOFENCE (server half): candidate stations cheaper than the local average by at
 * least `deltaCents`. The SW finishes the decision with the user's location + radius.
 * Pure; no location in, no location out.
 */
export function geofenceCandidates(alert, snapshot) {
  const fuel = alert.fuel || 'regular';
  const delta = Number(alert.deltaCents ?? 0);
  const avg = snapshot.regionalAvg ? snapshot.regionalAvg[fuel] : null;
  if (avg == null || !Number.isFinite(avg)) return [];
  const ceiling = avg - delta;
  return (snapshot.stations || [])
    .map((s) => ({ s, price: priceOf(s, fuel) }))
    .filter((m) => m.price != null && m.price <= ceiling && m.s.lat != null && m.s.lng != null)
    .sort((a, b) => a.price - b.price)
    .map((m) => ({
      stationKey: stationKey(m.s),
      brand: m.s.brand,
      name: m.s.name,
      lat: m.s.lat,
      lng: m.s.lng,
      fuel,
      price: m.price,
      avg,
      delta,
    }));
}

/** Build the per-(alert,station,fuel) cooldown key so we don't re-spam each cycle. */
function fireId(alertId, stationKey, fuel) {
  return `${alertId}::${stationKey}::${fuel}`;
}

/**
 * Top-level evaluation. PURE: takes alerts + snapshot + prior fire log, returns the
 * push jobs to send plus the updated fire log. Caller does the actual I/O.
 *
 * Cooldown rule: a given (alert, station, fuel) won't re-fire within `cooldownMs`
 * UNLESS the price dropped strictly below the last value we notified about — a real
 * further drop is worth a second ping. Idempotent given the same inputs.
 *
 * @param {object}  args
 * @param {Array}   args.alerts     enabled alert records (see store.mjs shape)
 * @param {object}  args.snapshot   /api/prices shape
 * @param {object} [args.fireLog]   { [fireId]: { firedAt:number, price:number } }
 * @param {number}  args.now        epoch ms (injected — engine never reads the clock)
 * @param {number} [args.cooldownMs] default 6h
 * @returns {{ jobs: Array, fireLog: object }}
 */
export function evaluate({ alerts = [], snapshot = {}, fireLog = {}, now, cooldownMs = 6 * 3600 * 1000 }) {
  if (typeof now !== 'number') throw new Error('evaluate(): `now` (epoch ms) is required — engine never reads the clock');
  const nextLog = { ...fireLog };
  const jobs = [];

  for (const alert of alerts) {
    if (alert.enabled === false) continue;

    if (alert.type === 'threshold') {
      const matches = evaluateThreshold(alert, snapshot);
      for (const m of matches) {
        const id = fireId(alert.id, m.stationKey, m.fuel);
        const prev = nextLog[id];
        const onCooldown = prev && now - prev.firedAt < cooldownMs && !(m.price < prev.price);
        if (onCooldown) continue;
        nextLog[id] = { firedAt: now, price: m.price };
        jobs.push({
          alertId: alert.id,
          userId: alert.userId,
          kind: 'threshold',
          // Server may send this directly — no location needed.
          payload: {
            kind: 'threshold',
            title: `${labelFuel(m.fuel)} dropped to ${fmt(m.price)}`,
            body: `${m.brand} · ${m.name} is at ${fmt(m.price)} (your target ${fmt(m.target)})`,
            station: m,
            alertId: alert.id,
          },
        });
      }
    } else if (alert.type === 'geofence') {
      const candidates = geofenceCandidates(alert, snapshot);
      if (!candidates.length) continue;
      // One job per alert carrying ALL candidates; SW filters by radius client-side.
      // Cooldown keyed on the alert + the cheapest candidate so repeated identical
      // candidate sets don't re-ping.
      const top = candidates[0];
      const id = fireId(alert.id, top.stationKey, top.fuel);
      const prev = nextLog[id];
      const onCooldown = prev && now - prev.firedAt < cooldownMs && !(top.price < prev.price);
      if (onCooldown) continue;
      nextLog[id] = { firedAt: now, price: top.price };
      jobs.push({
        alertId: alert.id,
        userId: alert.userId,
        kind: 'geofence',
        // SW MUST evaluate proximity before showing. Location stays on-device.
        payload: {
          kind: 'geofence',
          requiresProximity: true,
          radiusKm: Number(alert.radiusKm ?? 5),
          fuel: top.fuel,
          title: `Cheap ${labelFuel(top.fuel)} nearby?`,
          body: `${candidates.length} station(s) under local average — checking if any are within ${Number(alert.radiusKm ?? 5)} km`,
          candidates,
          alertId: alert.id,
        },
      });
    }
  }
  return { jobs, fireLog: nextLog };
}

function fmt(cents) {
  return `${Number(cents).toFixed(1)}¢`;
}
function labelFuel(f) {
  return f === 'super' ? 'Super' : f === 'diesel' ? 'Diesel' : 'Regular';
}

/** Haversine distance in km — exported for the SW + tests (client-side geofence check). */
export function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
