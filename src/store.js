const fs = require('fs');
const path = require('path');
const { dataDir, isServerless } = require('./paths');
const {
  downloadStore,
  uploadStore,
  downloadSmtpAccounts,
  uploadSmtpAccounts,
  downloadAccountFlags,
  uploadAccountFlags,
  getPersistMode,
  hasKv,
} = require('./kv-persist');

const dbPath = path.join(dataDir, 'store.json');

const empty = () => ({
  contacts: [],
  campaigns: [],
  send_queue: [],
  send_log: [],
  meta: { userStoppedSender: false, lastDailyLimitAt: null, storeVersion: 0 },
  _counters: { contacts: 0, campaigns: 0, send_queue: 0, send_log: 0, replies: 0 },
  replies: [],
});

let memory = null;
let loadedVersion = 0;
let loadedAt = 0;
let persistPromise = Promise.resolve();
let smtpPersistPromise = Promise.resolve();
let flagsPersistPromise = Promise.resolve();
let hydrating = null;

function applySmtpOverlay(data, smtpList) {
  if (!data) return data;
  if (!data.meta) data.meta = {};
  if (Array.isArray(smtpList)) {
    data.meta.saved_smtp_accounts = smtpList;
  }
  return data;
}

function applyFlagsOverlay(data, flags) {
  if (!data || !flags) return data;
  if (!data.meta) data.meta = {};
  if (Array.isArray(flags.disabled)) data.meta.disabled_account_ids = flags.disabled;
  if (Array.isArray(flags.stopped)) data.meta.stopped_account_ids = flags.stopped;
  return data;
}

function currentAccountFlags(data = memory) {
  return {
    disabled: [...(data?.meta?.disabled_account_ids || [])],
    stopped: [...(data?.meta?.stopped_account_ids || [])],
  };
}

function loadFromFile() {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return migrateData(JSON.parse(fs.readFileSync(dbPath, 'utf-8')));
  } catch {
    return null;
  }
}

function saveToFile(data) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[store] Failed to write local store:', err.message);
  }
}

function load() {
  if (memory) return memory;
  memory = loadFromFile() || empty();
  loadedVersion = memory.meta?.storeVersion || 0;
  loadedAt = Date.now();
  return memory;
}

async function ensureFresh(force = false) {
  if (!isServerless && !hasKv()) {
    if (!memory) load();
    return memory;
  }

  if (hydrating) {
    await hydrating;
    return memory;
  }

  const nowMs = Date.now();
  if (!force && memory && nowMs - loadedAt < 800) return memory;

  hydrating = (async () => {
    if (hasKv()) {
      const [remote, smtpRemote, flagsRemote] = await Promise.all([
        downloadStore(),
        downloadSmtpAccounts(),
        downloadAccountFlags(),
      ]);
      if (remote) {
        const remoteVersion = remote.meta?.storeVersion || 0;
        if (!memory || remoteVersion >= loadedVersion) {
          memory = migrateData(remote);
          loadedVersion = remoteVersion;
        } else if (memory && Array.isArray(smtpRemote)) {
          // Keep newer local store body, but never drop durable SMTP inboxes
          applySmtpOverlay(memory, smtpRemote);
        }
      } else if (!memory) {
        memory = loadFromFile() || empty();
        loadedVersion = memory.meta?.storeVersion || 0;
      }

      // Dedicated SMTP key always wins (survives contact-upload races)
      if (memory && Array.isArray(smtpRemote)) {
        applySmtpOverlay(memory, smtpRemote);
      } else if (
        memory
        && Array.isArray(memory.meta?.saved_smtp_accounts)
        && memory.meta.saved_smtp_accounts.length
        && smtpRemote == null
      ) {
        // One-time migrate: copy SMTP out of main store into dedicated key
        scheduleSmtpSave(memory.meta.saved_smtp_accounts);
      }

      // Dedicated flags key always wins (Remove/Stop must survive queue writes)
      if (memory && flagsRemote) {
        applyFlagsOverlay(memory, flagsRemote);
      } else if (
        memory
        && ((memory.meta?.disabled_account_ids || []).length
          || (memory.meta?.stopped_account_ids || []).length)
        && flagsRemote == null
      ) {
        scheduleFlagsSave(currentAccountFlags(memory));
      }

      // Hostinger inboxes: daily limit 400 + IMAP Sent-folder defaults
      if (memory?.meta?.saved_smtp_accounts?.length) {
        let bumped = false;
        for (const a of memory.meta.saved_smtp_accounts) {
          const isHostinger = a.provider === 'hostinger'
            || a.host === 'smtp.hostinger.com'
            || String(a.host || '').includes('hostinger');
          if (!isHostinger) continue;
          if ((parseInt(a.dailyLimit, 10) || 0) < 400) {
            a.dailyLimit = 400;
            bumped = true;
          }
          if (a.provider !== 'hostinger') { a.provider = 'hostinger'; bumped = true; }
          if (!a.imapHost) { a.imapHost = 'imap.hostinger.com'; bumped = true; }
          if (!a.imapPort) { a.imapPort = 993; bumped = true; }
          if (!a.sentFolder) { a.sentFolder = 'INBOX.Sent'; bumped = true; }
        }
        if (bumped) scheduleSmtpSave(memory.meta.saved_smtp_accounts);
      }

      if (memory) saveToFile(memory);
    } else if (!memory) {
      memory = loadFromFile() || empty();
      loadedVersion = memory.meta?.storeVersion || 0;
    }
    loadedAt = Date.now();
  })();

  try {
    await hydrating;
  } finally {
    hydrating = null;
  }
  return memory;
}

function scheduleRemoteSave(data) {
  if (!hasKv()) return;
  const snapshot = JSON.parse(JSON.stringify(data));
  persistPromise = persistPromise
    .then(() => uploadStore(snapshot))
    .catch((err) => console.error('[store] KV persist failed:', err.message));
}

function scheduleSmtpSave(accounts) {
  if (!hasKv()) return;
  const snapshot = JSON.parse(JSON.stringify(accounts || []));
  smtpPersistPromise = smtpPersistPromise
    .then(() => uploadSmtpAccounts(snapshot))
    .catch((err) => console.error('[store] SMTP KV persist failed:', err.message));
}

function scheduleFlagsSave(flags) {
  if (!hasKv()) return;
  const snapshot = {
    disabled: [...(flags?.disabled || [])],
    stopped: [...(flags?.stopped || [])],
  };
  flagsPersistPromise = flagsPersistPromise
    .then(() => uploadAccountFlags(snapshot))
    .catch((err) => console.error('[store] flags KV persist failed:', err.message));
}

async function flushPersist() {
  await Promise.all([persistPromise, smtpPersistPromise, flagsPersistPromise]);
}

async function persistSmtpAccountsNow(accounts) {
  scheduleSmtpSave(accounts);
  await smtpPersistPromise;
}

function getStorageInfo() {
  const info = getPersistMode(isServerless);
  return {
    ...info,
    storeVersion: memory?.meta?.storeVersion || loadedVersion || 0,
    contacts: memory?.contacts?.length || 0,
    sendLog: memory?.send_log?.length || 0,
    pendingQueue: memory?.send_queue?.filter(q => q.status === 'pending').length || 0,
    serverless: isServerless,
  };
}

function migrateData(data) {
  for (const c of data.contacts) {
    if (!c.list_id) c.list_id = 'list1';
  }
  for (const camp of data.campaigns) {
    if (!camp.smtp_account_id) camp.smtp_account_id = 'account1';
    if (!camp.list_id) camp.list_id = 'list1';
  }
  for (const log of data.send_log) {
    if (!log.smtp_account_id) log.smtp_account_id = 'account1';
    if (!log.list_id) log.list_id = 'list1';
    if (!log.failure_type && log.status === 'failed') log.failure_type = 'other';
  }
  return data;
}

function save(data) {
  if (!data.meta) data.meta = {};
  data.meta.storeVersion = (data.meta.storeVersion || 0) + 1;
  data.meta.updatedAt = new Date().toISOString();
  memory = data;
  loadedVersion = data.meta.storeVersion;
  loadedAt = Date.now();
  saveToFile(data);
  scheduleRemoteSave(data);
}

function now() {
  return new Date().toISOString();
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA');
}

function nextId(data, table) {
  data._counters[table] = (data._counters[table] || 0) + 1;
  return data._counters[table];
}

function withStore(fn) {
  const data = load();
  const result = fn(data);
  save(data);
  return result;
}

function withStoreRead(fn) {
  return fn(load());
}

// --- Contacts ---

function getContacts({ search = '', page = 1, limit = 50, list_id } = {}) {
  return withStoreRead((data) => {
    let list = data.contacts;
    if (list_id) list = list.filter(c => c.list_id === list_id);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c => c.email.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q));
    }
    const total = list.length;
    const offset = (page - 1) * limit;
    const contacts = [...list].sort((a, b) => b.id - a.id).slice(offset, offset + limit);
    return { contacts, total, page, limit, list_id: list_id || null };
  });
}

function addContact(email, fields = {}, listId = 'list1') {
  return withStore((data) => {
    const exists = data.contacts.find(c =>
      c.email.toLowerCase() === email.toLowerCase() && c.list_id === listId
    );
    if (exists) throw new Error('UNIQUE constraint failed');
    const contact = {
      id: nextId(data, 'contacts'),
      email: email.trim(),
      name: fields.name || '',
      first_name: fields.first_name || '',
      last_name: fields.last_name || '',
      company: fields.company || '',
      title: fields.title || '',
      website: fields.website || '',
      linkedin: fields.linkedin || '',
      city: fields.city || '',
      country: fields.country || '',
      industry: fields.industry || '',
      company_profile: fields.company_profile || '',
      list_id: listId,
      status: 'active',
      created_at: now(),
    };
    data.contacts.push(contact);
    return contact;
  });
}

function addContactsBulk(rows, listId = 'list1', { skipAlreadySent = true } = {}) {
  const BATCH = 500;
  let added = 0, skipped = 0, skippedAlreadySent = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = withStore((data) => {
      const sentEmails = skipAlreadySent
        ? collectSentEmails(data, { listId: 'all', scope: 'hostinger' })
        : new Set();
      let bAdded = 0, bSkipped = 0, bSkippedSent = 0;
      for (const row of batch) {
        const { email, name, first_name, last_name, company, title, website, linkedin } = row;
        if (!email || !email.includes('@')) { bSkipped++; continue; }
        const emailLower = email.toLowerCase();
        if (sentEmails.has(emailLower)) { bSkipped++; bSkippedSent++; continue; }
        const exists = data.contacts.some(c =>
          c.email.toLowerCase() === emailLower && c.list_id === listId
        );
        if (exists) { bSkipped++; continue; }
        data.contacts.push({
          id: nextId(data, 'contacts'), email,
          name: name || [first_name, last_name].filter(Boolean).join(' '),
          first_name: first_name || '', last_name: last_name || '',
          company: company || '', title: title || '',
          website: website || '', linkedin: linkedin || '',
          city: row.city || '', country: row.country || '', industry: row.industry || '',
          company_profile: row.company_profile || '',
          list_id: listId,
          status: 'active', created_at: now(),
        });
        bAdded++;
      }
      return { added: bAdded, skipped: bSkipped, skippedAlreadySent: bSkippedSent };
    });
    added += result.added;
    skipped += result.skipped;
    skippedAlreadySent += result.skippedAlreadySent;
  }

  return { added, skipped, skippedAlreadySent, listId };
}

/** Round-robin contacts across multiple lists so each sender inbox gets an equal share. */
function addContactsBulkSplit(rows, listIds = ['list1'], { skipAlreadySent = true } = {}) {
  const ids = (listIds || []).filter(Boolean);
  if (ids.length <= 1) {
    return { ...addContactsBulk(rows, ids[0] || 'list1', { skipAlreadySent }), perList: {} };
  }

  const BATCH = 500;
  let added = 0;
  let skipped = 0;
  let skippedAlreadySent = 0;
  let rotate = 0;
  const perList = Object.fromEntries(ids.map((id) => [id, 0]));

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = withStore((data) => {
      const sentEmails = skipAlreadySent
        ? collectSentEmails(data, { listId: 'all', scope: 'hostinger' })
        : new Set();
      let bAdded = 0;
      let bSkipped = 0;
      let bSkippedSent = 0;
      const bPerList = Object.fromEntries(ids.map((id) => [id, 0]));

      for (const row of batch) {
        const { email, name, first_name, last_name, company, title, website, linkedin } = row;
        if (!email || !email.includes('@')) {
          bSkipped++;
          continue;
        }
        const emailLower = email.toLowerCase();
        // Already delivered by Hostinger — do not re-import. Gmail-only history is allowed.
        if (sentEmails.has(emailLower)) {
          bSkipped++;
          bSkippedSent++;
          continue;
        }
        // Skip if this email already exists in any of the target lists
        const existsAnywhere = data.contacts.some(
          (c) => c.email.toLowerCase() === emailLower && ids.includes(c.list_id)
        );
        if (existsAnywhere) {
          bSkipped++;
          continue;
        }

        const listId = ids[rotate % ids.length];
        rotate += 1;

        data.contacts.push({
          id: nextId(data, 'contacts'),
          email,
          name: name || [first_name, last_name].filter(Boolean).join(' '),
          first_name: first_name || '',
          last_name: last_name || '',
          company: company || '',
          title: title || '',
          website: website || '',
          linkedin: linkedin || '',
          city: row.city || '',
          country: row.country || '',
          industry: row.industry || '',
          company_profile: row.company_profile || '',
          list_id: listId,
          status: 'active',
          created_at: now(),
        });
        bAdded++;
        bPerList[listId] += 1;
      }
      return {
        added: bAdded,
        skipped: bSkipped,
        skippedAlreadySent: bSkippedSent,
        perList: bPerList,
        rotate,
      };
    });
    added += result.added;
    skipped += result.skipped;
    skippedAlreadySent += result.skippedAlreadySent;
    rotate = result.rotate;
    for (const id of ids) perList[id] += result.perList[id] || 0;
  }

  return {
    added,
    skipped,
    skippedAlreadySent,
    listId: 'split',
    perList,
    listIds: ids,
  };
}

function deleteContact(id) {
  withStore((data) => { data.contacts = data.contacts.filter(c => c.id !== id); });
}

function deleteAllContacts(listId = null) {
  withStore((data) => {
    if (listId) {
      data.contacts = data.contacts.filter(c => c.list_id !== listId);
    } else {
      data.contacts = [];
    }
  });
}

function suppressContact(contactId, status, reason) {
  withStore((data) => {
    const c = data.contacts.find(x => x.id === contactId);
    if (c) {
      c.status = status;
      c.failure_reason = reason;
      c.suppressed_at = now();
    }
  });
}

function isHostingerSmtpAccount(account) {
  if (!account) return false;
  return account.provider === 'hostinger'
    || account.host === 'smtp.hostinger.com'
    || String(account.host || '').includes('hostinger');
}

/** Hostinger inboxes whose successful sends must never be repeated. */
function getNoResendHosts(data) {
  const accountIds = new Set();
  const listIds = new Set();
  for (const a of data.meta?.saved_smtp_accounts || []) {
    if (!isHostingerSmtpAccount(a)) continue;
    if (a.id) accountIds.add(a.id);
    if (a.listId) listIds.add(a.listId);
  }
  return { accountIds, listIds };
}

function wasSentViaNoResend(data, { smtpAccountId, listId } = {}) {
  const { accountIds, listIds } = getNoResendHosts(data);
  if (!accountIds.size && !listIds.size) return false;
  if (smtpAccountId && accountIds.has(smtpAccountId)) return true;
  if (listId && listIds.has(listId)) return true;
  return false;
}

function collectSentEmails(data, {
  listId = null,
  /** 'hostinger' = only Hostinger-sent (Gmail-sent can be retried). 'all' = any inbox. */
  scope = 'hostinger',
} = {}) {
  const sent = new Set();
  const allLists = !listId || listId === 'all';
  const filterHostinger = scope === 'hostinger';

  for (const log of data.send_log) {
    if (log.status !== 'sent' || !log.email) continue;
    if (!allLists && log.list_id !== listId) continue;
    if (filterHostinger && !wasSentViaNoResend(data, {
      smtpAccountId: log.smtp_account_id,
      listId: log.list_id,
    })) continue;
    sent.add(String(log.email).toLowerCase());
  }
  for (const q of data.send_queue) {
    if (q.status !== 'sent') continue;
    if (filterHostinger && !wasSentViaNoResend(data, {
      smtpAccountId: q.smtp_account_id,
      listId: q.list_id,
    })) continue;
    const email = q.email
      || data.contacts.find(c => c.id === q.contact_id)?.email;
    if (!email) continue;
    if (!allLists) {
      const contact = data.contacts.find(c => c.id === q.contact_id);
      if (contact && contact.list_id !== listId && q.list_id !== listId) continue;
    }
    sent.add(String(email).toLowerCase());
  }
  return sent;
}

/** Addresses already delivered by Hostinger (safe to retry Gmail-only history). */
function getGloballySentEmails() {
  return withStoreRead((data) => collectSentEmails(data, { listId: 'all', scope: 'hostinger' }));
}

function getSentEmailsForList(listId) {
  return withStoreRead((data) => collectSentEmails(data, { listId, scope: 'hostinger' }));
}

function getActiveContactIds(listId = null) {
  return withStoreRead((data) => {
    let contacts = data.contacts.filter(c => c.status === 'active');
    if (listId) contacts = contacts.filter(c => c.list_id === listId);
    return contacts.map(c => c.id);
  });
}

function getEligibleContactIds(listId, { skipAlreadySent = true } = {}) {
  return withStoreRead((data) => {
    const allLists = !listId || listId === 'all';
    // Skip only Hostinger-delivered addresses. Gmail-sent contacts may be retried
    // from Hostinger after Gmail inboxes are removed/disabled.
    const sentEmails = skipAlreadySent
      ? collectSentEmails(data, { listId: 'all', scope: 'hostinger' })
      : new Set();
    return data.contacts
      .filter(c => c.status === 'active' && (allLists || c.list_id === listId))
      .filter(c => !skipAlreadySent || !sentEmails.has(c.email.toLowerCase()))
      .map(c => c.id);
  });
}

/** Which SMTP account successfully sent the parent email to this contact. */
function getSentAccountForContact(parentCampaignId, contactId) {
  return withStoreRead((data) => {
    const logs = data.send_log
      .filter(l =>
        l.campaign_id === parentCampaignId
        && l.contact_id === contactId
        && l.status === 'sent'
      )
      .sort((a, b) => String(b.sent_at || '').localeCompare(String(a.sent_at || '')));
    if (logs[0]?.smtp_account_id) return logs[0].smtp_account_id;

    const q = data.send_queue.find(item =>
      item.campaign_id === parentCampaignId
      && item.contact_id === contactId
      && item.status === 'sent'
      && item.smtp_account_id
    );
    return q?.smtp_account_id || null;
  });
}

function getSuccessfulContactIds(campaignId) {
  return withStoreRead((data) => {
    const ids = new Set();
    for (const log of data.send_log) {
      if (log.campaign_id === campaignId && log.status === 'sent' && log.contact_id) {
        ids.add(log.contact_id);
      }
    }
    for (const q of data.send_queue) {
      if (q.campaign_id === campaignId && q.status === 'sent' && q.contact_id) {
        ids.add(q.contact_id);
      }
    }
    return [...ids].filter(id => {
      const c = data.contacts.find(x => x.id === id);
      return c && c.status === 'active';
    });
  });
}

function isFollowUpCampaign(data, campaignId) {
  const camp = data.campaigns.find(c => c.id === campaignId);
  return camp?.campaign_type === 'follow_up';
}

function queueItemEmail(data, q) {
  return q.email || data.contacts.find(c => c.id === q.contact_id)?.email || '';
}

/** First successful non-follow-up send per email → original SMTP inbox. */
function buildOriginalAccountByEmail(data) {
  const map = new Map();

  const consider = (email, smtpAccountId, campaignId, isFollowUpFlag) => {
    if (!email || !smtpAccountId) return;
    const key = String(email).toLowerCase();
    const follow = !!isFollowUpFlag || isFollowUpCampaign(data, campaignId);
    if (follow) return;
    if (!map.has(key)) map.set(key, smtpAccountId);
  };

  for (const log of data.send_log) {
    if (log.status !== 'sent') continue;
    consider(log.email, log.smtp_account_id, log.campaign_id, log.is_follow_up);
  }
  for (const q of data.send_queue) {
    if (q.status !== 'sent') continue;
    consider(queueItemEmail(data, q), q.smtp_account_id, q.campaign_id, q.is_follow_up);
  }
  return map;
}

function hasFollowUpForEmail(data, emailLower) {
  for (const log of data.send_log) {
    if (log.status !== 'sent' || !log.email) continue;
    if (String(log.email).toLowerCase() !== emailLower) continue;
    if (log.is_follow_up || isFollowUpCampaign(data, log.campaign_id)) return true;
  }
  for (const q of data.send_queue) {
    if (!['sent', 'pending'].includes(q.status)) continue;
    const email = queueItemEmail(data, q);
    if (!email || String(email).toLowerCase() !== emailLower) continue;
    if (q.is_follow_up || isFollowUpCampaign(data, q.campaign_id)) return true;
  }
  return false;
}

function findContactByEmail(data, emailLower) {
  return data.contacts.find(c => c.email.toLowerCase() === emailLower && c.status === 'active')
    || data.contacts.find(c => c.email.toLowerCase() === emailLower)
    || null;
}

/**
 * Match a follow-up CSV to the inbox that originally delivered each address.
 */
function matchFollowUpCsv(rows) {
  return withStoreRead((data) => {
    const originalByEmail = buildOriginalAccountByEmail(data);
    const matched = [];
    const neverSent = [];
    const alreadyFollowed = [];
    const bounced = [];
    const invalid = [];
    const seen = new Set();
    const byAccount = {};

    for (const row of rows || []) {
      const email = String(row.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        if (row.email) invalid.push(String(row.email));
        continue;
      }
      if (seen.has(email)) continue;
      seen.add(email);

      if (hasFollowUpForEmail(data, email)) {
        alreadyFollowed.push(email);
        continue;
      }

      const smtpAccountId = originalByEmail.get(email);
      if (!smtpAccountId) {
        neverSent.push(email);
        continue;
      }

      const contact = findContactByEmail(data, email);
      if (contact && contact.status && contact.status !== 'active') {
        bounced.push(email);
        continue;
      }

      matched.push({
        email,
        contactId: contact?.id || null,
        smtpAccountId,
        first_name: row.first_name || contact?.first_name || '',
        last_name: row.last_name || contact?.last_name || '',
        name: row.name || contact?.name || '',
        company: row.company || contact?.company || '',
        title: row.title || contact?.title || '',
        website: row.website || contact?.website || '',
        linkedin: row.linkedin || contact?.linkedin || '',
      });
      byAccount[smtpAccountId] = (byAccount[smtpAccountId] || 0) + 1;
    }

    return {
      matched,
      neverSent,
      alreadyFollowed,
      bounced,
      invalid,
      unique: seen.size,
      ready: matched.length,
      byAccount,
    };
  });
}

/**
 * Create missing contacts for CSV follow-up and return ids + sticky inbox map.
 */
function prepareFollowUpRecipients(matchedRows, listByAccount = {}) {
  return withStore((data) => {
    const contactIds = [];
    const stickyAccountByContact = {};

    for (const row of matchedRows || []) {
      const email = String(row.email || '').trim().toLowerCase();
      if (!email) continue;

      let contact = row.contactId
        ? data.contacts.find(c => c.id === row.contactId)
        : findContactByEmail(data, email);

      if (!contact) {
        const listId = listByAccount[row.smtpAccountId] || 'list1';
        contact = {
          id: nextId(data, 'contacts'),
          email,
          name: row.name || '',
          first_name: row.first_name || '',
          last_name: row.last_name || '',
          company: row.company || '',
          title: row.title || '',
          website: row.website || '',
          linkedin: row.linkedin || '',
          city: '',
          country: '',
          industry: '',
          company_profile: '',
          list_id: listId,
          status: 'active',
          created_at: now(),
        };
        data.contacts.push(contact);
      }

      if (contact.status !== 'active') continue;
      contactIds.push(contact.id);
      stickyAccountByContact[contact.id] = row.smtpAccountId;
    }

    return { contactIds, stickyAccountByContact };
  });
}

function getCampaignSentCount(campaignId) {
  return withStoreRead((data) => {
    const camp = data.campaigns.find(c => c.id === campaignId);
    if (!camp) return 0;
    return camp.sent_count || 0;
  });
}

function getContactCounts(listId = null) {
  return withStoreRead((data) => {
    let contacts = data.contacts;
    if (listId) contacts = contacts.filter(c => c.list_id === listId);
    return {
      total: contacts.length,
      active: contacts.filter(c => c.status === 'active').length,
      bounced: contacts.filter(c => c.status === 'bounced').length,
      blocked: contacts.filter(c => c.status === 'blocked').length,
      sent: contacts.filter(c => c.status === 'sent').length,
      list_id: listId,
    };
  });
}

function getAllListCounts() {
  return withStoreRead((data) => {
    const lists = {};
    for (const c of data.contacts) {
      const lid = c.list_id || 'list1';
      if (!lists[lid]) lists[lid] = { total: 0, active: 0, bounced: 0, blocked: 0 };
      lists[lid].total++;
      if (c.status === 'active') lists[lid].active++;
      else if (c.status === 'bounced') lists[lid].bounced++;
      else if (c.status === 'blocked') lists[lid].blocked++;
    }
    return lists;
  });
}

// --- Campaigns ---

function getCampaigns() {
  return withStoreRead((data) => [...data.campaigns].sort((a, b) => b.id - a.id));
}

function getCampaign(id) {
  return withStoreRead((data) => {
    const campaign = data.campaigns.find(c => c.id === id);
    if (!campaign) return null;
    const queueStats = {};
    for (const q of data.send_queue.filter(q => q.campaign_id === id)) {
      queueStats[q.status] = (queueStats[q.status] || 0) + 1;
    }
    return { ...campaign, queueStats: Object.entries(queueStats).map(([status, count]) => ({ status, count })) };
  });
}

function createCampaign({ name, subject, body_html, body_text = '', attachment = null, preheader = '', include_unsubscribe = false, smtp_account_id = 'account1', list_id = 'list1', parent_campaign_id = null, campaign_type = 'initial', delay_days = 0 }) {
  return withStore((data) => {
    const campaign = {
      id: nextId(data, 'campaigns'), name, subject, body_html, body_text,
      preheader, include_unsubscribe,
      smtp_account_id, list_id,
      attachment,
      parent_campaign_id,
      campaign_type: campaign_type || 'initial',
      delay_days: delay_days || 0,
      status: 'draft', total_recipients: 0, sent_count: 0, failed_count: 0,
      created_at: now(), started_at: null, completed_at: null,
    };
    data.campaigns.push(campaign);
    return campaign;
  });
}

function updateCampaign(id, fields) {
  withStore((data) => {
    const c = data.campaigns.find(c => c.id === id);
    if (!c) return;
    Object.assign(c, fields);
  });
}

function deleteCampaign(id) {
  return withStore((data) => {
    const campaign = data.campaigns.find(c => c.id === id);
    if (!campaign) return null;

    const pendingRemoved = data.send_queue.filter(
      q => q.campaign_id === id && q.status === 'pending'
    ).length;

    data.send_queue = data.send_queue.filter(q => q.campaign_id !== id);
    data.campaigns = data.campaigns.filter(c => c.id !== id);

    return {
      id,
      name: campaign.name,
      pendingRemoved,
    };
  });
}

function clearSendingHistory() {
  return withStore((data) => {
    const summary = {
      campaigns: (data.campaigns || []).length,
      queue: (data.send_queue || []).length,
      logs: (data.send_log || []).length,
      replies: (data.replies || []).length,
    };
    data.campaigns = [];
    data.send_queue = [];
    data.send_log = [];
    data.replies = [];
    data._counters = {
      ...(data._counters || {}),
      campaigns: 0,
      send_queue: 0,
      send_log: 0,
      replies: 0,
    };
    data.meta = {
      ...(data.meta || {}),
      userStoppedSender: true,
      lastDailyLimitAt: null,
      accountQuotas: {},
    };
    return summary;
  });
}

function setCampaignStatus(id, status) {
  withStore((data) => {
    const c = data.campaigns.find(c => c.id === id);
    if (c) c.status = status;
  });
}

function getCampaignsByStatus(statuses) {
  return withStoreRead((data) => data.campaigns.filter(c => statuses.includes(c.status)));
}

// --- Queue ---

function queueCampaign(campaignId, contactIds, {
  allowResend = false,
  smtpAccountIds = null,
  listAccountMap = null,
  stickyAccountByContact = null,
} = {}) {
  return withStore((data) => {
    const camp = data.campaigns.find(c => c.id === campaignId);
    const listId = camp?.list_id || 'list1';
    const isFollowUp = allowResend || camp?.campaign_type === 'follow_up';
    const accountPool = Array.isArray(smtpAccountIds) && smtpAccountIds.length > 0 ? smtpAccountIds : null;
    const listMap = listAccountMap && typeof listAccountMap === 'object' ? listAccountMap : null;
    let rotateIndex = 0;
    let added = 0;

    const stickyMap = stickyAccountByContact && typeof stickyAccountByContact === 'object'
      ? stickyAccountByContact
      : null;

    // Sticky follow-up: same SMTP account that delivered the first email
    const parentAccountByContact = new Map();
    const originalByEmail = isFollowUp ? buildOriginalAccountByEmail(data) : new Map();
    if (isFollowUp && camp?.parent_campaign_id) {
      const parentId = camp.parent_campaign_id;
      for (const log of data.send_log) {
        if (log.campaign_id === parentId && log.status === 'sent' && log.contact_id && log.smtp_account_id) {
          parentAccountByContact.set(log.contact_id, log.smtp_account_id);
        }
      }
      for (const q of data.send_queue) {
        if (q.campaign_id === parentId && q.status === 'sent' && q.contact_id && q.smtp_account_id) {
          if (!parentAccountByContact.has(q.contact_id)) {
            parentAccountByContact.set(q.contact_id, q.smtp_account_id);
          }
        }
      }
    }

    for (const contactId of contactIds) {
      const contact = data.contacts.find(c => c.id === contactId);
      if (!contact || contact.status !== 'active') continue;

      const alreadyQueued = data.send_queue.some(q =>
        q.campaign_id === campaignId && q.contact_id === contactId
      );
      if (alreadyQueued) continue;

      if (!isFollowUp) {
        // Dedupe only Hostinger deliveries — Gmail-sent addresses may be retried
        const alreadySent = data.send_log.some(l =>
          l.status === 'sent'
          && l.email
          && l.email.toLowerCase() === contact.email.toLowerCase()
          && wasSentViaNoResend(data, {
            smtpAccountId: l.smtp_account_id,
            listId: l.list_id,
          })
        );
        if (alreadySent) continue;
      } else {
        const alreadySentFollowUp = data.send_log.some(l =>
          l.status === 'sent' && l.campaign_id === campaignId && l.contact_id === contactId
        );
        if (alreadySentFollowUp) continue;
      }

      let smtpAccountId = camp?.smtp_account_id || 'account1';
      if (isFollowUp) {
        // Always reuse the inbox that sent the first email (CSV or parent campaign)
        const emailKey = String(contact.email || '').toLowerCase();
        smtpAccountId = stickyMap?.[contactId]
          || stickyMap?.[String(contactId)]
          || parentAccountByContact.get(contactId)
          || originalByEmail.get(emailKey)
          || accountPool?.[0]
          || 'account1';
        if (smtpAccountId === 'all') smtpAccountId = accountPool?.[0] || 'account1';
      } else {
        // Prefer inbox mapped to this contact's list (works for saved Hostinger ids too)
        const listKey = contact.list_id || 'list1';
        const mappedId = (listMap && listMap[listKey])
          || listKey.replace(/^list/, 'account');
        if (accountPool?.includes(mappedId)) {
          smtpAccountId = mappedId;
        } else if (accountPool?.length) {
          smtpAccountId = accountPool[rotateIndex % accountPool.length];
          rotateIndex += 1;
        } else if (smtpAccountId === 'all') {
          smtpAccountId = mappedId || 'account1';
        }
      }

      data.send_queue.push({
        id: nextId(data, 'send_queue'),
        campaign_id: campaignId,
        contact_id: contactId,
        smtp_account_id: smtpAccountId,
        list_id: contact.list_id || (listId === 'all' ? 'list1' : listId),
        status: 'pending',
        error_message: null,
        sent_at: null,
        is_follow_up: !!isFollowUp,
      });
      added++;
    }

    if (camp) {
      camp.total_recipients = data.send_queue.filter(q => q.campaign_id === campaignId).length;
      camp.status = 'queued';
    }
    return data.send_queue.filter(q => q.campaign_id === campaignId && q.status === 'pending').length;
  });
}

function getPendingQueue(limit, accountId = null) {
  return withStoreRead((data) => {
    const now = Date.now();
    const items = data.send_queue
      .filter(q => q.status === 'pending')
      .filter(q => !q.deferred_until || new Date(q.deferred_until).getTime() <= now)
      .sort((a, b) => a.id - b.id);

    const result = [];
    for (const q of items) {
      if (result.length >= limit) break;
      const camp = data.campaigns.find(c => c.id === q.campaign_id);
      if (!camp || !['sending', 'queued'].includes(camp.status)) continue;
      const contact = data.contacts.find(c => c.id === q.contact_id);
      if (!contact || contact.status !== 'active') continue;

      const smtpAccountId = q.smtp_account_id || camp.smtp_account_id || 'account1';
      if (accountId && smtpAccountId !== accountId) continue;

      result.push({
        queue_id: q.id, campaign_id: q.campaign_id, contact_id: q.contact_id,
        smtp_account_id: smtpAccountId,
        list_id: q.list_id || camp.list_id || contact.list_id || 'list1',
        email: contact.email,
        name: contact.name || [contact.first_name, contact.last_name].filter(Boolean).join(' '),
        first_name: contact.first_name || '',
        last_name: contact.last_name || '',
        company: contact.company || '',
        title: contact.title || '',
        website: contact.website || '',
        linkedin: contact.linkedin || '',
        city: contact.city || '',
        country: contact.country || '',
        industry: contact.industry || '',
        company_profile: contact.company_profile || '',
        subject: camp.subject, body_html: camp.body_html, body_text: camp.body_text,
        preheader: camp.preheader || '', include_unsubscribe: camp.include_unsubscribe === true,
        attachment: camp.attachment || null,
        campaign_name: camp.name,
        is_follow_up: !!(q.is_follow_up || camp.campaign_type === 'follow_up'),
      });
    }
    return result;
  });
}

function getPendingCount(accountId = null) {
  return withStoreRead((data) => data.send_queue.filter(q => {
    if (q.status !== 'pending') return false;
    if (!accountId) return true;
    const camp = data.campaigns.find(c => c.id === q.campaign_id);
    const smtpId = q.smtp_account_id || camp?.smtp_account_id || 'account1';
    return smtpId === accountId;
  }).length);
}

function getQueueRetries(queueId) {
  return withStoreRead((data) => {
    const q = data.send_queue.find(q => q.id === queueId);
    return q?.retry_count || 0;
  });
}

function requeueItem(queueId, errorMessage) {
  withStore((data) => {
    const q = data.send_queue.find(q => q.id === queueId);
    if (q) {
      q.status = 'pending';
      q.error_message = errorMessage;
      q.retry_count = (q.retry_count || 0) + 1;
    }
  });
}

/**
 * Move a pending queue item to the next SMTP inbox after a send failure.
 * Returns the new account id, or null if every account was already tried.
 */
function failoverQueueItem(queueId, fromAccountId, errorMessage, candidateAccountIds = []) {
  return withStore((data) => {
    const q = data.send_queue.find(x => x.id === queueId);
    if (!q) return null;

    const tried = new Set([...(q.tried_accounts || []), fromAccountId].filter(Boolean));
    q.tried_accounts = [...tried];
    q.retry_count = (q.retry_count || 0) + 1;
    q.error_message = errorMessage || q.error_message;
    q.status = 'pending';
    q.deferred_until = null;

    const nextId = (candidateAccountIds || []).find(id => id && !tried.has(id));
    if (!nextId) return null;

    q.smtp_account_id = nextId;
    return nextId;
  });
}

/**
 * Pure helper: reassign pending queue rows from an exhausted inbox onto healthy candidates.
 * Initial campaign sends move to the next inbox. Follow-ups stay on the original inbox.
 */
function applyPendingRedistribution(data, fromAccountId, candidateAccountIds = [], { reason = null } = {}) {
  const candidates = [...new Set((candidateAccountIds || []).filter(id => id && id !== fromAccountId))];
  if (!fromAccountId || candidates.length === 0) return { moved: 0, targets: {} };

  let rotate = 0;
  let moved = 0;
  const targets = {};

  for (const q of data.send_queue) {
    if (q.status !== 'pending') continue;

    const camp = data.campaigns.find(c => c.id === q.campaign_id);
    if (!camp || !['sending', 'queued'].includes(camp.status)) continue;
    if (q.is_follow_up || camp.campaign_type === 'follow_up') continue;

    const smtpId = q.smtp_account_id || camp.smtp_account_id || 'account1';
    if (smtpId !== fromAccountId) continue;

    const tried = new Set([...(q.tried_accounts || []), fromAccountId].filter(Boolean));
    const preferred = candidates.filter(id => !tried.has(id));
    const pool = preferred.length > 0 ? preferred : candidates;
    const nextId = pool[rotate % pool.length];
    rotate += 1;

    q.tried_accounts = [...tried];
    q.smtp_account_id = nextId;
    q.deferred_until = null;
    if (reason) q.error_message = reason;
    targets[nextId] = (targets[nextId] || 0) + 1;
    moved += 1;
  }

  return { moved, targets };
}

/**
 * Move all pending work off an inbox that cannot send (daily limit / stopped / blocked).
 * Returns { moved, targets }.
 */
function redistributePendingFromAccount(fromAccountId, candidateAccountIds = [], opts = {}) {
  return withStore((data) => applyPendingRedistribution(data, fromAccountId, candidateAccountIds, opts));
}

function getTriedAccounts(queueId) {
  return withStoreRead((data) => {
    const q = data.send_queue.find(x => x.id === queueId);
    return q?.tried_accounts || [];
  });
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function deferQueueItem(queueId, errorMessage) {
  withStore((data) => {
    const q = data.send_queue.find(q => q.id === queueId);
    if (q) {
      q.status = 'pending';
      q.error_message = errorMessage;
      q.deferred_until = endOfToday();
    }
  });
}

function deferBlockedQueueItems(accountId = null) {
  return withStore((data) => {
    let count = 0;
    for (const q of data.send_queue) {
      if (q.status !== 'pending') continue;
      const camp = data.campaigns.find(c => c.id === q.campaign_id);
      const smtpId = q.smtp_account_id || camp?.smtp_account_id || 'account1';
      if (accountId && smtpId !== accountId) continue;
      const msg = (q.error_message || '').toLowerCase();
      const stuck = msg.includes('daily') && msg.includes('limit') && (q.retry_count || 0) >= 3;
      if (stuck) {
        q.deferred_until = endOfToday();
        count++;
      }
    }
    return count;
  });
}

function getAccountQuotaState(accountId) {
  const meta = getMeta();
  return meta.accountQuotas?.[accountId] || {};
}

function setAccountQuotaState(accountId, fields) {
  const meta = getMeta();
  const accountQuotas = { ...(meta.accountQuotas || {}) };
  accountQuotas[accountId] = { ...(accountQuotas[accountId] || {}), ...fields };
  setMeta({ accountQuotas });
}

function pauseAllCampaigns() {
  withStore((data) => {
    for (const c of data.campaigns) {
      if (['sending', 'queued'].includes(c.status)) c.status = 'paused';
    }
  });
}

function pauseCampaignsForAccount(accountId) {
  withStore((data) => {
    for (const c of data.campaigns) {
      if (['sending', 'queued'].includes(c.status) && (c.smtp_account_id || 'account1') === accountId) {
        c.status = 'paused';
      }
    }
  });
}

function markSent(queueId, campaignId, contactId, email, meta = {}) {
  withStore((data) => {
    const q = data.send_queue.find(q => q.id === queueId);
    if (q) { q.status = 'sent'; q.sent_at = now(); }
    const contact = data.contacts.find(c => c.id === contactId);
    data.send_log.push({
      id: nextId(data, 'send_log'), campaign_id: campaignId, contact_id: contactId,
      email, status: 'sent', error_message: null, sent_at: now(),
      smtp_account_id: meta.smtp_account_id || q?.smtp_account_id || 'account1',
      list_id: meta.list_id || q?.list_id || contact?.list_id || 'list1',
    });
    const camp = data.campaigns.find(c => c.id === campaignId);
    if (camp) camp.sent_count++;
  });
}

function markFailed(queueId, campaignId, contactId, email, errorMessage, failureType = 'other', meta = {}) {
  withStore((data) => {
    const q = data.send_queue.find(q => q.id === queueId);
    if (q) { q.status = 'failed'; q.error_message = errorMessage; q.sent_at = now(); }
    const contact = data.contacts.find(c => c.id === contactId);
    const listId = meta.list_id || q?.list_id || contact?.list_id || 'list1';
    data.send_log.push({
      id: nextId(data, 'send_log'), campaign_id: campaignId, contact_id: contactId,
      email, status: 'failed', error_message: errorMessage, failure_type: failureType, sent_at: now(),
      smtp_account_id: meta.smtp_account_id || q?.smtp_account_id || 'account1',
      list_id: listId,
    });
    const camp = data.campaigns.find(c => c.id === campaignId);
    if (camp) camp.failed_count++;

    if (contact && ['invalid_recipient', 'blocked', 'permanent'].includes(failureType)) {
      contact.status = failureType === 'invalid_recipient' ? 'bounced' : 'blocked';
      contact.failure_reason = errorMessage;
      contact.suppressed_at = now();
    }
  });
}

function updateCampaignStatuses() {
  withStore((data) => {
    for (const camp of data.campaigns.filter(c => ['sending', 'queued'].includes(c.status))) {
      const pending = data.send_queue.filter(q => q.campaign_id === camp.id && q.status === 'pending').length;
      if (pending === 0) {
        camp.status = 'completed';
        camp.completed_at = now();
      } else if (camp.status === 'queued') {
        camp.status = 'sending';
        camp.started_at = now();
      }
    }
  });
}

// --- Logs & Stats ---

function getTodaySentCount(accountId = null) {
  return withStoreRead((data) => {
    const today = todayLocal();
    return data.send_log.filter(l => {
      if (l.status !== 'sent' || l.sent_at.slice(0, 10) !== today) return false;
      if (accountId) return l.smtp_account_id === accountId;
      return true;
    }).length;
  });
}

function getRemainingToday(limit, accountId = null) {
  return Math.max(0, limit - getTodaySentCount(accountId));
}

function getRecentLogs(limit = 20) {
  return withStoreRead((data) => {
    return [...data.send_log]
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))
      .slice(0, limit)
      .map(log => {
        const contact = data.contacts.find(c => c.id === log.contact_id);
        return { ...log, contact_name: contact?.name || null };
      });
  });
}

function getLast7Days() {
  return withStoreRead((data) => {
    const days = {};
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const log of data.send_log) {
      if (log.status !== 'sent' || new Date(log.sent_at) < cutoff) continue;
      const day = log.sent_at.slice(0, 10);
      days[day] = (days[day] || 0) + 1;
    }
    return Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).map(([day, sent]) => ({ day, sent }));
  });
}

function getCampaignStatusCounts() {
  return withStoreRead((data) => {
    const counts = {};
    for (const c of data.campaigns) counts[c.status] = (counts[c.status] || 0) + 1;
    return Object.entries(counts).map(([status, count]) => ({ status, count }));
  });
}

function getMeta() {
  return withStoreRead((data) => data.meta || {});
}

function setMeta(fields) {
  withStore((data) => {
    data.meta = { ...(data.meta || {}), ...fields };
  });
}

function getCustomVariables() {
  return withStoreRead((data) => data.meta?.custom_variables || []);
}

function setCustomVariables(vars) {
  withStore((data) => {
    data.meta = { ...(data.meta || {}), custom_variables: vars };
  });
}

function addCustomVariable({ name, value, content }) {
  const { normalizeToken } = require('./variables');
  return withStore((data) => {
    const vars = data.meta?.custom_variables || [];
    const token = normalizeToken(name);
    if (!token) throw new Error('Variable name is required');
    if (vars.some(v => v.token === token)) throw new Error('Variable already exists');
    const item = {
      id: vars.length ? Math.max(...vars.map(v => v.id || 0)) + 1 : 1,
      name: name.trim(),
      token,
      value: value || content || '',
      source: 'static',
      created_at: now(),
    };
    if (!data.meta) data.meta = {};
    data.meta.custom_variables = [...vars, item];
    return item;
  });
}

function deleteCustomVariable(id) {
  withStore((data) => {
    const vars = data.meta?.custom_variables || [];
    data.meta = {
      ...(data.meta || {}),
      custom_variables: vars.filter(v => v.id !== id),
    };
  });
}

function getLeadProviderKeys() {
  return withStoreRead((data) => {
    const keys = data.meta?.lead_provider_keys || {};
    return Object.fromEntries(
      Object.entries(keys).map(([k, v]) => [k, { configured: !!v, masked: v ? `${v.slice(0, 4)}••••` : '' }])
    );
  });
}

function getLeadProviderKey(providerId) {
  return withStoreRead((data) => data.meta?.lead_provider_keys?.[providerId] || '');
}

function setLeadProviderKey(providerId, apiKey) {
  withStore((data) => {
    const keys = { ...(data.meta?.lead_provider_keys || {}) };
    if (apiKey) keys[providerId] = apiKey.trim();
    else delete keys[providerId];
    data.meta = { ...(data.meta || {}), lead_provider_keys: keys };
  });
}

function getSavedSmtpAccounts() {
  return withStoreRead((data) => (data.meta?.saved_smtp_accounts || []).map(a => ({
    ...a,
    pass: a.pass ? '••••••••' : '',
  })));
}

function saveSmtpAccount(account) {
  const result = withStore((data) => {
    const list = data.meta?.saved_smtp_accounts || [];
    const id = account.id || `saved_${Date.now()}`;
    const existing = list.findIndex(a => a.id === id);
    const entry = {
      id,
      provider: account.provider || 'custom',
      label: account.label || account.email,
      host: account.host,
      port: parseInt(account.port, 10) || 587,
      secure: !!account.secure,
      imapHost: account.imapHost || undefined,
      imapPort: account.imapPort ? parseInt(account.imapPort, 10) : undefined,
      sentFolder: account.sentFolder || undefined,
      email: account.email?.trim(),
      fromName: account.fromName || account.email?.split('@')[0] || '',
      pass: account.pass && account.pass !== '••••••••' ? account.pass.replace(/\s/g, '') : undefined,
      listId: account.listId || 'list1',
      listLabel: account.listLabel || '',
      dailyLimit: parseInt(account.dailyLimit, 10) || 200,
      sendDelayMs: parseInt(account.sendDelayMs, 10) || 20000,
      verified: !!account.verified,
      updated_at: now(),
    };
    if (existing >= 0) {
      if (!entry.pass) entry.pass = list[existing].pass;
      list[existing] = { ...list[existing], ...entry };
    } else {
      if (!entry.pass) throw new Error('Password is required');
      list.push(entry);
    }
    data.meta = { ...(data.meta || {}), saved_smtp_accounts: list };
    scheduleSmtpSave(list);
    return { ...entry, pass: '••••••••' };
  });
  return result;
}

function getSavedSmtpAccountRaw(id) {
  return withStoreRead((data) => (data.meta?.saved_smtp_accounts || []).find(a => a.id === id) || null);
}

function getAllSavedSmtpAccountsRaw() {
  return withStoreRead((data) => [...(data.meta?.saved_smtp_accounts || [])]);
}

function deleteSavedSmtpAccount(id) {
  withStore((data) => {
    const list = (data.meta?.saved_smtp_accounts || []).filter(a => a.id !== id);
    data.meta = {
      ...(data.meta || {}),
      saved_smtp_accounts: list,
    };
    scheduleSmtpSave(list);
  });
}

function setAccountDisabled(accountId, disabled) {
  withStore((data) => {
    const set = new Set(data.meta?.disabled_account_ids || []);
    if (disabled) set.add(accountId);
    else set.delete(accountId);
    data.meta = { ...(data.meta || {}), disabled_account_ids: [...set] };
    scheduleFlagsSave(currentAccountFlags(data));
  });
}

function setAccountStopped(accountId, stopped) {
  withStore((data) => {
    const set = new Set(data.meta?.stopped_account_ids || []);
    if (stopped) set.add(accountId);
    else set.delete(accountId);
    data.meta = { ...(data.meta || {}), stopped_account_ids: [...set] };
    scheduleFlagsSave(currentAccountFlags(data));
  });
}

function isAccountStoppedMeta(accountId) {
  return withStoreRead((data) => (data.meta?.stopped_account_ids || []).includes(accountId));
}

function getQueueProgress() {
  return withStoreRead((data) => {
    const total = data.send_queue.length;
    const pending = data.send_queue.filter(q => q.status === 'pending').length;
    const sent = data.send_queue.filter(q => q.status === 'sent').length;
    const failed = data.send_queue.filter(q => q.status === 'failed').length;
    const completed = sent + failed;

    const nextItem = data.send_queue
      .filter(q => q.status === 'pending')
      .filter(q => !q.deferred_until || new Date(q.deferred_until).getTime() <= Date.now())
      .sort((a, b) => a.id - b.id)[0];

    let nextEmail = null;
    if (nextItem) {
      const contact = data.contacts.find(c => c.id === nextItem.contact_id);
      nextEmail = contact?.email || null;
    }

    const lastSentLog = [...data.send_log]
      .filter(l => l.status === 'sent')
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];

    const activeCampaigns = data.campaigns
      .filter(c => ['sending', 'queued', 'paused'].includes(c.status) && c.sent_count < c.total_recipients)
      .map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        smtp_account_id: c.smtp_account_id || 'account1',
        list_id: c.list_id || 'list1',
        sent: c.sent_count,
        total: c.total_recipients,
        pending: data.send_queue.filter(q => q.campaign_id === c.id && q.status === 'pending').length,
        percentComplete: c.total_recipients > 0
          ? Math.round((c.sent_count / c.total_recipients) * 100)
          : 0,
      }));

    return {
      total,
      pending,
      sent,
      failed,
      completed,
      nextPosition: total > 0 ? completed + 1 : 0,
      nextEmail,
      lastSentEmail: lastSentLog?.email || null,
      lastSentAt: lastSentLog?.sent_at || null,
      percentComplete: total > 0 ? Math.round((sent / total) * 100) : 0,
      activeCampaigns,
      activeCampaign: activeCampaigns[0] || null,
    };
  });
}

/**
 * Only advances draft/queued campaigns into sending.
 * Never auto-unpauses a user-paused campaign (pass includePaused=true on Resume).
 */
function resumeSendingCampaigns({ includePaused = false } = {}) {
  withStore((data) => {
    for (const camp of data.campaigns) {
      const hasPending = data.send_queue.some(q => q.campaign_id === camp.id && q.status === 'pending');
      if (!hasPending) continue;
      if (camp.status === 'queued') {
        camp.status = 'sending';
      } else if (includePaused && camp.status === 'paused') {
        camp.status = 'sending';
      }
    }
  });
}

function categorizeFailure(type) {
  if (['blocked', 'spam'].includes(type) || type === 'blocked') return 'denied';
  if (type === 'invalid_recipient') return 'invalid';
  if (type === 'rate_limit') return 'rate_limited';
  if (type === 'daily_quota') return 'quota';
  if (type === 'temporary') return 'temporary';
  return 'other';
}

function getAnalytics() {
  return withStoreRead((data) => {
    const queue = data.send_queue;
    const logs = data.send_log;
    const sent = queue.filter(q => q.status === 'sent').length;
    const failed = queue.filter(q => q.status === 'failed').length;
    const pending = queue.filter(q => q.status === 'pending').length;
    const total = queue.length;
    const processed = sent + failed;
    const successRate = processed > 0 ? Math.round((sent / processed) * 1000) / 10 : 0;

    const failureBreakdown = {};
    for (const log of logs.filter(l => l.status === 'failed')) {
      const cat = categorizeFailure(log.failure_type || 'other');
      failureBreakdown[cat] = (failureBreakdown[cat] || 0) + 1;
    }

    const failureReasons = {};
    for (const log of logs.filter(l => l.status === 'failed' && l.error_message)) {
      const key = (log.error_message || '').slice(0, 80);
      failureReasons[key] = (failureReasons[key] || 0) + 1;
    }
    const topFailures = Object.entries(failureReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }));

    const today = todayLocal();
    const hourlyToday = Array.from({ length: 24 }, (_, h) => ({ hour: h, sent: 0, failed: 0 }));
    for (const log of logs) {
      const d = new Date(log.sent_at);
      if (d.toLocaleDateString('en-CA') !== today) continue;
      const h = d.getHours();
      if (log.status === 'sent') hourlyToday[h].sent++;
      else if (log.status === 'failed') hourlyToday[h].failed++;
    }

    const daily14 = {};
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const log of logs) {
      if (new Date(log.sent_at) < cutoff) continue;
      const day = log.sent_at.slice(0, 10);
      if (!daily14[day]) daily14[day] = { day, sent: 0, failed: 0 };
      if (log.status === 'sent') daily14[day].sent++;
      else if (log.status === 'failed') daily14[day].failed++;
    }
    const dailyChart = Object.values(daily14).sort((a, b) => a.day.localeCompare(b.day));

    const campaignStats = data.campaigns.map(c => ({
      id: c.id,
      name: c.name,
      subject: c.subject,
      status: c.status,
      smtp_account_id: c.smtp_account_id || 'account1',
      list_id: c.list_id || 'list1',
      sent: c.sent_count,
      failed: c.failed_count,
      total: c.total_recipients,
      pending: data.send_queue.filter(q => q.campaign_id === c.id && q.status === 'pending').length,
      successRate: (c.sent_count + c.failed_count) > 0
        ? Math.round((c.sent_count / (c.sent_count + c.failed_count)) * 1000) / 10
        : 0,
      started_at: c.started_at,
      completed_at: c.completed_at,
    })).sort((a, b) => b.id - a.id);

    const todaySent = logs.filter(l => l.status === 'sent' && l.sent_at.slice(0, 10) === today).length;
    const todayFailed = logs.filter(l => l.status === 'failed' && l.sent_at.slice(0, 10) === today).length;

    const replies = data.replies || [];

    return {
      overview: {
        total, sent, failed, pending, processed, successRate,
        denied: failureBreakdown.denied || 0,
        invalid: failureBreakdown.invalid || 0,
        rateLimited: failureBreakdown.rate_limited || 0,
        todaySent, todayFailed,
        replyCount: replies.length,
      },
      failureBreakdown,
      topFailures,
      hourlyToday,
      dailyChart,
      campaignStats,
      replies: replies.slice(-20),
    };
  });
}

function markReply(email, subject, snippet) {
  withStore((data) => {
    if (!data.replies) data.replies = [];
    data.replies.push({
      id: nextId(data, 'replies'),
      email, subject: subject || '', snippet: snippet || '', received_at: now(),
    });
  });
}

function markBounce(email, reason = 'Delivery failed') {
  withStore((data) => {
    const emailLower = email.toLowerCase();
    const contact = data.contacts.find(c => c.email.toLowerCase() === emailLower);
    if (contact) {
      contact.status = 'bounced';
      contact.failure_reason = reason;
      contact.suppressed_at = now();
    }
    for (const log of data.send_log) {
      if (log.email.toLowerCase() === emailLower && log.status === 'sent') {
        log.status = 'failed';
        log.failure_type = 'invalid_recipient';
        log.error_message = reason;
      }
    }
  });
}

module.exports = {
  getContacts, addContact, addContactsBulk, addContactsBulkSplit, deleteContact, deleteAllContacts,
  getActiveContactIds, getEligibleContactIds, getSuccessfulContactIds, getSentAccountForContact,
  matchFollowUpCsv, prepareFollowUpRecipients,
  getCampaignSentCount, getContactCounts, getAllListCounts,
  suppressContact, getSentEmailsForList, getGloballySentEmails,
  getCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign, clearSendingHistory, setCampaignStatus, getCampaignsByStatus,
  queueCampaign, getPendingQueue, getPendingCount, getQueueRetries, requeueItem, failoverQueueItem,
  applyPendingRedistribution, redistributePendingFromAccount, getTriedAccounts, deferQueueItem,
  deferBlockedQueueItems, getAccountQuotaState, setAccountQuotaState,
  pauseAllCampaigns, pauseCampaignsForAccount,
  markSent, markFailed, updateCampaignStatuses,
  getTodaySentCount, getRemainingToday, getRecentLogs, getLast7Days, getCampaignStatusCounts,
  getMeta, setMeta, getCustomVariables, setCustomVariables, addCustomVariable, deleteCustomVariable,
  getLeadProviderKeys, getLeadProviderKey, setLeadProviderKey,
  getSavedSmtpAccounts, saveSmtpAccount, getSavedSmtpAccountRaw, getAllSavedSmtpAccountsRaw, deleteSavedSmtpAccount,
  setAccountDisabled, setAccountStopped, isAccountStoppedMeta,
  getQueueProgress, resumeSendingCampaigns, getAnalytics, markReply, markBounce,
  ensureFresh, flushPersist, persistSmtpAccountsNow, getStorageInfo,
};
