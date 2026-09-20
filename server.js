require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { parseContactsCsv, parseContactsXlsx } = require('./src/import-contacts');
const { getTemplate, listTemplates, buildFollowUpHtml, normalizeCalendarUrl } = require('./src/campaign-templates');
const { firstNameFromEmail } = require('./src/personalize-opener');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const { uploadsDir, attachmentsDir, isServerless } = require('./src/paths');
const store = require('./src/store');
const {
  getAccounts, getAccount, getAccountByList, getPreferredTestAccount, getSendableAccounts, resolveTestAccountId, resetAccountsCache, DEFAULT_DAILY, DEFAULT_DELAY,
} = require('./src/accounts');
const { validateCampaign, htmlToPlain } = require('./src/email-utils');
const {
  getSmtpConfig,
  verifySmtp,
  resetTransporter,
  startSender,
  stopSender,
  runSenderTick,
  getSenderStatus,
  getAccountStatuses,
  queueCampaign,
  resetDailyState,
  sendTestEmail,
  renderPreview,
  personalize,
  unsubscribeToken,
  verifyCustomSmtp,
  sendTestWithCustomConfig,
  DAILY_LIMIT,
} = require('./src/mailer');
const { getProviders, getProvider } = require('./src/email-providers');
const { getLeadProviders, searchLeads } = require('./src/lead-providers');
const { getDataVariables } = require('./src/variables');
const { requireAuth, isAuthenticated, setAuthCookie, clearAuthCookie, verifyPassword } = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3001;

if (process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const upload = multer({ dest: uploadsDir, limits: { fileSize: 50 * 1024 * 1024 } });
const attachmentUpload = multer({ dest: attachmentsDir, limits: { fileSize: 25 * 1024 * 1024 } });

function toHtmlBody(body) {
  if (!body) return '';
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  return body.split('\n').filter(Boolean).map(line =>
    `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
  ).join('');
}

app.use(express.json({ limit: '5mb' }));

function scheduleBackground(promise) {
  try {
    const { waitUntil } = require('@vercel/functions');
    if (typeof waitUntil === 'function') {
      waitUntil(promise);
      return;
    }
  } catch (_) { /* not on Vercel functions runtime */ }
  promise.catch((err) => console.error('[bg]', err.message));
}

// Hydrate durable store (Upstash) on every serverless request
app.use(async (req, res, next) => {
  try {
    await store.ensureFresh();
    // Accounts can be added on another instance — never serve a stale in-memory list
    resetAccountsCache();
    next();
  } catch (err) {
    next(err);
  }
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'login.html'));
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  setAuthCookie(res);
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

function handleUnsubscribe(req, res) {
  const email = String(req.query.e || req.body?.email || '').trim();
  const token = String(req.query.t || req.body?.t || '').trim();
  if (!email || !email.includes('@') || token !== unsubscribeToken(email)) {
    return res.status(400).send('This unsubscribe link is not valid.');
  }
  store.suppressByEmail(email, 'unsubscribed', 'Recipient unsubscribed');
  scheduleBackground(store.flushPersist());
  res.status(200).type('html').send(
    '<p>You will not receive more emails from this sender.</p>'
  );
}

app.get('/api/unsubscribe', handleUnsubscribe);
app.post('/api/unsubscribe', handleUnsubscribe);

app.use(requireAuth);

app.post('/api/campaigns/validate', (req, res) => {
  const { subject, body, preheader } = req.body;
  const result = validateCampaign({ subject, bodyHtml: body || '', preheader: preheader || '' });
  res.json(result);
});

app.post('/api/campaigns/preview', (req, res) => {
  const { subject, body, preheader, include_unsubscribe, smtp_account_id, sample_contact } = req.body;
  if (!subject || !body) {
    return res.status(400).json({ error: 'Subject and body are required' });
  }
  const accountId = (!smtp_account_id || smtp_account_id === 'all')
    ? (getAccounts()[0]?.id || 'account1')
    : smtp_account_id;
  const preview = renderPreview({
    subject: subject.trim(),
    body_html: toHtmlBody(body),
    body_text: htmlToPlain(toHtmlBody(body)),
    preheader: (preheader || '').trim(),
    include_unsubscribe: include_unsubscribe === true,
  }, sample_contact, accountId);
  res.json(preview);
});

app.get('/api/accounts', (req, res) => {
  const accounts = getAccountStatuses();
  const lists = store.getAllListCounts();
  res.json({ accounts, lists });
});

/** Connect any mailbox: Gmail, Hostinger, Outlook, or custom SMTP */
app.post('/api/accounts/connect', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    const pass = (req.body.pass || req.body.password || '').trim();
    const label = (req.body.label || '').trim();
    const fromName = (req.body.fromName || process.env.SMTP_FROM_NAME || 'Abdullah Yaseen').trim();
    const providerId = (req.body.provider || 'gmail').trim();
    const provider = getProvider(providerId);

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address required' });
    }
    if (!pass) return res.status(400).json({ error: 'Password / App password required' });

    let host = (req.body.host || provider.host || '').trim();
    let port = parseInt(req.body.port, 10) || provider.port || 587;
    let secure = req.body.secure === true || req.body.secure === 'true' || !!provider.secure;

    // Auto-pick Hostinger if custom domain and provider left as gmail by mistake
    if ((!host || providerId === 'gmail') && !email.toLowerCase().endsWith('@gmail.com') && !email.toLowerCase().endsWith('@googlemail.com')) {
      if (providerId === 'hostinger' || req.body.autoHostinger) {
        host = 'smtp.hostinger.com';
        port = 465;
        secure = true;
      }
    }
    if (!host) {
      return res.status(400).json({ error: 'SMTP host required (choose Hostinger / Custom)' });
    }

    const cfg = {
      host,
      port,
      secure,
      email,
      pass: pass.replace(/\s/g, ''),
      fromName,
    };
    await verifyCustomSmtp(cfg);

    const existing = store.getAllSavedSmtpAccountsRaw().find(
      a => a.email?.toLowerCase() === email.toLowerCase()
    );
    const usedLists = new Set(getAccounts().map(a => a.listId));
    let listId = existing?.listId;
    if (!listId || usedLists.has(listId)) {
      let n = 1;
      while (usedLists.has(`list${n}`)) n += 1;
      listId = `list${n}`;
    }

    const providerLabel = provider?.name || providerId;
    const isHostinger = providerId === 'hostinger'
      || host === 'smtp.hostinger.com'
      || String(host).includes('hostinger');
    const dailyLimit = parseInt(req.body.dailyLimit, 10)
      || (isHostinger ? 400 : DEFAULT_DAILY);
    const saved = store.saveSmtpAccount({
      id: existing?.id,
      provider: providerId || 'custom',
      label: label || `${providerLabel} — ${email.split('@')[0]}`,
      host,
      port,
      secure,
      imapHost: provider?.imapHost || (isHostinger ? 'imap.hostinger.com' : undefined),
      imapPort: provider?.imapPort || (isHostinger ? 993 : undefined),
      sentFolder: provider?.sentFolder || (isHostinger ? 'INBOX.Sent' : undefined),
      email,
      pass,
      fromName,
      listId,
      listLabel: `Data List (${email.split('@')[0]})`,
      dailyLimit,
      sendDelayMs: DEFAULT_DELAY,
      verified: true,
    });

    store.setAccountDisabled(saved.id, false);
    // Wait until Upstash has the inbox — otherwise the next contact upload can race and drop it
    await store.flushPersist();
    resetAccountsCache();
    resetTransporter();

    res.json({
      success: true,
      account: saved,
      message: `Connected ${email} via ${host}`,
      accounts: getAccountStatuses(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Could not connect email' });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const acc = getAccount(id);
    const saved = store.getSavedSmtpAccountRaw(id);

    if (acc?.source === 'env' || /^account[12]$/.test(String(id))) {
      return res.status(400).json({ error: 'The Raahban inboxes stay connected' });
    }
    if (saved) {
      store.deleteSavedSmtpAccount(id);
    } else if (acc?.source === 'env' || String(id).startsWith('account')) {
      store.setAccountDisabled(id, true);
    } else {
      // Still try disable — env account may already be filtered from getAccounts
      if (String(id).startsWith('account') || String(id).startsWith('saved_')) {
        store.setAccountDisabled(id, true);
        store.deleteSavedSmtpAccount(id);
      } else {
        return res.status(404).json({ error: 'Account not found' });
      }
    }

    store.setAccountStopped(id, false);
    await store.flushPersist();
    resetAccountsCache();
    resetTransporter(id);
    res.json({ success: true, message: 'Account removed', accounts: getAccountStatuses() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to remove account' });
  }
});

app.post('/api/accounts/:id/stop', async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!getAccount(id) && !store.getSavedSmtpAccountRaw(id) && !String(id).startsWith('account')) {
    return res.status(404).json({ error: 'Account not found' });
  }
  store.setAccountStopped(id, true);
  await store.flushPersist();
  resetAccountsCache();
  res.json({ success: true, message: 'Account stopped — this inbox will not send', accounts: getAccountStatuses(), sender: getSenderStatus() });
});

app.post('/api/accounts/:id/start', async (req, res) => {
  const id = decodeURIComponent(req.params.id);
  store.setAccountStopped(id, false);
  store.setAccountDisabled(id, false);
  await store.flushPersist();
  resetAccountsCache();
  res.json({ success: true, message: 'Account started', accounts: getAccountStatuses(), sender: getSenderStatus() });
});

app.get('/api/stats', (req, res) => {
  const sender = getSenderStatus();
  const progress = store.getQueueProgress();

  // Watchdog: if campaign armed and pending, keep ticking in background (survives tab close when cron also set)
  if (
    isServerless
    && sender.running
    && !sender.userStopped
    && progress.pending > 0
    && !sender.dailyLimitReached
  ) {
    const last = sender.lastTickAt ? Date.parse(sender.lastTickAt) : 0;
    if (!last || Date.now() - last > 12000) {
      scheduleBackground(
        runSenderTick({ force: false }).catch((err) => console.error('[watchdog]', err.message))
      );
    }
  }

  res.json({
    sender,
    accounts: getAccountStatuses(),
    lists: store.getAllListCounts(),
    contacts: store.getContactCounts(),
    campaigns: store.getCampaignStatusCounts(),
    recentLogs: store.getRecentLogs(50),
    last7Days: store.getLast7Days(),
    dailyLimit: DAILY_LIMIT,
    progress,
    analytics: store.getAnalytics(),
    storage: store.getStorageInfo(),
  });
});

app.post('/api/history/clear', (req, res) => {
  stopSender(false);
  const summary = store.clearSendingHistory();
  res.json({
    success: true,
    summary,
    message: 'Campaigns, queue, activity, and errors were cleared. Contacts and email accounts were kept.',
  });
});

app.get('/api/smtp', (req, res) => {
  const accountId = req.query.account || getAccounts()[0]?.id;
  const cfg = getSmtpConfig(accountId);
  res.json({
    accountId,
    host: cfg.host || '',
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user || '',
    from: cfg.from || '',
    fromName: cfg.fromName || '',
    dailyLimit: cfg.dailyLimit,
    protected: cfg.protected,
    configured: !!(cfg.user && cfg.pass),
  });
});

app.post('/api/smtp/test', async (req, res) => {
  const accountId = req.body?.account || req.query?.account || getAccounts()[0]?.id;
  try {
    resetTransporter(accountId);
    await verifySmtp(accountId);
    const acc = getAccount(accountId);
    res.json({ success: true, message: `SMTP verified for ${acc?.email || accountId}` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/contacts', (req, res) => {
  const { search, page = 1, limit = 50, list_id } = req.query;
  res.json(store.getContacts({
    search,
    page: parseInt(page),
    limit: parseInt(limit),
    list_id: list_id || undefined,
  }));
});

app.post('/api/contacts', (req, res) => {
  const { email, name, first_name, last_name, company, title, website, linkedin, list_id, split } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const accounts = getAccounts();
    const shouldSplit = split !== false && accounts.length > 1;
    if (shouldSplit) {
      // Put single contact on the currently smaller list for balance
      const counts = store.getAllListCounts();
      const sorted = accounts
        .map((a) => ({ id: a.listId, active: counts[a.listId]?.active || 0 }))
        .sort((a, b) => a.active - b.active);
      const listId = sorted[0]?.id || list_id || 'list1';
      const contact = store.addContact(email, { name, first_name, last_name, company, title, website, linkedin }, listId);
      return res.json({ ...contact, split: true });
    }

    const listId = list_id || 'list1';
    const contact = store.addContact(email, { name, first_name, last_name, company, title, website, linkedin }, listId);
    res.json(contact);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email already exists in this list' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const listId = req.body.list_id || 'list1';
  const splitRequested = req.body.split !== 'false' && req.body.split !== false;

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows;

    if (ext === '.xlsx' || ext === '.xls') {
      const buffer = fs.readFileSync(req.file.path);
      rows = parseContactsXlsx(buffer);
    } else {
      const content = fs.readFileSync(req.file.path, 'utf-8');
      rows = parseContactsCsv(content);
    }

    fs.unlinkSync(req.file.path);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found in file' });
    }

    const accounts = getAccounts();
    const listIds = accounts.map((a) => a.listId).filter(Boolean);
    const doSplit = splitRequested && listIds.length > 1;

    if (doSplit) {
      const result = store.addContactsBulkSplit(rows, listIds);
      const breakdown = listIds.map((id) => {
        const acc = getAccountByList(id);
        return `${acc?.listLabel || id}: ${result.perList?.[id] || 0}`;
      }).join(' · ');
      const sentSkip = result.skippedAlreadySent || 0;
      return res.json({
        ...result,
        total: rows.length,
        split: true,
        listId: 'split',
        listLabel: `Split evenly (${breakdown})`,
        message: `Split across ${listIds.length} lists — ${breakdown}`
          + (sentSkip ? ` · skipped ${sentSkip} already sent via Hostinger` : ''),
      });
    }

    const result = store.addContactsBulk(rows, listId);
    const acc = getAccountByList(listId);
    const sentSkip = result.skippedAlreadySent || 0;
    res.json({
      ...result,
      total: rows.length,
      listId,
      listLabel: acc?.listLabel || listId,
      split: false,
      message: sentSkip
        ? `Added ${result.added}. Skipped ${sentSkip} already sent via Hostinger (Gmail-only history can retry).`
        : undefined,
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'Failed to parse file: ' + err.message });
  }
});

app.delete('/api/contacts/:id', (req, res) => {
  store.deleteContact(parseInt(req.params.id));
  res.json({ success: true });
});

app.delete('/api/contacts', (req, res) => {
  const listId = req.query.list_id || null;
  store.deleteAllContacts(listId);
  res.json({ success: true, list_id: listId });
});

app.get('/api/campaigns/templates', (req, res) => {
  res.json(listTemplates());
});

app.get('/api/campaigns/templates/:id', (req, res) => {
  const template = getTemplate(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  res.json(template);
});

app.post('/api/campaigns/test-email', attachmentUpload.single('attachment'), async (req, res) => {
  const { subject, body, preheader, include_unsubscribe, smtp_account_id, sample_contact, test_to } = req.body;
  const bodyContent = (body || '').trim();
  const accountId = resolveTestAccountId(smtp_account_id);

  if (!subject || !bodyContent) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Subject and body are required' });
  }

  const cfg = getSmtpConfig(accountId);
  if (!cfg.user || !cfg.pass) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'SMTP not configured for selected account' });
  }

  let attachment = null;
  if (req.file) {
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(attachmentsDir, `test-${Date.now()}-${safeName}`);
    fs.renameSync(req.file.path, dest);
    attachment = { filename: req.file.originalname, path: dest };
  }

  const template = getTemplate('default');
  const testTo = (test_to || '').trim() || process.env.TEST_EMAIL || template.test_email || 'ahmadjutt463@gmail.com';

  let sample = template.sample_contact;
  if (sample_contact) {
    try {
      sample = typeof sample_contact === 'string' ? JSON.parse(sample_contact) : sample_contact;
    } catch {
      return res.status(400).json({ error: 'Invalid sample_contact JSON' });
    }
  }

  sample.email = sample.email || testTo;
  if (!sample.first_name) {
    sample.first_name = firstNameFromEmail(testTo) || 'there';
  }

  const first = sample.first_name;
  const last = sample.last_name || '';
  sample.name = sample.name || [first, last].filter(Boolean).join(' ');

  try {
    resetTransporter(accountId);
    await sendTestEmail({
      subject: subject.trim(),
      body_html: toHtmlBody(bodyContent),
      body_text: htmlToPlain(toHtmlBody(bodyContent)),
      preheader: (preheader || '').trim(),
      include_unsubscribe: include_unsubscribe === true,
      attachment,
    }, testTo, sample, accountId);

    const who = [first, sample.title, sample.company].filter(Boolean).join(' · ') || first;
    res.json({
      success: true,
      message: `Test sent from ${cfg.from} to ${testTo} as ${who}`,
      sentTo: testTo,
      accountId,
      personalizedAs: who,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.get('/api/campaigns', (req, res) => {
  res.json(store.getCampaigns());
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaign = store.getCampaign(parseInt(req.params.id));
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

app.post('/api/campaigns', attachmentUpload.single('attachment'), (req, res) => {
  const { name, subject, body, preheader, include_unsubscribe, smtp_account_id, list_id } = req.body;
  const bodyContent = (body || '').trim();
  const accountId = smtp_account_id || getAccounts()[0]?.id || 'account1';
  const useAllAccounts = accountId === 'all';
  const acc = useAllAccounts ? null : getAccount(accountId);
  const listId = list_id || (useAllAccounts ? 'all' : (acc?.listId || 'list1'));

  if (!name || !subject || !bodyContent) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Name, subject, and body are required' });
  }

  const validation = validateCampaign({
    subject: subject.trim(),
    bodyHtml: bodyContent,
    preheader: (preheader || '').trim(),
  });
  if (!validation.valid) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: validation.errors.join('. '), validation });
  }

  let attachment = null;
  if (req.file) {
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(attachmentsDir, `${Date.now()}-${safeName}`);
    fs.renameSync(req.file.path, dest);
    attachment = { filename: req.file.originalname, path: dest };
  }

  const body_html = toHtmlBody(bodyContent);
  const campaign = store.createCampaign({
    name: name.trim(),
    subject: subject.trim(),
    body_html,
    body_text: htmlToPlain(body_html),
    preheader: (preheader || '').trim(),
    include_unsubscribe: include_unsubscribe === true,
    smtp_account_id: accountId,
    list_id: listId,
    attachment,
  });

  res.json({
    id: campaign.id,
    name: campaign.name,
    subject: campaign.subject,
    smtp_account_id: accountId,
    list_id: listId,
    hasAttachment: !!attachment,
    validation,
  });
});

app.put('/api/campaigns/:id', attachmentUpload.single('attachment'), (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = store.getCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['draft', 'paused'].includes(campaign.status)) {
    return res.status(400).json({ error: 'Pause the campaign before editing' });
  }

  const { name, subject, body, body_html, preheader, include_unsubscribe } = req.body;
  const bodyContent = (body || body_html || '').trim();

  if (subject && !bodyContent && !campaign.body_html) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Email body is required' });
  }

  let attachment = campaign.attachment || null;
  if (req.file) {
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(attachmentsDir, `${Date.now()}-${safeName}`);
    fs.renameSync(req.file.path, dest);
    attachment = { filename: req.file.originalname, path: dest };
  }

  const html = bodyContent ? toHtmlBody(bodyContent) : campaign.body_html;
  store.updateCampaign(id, {
    name: (name || campaign.name).trim(),
    subject: (subject || campaign.subject).trim(),
    body_html: html,
    body_text: htmlToPlain(html),
    preheader: preheader !== undefined ? String(preheader).trim() : campaign.preheader,
    include_unsubscribe: include_unsubscribe === true,
    attachment,
    updated_at: new Date().toISOString(),
  });

  res.json({
    success: true,
    id,
    message: campaign.status === 'paused'
      ? 'Campaign updated. Click Resume to continue sending with the new content.'
      : 'Campaign updated',
  });
});

app.post('/api/campaigns/:id/send', async (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = store.getCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'draft') {
    return res.status(400).json({ error: 'Campaign already sent or in progress' });
  }

  const accountId = campaign.smtp_account_id || 'account1';
  const listId = campaign.list_id || 'list1';
  const useAllAccounts = accountId === 'all';
  const accounts = getSendableAccounts();
  const smtpAccountIds = useAllAccounts ? accounts.map(a => a.id) : [accountId];

  if (useAllAccounts) {
    if (smtpAccountIds.length === 0) {
      return res.status(400).json({ error: 'No SMTP accounts configured' });
    }
  } else {
    const cfg = getSmtpConfig(accountId);
    if (!cfg.user || !cfg.pass) {
      return res.status(400).json({ error: 'SMTP not configured for selected account' });
    }
  }

  const isFollowUp = campaign.campaign_type === 'follow_up';
  const contactIds = isFollowUp
    ? store.getSuccessfulContactIds(campaign.parent_campaign_id)
    : store.getEligibleContactIds(listId, { skipAlreadySent: true });

  if (contactIds.length === 0) {
    return res.status(400).json({
      error: isFollowUp
        ? 'No successful recipients found for follow-up'
        : 'No eligible contacts in selected list (all sent, bounced, or blocked)',
    });
  }

  const listAccountMap = Object.fromEntries(
    accounts.map((a) => [a.listId, a.id]).filter(([list]) => list)
  );
  const queued = queueCampaign(id, contactIds, {
    allowResend: isFollowUp,
    smtpAccountIds,
    listAccountMap,
  });

  const totalDaily = useAllAccounts
    ? accounts.reduce((sum, a) => sum + (a.dailyLimit || 0), 0)
    : (getAccount(accountId)?.dailyLimit || 490);
  const remaining = useAllAccounts
    ? accounts.reduce((sum, a) => sum + store.getRemainingToday(a.dailyLimit, a.id), 0)
    : store.getRemainingToday(getAccount(accountId).dailyLimit, accountId);
  const daysNeeded = Math.ceil(queued / Math.max(totalDaily, 1));
  startSender();
  let tickResult = null;
  if (isServerless) {
    try {
      tickResult = await runSenderTick({ force: true });
    } catch (err) {
      console.error('Initial send tick failed:', err.message);
    }
  }

  const otherActive = store.getCampaigns().filter(c =>
    c.id !== id && ['sending', 'queued'].includes(c.status)
  ).length;

  const viaLabel = useAllAccounts
    ? `${smtpAccountIds.length} accounts (split evenly)`
    : (getAccount(accountId)?.email || accountId);

  let message;
  if (queued <= remaining) {
    message = otherActive > 0
      ? `Queued ${queued.toLocaleString()} emails via ${viaLabel}. Sending in parallel with other active campaign(s).`
      : `Queued ${queued.toLocaleString()} emails via ${viaLabel}. Sending now...`;
  } else {
    message = `Queued ${queued.toLocaleString()} emails via ${viaLabel}. Sending ~${remaining} today, ~${daysNeeded} days at ${totalDaily}/day combined.`;
  }

  if (isFollowUp) {
    message += ' Follow-ups use the same sending account as each contact’s first email.';
  }
  if (isServerless) {
    message += ' Keep the Dashboard tab open so sending continues.';
  }

  res.json({
    success: true,
    queued,
    remainingToday: remaining,
    daysNeeded,
    accountId,
    smtpAccountIds,
    listId,
    message,
    tick: tickResult,
  });
});

app.post('/api/campaigns/:id/pause', (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = store.getCampaign(id);
  if (campaign && ['sending', 'queued'].includes(campaign.status)) {
    store.setCampaignStatus(id, 'paused');
    const stillActive = store.getCampaigns().some(c =>
      c.id !== id && ['sending', 'queued'].includes(c.status)
    );
    if (!stillActive) {
      store.setMeta({ userStoppedSender: true });
      stopSender(false);
    }
    res.json({ success: true, message: 'Campaign paused. Sending stopped for this campaign.' });
  } else {
    res.json({ success: true, message: 'Campaign is not running' });
  }
});

app.post('/api/campaigns/:id/resume', async (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = store.getCampaign(id);
  if (campaign && campaign.status === 'paused') {
    store.setCampaignStatus(id, 'sending');
    store.setMeta({ userStoppedSender: false });
    startSender();
    if (isServerless) {
      try { await runSenderTick({ force: true }); } catch (_) { /* ignore */ }
    }
  }
  res.json({ success: true, message: 'Campaign resumed' });
});

app.delete('/api/campaigns/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const campaign = store.getCampaign(id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const result = store.deleteCampaign(id);
  const stillActive = store.getCampaigns().some(c =>
    ['sending', 'queued'].includes(c.status)
  );
  if (!stillActive) {
    store.setMeta({ userStoppedSender: true });
    stopSender(false);
  }

  res.json({
    success: true,
    id,
    pendingRemoved: result?.pendingRemoved || 0,
    message: result?.pendingRemoved
      ? `Campaign deleted. ${result.pendingRemoved.toLocaleString()} remaining emails removed from the queue.`
      : 'Campaign deleted.',
  });
});

app.post('/api/campaigns/:id/follow-up', (req, res) => {
  const parentId = parseInt(req.params.id);
  const parent = store.getCampaign(parentId);
  if (!parent) return res.status(404).json({ error: 'Campaign not found' });

  const contactIds = store.getSuccessfulContactIds(parentId);
  if (contactIds.length === 0) {
    return res.status(400).json({
      error: 'No successful sends yet — wait until some emails are delivered, then create a follow-up.',
    });
  }

  const { subject, body, preheader, delay_days, send_now } = req.body || {};
  const followTpl = getTemplate('follow-up');
  // Always use the latest follow-up template so bold + copy stay consistent
  const calendarUrl = normalizeCalendarUrl(req.body?.calendar_link || store.getMeta()?.calendar_link);
  if (calendarUrl) store.setMeta({ calendar_link: calendarUrl });
  const body_html = toHtmlBody(buildFollowUpHtml(calendarUrl));
  const followSubject = (subject && String(subject).trim()) || followTpl.subject;

  const campaign = store.createCampaign({
    name: `Follow-up: ${parent.name}`.slice(0, 120),
    subject: followSubject.trim(),
    body_html,
    body_text: htmlToPlain(body_html),
    preheader: (preheader || followTpl.preheader || '').trim(),
    include_unsubscribe: false,
    smtp_account_id: parent.smtp_account_id === 'all' ? 'all' : parent.smtp_account_id,
    list_id: parent.list_id,
    attachment: parent.attachment || null,
    parent_campaign_id: parentId,
    campaign_type: 'follow_up',
    delay_days: parseInt(delay_days, 10) || 0,
  });

  const shouldSend = send_now !== false;
  let queued = 0;
  if (shouldSend) {
    const smtpAccountIds = getAccounts().filter(a => a.email && a.pass).map(a => a.id);
    queued = queueCampaign(campaign.id, contactIds, {
      allowResend: true,
      smtpAccountIds,
    });
    startSender();
  }

  res.json({
    success: true,
    campaign,
    queued,
    recipients: contactIds.length,
    message: shouldSend
      ? `Follow-up queued to ${queued.toLocaleString()} recipients from campaign #${parentId}. Each follow-up sends from the same inbox as the first email.`
      : `Follow-up draft created for ${contactIds.length.toLocaleString()} successful recipients. Open Campaigns to send.`,
  });
});

app.get('/api/campaigns/:id/follow-up-preview', (req, res) => {
  const parentId = parseInt(req.params.id);
  const parent = store.getCampaign(parentId);
  if (!parent) return res.status(404).json({ error: 'Campaign not found' });
  const contactIds = store.getSuccessfulContactIds(parentId);
  const tpl = getTemplate('follow-up');
  const calendarUrl = normalizeCalendarUrl(store.getMeta()?.calendar_link);
  const body_html = buildFollowUpHtml(calendarUrl);
  res.json({
    parent: { id: parent.id, name: parent.name, sent_count: parent.sent_count, status: parent.status },
    eligible: contactIds.length,
    template: { subject: tpl.subject, body_html },
    calendar_link: calendarUrl,
  });
});

app.get('/api/follow-up/message', (req, res) => {
  const tpl = getTemplate('follow-up');
  const calendarUrl = normalizeCalendarUrl(store.getMeta()?.calendar_link);
  const body_html = buildFollowUpHtml(calendarUrl);
  const accountId = getAccounts()[0]?.id || 'account1';
  const preview = renderPreview({
    subject: tpl.subject,
    body_html: toHtmlBody(body_html),
    body_text: htmlToPlain(body_html),
    preheader: tpl.preheader || '',
    include_unsubscribe: false,
    campaign_type: 'follow_up',
  }, tpl.sample_contact, accountId);
  res.json({
    calendar_link: calendarUrl,
    subject: tpl.subject,
    body_html,
    preview,
  });
});

app.put('/api/follow-up/calendar', (req, res) => {
  const raw = req.body?.url ?? req.body?.calendar_link ?? '';
  const url = normalizeCalendarUrl(raw);
  if (String(raw).trim() && !url) {
    return res.status(400).json({ error: 'Enter a valid calendar URL starting with https://' });
  }
  store.setMeta({ calendar_link: url });
  const tpl = getTemplate('follow-up');
  const body_html = buildFollowUpHtml(url);
  const preview = renderPreview({
    subject: tpl.subject,
    body_html: toHtmlBody(body_html),
    body_text: htmlToPlain(body_html),
    preheader: tpl.preheader || '',
    include_unsubscribe: false,
    campaign_type: 'follow_up',
  }, tpl.sample_contact, getAccounts()[0]?.id || 'account1');
  res.json({ calendar_link: url, subject: tpl.subject, body_html, preview });
});

function parseUploadedRows(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    return parseContactsXlsx(fs.readFileSync(file.path));
  }
  return parseContactsCsv(fs.readFileSync(file.path, 'utf-8'));
}

app.post('/api/follow-up/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a CSV or Excel file' });
  try {
    const rows = parseUploadedRows(req.file);
    fs.unlinkSync(req.file.path);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found in file' });
    }
    const match = store.matchFollowUpCsv(rows);
    const byAccount = Object.entries(match.byAccount || {}).map(([id, count]) => ({
      id,
      email: getAccount(id)?.email || id,
      label: getAccount(id)?.label || id,
      count,
    }));
    res.json({
      ...match,
      byAccount,
      sample: match.matched.slice(0, 25),
      totalRows: rows.length,
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'Failed to parse file: ' + err.message });
  }
});

app.post('/api/follow-up/send', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a CSV or Excel file' });
  try {
    const rows = parseUploadedRows(req.file);
    fs.unlinkSync(req.file.path);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No valid email addresses found in file' });
    }

    const match = store.matchFollowUpCsv(rows);
    if (match.matched.length === 0) {
      return res.status(400).json({
        error: 'No matching emails that already received a first message from one of your inboxes.',
        neverSent: match.neverSent.length,
        alreadyFollowed: match.alreadyFollowed.length,
        bounced: match.bounced.length,
      });
    }

    const accounts = getAccounts().filter(a => a.email && a.pass);
    const listByAccount = Object.fromEntries(accounts.map(a => [a.id, a.listId]));
    const { contactIds, stickyAccountByContact } = store.prepareFollowUpRecipients(
      match.matched,
      listByAccount
    );

    if (contactIds.length === 0) {
      return res.status(400).json({ error: 'No active contacts left to queue after matching.' });
    }

    const followTpl = getTemplate('follow-up');
    const calendarUrl = normalizeCalendarUrl(req.body?.calendar_link || store.getMeta()?.calendar_link);
    if (calendarUrl) store.setMeta({ calendar_link: calendarUrl });
    const body_html = toHtmlBody(buildFollowUpHtml(calendarUrl));
    const campaign = store.createCampaign({
      name: `Follow-up CSV — ${new Date().toISOString().slice(0, 10)}`,
      subject: followTpl.subject,
      body_html,
      body_text: htmlToPlain(body_html),
      preheader: followTpl.preheader || '',
      include_unsubscribe: false,
      smtp_account_id: 'all',
      list_id: 'all',
      campaign_type: 'follow_up',
    });

    const queued = queueCampaign(campaign.id, contactIds, {
      allowResend: true,
      smtpAccountIds: accounts.map(a => a.id),
      stickyAccountByContact,
    });
    startSender();

    const byAccount = Object.entries(match.byAccount || {}).map(([id, count]) => ({
      id,
      email: getAccount(id)?.email || id,
      count,
    }));

    res.json({
      success: true,
      campaignId: campaign.id,
      queued,
      ready: match.ready,
      neverSent: match.neverSent.length,
      alreadyFollowed: match.alreadyFollowed.length,
      bounced: match.bounced.length,
      byAccount,
      message: `Follow-up queued to ${queued.toLocaleString()} people. Each one sends from the same inbox as their first email.`,
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: err.message || 'Follow-up failed' });
  }
});

app.get('/api/demo/data', (req, res) => {
  res.json({
    demoEmails: [
      { id: 'demo1', first_name: 'Ahmad', email: 'ahmad.yaseen@gmail.com', label: 'Ahmad — Gmail Primary', provider: 'gmail', fromName: 'Ahmad Yaseen' },
      { id: 'demo2', first_name: 'Ahmad', email: 'ahmad.randhawa@outlook.com', label: 'Ahmad — Outlook', provider: 'outlook', fromName: 'Ahmad Randhawa' },
      { id: 'demo3', first_name: 'Ahmad', email: 'ahmad.demo@yahoo.com', label: 'Ahmad — Yahoo Demo', provider: 'yahoo', fromName: 'Ahmad Demo' },
      { id: 'demo4', first_name: 'Ahmad', email: 'ahmad@customsmtp.demo', label: 'Ahmad — Custom SMTP', provider: 'custom', fromName: 'Ahmad Yaseen' },
    ],
    features: [
      'Multi-account SMTP (Gmail, Outlook, Yahoo, Custom)',
      'Follow-up campaigns to successful recipients',
      'Lead research with Apollo, FindyMail, Hunter, Snov, Lusha, Clearbit',
      'Variable builder with static + data tokens',
      'Parallel sending across accounts',
    ],
  });
});

app.post('/api/replies', (req, res) => {
  const { email, subject, snippet } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  store.markReply(email, subject, snippet);
  res.json({ success: true });
});

app.post('/api/bounces', (req, res) => {
  const { email, reason } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  store.markBounce(email, reason || 'Address not found / domain invalid');
  res.json({ success: true, message: `${email} marked as bounced and suppressed` });
});

app.get('/api/sender/status', (req, res) => {
  res.json(getSenderStatus());
});

app.post('/api/sender/start', async (req, res) => {
  try {
    startSender();
    // On serverless, start immediately processes a batch so sending does not depend on timers
    if (isServerless) {
      const tick = await runSenderTick({ force: true });
      return res.json({ ...tick.status, tick });
    }
    res.json(getSenderStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sender/stop', (req, res) => {
  stopSender();
  res.json(getSenderStatus());
});

async function handleSenderTick(req, res) {
  try {
    await store.ensureFresh(true);
    const force = req.query.force === '1' || req.body?.force === true;
    const tick = await runSenderTick({ force });
    res.json(tick);
  } catch (err) {
    console.error('Sender tick failed:', err);
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/sender/tick', handleSenderTick);
app.post('/api/sender/tick', handleSenderTick);
app.get('/api/cron/sender', handleSenderTick);
app.post('/api/cron/sender', handleSenderTick);

// --- Email configuration ---

app.get('/api/email-providers', (req, res) => {
  res.json(getProviders());
});

app.get('/api/email-config/accounts', (req, res) => {
  const envAccounts = getAccounts().map(a => ({
    id: a.id,
    provider: a.email?.includes('gmail') ? 'gmail' : a.host?.includes('hostinger') ? 'hostinger' : 'custom',
    label: a.label,
    email: a.email,
    host: a.host,
    port: a.port,
    secure: a.secure,
    fromName: a.fromName,
    listId: a.listId,
    listLabel: a.listLabel,
    dailyLimit: a.dailyLimit,
    sendDelayMs: a.sendDelayMs,
    protected: a.protected,
    source: 'env',
    configured: true,
  }));
  const saved = store.getSavedSmtpAccounts();
  const demoAccounts = [
    {
      id: 'demo_gmail_ahmad',
      provider: 'gmail',
      label: 'Ahmad — Gmail Demo',
      email: 'ahmad.yaseen@gmail.com',
      fromName: 'Ahmad Yaseen',
      host: 'smtp.gmail.com',
      port: 587,
      dailyLimit: 490,
      source: 'demo',
      configured: true,
      first_name: 'Ahmad',
    },
    {
      id: 'demo_outlook_ahmad',
      provider: 'outlook',
      label: 'Ahmad — Outlook Demo',
      email: 'ahmad.randhawa@outlook.com',
      fromName: 'Ahmad Randhawa',
      host: 'smtp-mail.outlook.com',
      port: 587,
      dailyLimit: 300,
      source: 'demo',
      configured: true,
      first_name: 'Ahmad',
    },
    {
      id: 'demo_yahoo_ahmad',
      provider: 'yahoo',
      label: 'Ahmad — Yahoo Demo',
      email: 'ahmad.demo@yahoo.com',
      fromName: 'Ahmad Demo',
      host: 'smtp.mail.yahoo.com',
      port: 587,
      dailyLimit: 200,
      source: 'demo',
      configured: true,
      first_name: 'Ahmad',
    },
  ];
  res.json({ envAccounts, savedAccounts: saved, demoAccounts });
});

app.post('/api/email-config/accounts', (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.host) {
      body.host = 'smtp.gmail.com';
      body.port = 587;
      body.secure = false;
      body.provider = body.provider || 'gmail';
    }
    const saved = store.saveSmtpAccount(body);
    resetAccountsCache();
    resetTransporter();
    res.json({ success: true, account: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/email-config/accounts/:id', (req, res) => {
  store.deleteSavedSmtpAccount(req.params.id);
  store.setAccountDisabled(req.params.id, false);
  resetAccountsCache();
  resetTransporter(req.params.id);
  res.json({ success: true });
});

app.post('/api/email-config/test', async (req, res) => {
  const { account, host, port, secure, email, pass, fromName } = req.body;
  try {
    let cfg;
    if (account && getAccount(account)) {
      resetTransporter(account);
      await verifySmtp(account);
      const acc = getAccount(account);
      return res.json({ success: true, message: `SMTP verified for ${acc.email}` });
    }
    if (!host || !email || !pass) {
      return res.status(400).json({ error: 'Host, email, and password are required' });
    }
    cfg = { host, port: parseInt(port, 10) || 587, secure: !!secure, email, pass, fromName };
    await verifyCustomSmtp(cfg);
    res.json({ success: true, message: `SMTP verified for ${email}` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

app.post('/api/email-config/test-send', async (req, res) => {
  const { host, port, secure, email, pass, fromName, test_to, account } = req.body;
  const testTo = test_to || email;
  if (!testTo) return res.status(400).json({ error: 'Test recipient email required' });
  try {
    if (account && getAccount(account)) {
      await sendTestEmail({
        subject: 'Reachly — SMTP test',
        body_html: '<p>SMTP test successful.</p>',
        body_text: 'SMTP test successful.',
      }, testTo, { first_name: 'Test', email: testTo, company: 'Test Co', title: 'Tester' }, account);
      return res.json({ success: true, message: `Test email sent to ${testTo}` });
    }
    const cfg = { host, port: parseInt(port, 10) || 587, secure: !!secure, email, pass, fromName };
    await sendTestWithCustomConfig(cfg, testTo);
    res.json({ success: true, message: `Test email sent to ${testTo}` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// --- Lead research ---

app.get('/api/lead-providers', (req, res) => {
  res.json({ providers: getLeadProviders(), keys: store.getLeadProviderKeys() });
});

app.post('/api/lead-providers/:id/key', (req, res) => {
  store.setLeadProviderKey(req.params.id, req.body.apiKey || '');
  res.json({ success: true });
});

app.post('/api/lead-research/search', async (req, res) => {
  const { provider, query } = req.body;
  if (!provider) return res.status(400).json({ error: 'Provider required' });
  const apiKey = store.getLeadProviderKey(provider);
  try {
    const result = await searchLeads(provider, query || {}, apiKey);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/lead-research/import', (req, res) => {
  const { leads, list_id } = req.body;
  if (!Array.isArray(leads) || !leads.length) {
    return res.status(400).json({ error: 'No leads to import' });
  }
  const listId = list_id || 'list1';
  let added = 0;
  let skipped = 0;
  for (const lead of leads) {
    if (!lead.email) { skipped++; continue; }
    try {
      store.addContact(lead.email, {
        name: lead.name,
        first_name: lead.first_name,
        last_name: lead.last_name,
        company: lead.company,
        title: lead.title,
        city: lead.city,
        industry: lead.industry,
        linkedin: lead.linkedin,
        company_profile: lead.company_profile,
      }, listId);
      added++;
    } catch {
      skipped++;
    }
  }
  res.json({ success: true, added, skipped, listId });
});

// --- Variables ---

app.get('/api/variables', (req, res) => {
  res.json({
    data: getDataVariables(),
    custom: store.getCustomVariables(),
  });
});

app.post('/api/variables/custom', (req, res) => {
  try {
    const item = store.addCustomVariable(req.body);
    res.json({ success: true, variable: item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/variables/custom/:id', (req, res) => {
  store.deleteCustomVariable(parseInt(req.params.id, 10));
  res.json({ success: true });
});

app.use(express.static(path.join(__dirname, 'static')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Request error:', err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

function startBackgroundJobs() {
  if (store.getPendingCount() > 0) {
    const hasQuota = getAccounts().some(a => store.getRemainingToday(a.dailyLimit, a.id) > 0);
    if (hasQuota) {
      store.setMeta({ userStoppedSender: false });
      startSender();
    } else {
      const p = store.getQueueProgress();
      console.log(`Queue: ${p.pending.toLocaleString()} pending. Daily limits reached — resumes tomorrow.`);
    }
  }

  cron.schedule('0 0 * * *', () => {
    resetDailyState();
    store.setMeta({ userStoppedSender: false });
    const pending = store.getPendingCount();
    console.log(`New day — limits reset. ${pending.toLocaleString()} emails in queue.`);
    if (pending > 0) startSender();
  });
}

if (!isServerless) {
  startBackgroundJobs();
  app.listen(PORT, () => {
    const accounts = getAccountStatuses();
    console.log(`Reachly running at http://localhost:${PORT}`);
    for (const a of accounts) {
      console.log(`  ${a.label}: ${a.email} | ${a.todaySent}/${a.dailyLimit} today | ${a.protected ? 'PROTECTED' : 'standard'}`);
    }
  });
} else {
  const storage = store.getStorageInfo();
  console.log('Reachly serverless mode — tick sender + Upstash persistence');
  console.log(`  Storage: ${storage.label}`);
  if (!storage.durable) {
    console.log('  WARNING: set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN');
  }
}

module.exports = app;
