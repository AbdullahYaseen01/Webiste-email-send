const HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SECURE = process.env.SMTP_SECURE === 'true';
const DEFAULT_DAILY = parseInt(process.env.DAILY_LIMIT || '200', 10);
const DEFAULT_DELAY = parseInt(process.env.SEND_DELAY_MS || '20000', 10);
const MAX_ACCOUNTS = 20;

function buildAccount({
  id,
  listId,
  label,
  listLabel,
  email,
  pass,
  fromName,
  dailyLimit,
  sendDelayMs,
  protected: isProtected,
  host,
  port,
  secure,
  provider,
  imapHost,
  imapPort,
  sentFolder,
  source = 'env',
  removable = false,
}) {
  if (!email || !pass) return null;
  const resolvedHost = host || HOST;
  const isHostinger = provider === 'hostinger'
    || resolvedHost === 'smtp.hostinger.com'
    || String(resolvedHost).includes('hostinger');
  return {
    id,
    listId,
    label,
    listLabel,
    host: resolvedHost,
    port: port != null ? port : PORT,
    secure: secure != null ? secure : SECURE,
    provider: provider || (isHostinger ? 'hostinger' : undefined),
    imapHost: imapHost || (isHostinger ? 'imap.hostinger.com' : undefined),
    imapPort: imapPort || (isHostinger ? 993 : undefined),
    sentFolder: sentFolder || (isHostinger ? 'INBOX.Sent' : undefined),
    email: email.trim(),
    pass: String(pass).replace(/\s/g, ''),
    from: email.trim(),
    fromName: fromName || 'Abdullah Yaseen',
    dailyLimit,
    sendDelayMs,
    protected: !!isProtected,
    source,
    removable,
  };
}

function envFlag(name) {
  const v = process.env[name];
  if (v == null) return undefined;
  return v !== 'false' && v !== '0';
}

function getMetaFlags() {
  try {
    const store = require('./store');
    const meta = store.getMeta() || {};
    return {
      disabled: new Set(meta.disabled_account_ids || []),
      stopped: new Set(meta.stopped_account_ids || []),
    };
  } catch {
    return { disabled: new Set(), stopped: new Set() };
  }
}

function loadEnvAccounts() {
  const accounts = [];
  for (let i = 1; i <= 10; i++) {
    const user = process.env[`SMTP_ACCOUNT_${i}_USER`]
      || (i === 1 ? process.env.SMTP_USER : null);
    const pass = process.env[`SMTP_ACCOUNT_${i}_PASS`]
      || (i === 1 ? process.env.SMTP_PASS : null);

    const account = buildAccount({
      id: `account${i}`,
      listId: `list${i}`,
      label: process.env[`SMTP_ACCOUNT_${i}_LABEL`] || `Gmail ${i}`,
      listLabel: `Data List ${i}`,
      email: user,
      pass,
      fromName: process.env[`SMTP_ACCOUNT_${i}_FROM_NAME`]
      || process.env.SMTP_FROM_NAME
      || 'Abdullah Yaseen',
      host: process.env[`SMTP_ACCOUNT_${i}_HOST`] || process.env.SMTP_HOST || 'smtp.gmail.com',
      port: process.env[`SMTP_ACCOUNT_${i}_PORT`]
        ? parseInt(process.env[`SMTP_ACCOUNT_${i}_PORT`], 10)
        : undefined,
      secure: envFlag(`SMTP_ACCOUNT_${i}_SECURE`) != null
        ? envFlag(`SMTP_ACCOUNT_${i}_SECURE`)
        : undefined,
      dailyLimit: parseInt(
        process.env[`SMTP_ACCOUNT_${i}_DAILY_LIMIT`] || String(DEFAULT_DAILY),
        10
      ),
      sendDelayMs: parseInt(
        process.env[`SMTP_ACCOUNT_${i}_DELAY_MS`] || String(DEFAULT_DELAY),
        10
      ),
      protected: true,
      source: 'env',
      removable: false,
    });
    if (account) accounts.push(account);
  }
  return accounts;
}

function loadSavedAccounts(usedListIds, usedEmails) {
  let raw = [];
  try {
    const store = require('./store');
    raw = store.getAllSavedSmtpAccountsRaw() || [];
  } catch {
    return [];
  }

  const accounts = [];
  let listCounter = 1;
  for (const s of raw) {
    if (!s.email || !s.pass) continue;
    const emailLower = s.email.toLowerCase();
    if (usedEmails.has(emailLower)) continue;

    let listId = s.listId;
    if (!listId || usedListIds.has(listId)) {
      while (usedListIds.has(`list${listCounter}`)) listCounter += 1;
      listId = `list${listCounter}`;
      listCounter += 1;
    }
    usedListIds.add(listId);
    usedEmails.add(emailLower);

    const isHostinger = s.provider === 'hostinger'
      || s.host === 'smtp.hostinger.com'
      || String(s.host || '').includes('hostinger');
    const dailyLimit = isHostinger
      ? Math.max(parseInt(s.dailyLimit, 10) || 0, 400)
      : (s.dailyLimit || DEFAULT_DAILY);

    const account = buildAccount({
      id: s.id,
      listId,
      label: s.label || s.email,
      listLabel: s.listLabel || `Data List ${String(listId).replace(/^list/, '')}`,
      email: s.email,
      pass: s.pass,
      fromName: s.fromName || 'Abdullah Yaseen',
      host: s.host || 'smtp.gmail.com',
      port: s.port || 587,
      secure: !!s.secure,
      provider: s.provider,
      imapHost: s.imapHost,
      imapPort: s.imapPort,
      sentFolder: s.sentFolder,
      dailyLimit,
      sendDelayMs: s.sendDelayMs || DEFAULT_DELAY,
      source: 'saved',
      removable: true,
    });
    if (account) accounts.push(account);
  }
  return accounts;
}

let cachedAccounts = null;

function loadAccounts() {
  const usedListIds = new Set();
  const usedEmails = new Set();

  const envAccounts = loadEnvAccounts().filter(a => {
    usedListIds.add(a.listId);
    usedEmails.add(a.email.toLowerCase());
    return true;
  });

  try {
    const store = require('./store');
    if (typeof store.clearSavedSmtpAccounts === 'function') store.clearSavedSmtpAccounts();
  } catch { /* ignore */ }

  return envAccounts.slice(0, MAX_ACCOUNTS);
}

function getAccounts() {
  if (!cachedAccounts) cachedAccounts = loadAccounts();
  return cachedAccounts;
}

function getAccount(id) {
  return getAccounts().find(a => a.id === id) || null;
}

function getAccountByList(listId) {
  return getAccounts().find(a => a.listId === listId) || null;
}

function getDefaultAccount() {
  return getAccounts()[0] || null;
}

function getSendableAccounts() {
  return getAccounts().filter((a) => a.email && a.pass);
}

function getPreferredTestAccount() {
  const accounts = getAccounts();
  const raahban = accounts.find((a) => /^abdullah@raahban\.com$/i.test(a.email || ''))
    || accounts.find((a) => /@raahban\.com$/i.test(a.email || ''));
  if (raahban) return raahban;
  const abdullah = accounts.find((a) => /^abdullah@/i.test(a.email || ''));
  return abdullah || accounts[0] || null;
}

function resolveTestAccountId() {
  return getPreferredTestAccount()?.id || 'account1';
}

function resetAccountsCache() {
  cachedAccounts = null;
}

function isAccountStopped(accountId) {
  return getMetaFlags().stopped.has(accountId);
}

module.exports = {
  getAccounts,
  getAccount,
  getAccountByList,
  getDefaultAccount,
  getSendableAccounts,
  getPreferredTestAccount,
  resolveTestAccountId,
  resetAccountsCache,
  isAccountStopped,
  MAX_ACCOUNTS,
  DEFAULT_DAILY,
  DEFAULT_DELAY,
};
