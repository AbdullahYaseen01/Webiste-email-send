const nodemailer = require('nodemailer');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./store');
const { getAccounts, getAccount, getDefaultAccount } = require('./accounts');
const { htmlToPlain, wrapHtmlEmail, classifySmtpError } = require('./email-utils');
const {
  generatePersonalizedOpener,
  generatePersonalizedClosing,
  generatePersonalizedSubject,
} = require('./personalize-opener');
const { mergeAttachments } = require('./default-attachment');

const transporters = {};
const accountTimers = {};
let lastSendDelayMs = 5000;

const senderState = {
  lastError: null,
  lastSentAt: null,
  accountState: {},
};

function initAccountState(accountId) {
  if (!senderState.accountState[accountId]) {
    const today = new Date().toLocaleDateString('en-CA');
    const persisted = store.getAccountQuotaState(accountId);
    senderState.accountState[accountId] = {
      dailyQuotaHit: !!(persisted.dailyQuotaHit && persisted.quotaHitDate === today),
      quotaHitDate: persisted.quotaHitDate || null,
      blockedUntil: null,
      pausedUntil: null,
      pauseReason: null,
      consecutiveRateLimits: 0,
      isSending: false,
    };
  }
  return senderState.accountState[accountId];
}

function getSmtpConfig(accountId) {
  const acc = getAccount(accountId) || getDefaultAccount();
  if (!acc) return {};
  return {
    id: acc.id,
    host: acc.host,
    port: acc.port,
    secure: acc.secure,
    user: acc.email,
    pass: acc.pass,
    from: acc.from,
    fromName: acc.fromName,
    dailyLimit: acc.dailyLimit,
    sendDelayMs: acc.sendDelayMs,
    protected: acc.protected,
  };
}

function createTransporter(accountId) {
  const cfg = getSmtpConfig(accountId);
  if (!cfg.user || !cfg.pass) {
    throw new Error(`SMTP not configured for ${accountId}`);
  }
  const auth = { user: cfg.user, pass: cfg.pass };
  if (cfg.host === 'smtp.gmail.com') {
    return nodemailer.createTransport({ service: 'gmail', auth, pool: false });
  }
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth, pool: false,
  });
}

function getTransporter(accountId) {
  if (!transporters[accountId]) transporters[accountId] = createTransporter(accountId);
  return transporters[accountId];
}

function resetTransporter(accountId = null) {
  if (accountId) {
    delete transporters[accountId];
    return;
  }
  Object.keys(transporters).forEach(k => delete transporters[k]);
}

async function verifySmtp(accountId) {
  const id = accountId || getDefaultAccount()?.id;
  await createTransporter(id).verify();
  return true;
}

function personalize(text, contact, extras = {}) {
  const c = typeof contact === 'object' ? contact : { name: contact, email: arguments[2] };
  const ctx = { ...c, ...extras };
  const first = ctx.first_name || (ctx.name || '').split(' ')[0] || 'there';
  const last = ctx.last_name || '';
  const fullName = ctx.name || [first, last].filter(Boolean).join(' ') || 'there';

  const location = ctx.city || 'your area';

  const map = {
    '{{first_name}}': first,
    '{{last_name}}': last,
    '{{name}}': fullName,
    '{{title}}': ctx.title || 'your role',
    '{{job_title}}': ctx.title || 'your role',
    '{{company}}': ctx.company || 'your organization',
    '{{website}}': ctx.website || '',
    '{{linkedin}}': ctx.linkedin || '',
    '{{email}}': ctx.email || '',
    '{{city}}': ctx.city || '',
    '{{country}}': ctx.country || '',
    '{{location}}': location,
    '{{industry}}': ctx.industry || 'your industry',
    '{{personalized_opener}}': generatePersonalizedOpener(ctx),
    '{{personalized_closing}}': generatePersonalizedClosing(ctx),
    '{{personalized_subject}}': generatePersonalizedSubject(ctx),
  };

  for (const cv of store.getCustomVariables()) {
    if (cv.token) map[cv.token] = cv.value || '';
  }

  for (const [key, val] of Object.entries(c)) {
    if (typeof val === 'string' && key.startsWith('custom_')) {
      map[`{{${key.replace(/^custom_/, '')}}}`] = val;
    }
  }

  let result = text || '';
  for (const [token, value] of Object.entries(map)) {
    result = result.replace(new RegExp(token.replace(/[{}]/g, '\\$&'), 'gi'), value);
  }
  return result;
}

function buildEmailContent(campaign, contact, accountId) {
  const cfg = getSmtpConfig(accountId);
  const extras = {
    _is_follow_up: campaign.campaign_type === 'follow_up' || campaign.is_follow_up === true,
  };
  const subject = personalize(campaign.subject, contact, extras);
  const rawHtml = personalize(campaign.body_html, contact, extras);
  const preheader = personalize(campaign.preheader || '', contact, extras);

  // Always include a soft opt-out line — helps inbox trust on cold outreach
  const html = wrapHtmlEmail(rawHtml, {
    preheader,
    fromEmail: cfg.from || true,
    includeUnsubscribe: campaign.include_unsubscribe === true,
  });

  const plainSource = campaign.body_text || htmlToPlain(rawHtml);
  const text = personalize(plainSource, contact, extras);

  return { subject, html, text, cfg };
}

function renderPreview(campaign, sampleContact, accountId) {
  const contact = sampleContact || {
    first_name: 'Alex', last_name: 'Morgan', name: 'Alex Morgan',
    title: 'CTO', company: 'Example Technologies', email: 'alex@example.com',
  };
  const { subject, html, text, cfg } = buildEmailContent(campaign, contact, accountId);
  return {
    subject,
    html,
    text,
    from: cfg.from,
    fromName: cfg.fromName,
    to: contact.email,
    sampleContact: contact,
  };
}

function pauseSenderForAccount(accountId, ms, reason) {
  const state = initAccountState(accountId);
  state.pausedUntil = Date.now() + ms;
  state.pauseReason = reason;
  console.log(`[${accountId}] Sender paused for ${Math.round(ms / 1000)}s: ${reason}`);
}

function clearAccountPause(accountId) {
  const state = initAccountState(accountId);
  state.pausedUntil = null;
  state.pauseReason = null;
}

function isAccountPaused(accountId) {
  const state = initAccountState(accountId);
  if (state.pausedUntil && Date.now() < state.pausedUntil) return true;
  if (state.pausedUntil && Date.now() >= state.pausedUntil) {
    clearAccountPause(accountId);
    state.consecutiveRateLimits = Math.max(0, state.consecutiveRateLimits - 1);
  }
  return false;
}

function markAccountDailyQuotaHit(accountId) {
  const today = new Date().toLocaleDateString('en-CA');
  const state = initAccountState(accountId);
  state.dailyQuotaHit = true;
  state.quotaHitDate = today;
  store.setAccountQuotaState(accountId, { dailyQuotaHit: true, quotaHitDate: today });
  store.setMeta({ lastDailyLimitAt: new Date().toISOString() });
}

function accountCanSend(accountId) {
  const acc = getAccount(accountId);
  if (!acc) return false;

  const { isAccountStopped } = require('./accounts');
  if (isAccountStopped(accountId) || store.isAccountStoppedMeta(accountId)) return false;

  const state = initAccountState(accountId);
  const today = new Date().toLocaleDateString('en-CA');

  if (state.blockedUntil && Date.now() < state.blockedUntil) return false;
  if (state.blockedUntil && Date.now() >= state.blockedUntil) state.blockedUntil = null;

  if (state.dailyQuotaHit && state.quotaHitDate === today) return false;

  const remaining = store.getRemainingToday(acc.dailyLimit, accountId);
  if (remaining <= 0) {
    markAccountDailyQuotaHit(accountId);
    return false;
  }

  return true;
}

function accountHasPendingWork(accountId) {
  return store.getPendingCount(accountId) > 0;
}

async function sendOneEmail(campaign, contact, accountId) {
  const cfg = getSmtpConfig(accountId);
  const t = getTransporter(accountId);
  const { subject, html, text } = buildEmailContent(campaign, contact, accountId);

  const mailOptions = {
    from: `"${cfg.fromName}" <${cfg.from}>`,
    replyTo: `"${cfg.fromName}" <${cfg.from}>`,
    to: contact.email,
    subject,
    html,
    text,
    headers: {
      'Message-ID': `<${crypto.randomUUID()}@${cfg.from.split('@')[1] || 'mail.local'}>`,
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
    },
  };

  if (campaign.include_unsubscribe === true) {
    mailOptions.headers['List-Unsubscribe'] = `<mailto:${cfg.from}?subject=unsubscribe>`;
    mailOptions.headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const attachments = mergeAttachments(campaign.attachment);
  if (attachments.length) mailOptions.attachments = attachments;

  const timeoutMs = parseInt(process.env.SEND_TIMEOUT_MS || '60000', 10);
  await Promise.race([
    t.sendMail(mailOptions),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`SMTP send timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    }),
  ]);

  // Hostinger/webmail: SMTP alone does not put mail in Sent — APPEND via IMAP
  const acc = getAccount(accountId);
  if (acc) {
    const { saveCopyToSent } = require('./save-to-sent');
    const saved = await saveCopyToSent(acc, mailOptions);
    if (saved?.ok) {
      console.log(`↩ [${accountId}] Saved to Sent (${saved.path})`);
    }
  }
}

async function sendTestEmail(campaign, testTo, sampleContact, accountId) {
  const contact = { ...sampleContact, email: testTo };
  await sendOneEmail(campaign, contact, accountId || getDefaultAccount()?.id);
  return { sentTo: testTo, previewAs: sampleContact.first_name };
}

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

function getHealthyAccountIds(excludeAccountId = null) {
  return getAccounts()
    .filter(a => a.id !== excludeAccountId && accountCanSend(a.id))
    .map(a => a.id);
}

function getFailoverCandidates(excludeAccountId, tried = []) {
  const triedSet = new Set([...(tried || []), excludeAccountId].filter(Boolean));
  return getHealthyAccountIds(excludeAccountId).filter(id => !triedSet.has(id));
}

/**
 * On send failure: move recipient to next healthy inbox (not for bad recipient addresses).
 */
function tryFailoverToNextAccount(item, fromAccountId, reason) {
  const tried = store.getTriedAccounts(item.queue_id);
  const candidates = getFailoverCandidates(fromAccountId, tried);
  if (candidates.length === 0) return null;

  const nextId = store.failoverQueueItem(
    item.queue_id,
    fromAccountId,
    `${reason} — failover pending`,
    candidates
  );
  if (nextId) {
    store.requeueItem(item.queue_id, `${reason} — moved to ${nextId}`);
    console.warn(`⇄ [${fromAccountId} → ${nextId}] ${item.email}: ${reason}`);
  }
  return nextId;
}

/**
 * When an inbox hits daily limit / is blocked / stopped: move its whole pending queue
 * onto healthy inboxes that still have remaining quota (keeps campaign moving today).
 */
function redistributeFromExhaustedAccount(accountId, reason = 'Daily limit reached') {
  if (!accountId || store.getPendingCount(accountId) === 0) return { moved: 0, targets: {} };

  const candidates = getHealthyAccountIds(accountId);
  if (candidates.length === 0) return { moved: 0, targets: {} };

  const result = store.redistributePendingFromAccount(
    accountId,
    candidates,
    { reason: `${reason} — moved to inbox with remaining limit` }
  );

  if (result.moved > 0) {
    const summary = Object.entries(result.targets).map(([id, n]) => `${id}:${n}`).join(', ');
    console.warn(`⇄ [${accountId}] Redistributed ${result.moved} pending → ${summary}`);
    const { isServerless } = require('./paths');
    if (!isServerless) {
      for (const targetId of Object.keys(result.targets)) {
        if (accountCanSend(targetId) && store.getPendingCount(targetId) > 0) {
          scheduleAccountSender(targetId);
        }
      }
    }
  }
  return result;
}

/** Drain every inbox that cannot send but still owns pending work. */
function redistributeAllExhaustedAccounts(reason = 'Inbox unavailable') {
  const results = [];
  for (const acc of getAccounts()) {
    if (accountCanSend(acc.id)) continue;
    if (store.getPendingCount(acc.id) === 0) continue;
    results.push({ accountId: acc.id, ...redistributeFromExhaustedAccount(acc.id, reason) });
  }
  return results;
}

async function processNextEmailForAccount(accountId) {
  const state = initAccountState(accountId);
  if (state.isSending) return { skipped: true, reason: 'already_sending', accountId };

  if (isAccountPaused(accountId)) {
    return { skipped: true, reason: 'paused', pauseReason: state.pauseReason, accountId };
  }

  if (!accountCanSend(accountId)) {
    // Soft daily limit / blocked / stopped: do not leave this inbox's queue stranded.
    const moved = redistributeFromExhaustedAccount(accountId, 'Daily limit or inbox unavailable');
    return {
      skipped: true,
      reason: 'at_limit',
      accountId,
      redistributed: moved.moved || 0,
      failoverTargets: moved.targets || {},
    };
  }

  const items = store.getPendingQueue(1, accountId);
  if (items.length === 0) {
    if (store.getPendingCount() === 0) store.updateCampaignStatuses();
    stopAccountSender(accountId);
    return { skipped: true, reason: 'queue_empty', accountId };
  }

  const item = items[0];
  const acc = getAccount(accountId);
  const meta = { smtp_account_id: accountId, list_id: item.list_id };

  state.isSending = true;

  try {
    await sendOneEmail(item, item, accountId);
    store.markSent(item.queue_id, item.campaign_id, item.contact_id, item.email, meta);
    store.updateCampaignStatuses();
    state.consecutiveRateLimits = 0;
    senderState.lastError = null;
    senderState.lastSentAt = Date.now();
    lastSendDelayMs = acc?.sendDelayMs || 20000;
    const todayCount = store.getTodaySentCount(accountId);
    console.log(`✓ [${accountId}] Sent to ${item.email} (${todayCount}/${acc.dailyLimit} today)`);
    return { success: true, email: item.email, accountId };
  } catch (err) {
    const classified = classifySmtpError(err);
    senderState.lastError = { ...classified, raw: err.message, at: new Date().toISOString(), accountId };

    // Bad recipient — do not bounce across inboxes
    if (classified.type === 'invalid_recipient') {
      store.markFailed(item.queue_id, item.campaign_id, item.contact_id, item.email, err.message, classified.type, meta);
      store.updateCampaignStatuses();
      console.error(`✗ [${accountId}] Invalid recipient ${item.email}: ${err.message}`);
      return { success: false, email: item.email, error: err.message, accountId };
    }

    if (classified.stopDay) {
      markAccountDailyQuotaHit(accountId);
      stopAccountSender(accountId);
      if (item.is_follow_up) {
        store.deferQueueItem(item.queue_id, classified.message);
        const bulk = redistributeFromExhaustedAccount(accountId, 'Daily limit on inbox');
        console.warn(`⏳ [${accountId}] Follow-up for ${item.email} waits on the same inbox until tomorrow`);
        return {
          success: false,
          email: item.email,
          retry: true,
          redistributed: bulk.moved || 0,
          error: classified.message,
          accountId,
          stopDay: true,
        };
      }
      // Prefer explicit single-item failover for this recipient, then drain the rest of the inbox queue.
      const nextId = tryFailoverToNextAccount(item, accountId, 'Daily limit on inbox');
      const bulk = redistributeFromExhaustedAccount(accountId, 'Daily limit on inbox');
      if (nextId || (bulk.moved || 0) > 0) {
        return {
          success: false,
          email: item.email,
          retry: true,
          failover: nextId || Object.keys(bulk.targets || {})[0] || null,
          redistributed: bulk.moved || 0,
          error: classified.message,
          accountId,
          stopDay: true,
        };
      }
      store.deferQueueItem(item.queue_id, classified.message);
      console.error(`⛔ [${accountId}] Daily limit — no failover left for ${item.email}`);
      return { success: false, email: item.email, error: classified.message, accountId, stopDay: true };
    }

    if (classified.type === 'rate_limit' || classified.type === 'temporary') {
      state.consecutiveRateLimits++;
      const backoff = (classified.pauseMs || 60000) * Math.pow(1.5, Math.max(0, state.consecutiveRateLimits - 1));
      const pauseMs = Math.min(backoff, 1800000);
      pauseSenderForAccount(accountId, pauseMs, classified.message);

      if (!item.is_follow_up) {
        const nextId = tryFailoverToNextAccount(item, accountId, classified.message);
        if (nextId) {
          return { success: false, email: item.email, retry: true, failover: nextId, error: classified.message, accountId };
        }
      }

      const retries = store.getQueueRetries(item.queue_id);
      if (retries < MAX_RETRIES) {
        store.requeueItem(item.queue_id, classified.message);
        console.warn(`↻ [${accountId}] Retry same inbox ${item.email} — ${retries + 1}/${MAX_RETRIES}`);
        return { success: false, email: item.email, retry: true, error: classified.message, accountId };
      }
    }

    if (classified.pauseAll) {
      const pauseMs = acc?.protected ? 7200000 : 3600000;
      pauseSenderForAccount(accountId, pauseMs, classified.message);
      if (acc?.protected) state.blockedUntil = Date.now() + pauseMs;

      if (!item.is_follow_up) {
        const nextId = tryFailoverToNextAccount(item, accountId, classified.message);
        if (nextId) {
          console.error(`⛔ [${accountId}] Blocked — recipient moved to ${nextId}`);
          return { success: false, email: item.email, retry: true, failover: nextId, error: classified.message, accountId };
        }
      }
      store.requeueItem(item.queue_id, classified.message);
      console.error(`⛔ [${accountId}] Blocked — ${item.is_follow_up ? 'follow-up stays on this inbox' : 'no failover'} for ${item.email}`);
      return { success: false, email: item.email, error: classified.message, accountId };
    }

    // Other failures: try next inbox before marking failed (follow-ups stay on the original inbox)
    if (!item.is_follow_up) {
      const nextId = tryFailoverToNextAccount(item, accountId, err.message || classified.message);
      if (nextId) {
        return { success: false, email: item.email, retry: true, failover: nextId, error: err.message, accountId };
      }
    }

    store.markFailed(item.queue_id, item.campaign_id, item.contact_id, item.email, err.message, classified.type, meta);
    store.updateCampaignStatuses();
    console.error(`✗ [${accountId}] Failed ${item.email}: ${err.message}`);
    return { success: false, email: item.email, error: err.message, accountId };
  } finally {
    state.isSending = false;
  }
}

async function processNextEmail() {
  const accounts = getAccounts();
  for (const acc of accounts) {
    if (!accountTimers[acc.id]) continue;
    const result = await processNextEmailForAccount(acc.id);
    if (result.success || result.retry) return result;
  }
  return { skipped: true, reason: 'no_active_workers' };
}

function scheduleAccountSender(accountId) {
  if (accountTimers[accountId]) return;

  const acc = getAccount(accountId);
  const tick = async () => {
    if (!accountTimers[accountId]) return;
    try {
      await processNextEmailForAccount(accountId);
    } catch (err) {
      console.error(`[${accountId}] Send error:`, err.message);
    }

    if (!accountTimers[accountId]) return;

    const pending = store.getPendingCount(accountId);
    if (pending === 0) {
      stopAccountSender(accountId);
      if (store.getPendingCount() === 0) store.updateCampaignStatuses();
      return;
    }
    if (!accountCanSend(accountId)) {
      stopAccountSender(accountId);
      redistributeFromExhaustedAccount(accountId, 'Daily limit or inbox unavailable');
      if (store.getPendingCount() === 0) store.updateCampaignStatuses();
      return;
    }

    const delay = acc?.sendDelayMs || 20000;
    accountTimers[accountId] = setTimeout(tick, delay);
  };

  accountTimers[accountId] = setTimeout(tick, 100);
}

function stopAccountSender(accountId) {
  if (accountTimers[accountId]) {
    clearTimeout(accountTimers[accountId]);
    delete accountTimers[accountId];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a batch of emails in the current request.
 * Required on Vercel (no long-lived setTimeout). Also used by cron + dashboard keepalive.
 */
async function runSenderTick({ force = false, maxPerAccount = null, maxMs = null } = {}) {
  const { isServerless } = require('./paths');
  const started = Date.now();
  // Serverless: short ticks (1/account, parallel) + external cron spacing → low Fluid CPU, stays alive
  const budgetMs = maxMs || parseInt(process.env.SEND_TICK_MAX_MS || (isServerless ? '50000' : '20000'), 10);
  const perAccount = maxPerAccount || parseInt(
    process.env.SEND_TICK_PER_ACCOUNT || (isServerless ? '1' : '2'),
    10
  );
  const results = [];

  const meta = store.getMeta();
  if (meta.userStoppedSender && !force) {
    return { skipped: true, reason: 'user_stopped', results, status: getSenderStatus() };
  }

  for (const acc of getAccounts()) {
    try { store.deferBlockedQueueItems(acc.id); } catch (_) { /* ignore */ }
  }

  // Never auto-unpause user-paused campaigns during ticks
  store.resumeSendingCampaigns({ includePaused: false });
  if (force) store.setMeta({ userStoppedSender: false });

  // Soft daily-limit / blocked / stopped inboxes: move their pending work onto healthy inboxes
  // before this tick runs, so remaining quota is used the same day.
  try {
    redistributeAllExhaustedAccounts('Daily limit or inbox unavailable');
  } catch (err) {
    console.warn('[tick] redistribute failed:', err.message);
  }

  // Parallel per-inbox send — one account failing must not stop others
  const accountJobs = getAccounts().map(async (acc) => {
    const accountResults = [];
    let processed = 0;
    while (processed < perAccount && (Date.now() - started) < budgetMs) {
      try {
        if (!accountCanSend(acc.id)) break;
        if (store.getPendingCount(acc.id) === 0) break;

        const result = await processNextEmailForAccount(acc.id);
        accountResults.push(result);

        if (result.skipped && ['already_sending', 'paused', 'at_limit', 'queue_empty'].includes(result.reason)) {
          break;
        }
        if (result.retry || result.stopDay) break;

        processed += 1;
        // On Vercel skip long sleeps (cron/dashboard provides spacing). Local keeps delay.
        if (!isServerless && processed < perAccount && (Date.now() - started) < budgetMs) {
          await sleep(acc.sendDelayMs || 20000);
        }
      } catch (err) {
        console.error(`[tick] ${acc.id} error:`, err.message);
        accountResults.push({ success: false, accountId: acc.id, error: err.message });
        break;
      }
    }
    return accountResults;
  });

  const nested = await Promise.all(accountJobs);
  for (const batch of nested) results.push(...batch);

  try {
    if (store.getPendingCount() === 0) store.updateCampaignStatuses();
  } catch (_) { /* ignore */ }

  store.setMeta({ lastTickAt: new Date().toISOString() });
  await store.flushPersist();

  const sent = results.filter(r => r.success).length;
  const failed = results.filter(r => r.success === false && !r.retry).length;
  console.log(`[tick] processed=${results.length} sent=${sent} failed=${failed}`);
  return { skipped: false, sent, failed, results, status: getSenderStatus() };
}

function startSender() {
  const { isServerless } = require('./paths');
  store.setMeta({ userStoppedSender: false });
  // User clicked Start — resume paused campaigns that still have queue
  store.resumeSendingCampaigns({ includePaused: true });

  // Serverless cannot keep setTimeout workers alive — tick mode only.
  if (isServerless) {
    const progress = store.getQueueProgress();
    console.log(`Email sender armed (serverless tick mode) — ${progress.pending} pending`);
    return;
  }

  const accounts = getAccounts();
  let started = false;

  for (const acc of accounts) {
    const deferred = store.deferBlockedQueueItems(acc.id);
    if (deferred > 0) {
      console.log(`[${acc.id}] Deferred ${deferred} stuck queue item(s) until tomorrow`);
    }
  }

  // Move work off exhausted inboxes before starting workers.
  redistributeAllExhaustedAccounts('Daily limit or inbox unavailable');

  for (const acc of getAccounts()) {
    const pending = store.getPendingCount(acc.id);
    if (pending > 0 && accountCanSend(acc.id)) {
      scheduleAccountSender(acc.id);
      started = true;
    }
  }

  if (!started) {
    const totalPending = store.getPendingCount();
    if (totalPending === 0) {
      console.log('No pending emails in queue');
    } else {
      console.log('All accounts at daily limit — will resume tomorrow');
    }
    return;
  }

  const progress = store.getQueueProgress();
  const activeWorkers = Object.keys(accountTimers).join(', ');
  console.log(`Email sender started (${activeWorkers}) — #${progress.nextPosition} of ${progress.total} (${progress.pending} remaining)`);
}

function stopSender(userInitiated = true) {
  for (const accountId of Object.keys(accountTimers)) {
    stopAccountSender(accountId);
  }

  if (userInitiated) {
    // Pause all active campaigns so ticks cannot continue sending
    const active = store.getCampaigns().filter(c => ['sending', 'queued'].includes(c.status));
    for (const c of active) {
      store.setCampaignStatus(c.id, 'paused');
    }
    const progress = store.getQueueProgress();
    store.setMeta({
      userStoppedSender: true,
      stoppedAt: new Date().toISOString(),
      stoppedAtPosition: progress.completed,
      stoppedNextEmail: progress.nextEmail,
    });
    console.log(`Sender stopped by user at #${progress.completed} of ${progress.total}`);
  }
}

function resetDailyState() {
  for (const acc of getAccounts()) {
    const state = initAccountState(acc.id);
    state.dailyQuotaHit = false;
    state.quotaHitDate = null;
    state.blockedUntil = null;
    state.pausedUntil = null;
    state.pauseReason = null;
    state.consecutiveRateLimits = 0;
    state.isSending = false;
    store.setAccountQuotaState(acc.id, { dailyQuotaHit: false, quotaHitDate: null });
  }
  store.setMeta({ userStoppedSender: false, lastDailyLimitAt: null, accountQuotas: {} });
}

function getAccountStatuses() {
  return getAccounts().map(acc => {
    const state = initAccountState(acc.id);
    const todaySent = store.getTodaySentCount(acc.id);
    const remaining = store.getRemainingToday(acc.dailyLimit, acc.id);
    const today = new Date().toLocaleDateString('en-CA');
    const paused = isAccountPaused(acc.id);
    return {
      id: acc.id,
      email: acc.email,
      label: acc.label,
      listId: acc.listId,
      listLabel: acc.listLabel,
      protected: acc.protected,
      dailyLimit: acc.dailyLimit,
      sendDelayMs: acc.sendDelayMs,
      todaySent,
      remainingToday: remaining,
      dailyQuotaHit: state.dailyQuotaHit && state.quotaHitDate === today,
      blocked: state.blockedUntil && Date.now() < state.blockedUntil,
      blockedUntil: state.blockedUntil ? new Date(state.blockedUntil).toISOString() : null,
      running: !!accountTimers[acc.id],
      isSending: !!state.isSending,
      userStopped: store.isAccountStoppedMeta(acc.id),
      removable: !!acc.removable,
      source: acc.source || 'env',
      paused: paused || store.isAccountStoppedMeta(acc.id),
      pauseReason: store.isAccountStoppedMeta(acc.id)
        ? 'Stopped from dashboard'
        : (paused ? state.pauseReason : null),
      pausedUntil: paused && state.pausedUntil ? new Date(state.pausedUntil).toISOString() : null,
      pendingQueue: store.getPendingCount(acc.id),
    };
  });
}

function getSenderStatus() {
  const { isServerless } = require('./paths');
  const meta = store.getMeta();
  const progress = store.getQueueProgress();
  const accounts = getAccountStatuses();
  const totalRemaining = accounts.reduce((s, a) => s + a.remainingToday, 0);
  const totalSentToday = accounts.reduce((s, a) => s + a.todaySent, 0);
  const daysLeft = totalRemaining > 0
    ? Math.ceil(progress.pending / totalRemaining)
    : Math.ceil(progress.pending / (accounts[0]?.dailyLimit || 490));
  const timerRunning = accounts.some(a => a.running);
  const isSending = accounts.some(a => a.isSending);
  const pausedAccounts = accounts.filter(a => a.paused);
  const dailyQuotaHit = accounts.length > 0 && accounts.every(a => a.dailyQuotaHit || a.remainingToday <= 0);
  const hasActiveCampaign = (progress.activeCampaigns || []).some(c =>
    ['sending', 'queued'].includes(c.status)
  );
  const armed = !meta.userStoppedSender && progress.pending > 0 && totalRemaining > 0 && hasActiveCampaign;
  // On serverless, "running" means campaign is armed for tick processing (no long-lived timers).
  const running = isServerless ? armed : timerRunning;

  return {
    running,
    isSending,
    serverless: isServerless,
    tickMode: isServerless,
    storage: store.getStorageInfo(),
    lastTickAt: meta.lastTickAt || null,
    accounts,
    todaySent: totalSentToday,
    remainingToday: totalRemaining,
    pendingQueue: progress.pending,
    sendDelayMs: lastSendDelayMs,
    paused: pausedAccounts.length > 0,
    pauseReason: pausedAccounts.map(a => `[${a.id}] ${a.pauseReason}`).join('; ') || null,
    pausedUntil: pausedAccounts[0]?.pausedUntil || null,
    dailyQuotaHit,
    dailyLimitReached: totalRemaining <= 0 && progress.pending > 0,
    lastError: senderState.lastError,
    lastSentAt: senderState.lastSentAt ? new Date(senderState.lastSentAt).toISOString() : null,
    userStopped: meta.userStoppedSender || false,
    stoppedAtPosition: meta.stoppedAtPosition || progress.completed,
    stoppedNextEmail: meta.stoppedNextEmail || progress.nextEmail,
    progress,
    estimatedDaysRemaining: progress.pending > 0 ? daysLeft : 0,
    parallelMode: true,
  };
}

const defaultAccount = getDefaultAccount();
const DAILY_LIMIT = defaultAccount?.dailyLimit || parseInt(process.env.DAILY_LIMIT || '490', 10);

function createCustomTransporter(cfg) {
  const auth = { user: cfg.email || cfg.user, pass: cfg.pass };
  if (cfg.host === 'smtp.gmail.com') {
    return nodemailer.createTransport({ service: 'gmail', auth, pool: false });
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port || 587,
    secure: !!cfg.secure,
    auth,
    pool: false,
  });
}

async function verifyCustomSmtp(cfg) {
  const t = createCustomTransporter(cfg);
  await t.verify();
  return true;
}

async function sendTestWithCustomConfig(cfg, testTo) {
  const t = createCustomTransporter(cfg);
  const fromName = cfg.fromName || cfg.email?.split('@')[0] || 'Test';
  const fromEmail = cfg.email || cfg.user;
  await t.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: testTo,
    subject: 'Reachly — SMTP connection test',
    text: `This is a test email from Reachly.\n\nAccount: ${fromEmail}\nHost: ${cfg.host}:${cfg.port || 587}\n\nIf you received this, your SMTP configuration is working.`,
    html: `<p>This is a test email from <strong>Reachly</strong>.</p><p>Account: ${fromEmail}<br>Host: ${cfg.host}:${cfg.port || 587}</p><p>If you received this, your SMTP configuration is working.</p>`,
  });
  return { sentTo: testTo };
}

module.exports = {
  getSmtpConfig,
  verifySmtp,
  verifyCustomSmtp,
  sendTestWithCustomConfig,
  resetTransporter,
  startSender,
  stopSender,
  runSenderTick,
  getSenderStatus,
  getAccountStatuses,
  queueCampaign: store.queueCampaign,
  processNextEmail,
  resetDailyState,
  sendTestEmail,
  renderPreview,
  personalize,
  DAILY_LIMIT,
};
