/**
 * Web Push sender — thin wrapper over the `web-push` library (VAPID auth + RFC 8291
 * aes128gcm payload encryption). Hand-rolling that crypto is a footgun, so we take
 * one well-maintained dependency. It is lazy-loaded: routes that don't send pushes
 * still work if it isn't installed, and the server boots either way.
 *
 * SECRETS: the VAPID *private* key is read from env (VAPID_PRIVATE_KEY) and NEVER
 * committed — same posture as GOOGLE_MAPS_API_KEY_WEB. The *public* key is safe to
 * expose to the browser (that's its job). Generate a dev pair with:
 *     node alerts/push.mjs --generate-keys
 * and put them in .env (gitignored). Prod keys are provisioned by Ops in Vercel env.
 */

let _webpush = null;
let _configured = false;

async function load() {
  if (_webpush) return _webpush;
  try {
    _webpush = (await import('web-push')).default;
    return _webpush;
  } catch {
    throw new Error(
      "web-push not installed — run `npm install` (it's in package.json). " +
        'Push send is disabled until then; the rest of the server still runs.',
    );
  }
}

export function vapidConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

async function ensureConfigured() {
  const wp = await load();
  if (!_configured) {
    if (!vapidConfigured()) {
      throw new Error('VAPID keys missing — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (see `node alerts/push.mjs --generate-keys`)');
    }
    wp.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:alerts@agentislab.ai',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    _configured = true;
  }
  return wp;
}

/**
 * Send one push. Returns { ok } or { ok:false, statusCode, gone } so the caller can
 * prune dead subscriptions (404/410 = endpoint gone).
 */
export async function sendPush(subscription, payloadObj) {
  const wp = await ensureConfigured();
  try {
    await wp.sendNotification(subscription, JSON.stringify(payloadObj), { TTL: 3600 });
    return { ok: true };
  } catch (err) {
    const statusCode = err && err.statusCode;
    return { ok: false, statusCode, gone: statusCode === 404 || statusCode === 410, error: String(err && err.message || err) };
  }
}

/**
 * Fan a set of engine jobs out to a user's subscriptions. Prunes dead endpoints via
 * the provided store. Returns a delivery summary.
 */
export async function deliverJobs(jobs, store) {
  const summary = { sent: 0, failed: 0, pruned: 0, byUser: {} };
  for (const job of jobs) {
    const subs = store.getSubscriptions(job.userId);
    for (const sub of subs) {
      const res = await sendPush(sub, job.payload);
      summary.byUser[job.userId] ||= { sent: 0, failed: 0 };
      if (res.ok) {
        summary.sent++;
        summary.byUser[job.userId].sent++;
      } else {
        summary.failed++;
        summary.byUser[job.userId].failed++;
        if (res.gone) {
          await store.removeSubscription(job.userId, sub.endpoint);
          summary.pruned++;
        }
      }
    }
  }
  return summary;
}

// CLI: generate a VAPID keypair for local dev.
if (process.argv[1] && process.argv[1].endsWith('push.mjs') && process.argv.includes('--generate-keys')) {
  const wp = await load();
  const keys = wp.generateVAPIDKeys();
  console.log('# Add these to .env (gitignored). NEVER commit the private key.');
  console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
  console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
  console.log('VAPID_SUBJECT=mailto:alerts@agentislab.ai');
}
