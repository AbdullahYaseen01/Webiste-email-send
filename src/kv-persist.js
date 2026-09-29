/**
 * Durable store for Vercel via Upstash Redis REST (not Blob — avoids Blob op limits).
 * Free Upstash DB: https://console.upstash.com
 *
 * Env:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

const STORE_KEY = process.env.REACHLY_STORE_KEY || 'reachly:store';
/** Separate key so contact/queue writes cannot wipe dashboard-added SMTP inboxes */
const SMTP_KEY = process.env.REACHLY_SMTP_KEY || 'reachly:smtp_accounts';
/** Disabled/stopped account flags — must not be lost when queue writes overwrite the main store */
const FLAGS_KEY = process.env.REACHLY_FLAGS_KEY || 'reachly:account_flags';
/**
 * Durable "already mailed" map — survives store races / log clears so CSV re-upload
 * never re-targets addresses this account (or any account) already sent to.
 */
const SENT_KEY = process.env.REACHLY_SENT_KEY || 'reachly:sent_registry';

function hasKv() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstash ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function downloadStore() {
  if (!hasKv()) return null;
  try {
    const data = await redisCommand(['GET', STORE_KEY]);
    if (data.result == null || data.result === '') return null;
    const raw = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[kv] download failed:', err.message);
    return null;
  }
}

async function uploadStore(storeData) {
  if (!hasKv()) return false;
  try {
    const payload = JSON.stringify(storeData);
    // Keep last 7 days of campaign data durable; Upstash free tier is plenty for this size
    await redisCommand(['SET', STORE_KEY, payload]);
    return true;
  } catch (err) {
    console.error('[kv] upload failed:', err.message);
    return false;
  }
}

async function downloadSmtpAccounts() {
  if (!hasKv()) return null;
  try {
    const data = await redisCommand(['GET', SMTP_KEY]);
    if (data.result == null || data.result === '') return null;
    const raw = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed?.accounts || null);
  } catch (err) {
    console.warn('[kv] smtp download failed:', err.message);
    return null;
  }
}

async function uploadSmtpAccounts(accounts) {
  if (!hasKv()) return false;
  try {
    const list = Array.isArray(accounts) ? accounts : [];
    await redisCommand(['SET', SMTP_KEY, JSON.stringify(list)]);
    return true;
  } catch (err) {
    console.error('[kv] smtp upload failed:', err.message);
    return false;
  }
}

async function downloadAccountFlags() {
  if (!hasKv()) return null;
  try {
    const data = await redisCommand(['GET', FLAGS_KEY]);
    if (data.result == null || data.result === '') return null;
    const raw = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const parsed = JSON.parse(raw);
    return {
      disabled: Array.isArray(parsed?.disabled) ? parsed.disabled : [],
      stopped: Array.isArray(parsed?.stopped) ? parsed.stopped : [],
    };
  } catch (err) {
    console.warn('[kv] flags download failed:', err.message);
    return null;
  }
}

async function uploadAccountFlags(flags) {
  if (!hasKv()) return false;
  try {
    const payload = {
      disabled: Array.isArray(flags?.disabled) ? [...new Set(flags.disabled)] : [],
      stopped: Array.isArray(flags?.stopped) ? [...new Set(flags.stopped)] : [],
    };
    await redisCommand(['SET', FLAGS_KEY, JSON.stringify(payload)]);
    return true;
  } catch (err) {
    console.error('[kv] flags upload failed:', err.message);
    return false;
  }
}

async function downloadSentRegistry() {
  if (!hasKv()) return null;
  try {
    const data = await redisCommand(['GET', SENT_KEY]);
    if (data.result == null || data.result === '') return null;
    const raw = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn('[kv] sent registry download failed:', err.message);
    return null;
  }
}

async function uploadSentRegistry(registry) {
  if (!hasKv()) return false;
  try {
    const payload = registry && typeof registry === 'object' ? registry : {};
    await redisCommand(['SET', SENT_KEY, JSON.stringify(payload)]);
    return true;
  } catch (err) {
    console.error('[kv] sent registry upload failed:', err.message);
    return false;
  }
}

function getPersistMode(isServerless) {
  if (hasKv()) {
    return { mode: 'upstash', durable: true, label: 'Upstash Redis (durable)' };
  }
  if (isServerless) {
    return {
      mode: 'ephemeral',
      durable: false,
      label: 'Ephemeral /tmp',
      warning: 'Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (free) so queue/sent logs survive and campaigns do not reset.',
    };
  }
  return { mode: 'disk', durable: true, label: 'Local disk' };
}

module.exports = {
  STORE_KEY,
  SMTP_KEY,
  FLAGS_KEY,
  SENT_KEY,
  hasKv,
  downloadStore,
  uploadStore,
  downloadSmtpAccounts,
  uploadSmtpAccounts,
  downloadAccountFlags,
  uploadAccountFlags,
  downloadSentRegistry,
  uploadSentRegistry,
  getPersistMode,
};
