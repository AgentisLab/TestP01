import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  evaluateThreshold,
  geofenceCandidates,
  stationKey,
  distanceKm,
  FUELS,
} from './engine.mjs';

const SNAPSHOT = {
  region: 'Québec City',
  lastUpdated: '2026-06-01T12:00:00-04:00',
  stale: false,
  source: 'test',
  regionalAvg: { regular: 163.4, super: 181.2, diesel: 172.0 },
  stations: [
    { brand: 'Costco', name: 'Costco Gas Québec', region: 'Québec City', lat: 46.8569, lng: -71.2901, prices: { regular: 158.9, super: 176.9, diesel: 167.4 } },
    { brand: 'Esso', name: 'Esso Sainte-Foy', region: 'Québec City', lat: 46.7805, lng: -71.2918, prices: { regular: 163.4, super: 181.9, diesel: 172.4 } },
    { brand: 'Shell', name: 'Shell Lebourgneuf', region: 'Québec City', lat: 46.8602, lng: -71.3104, prices: { regular: 164.9, super: 183.9, diesel: 173.9 } },
  ],
};
const NOW = 1_750_000_000_000;

test('stationKey is stable, slugged, accent-stripped', () => {
  assert.equal(stationKey({ brand: 'Costco', name: 'Costco Gas Québec', region: 'Québec City' }), 'costco-costco-gas-quebec-quebec-city');
});

test('threshold: fires for stations at/below target, cheapest-first', () => {
  const a = { id: 'a1', userId: 'u1', type: 'threshold', fuel: 'regular', targetCents: 159.0, scope: 'all' };
  const m = evaluateThreshold(a, SNAPSHOT);
  assert.equal(m.length, 1);
  assert.equal(m[0].brand, 'Costco');
  assert.equal(m[0].price, 158.9);
});

test('threshold: no fire when nothing is below target', () => {
  const a = { id: 'a2', userId: 'u1', type: 'threshold', fuel: 'regular', targetCents: 150.0, scope: 'all' };
  assert.equal(evaluateThreshold(a, SNAPSHOT).length, 0);
});

test('threshold: scope=favorites limits to chosen brands', () => {
  const a = { id: 'a3', userId: 'u1', type: 'threshold', fuel: 'regular', targetCents: 200, scope: 'favorites', brands: ['Shell'] };
  const m = evaluateThreshold(a, SNAPSHOT);
  assert.equal(m.length, 1);
  assert.equal(m[0].brand, 'Shell');
});

test('geofence: candidates are cheaper than regional avg by delta, with coords', () => {
  const a = { id: 'g1', userId: 'u1', type: 'geofence', fuel: 'regular', deltaCents: 3, radiusKm: 5 };
  const c = geofenceCandidates(a, SNAPSHOT);
  // avg 163.4 - 3 = 160.4 → only Costco (158.9)
  assert.equal(c.length, 1);
  assert.equal(c[0].brand, 'Costco');
  assert.ok(c[0].lat && c[0].lng, 'candidate carries coords for client-side radius check');
});

test('evaluate(): requires injected `now` (engine never reads the clock)', () => {
  assert.throws(() => evaluate({ alerts: [], snapshot: SNAPSHOT }), /now.*required/);
});

test('evaluate(): emits a threshold push job', () => {
  const alerts = [{ id: 'a1', userId: 'u1', type: 'threshold', fuel: 'regular', targetCents: 159, scope: 'all', enabled: true }];
  const { jobs } = evaluate({ alerts, snapshot: SNAPSHOT, now: NOW });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'threshold');
  assert.equal(jobs[0].userId, 'u1');
  assert.match(jobs[0].payload.title, /Regular dropped/);
});

test('evaluate(): geofence job carries candidates + requiresProximity for SW', () => {
  const alerts = [{ id: 'g1', userId: 'u1', type: 'geofence', fuel: 'regular', deltaCents: 3, radiusKm: 5, enabled: true }];
  const { jobs } = evaluate({ alerts, snapshot: SNAPSHOT, now: NOW });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'geofence');
  assert.equal(jobs[0].payload.requiresProximity, true);
  assert.equal(jobs[0].payload.radiusKm, 5);
  assert.ok(jobs[0].payload.candidates.length >= 1);
});

test('evaluate(): cooldown suppresses an immediate re-fire at the same price', () => {
  const alerts = [{ id: 'a1', userId: 'u1', type: 'threshold', fuel: 'regular', targetCents: 159, scope: 'all', enabled: true }];
  const first = evaluate({ alerts, snapshot: SNAPSHOT, now: NOW });
  assert.equal(first.jobs.length, 1);
  const second = evaluate({ alerts, snapshot: SNAPSHOT, fireLog: first.fireLog, now: NOW + 60_000 });
  assert.equal(second.jobs.length, 0, 'within cooldown, same price → no re-fire');
});

test('evaluate(): a further price drop re-fires even within cooldown', () => {
  const alerts = [{ id: 'a1', userId: 'u1', type: 'threshold', fuel: 'regular', targetCents: 159, scope: 'all', enabled: true }];
  const first = evaluate({ alerts, snapshot: SNAPSHOT, now: NOW });
  const cheaper = JSON.parse(JSON.stringify(SNAPSHOT));
  cheaper.stations[0].prices.regular = 154.9;
  const second = evaluate({ alerts, snapshot: cheaper, fireLog: first.fireLog, now: NOW + 60_000 });
  assert.equal(second.jobs.length, 1, 'a strictly lower price is worth a second ping');
});

test('evaluate(): disabled alert never fires', () => {
  const alerts = [{ id: 'a1', userId: 'u1', type: 'threshold', fuel: 'regular', targetCents: 159, scope: 'all', enabled: false }];
  assert.equal(evaluate({ alerts, snapshot: SNAPSHOT, now: NOW }).jobs.length, 0);
});

test('distanceKm: Costco↔Esso ~ 8-9 km, self = 0', () => {
  assert.equal(Math.round(distanceKm(46.8569, -71.2901, 46.8569, -71.2901)), 0);
  const d = distanceKm(46.8569, -71.2901, 46.7805, -71.2918);
  assert.ok(d > 7 && d < 10, `expected ~8.5km, got ${d}`);
});

test('FUELS contract is stable', () => {
  assert.deepEqual(FUELS, ['regular', 'super', 'diesel']);
});
