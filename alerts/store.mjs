/**
 * Alert + push-subscription persistence — repository interface with a local
 * JSON-file backend.
 *
 * WHY a file: TestP01 has no DB and the live Neon schema is under an open decision
 * (task-39c9e7da) with DDL FROZEN by Ops (27k un-backfillable rows). So this local
 * backend lets the whole feature be built and verified end-to-end now, WITHOUT
 * touching Neon. In prod, swap `createFileStore` for a `createPgStore` with the same
 * method surface — callers (server.mjs / the poller) don't change. The required
 * tables are ADDITIVE only (no change to existing stations/prices):
 *
 *   push_subscriptions(user_id text, endpoint text PRIMARY KEY, p256dh text,
 *                      auth text, created_at timestamptz default now())
 *   alerts(id uuid PK, user_id text, type text, fuel text, target_cents numeric,
 *          delta_cents numeric, radius_km numeric, scope text, brands jsonb,
 *          enabled bool, created_at timestamptz, updated_at timestamptz)
 *   alert_fire_log(fire_id text PK, fired_at timestamptz, price numeric)
 *
 * Identity: keyed by a stable device id (`x-user-id`) the client persists OUTSIDE
 * the profile blob, so alerts survive "logout"/redo-onboarding. True multi-device
 * account login needs an auth system this PWA doesn't have yet — flagged as a
 * follow-up, not faked here.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

function uuid() {
  // crypto.randomUUID is available on Node 18+ and in the browser/SW.
  return globalThis.crypto.randomUUID();
}

export async function createFileStore(file) {
  let data = { subscriptions: {}, alerts: {}, fireLog: {} };
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
    data.subscriptions ||= {};
    data.alerts ||= {};
    data.fireLog ||= {};
  } catch {
    /* first run — start empty */
  }

  let writing = Promise.resolve();
  async function flush() {
    // Serialize writes; write-to-temp + rename for crash-safety.
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, file);
    });
    return writing;
  }

  return {
    // ── push subscriptions ────────────────────────────────────────────────
    async addSubscription(userId, sub) {
      if (!userId || !sub || !sub.endpoint) throw new Error('addSubscription: userId + sub.endpoint required');
      data.subscriptions[userId] ||= {};
      data.subscriptions[userId][sub.endpoint] = { ...sub, userId };
      await flush();
      return sub;
    },
    async removeSubscription(userId, endpoint) {
      if (data.subscriptions[userId]) {
        delete data.subscriptions[userId][endpoint];
        await flush();
      }
    },
    getSubscriptions(userId) {
      return Object.values(data.subscriptions[userId] || {});
    },
    allSubscriptions() {
      return Object.values(data.subscriptions).flatMap((byEndpoint) => Object.values(byEndpoint));
    },

    // ── alerts (CRUD) ─────────────────────────────────────────────────────
    listAlerts(userId) {
      return Object.values(data.alerts[userId] || {});
    },
    getAlert(userId, id) {
      return (data.alerts[userId] || {})[id] || null;
    },
    async createAlert(userId, input) {
      if (!userId) throw new Error('createAlert: userId required');
      const id = uuid();
      const now = new Date().toISOString();
      const alert = normalizeAlert({ ...input, id, userId, createdAt: now, updatedAt: now });
      data.alerts[userId] ||= {};
      data.alerts[userId][id] = alert;
      await flush();
      return alert;
    },
    async updateAlert(userId, id, patch) {
      const cur = (data.alerts[userId] || {})[id];
      if (!cur) return null;
      const next = normalizeAlert({ ...cur, ...patch, id, userId, updatedAt: new Date().toISOString() });
      data.alerts[userId][id] = next;
      await flush();
      return next;
    },
    async deleteAlert(userId, id) {
      if ((data.alerts[userId] || {})[id]) {
        delete data.alerts[userId][id];
        await flush();
        return true;
      }
      return false;
    },
    allEnabledAlerts() {
      return Object.values(data.alerts).flatMap((byId) =>
        Object.values(byId).filter((a) => a.enabled !== false),
      );
    },

    // ── fire log (engine cooldown state) ──────────────────────────────────
    getFireLog() {
      return data.fireLog;
    },
    async setFireLog(log) {
      data.fireLog = log || {};
      await flush();
    },
  };
}

/** Validate + coerce an alert record at the boundary (fail fast, fail loud). */
export function normalizeAlert(a) {
  const type = a.type === 'geofence' ? 'geofence' : 'threshold';
  const fuel = ['regular', 'super', 'diesel'].includes(a.fuel) ? a.fuel : 'regular';
  const out = {
    id: a.id,
    userId: a.userId,
    type,
    fuel,
    enabled: a.enabled !== false,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
  if (type === 'threshold') {
    const t = Number(a.targetCents);
    if (!Number.isFinite(t) || t <= 0) throw new Error('threshold alert needs a positive targetCents');
    out.targetCents = t;
    out.scope = a.scope === 'favorites' || Array.isArray(a.scope) ? a.scope : 'all';
    out.brands = Array.isArray(a.brands) ? a.brands.map(String) : [];
  } else {
    const r = Number(a.radiusKm);
    const d = Number(a.deltaCents);
    if (!Number.isFinite(r) || r <= 0) throw new Error('geofence alert needs a positive radiusKm');
    if (!Number.isFinite(d) || d < 0) throw new Error('geofence alert needs a non-negative deltaCents');
    out.radiusKm = r;
    out.deltaCents = d;
  }
  return out;
}
