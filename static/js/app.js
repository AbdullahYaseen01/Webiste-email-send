const API = '/api';

let currentPage = 1;
let refreshInterval = null;
let quillEditor = null;
let charts = {};
let lastSenderRunning = false;
let selectedListId = 'list1';
let selectedAccountId = 'all';
let loadedTemplateVersion = 0;
let accountsData = [];
let editingCampaignId = null;

// --- Quill Editor ---

function initEditor() {
  if (quillEditor) return;
  quillEditor = new Quill('#emailEditor', {
    theme: 'snow',
    placeholder: 'Write your email here...',
    modules: {
      toolbar: [
        ['bold', 'italic', 'underline'],
        [{ list: 'bullet' }, { list: 'ordered' }],
        ['link'],
      ],
    },
  });
  quillEditor.on('text-change', debounce(() => { runValidation(); updatePreview(); }, 400));
}

function getEditorHtml() {
  return quillEditor ? quillEditor.root.innerHTML : '';
}

function getEditorText() {
  return quillEditor ? quillEditor.getText().trim() : '';
}

/** Load HTML into Quill without stripping bold/links (root.innerHTML is unreliable). */
function setEditorHtml(html) {
  if (!quillEditor) return;
  const safe = html || '';
  quillEditor.setContents([]);
  quillEditor.clipboard.dangerouslyPasteHTML(0, safe);
}

function insertAtCursor(text) {
  if (!quillEditor) return;
  const range = quillEditor.getSelection(true);
  quillEditor.insertText(range.index, text);
  quillEditor.setSelection(range.index + text.length);
}

// --- Navigation ---

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const page = link.dataset.page;
    showPage(page);
  });
});

function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`[data-page="${page}"]`).classList.add('active');

  if (page === 'dashboard') loadDashboard();
  if (page === 'compose') loadComposePage();
  if (page === 'contacts') loadContacts();
  if (page === 'follow-up') loadFollowUpPage();
  if (page === 'campaigns') loadCampaigns();
  if (page === 'email-config') loadEmailConfig();
  if (page === 'lead-research') loadLeadResearch();
  if (page === 'settings') loadSettings();
}

// --- Toast ---

function toast(message, type = 'success') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// --- API helpers ---

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
  return data;
}

// --- Dashboard & Charts ---

const CHART_COLORS = {
  sent: '#22c55e',
  failed: '#ef4444',
  pending: '#6366f1',
  denied: '#f97316',
  grid: '#2e3345',
  text: '#8b90a0',
};

function renderAccountQuotas(accounts) {
  const el = document.getElementById('accountQuotas');
  if (!el || !accounts?.length) return;
  el.innerHTML = accounts.map(a => {
    const pct = a.dailyLimit > 0 ? Math.min((a.todaySent / a.dailyLimit) * 100, 100) : 0;
    const short = a.email.split('@')[0];
    return `<div class="sidebar-quota-item">
      <div class="sidebar-quota-label">${a.protected ? '🛡 ' : ''}${short}</div>
      <div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div>
      <div class="quota-text">${a.todaySent} / ${a.dailyLimit}</div>
    </div>`;
  }).join('');
}

function renderAccountCards(accounts) {
  const el = document.getElementById('accountCards');
  if (!el) return;
  if (!accounts?.length) { el.innerHTML = ''; return; }
  el.innerHTML = accounts.map(a => {
    let badge = 'ok', badgeText = 'Healthy';
    if (a.paused) { badge = 'warning'; badgeText = 'Paused'; }
    else if (a.isSending) { badge = 'sending'; badgeText = 'Sending now'; }
    else if (a.running) { badge = 'running'; badgeText = 'Running'; }
    else if (a.blocked) { badge = 'danger'; badgeText = 'Paused (block)'; }
    else if (a.dailyQuotaHit) { badge = 'warning'; badgeText = 'Daily limit'; }
    else if (a.protected) { badge = 'protected'; badgeText = 'Protected'; }
    const pct = a.dailyLimit > 0 ? Math.round((a.todaySent / a.dailyLimit) * 100) : 0;
    const stopped = !!a.userStopped;
    if (stopped) { badge = 'warning'; badgeText = 'Stopped'; }
    return `<div class="account-card ${a.protected ? 'protected' : ''} ${stopped ? 'stopped' : ''}">
      <div class="account-card-header">
        <div><strong>${escapeHtml(a.label)}</strong><div class="account-card-email">${escapeHtml(a.email)}</div></div>
        <span class="account-badge ${badge}">${badgeText}</span>
      </div>
      <div class="quota-bar" style="margin:8px 0"><div class="quota-fill" style="width:${pct}%"></div></div>
      <div style="font-size:0.85rem;color:var(--text-muted)">
        ${a.todaySent}/${a.dailyLimit} today · ${a.remainingToday} left · ${a.sendDelayMs / 1000}s delay · ${escapeHtml(a.listLabel)}${a.pendingQueue ? ` · ${a.pendingQueue.toLocaleString()} queued` : ''}
      </div>
      <div class="account-card-actions" data-account-id="${escapeHtml(a.id)}" data-account-email="${escapeHtml(a.email || '')}">
        ${stopped
          ? `<button type="button" class="btn btn-sm btn-success" data-action="start">Start</button>`
          : `<button type="button" class="btn btn-sm" data-action="stop">Stop</button>`}
        ${a.removable !== false
          ? `<button type="button" class="btn btn-sm btn-danger" data-action="remove">Remove</button>`
          : ''}
      </div>
    </div>`;
  }).join('');
}

const EMAIL_PROVIDER_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false, dailyLimit: 200, hint: 'Gmail: use Google App Password (not normal password).' },
  hostinger: { host: 'smtp.hostinger.com', port: 465, secure: true, dailyLimit: 400, hint: 'Hostinger: full email + mailbox password. Limit 400/day.' },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false, dailyLimit: 200, hint: 'Outlook / Hotmail app password or account password.' },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 587, secure: false, dailyLimit: 200, hint: 'Yahoo: generate an app password.' },
  zoho: { host: 'smtp.zoho.com', port: 587, secure: false, dailyLimit: 200, hint: 'Zoho: use app-specific password.' },
  custom: { host: '', port: 587, secure: false, dailyLimit: 200, hint: 'Enter your SMTP host, port, and password.' },
};

function applyAddEmailProvider() {
  const id = document.getElementById('addEmailProvider')?.value || 'gmail';
  const p = EMAIL_PROVIDER_PRESETS[id] || EMAIL_PROVIDER_PRESETS.custom;
  const hint = document.getElementById('addEmailProviderHint');
  if (hint) hint.textContent = p.hint;
  const smtpFields = document.getElementById('addEmailSmtpFields');
  const showCustom = id === 'custom';
  smtpFields?.classList.toggle('hidden', !showCustom);
  if (document.getElementById('addEmailHost')) document.getElementById('addEmailHost').value = p.host;
  if (document.getElementById('addEmailPort')) document.getElementById('addEmailPort').value = p.port;
  if (document.getElementById('addEmailSecure')) document.getElementById('addEmailSecure').value = p.secure ? 'true' : 'false';
  if (document.getElementById('addEmailDailyLimit')) document.getElementById('addEmailDailyLimit').value = p.dailyLimit || 200;
}

document.getElementById('openAddGmailBtn')?.addEventListener('click', () => {
  document.getElementById('addGmailModal')?.classList.remove('hidden');
  applyAddEmailProvider();
});
document.getElementById('closeAddGmailModal')?.addEventListener('click', () => {
  document.getElementById('addGmailModal')?.classList.add('hidden');
});
document.getElementById('addEmailProvider')?.addEventListener('change', applyAddEmailProvider);

document.getElementById('addGmailForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const provider = document.getElementById('addEmailProvider')?.value || 'gmail';
  const preset = EMAIL_PROVIDER_PRESETS[provider] || EMAIL_PROVIDER_PRESETS.custom;
  const email = document.getElementById('addGmailEmail').value.trim();
  const pass = document.getElementById('addGmailPass').value.trim();
  const label = document.getElementById('addGmailLabel').value.trim();
  const host = (document.getElementById('addEmailHost')?.value || preset.host || '').trim();
  const port = parseInt(document.getElementById('addEmailPort')?.value || preset.port, 10);
  const secure = (document.getElementById('addEmailSecure')?.value || String(!!preset.secure)) === 'true';
  const dailyLimit = parseInt(document.getElementById('addEmailDailyLimit')?.value || preset.dailyLimit || 200, 10);
  try {
    const res = await api('/accounts/connect', {
      method: 'POST',
      body: JSON.stringify({ email, pass, label, provider, host, port, secure, dailyLimit }),
    });
    toast(res.message || 'Email connected');
    document.getElementById('addGmailModal')?.classList.add('hidden');
    document.getElementById('addGmailForm').reset();
    loadDashboard();
    loadAccounts().then(() => populateAccountSelect());
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function stopAccount(id) {
  try {
    const res = await api(`/accounts/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    toast(res.message || 'Account stopped');
    if (res.accounts) renderAccountCards(res.accounts);
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function startAccount(id) {
  try {
    const res = await api(`/accounts/${encodeURIComponent(id)}/start`, { method: 'POST' });
    toast(res.message || 'Account started');
    if (res.accounts) renderAccountCards(res.accounts);
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeAccount(id, email) {
  if (!confirm(`Remove ${email || 'this account'}? It will stop sending from this inbox.`)) return;
  try {
    const res = await api(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast(res.message || 'Account removed');
    if (res.accounts) {
      renderAccountCards(res.accounts);
      renderAccountQuotas(res.accounts);
    }
    loadDashboard();
    loadAccounts().then(() => populateAccountSelect());
  } catch (err) {
    toast(err.message, 'error');
  }
}

window.stopAccount = stopAccount;
window.startAccount = startAccount;
window.removeAccount = removeAccount;

document.getElementById('accountCards')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const wrap = btn.closest('[data-account-id]');
  const id = wrap?.getAttribute('data-account-id');
  if (!id) return;
  const email = wrap.getAttribute('data-account-email') || '';
  const action = btn.getAttribute('data-action');
  if (action === 'stop') stopAccount(id);
  else if (action === 'start') startAccount(id);
  else if (action === 'remove') removeAccount(id, email);
});

function failureLabel(type) {
  const map = {
    invalid_recipient: 'Not found',
    blocked: 'Blocked',
    rate_limit: 'Rate limit',
    daily_quota: 'Quota',
    permanent: 'Failed',
    temporary: 'Temp error',
  };
  return map[type] || type || '';
}

function upsertChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return;
  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    ...config.options,
  };
  if (charts[id]) {
    charts[id].data = config.data;
    charts[id].options = baseOptions;
    charts[id].update('none');
    return;
  }
  charts[id] = new Chart(canvas, { ...config, options: baseOptions });
}

function renderCharts(analytics, progress) {
  const o = analytics.overview;

  upsertChart('chartStatus', {
    type: 'doughnut',
    data: {
      labels: ['Sent', 'Failed', 'Pending'],
      datasets: [{
        data: [o.sent, o.failed, o.pending],
        backgroundColor: [CHART_COLORS.sent, CHART_COLORS.failed, CHART_COLORS.pending],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { color: CHART_COLORS.text } } },
    },
  });

  const daily = analytics.dailyChart;
  upsertChart('chartDaily', {
    type: 'bar',
    data: {
      labels: daily.map(d => d.day.slice(5)),
      datasets: [
        { label: 'Sent', data: daily.map(d => d.sent), backgroundColor: CHART_COLORS.sent },
        { label: 'Failed', data: daily.map(d => d.failed), backgroundColor: CHART_COLORS.failed },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: CHART_COLORS.text }, grid: { color: CHART_COLORS.grid } },
        y: { ticks: { color: CHART_COLORS.text }, grid: { color: CHART_COLORS.grid }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: CHART_COLORS.text } } },
    },
  });

  const hourly = analytics.hourlyToday.filter(h => h.sent > 0 || h.failed > 0);
  const hours = hourly.length > 0 ? hourly : analytics.hourlyToday;
  upsertChart('chartHourly', {
    type: 'line',
    data: {
      labels: hours.map(h => `${h.hour}:00`),
      datasets: [
        { label: 'Sent', data: hours.map(h => h.sent), borderColor: CHART_COLORS.sent, tension: 0.3, fill: false },
        { label: 'Failed', data: hours.map(h => h.failed), borderColor: CHART_COLORS.failed, tension: 0.3, fill: false },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: CHART_COLORS.text }, grid: { color: CHART_COLORS.grid } },
        y: { ticks: { color: CHART_COLORS.text }, grid: { color: CHART_COLORS.grid }, beginAtZero: true },
      },
      plugins: { legend: { labels: { color: CHART_COLORS.text } } },
    },
  });

  const fb = analytics.failureBreakdown;
  const fbLabels = Object.keys(fb);
  upsertChart('chartFailures', {
    type: 'bar',
    data: {
      labels: fbLabels.length ? fbLabels : ['none'],
      datasets: [{
        label: 'Count',
        data: fbLabels.length ? fbLabels.map(k => fb[k]) : [0],
        backgroundColor: CHART_COLORS.denied,
      }],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      scales: {
        x: { ticks: { color: CHART_COLORS.text }, grid: { color: CHART_COLORS.grid }, beginAtZero: true },
        y: { ticks: { color: CHART_COLORS.text }, grid: { color: CHART_COLORS.grid } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

async function loadDashboard() {
  try {
    const data = await api('/stats');
    const { sender, recentLogs, progress, analytics } = data;
    const accounts = data.accounts || sender.accounts || [];
    accountsData = accounts;
    const o = analytics.overview;

    document.getElementById('statTotalSent').textContent = o.sent.toLocaleString();
    document.getElementById('statTotalFailed').textContent = o.failed.toLocaleString();
    document.getElementById('statPending').textContent = o.pending.toLocaleString();
    document.getElementById('statSuccessRate').textContent = `${o.successRate}%`;
    document.getElementById('statTodaySent').textContent = o.todaySent.toLocaleString();
    document.getElementById('statReplies').textContent = o.replyCount.toLocaleString();

    renderAccountQuotas(accounts);
    renderAccountCards(accounts);

    renderQueueProgress(sender, progress);
    renderCharts(analytics, progress);

    const liveDot = document.getElementById('liveDot');
    if (sender.running) {
      liveDot.classList.remove('hidden');
    } else {
      liveDot.classList.add('hidden');
    }
    lastSenderRunning = sender.running;

    const badge = document.getElementById('senderBadge');
    if (sender.isSending) {
      badge.textContent = 'Sending...';
      badge.className = 'badge sending';
    } else if (sender.running) {
      badge.textContent = 'Running';
      badge.className = 'badge running';
    } else if (sender.userStopped && progress.pending > 0) {
      badge.textContent = 'Stopped';
      badge.className = 'badge paused';
    } else if (sender.dailyLimitReached) {
      badge.textContent = 'Daily Limit';
      badge.className = 'badge paused';
    } else {
      badge.textContent = 'Idle';
      badge.className = 'badge idle';
    }

    document.getElementById('toggleSender').textContent = sender.running ? 'Stop Sender' : 'Start Sender';
    renderDashboardAlerts(sender, progress, data.storage);
    await keepSenderAlive(sender, progress);

    const campTbody = document.getElementById('campaignStatsTable');
    if (!analytics.campaignStats.length) {
      campTbody.innerHTML = '<tr><td colspan="11" class="empty-state">No campaigns yet</td></tr>';
    } else {
      campTbody.innerHTML = analytics.campaignStats.map(c => {
        const prog = c.total > 0 ? Math.round(((c.sent + c.failed) / c.total) * 100) : 0;
        const acc = accounts.find(a => a.id === c.smtp_account_id);
        const actions = campaignActions({
          id: c.id,
          status: c.status,
          sent_count: c.sent,
          campaign_type: c.campaign_type,
        });
        return `<tr>
          <td>${escapeHtml(c.name)}</td>
          <td style="font-size:0.8rem">${acc ? escapeHtml(acc.email.split('@')[0]) : c.smtp_account_id || '—'}</td>
          <td>${c.list_id || '—'}</td>
          <td style="font-size:0.85rem">${escapeHtml(c.subject || '—')}</td>
          <td><span class="status-badge ${c.status}">${c.status}</span></td>
          <td>${c.sent.toLocaleString()}</td>
          <td>${c.failed.toLocaleString()}</td>
          <td>${c.pending.toLocaleString()}</td>
          <td>${c.successRate}%</td>
          <td>
            <div class="progress-cell">
              <div class="progress-mini"><div class="progress-mini-fill" style="width:${prog}%"></div></div>
              <span>${prog}%</span>
            </div>
          </td>
          <td><div class="campaign-actions-cell">${actions}</div></td>
        </tr>`;
      }).join('');
    }

    const failTbody = document.getElementById('failureReasonsTable');
    if (!analytics.topFailures.length) {
      failTbody.innerHTML = '<tr><td colspan="2" class="empty-state">No failures recorded</td></tr>';
    } else {
      failTbody.innerHTML = analytics.topFailures.map(f => `
        <tr>
          <td>${f.count}</td>
          <td style="font-size:0.85rem">${escapeHtml(f.reason)}</td>
        </tr>
      `).join('');
    }

    const tbody = document.getElementById('recentLogs');
    if (recentLogs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No activity yet</td></tr>';
    } else {
      tbody.innerHTML = recentLogs.map(log => `
        <tr>
          <td style="white-space:nowrap">${formatDate(log.sent_at)}</td>
          <td>${escapeHtml(log.email)}</td>
          <td style="white-space:nowrap">
            <span class="status-badge ${log.status === 'failed' ? 'failed' : log.status}">${log.status}</span>
            ${log.failure_type ? `<span class="failure-type">${failureLabel(log.failure_type)}</span>` : ''}
          </td>
          <td>
            <div class="log-actions">
              <span class="log-detail-text">${log.error_message ? escapeHtml(log.error_message.slice(0, 120)) : '—'}</span>
              ${log.status === 'sent' ? `<button class="btn btn-sm" onclick='logReply(${JSON.stringify(log.email)})'>Reply</button>` : ''}
            </div>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function logReply(email) {
  const subject = prompt(`Log reply from ${email} — subject (optional):`);
  if (subject === null) return;
  try {
    await api('/replies', { method: 'POST', body: JSON.stringify({ email, subject }) });
    toast('Reply logged');
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderQueueProgress(sender, progress) {
  const card = document.getElementById('queueProgressCard');
  if (!progress || progress.total === 0) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  document.getElementById('progressSent').textContent = progress.sent.toLocaleString();
  document.getElementById('progressPending').textContent = progress.pending.toLocaleString();
  document.getElementById('progressTotal').textContent = progress.total.toLocaleString();
  document.getElementById('progressPercent').textContent = `${progress.percentComplete}%`;
  document.getElementById('campaignProgressFill').style.width = `${progress.percentComplete}%`;

  const detail = document.getElementById('progressDetail');
  const estimate = document.getElementById('progressEstimate');

  if (sender.running) {
    detail.textContent = `Currently sending #${progress.nextPosition} of ${progress.total.toLocaleString()}${progress.nextEmail ? ` → ${progress.nextEmail}` : ''}`;
  } else if (sender.userStopped && progress.pending > 0) {
    detail.innerHTML = `Stopped at <strong>#${sender.stoppedAtPosition || progress.completed}</strong> of ${progress.total.toLocaleString()}. Click <strong>Start Sender</strong> to resume from ${progress.nextEmail || 'next email'}.`;
  } else if (sender.dailyLimitReached && progress.pending > 0) {
    detail.innerHTML = `Today's limit reached (${sender.dailyLimit}/day). <strong>${progress.pending.toLocaleString()}</strong> emails saved — auto-resumes tomorrow at midnight.`;
  } else if (progress.pending > 0) {
    detail.textContent = `Ready to send ${progress.pending.toLocaleString()} remaining emails. Next: ${progress.nextEmail || '—'}`;
  } else {
    detail.textContent = `All ${progress.total.toLocaleString()} emails processed (${progress.sent.toLocaleString()} sent, ${progress.failed} failed).`;
  }

  if (progress.pending > 0 && sender.estimatedDaysRemaining > 0) {
    const combinedDaily = (sender.accounts || []).reduce((sum, a) => sum + (a.remainingToday || 0), 0);
    const dailyNote = (sender.accounts || []).length > 1
      ? `~${combinedDaily} emails/day combined across accounts`
      : `${sender.accounts?.[0]?.dailyLimit || 490}/day`;
    estimate.textContent = `Estimated ~${sender.estimatedDaysRemaining} day(s) remaining at ${dailyNote}`;
  } else {
    estimate.textContent = '';
  }

  const campaigns = progress.activeCampaigns || (progress.activeCampaign ? [progress.activeCampaign] : []);
  const listEl = document.getElementById('activeCampaignsList');
  const actionsEl = document.getElementById('campaignProgressActions');

  if (listEl) {
    if (campaigns.length > 1) {
      listEl.innerHTML = campaigns.map(c => {
        const acc = accountsData.find(a => a.id === c.smtp_account_id);
        return `<div class="active-campaign-row">
          <div class="active-campaign-row-header">
            <div><strong>Campaign #${c.id}</strong> · <span class="status-badge ${c.status}">${c.status}</span></div>
            <div class="campaign-actions-cell">${campaignActions(c)}</div>
          </div>
          <div class="active-campaign-row-meta">
            ${escapeHtml(c.name)} · ${acc ? escapeHtml(acc.email) : c.smtp_account_id} · ${c.list_id || '—'}
          </div>
          <div class="quota-bar"><div class="quota-fill" style="width:${c.percentComplete || 0}%"></div></div>
          <div style="font-size:0.85rem;color:var(--text-muted);margin-top:6px">
            ${c.sent.toLocaleString()} sent · ${c.pending.toLocaleString()} remaining · ${c.total.toLocaleString()} total (${c.percentComplete || 0}%)
          </div>
        </div>`;
      }).join('');
      actionsEl?.classList.add('hidden');
      if (actionsEl) actionsEl.innerHTML = '';
    } else {
      listEl.innerHTML = '';
      const active = campaigns[0];
      if (actionsEl && active) {
        actionsEl.classList.remove('hidden');
        actionsEl.innerHTML = campaignActions(active);
      } else if (actionsEl) {
        actionsEl.classList.add('hidden');
        actionsEl.innerHTML = '';
      }
    }
  }

  const parallelHint = document.getElementById('parallelHint');
  if (parallelHint) {
    const runningCount = (sender.accounts || []).filter(a => a.running).length;
    parallelHint.textContent = runningCount > 1
      ? `${runningCount} Gmail accounts sending in parallel right now.`
      : 'Both Gmail accounts can run campaigns in parallel — one campaign per account.';
  }
}

function renderDashboardAlerts(sender, progress, storage) {
  const el = document.getElementById('dashboardAlerts');
  const alerts = [];
  const storeInfo = storage || sender.storage || {};

  if (storeInfo.warning) {
    alerts.push({ type: 'error', msg: storeInfo.warning });
  } else if (sender.tickMode && storeInfo.durable && progress?.pending > 0 && sender.running) {
    alerts.push({
      type: 'info',
      msg: 'Hardened Vercel sender active — queue is durable. Keep Dashboard open OR use an external cron on /api/cron/sender.',
    });
  }

  if (progress?.pending > 0 && sender.dailyLimitReached) {
    alerts.push({ type: 'info', msg: `${progress.pending.toLocaleString()} emails queued. Will auto-resume tomorrow when limits reset.` });
  }
  if (sender.userStopped && progress?.pending > 0) {
    alerts.push({ type: 'warning', msg: `Sender stopped at email #${sender.stoppedAtPosition || progress.completed}. Click Start Sender to continue.` });
  }
  if (sender.dailyQuotaHit) {
    alerts.push({ type: 'error', msg: 'Daily sending limit reached. Queue resumes automatically tomorrow.' });
  }
  if (sender.paused && sender.pauseReason) {
    alerts.push({ type: 'warning', msg: `Account paused: ${sender.pauseReason}${sender.pausedUntil ? `. Resumes at ${formatDate(sender.pausedUntil)}` : ''}` });
  }
  const runningAccounts = (sender.accounts || []).filter(a => a.running || a.isSending);
  if (runningAccounts.length > 1) {
    alerts.push({ type: 'info', msg: `${runningAccounts.length} inboxes active (${runningAccounts.map(a => a.email.split('@')[0]).join(' + ')}).` });
  }
  if (sender.lastError?.type === 'blocked') {
    alerts.push({ type: 'error', msg: 'SMTP blocked an email. Review content and wait before resuming.' });
  }

  if (alerts.length === 0) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = alerts.map(a =>
    `<div class="dashboard-alert ${a.type}">${escapeHtml(a.msg)}</div>`
  ).join('');
}

let senderTickInFlight = false;
let lastSenderTickAt = 0;

/** Gentle keepalive — 1 tick / 15s so Fluid CPU stays low but campaign does not stall. */
async function keepSenderAlive(sender, progress) {
  if (!sender?.tickMode) return;
  if (sender.userStopped || sender.dailyLimitReached) return;
  if (!progress?.pending || progress.pending <= 0) return;
  if (senderTickInFlight) return;
  if (Date.now() - lastSenderTickAt < 15000) return;

  senderTickInFlight = true;
  lastSenderTickAt = Date.now();
  try {
    await api('/sender/tick', { method: 'POST', body: JSON.stringify({}) });
  } catch (err) {
    console.warn('Sender tick failed:', err.message);
  } finally {
    senderTickInFlight = false;
  }
}

document.getElementById('toggleSender').addEventListener('click', async () => {
  try {
    const status = await api('/sender/status');
    if (status.running) {
      await api('/sender/stop', { method: 'POST' });
      toast('Campaign stopped — all active campaigns paused. Click Start Sender to resume.');
    } else {
      const result = await api('/sender/start', { method: 'POST' });
      const sentNow = result.tick?.sent || 0;
      toast(sentNow > 0
        ? `Sender started — ${sentNow} email(s) sent in this batch.`
        : 'Sender started — paused campaigns resumed.');
    }
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('clearHistoryBtn')?.addEventListener('click', async () => {
  if (!confirm('Clear all campaign history on the dashboard?\n\nThis removes campaigns, the send queue, activity, and errors.\nContacts and email accounts are kept.')) {
    return;
  }
  try {
    const result = await api('/history/clear', { method: 'POST' });
    toast(result.message || 'History cleared');
    loadDashboard();
    loadCampaigns();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Compose ---

async function loadAccounts() {
  try {
    const data = await api('/accounts');
    accountsData = data.accounts || [];
    return data;
  } catch {
    return { accounts: [], lists: {} };
  }
}

function populateAccountSelect() {
  const sel = document.getElementById('smtpAccountSelect');
  if (!sel) return;
  const allOpt = accountsData.length > 1
    ? `<option value="all" ${selectedAccountId === 'all' ? 'selected' : ''}>All accounts — split evenly (${accountsData.length} inboxes)</option>`
    : '';
  sel.innerHTML = allOpt + accountsData.map(a =>
    `<option value="${a.id}" ${a.id === selectedAccountId ? 'selected' : ''}>${escapeHtml(a.label)} — ${escapeHtml(a.email)} (${a.dailyLimit}/day${a.protected ? ', protected' : ''})</option>`
  ).join('');
}

function getSelectedAccount() {
  if (selectedAccountId === 'all') {
    const totalLimit = accountsData.reduce((s, a) => s + (a.dailyLimit || 0), 0);
    return {
      id: 'all',
      email: `${accountsData.length} accounts (split evenly)`,
      listId: 'all',
      listLabel: 'All contact lists',
      dailyLimit: totalLimit,
      sendDelayMs: Math.min(...accountsData.map(a => a.sendDelayMs || 5000)),
      protected: false,
    };
  }
  return accountsData.find(a => a.id === selectedAccountId) || accountsData[0];
}

function countActiveContacts(listsMap, listId) {
  const lists = listsMap || {};
  if (!listId || listId === 'all') {
    return Object.values(lists).reduce((s, l) => s + (l.active || 0), 0);
  }
  return (lists[listId] || {}).active || 0;
}

async function updateComposeMeta() {
  const acc = getSelectedAccount();
  if (!acc) return;
  document.getElementById('composeFrom').textContent = acc.email;
  const lists = await api('/accounts');
  const active = countActiveContacts(lists.lists, acc.listId);
  document.getElementById('composeContactCount').textContent = `${active.toLocaleString()} eligible`;
  document.getElementById('composeTo').textContent = active > 0
    ? `${acc.listLabel} (${active.toLocaleString()} contacts, duplicates skipped)`
    : `Upload contacts in the Contacts tab first`;
  const hint = document.getElementById('accountHint');
  if (hint) {
    if (acc.id === 'all') {
      hint.textContent = `Split evenly across ${accountsData.length} inboxes. Contacts from every list are included. Follow-ups reuse the same inbox per contact.`;
    } else {
      hint.textContent = acc.protected
        ? `Protected: ${acc.dailyLimit}/day max, ${acc.sendDelayMs / 1000}s between sends, extended pause on blocks`
        : `Standard: ${acc.dailyLimit}/day, ${acc.sendDelayMs / 1000}s delay between sends`;
    }
  }
  if (active > 0) document.getElementById('step2')?.classList.add('done');
}

async function updatePreview() {
  const subject = document.getElementById('campaignSubject')?.value.trim();
  const body = getEditorHtml();
  if (!subject && !getEditorText()) return;

  try {
    const sample = testModes.compose === 'manual'
      ? getTestSampleContact('compose')
      : (previewSampleContact || undefined);
    const preview = await api('/campaigns/preview', {
      method: 'POST',
      body: JSON.stringify({
        subject,
        body,
        preheader: document.getElementById('campaignPreheader').value.trim(),
        include_unsubscribe: document.getElementById('includeUnsubscribe').checked,
        smtp_account_id: selectedAccountId,
        sample_contact: sample,
      }),
    });
    document.getElementById('previewFrom').textContent = `${preview.fromName} <${preview.from}>`;
    document.getElementById('previewTo').textContent = preview.to;
    document.getElementById('previewSubject').textContent = preview.subject;
    document.getElementById('previewPlain').textContent = preview.text;
    const frame = document.getElementById('previewFrame');
    if (frame) frame.srcdoc = preview.html;
  } catch { /* ignore preview errors during typing */ }
}

async function loadComposePage() {
  initEditor();
  try {
    await loadAccounts();
    if (accountsData.length > 1) selectedAccountId = 'all';
    else if (accountsData.find(a => a.id === 'account2')) selectedAccountId = 'account2';
    populateAccountSelect();
    document.getElementById('smtpAccountSelect').value = selectedAccountId;
    await updateComposeMeta();
    await loadDefaultEmail(true);
    document.getElementById('step1')?.classList.add('done');
    if (typeof loadVariablesPanel === 'function') loadVariablesPanel();
  } catch { /* ignore */ }
}

document.getElementById('smtpAccountSelect')?.addEventListener('change', async (e) => {
  selectedAccountId = e.target.value;
  await updateComposeMeta();
  await updatePreview();
});

document.getElementById('refreshPreview')?.addEventListener('click', () => updatePreview());

async function runValidation() {
  const subject = document.getElementById('campaignSubject').value.trim();
  const body = getEditorHtml();
  const preheader = document.getElementById('campaignPreheader').value.trim();

  if (!subject && !getEditorText()) return;

  try {
    const result = await api('/campaigns/validate', {
      method: 'POST',
      body: JSON.stringify({ subject, body, preheader }),
    });
    updateDeliverabilityUI(result);
    updatePreview();
  } catch { /* ignore */ }
}

function updateDeliverabilityUI(result) {
  const badge = document.getElementById('deliverabilityBadge');
  const warnings = document.getElementById('deliverabilityWarnings');

  badge.textContent = result.deliverability.charAt(0).toUpperCase() + result.deliverability.slice(1);
  badge.className = `score-badge ${result.deliverability}`;

  if (result.warnings.length === 0) {
    warnings.innerHTML = '<li style="color:var(--success)">✓ No spam issues detected</li>';
  } else {
    warnings.innerHTML = result.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
  }
}

let templateLoaded = false;
let previewSampleContact = null;
const testModes = { compose: 'quick', dashboard: 'quick' };

function firstNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  const token = local.split(/[._+\-]/)[0].replace(/\d+/g, '');
  if (token.length >= 2 && /^[a-zA-Z]+$/.test(token)) {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }
  return 'there';
}

function getTestTo(panel) {
  const isDash = panel === 'dashboard';
  return (document.getElementById(isDash ? 'dashTestTo' : 'testTo')?.value || '').trim();
}

function preferredTestAccountId() {
  const raahban = accountsData.find((a) => /^abdullah@raahban\.com$/i.test(a.email || ''))
    || accountsData.find((a) => /@raahban\.com$/i.test(a.email || ''));
  if (raahban) return raahban.id;
  const abdullah = accountsData.find((a) => /^abdullah@/i.test(a.email || ''));
  return abdullah?.id || accountsData[0]?.id || 'account1';
}

const BURNED_TEST_INBOXES = ['ahmadjutt463@gmail.com'];

function readManualContact(panel) {
  const id = (name) => (document.getElementById(name)?.value || '').trim();
  const isDash = panel === 'dashboard';
  const testTo = getTestTo(panel);
  const first = id(isDash ? 'dashTestFirstName' : 'testFirstName') || firstNameFromEmail(testTo);
  const last = id(isDash ? 'dashTestLastName' : 'testLastName');
  return {
    first_name: first,
    last_name: last,
    name: [first, last].filter(Boolean).join(' '),
    title: id(isDash ? 'dashTestTitle' : 'testTitle'),
    company: id(isDash ? 'dashTestCompany' : 'testCompany'),
    city: id(isDash ? 'dashTestCity' : 'testCity'),
    industry: id(isDash ? 'dashTestIndustry' : 'testIndustry'),
    company_profile: id(isDash ? 'dashTestCompanyProfile' : 'testCompanyProfile'),
    email: testTo,
  };
}

function getTestSampleContact(panel) {
  const testTo = getTestTo(panel);
  if (!testTo) throw new Error('Enter Send Test To');
  if (testModes[panel] === 'manual') {
    return readManualContact(panel);
  }
  if (previewSampleContact && previewSampleContact.company) {
    return { ...previewSampleContact, email: testTo };
  }
  const first = firstNameFromEmail(testTo);
  return {
    first_name: first,
    last_name: '',
    name: first,
    title: 'CTO',
    company: 'Everpay Corporation',
    city: 'Miami',
    industry: 'Financial Services',
    company_profile: '',
    email: testTo,
  };
}

function setTestMode(panel, mode) {
  testModes[panel] = mode;
  const manualId = panel === 'dashboard' ? 'dashManualTestFields' : 'composeManualTestFields';
  const quickId = panel === 'dashboard' ? 'dashQuickTestHint' : 'composeQuickTestHint';
  document.getElementById(manualId)?.classList.toggle('hidden', mode !== 'manual');
  document.getElementById(quickId)?.classList.toggle('hidden', mode === 'manual');
  document.querySelectorAll(`[data-test-panel="${panel}"]`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.testMode === mode);
  });
}

document.querySelectorAll('[data-test-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    setTestMode(btn.dataset.testPanel, btn.dataset.testMode);
    if (btn.dataset.testPanel === 'compose') updatePreview();
  });
});

async function getEmailContentForTest(source) {
  if (source === 'compose') {
    const subject = document.getElementById('campaignSubject')?.value.trim();
    const body = getEditorHtml();
    const preheader = document.getElementById('campaignPreheader')?.value.trim();
    if (!subject || !getEditorText()) throw new Error('Load default email or write content in Compose first');
    return { subject, body, preheader };
  }

  const campaigns = await api('/campaigns');
  const active = campaigns.find(c => ['sending', 'queued', 'paused'].includes(c.status));
  if (active) {
    const full = await api(`/campaigns/${active.id}`);
    return {
      subject: full.subject,
      body: full.body_html,
      preheader: full.preheader || '',
      attachmentNote: active.attachment ? 'Using campaign attachment if present on server' : null,
    };
  }

  const tpl = await api('/campaigns/templates/default');
  return { subject: tpl.subject, body: tpl.body_html, preheader: tpl.preheader || '' };
}

async function sendTestFromPanel(source) {
  const panel = source;
  const btnId = source === 'dashboard' ? 'dashSendTestEmail' : 'sendTestEmail';
  const btn = document.getElementById(btnId);
  const data = source === 'compose' ? getComposeFormData() : {};
  const testTo = getTestTo(panel);
  if (!testTo) {
    toast('Enter a Send Test To address.', 'error');
    return;
  }
  if (BURNED_TEST_INBOXES.includes(testTo.toLowerCase())) {
    const ok = window.confirm(
      'This Gmail may already treat this sending domain as spam. Click Report not spam, add abdullah@raahban.com to contacts, or test a different Gmail.\n\nSend to this same inbox anyway?'
    );
    if (!ok) return;
  }

  const content = await getEmailContentForTest(source);
  const sample = getTestSampleContact(panel);

  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Sending test...';

  try {
    const formData = new FormData();
    formData.append('subject', content.subject);
    formData.append('body', content.body);
    formData.append('preheader', content.preheader || data.preheader || '');
    formData.append('include_unsubscribe', document.getElementById('includeUnsubscribe')?.checked ?? false);
    formData.append('smtp_account_id', preferredTestAccountId());
    formData.append('sample_contact', JSON.stringify(sample));
    formData.append('test_to', testTo);
    const attach = document.getElementById('campaignAttachment')?.files[0];
    if (attach) formData.append('attachment', attach);

    const res = await fetch('/api/campaigns/test-email', { method: 'POST', body: formData });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || result.error);
    const to = result.sentTo || sample.email || '';
    if (/@gmail\.com$/i.test(to)) {
      toast(`${result.message}. If Gmail still puts it in Spam, open it and click Report not spam.`);
    } else {
      toast(result.message);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

async function previewWithManualFields() {
  try {
    const sample = getTestSampleContact('compose');
    previewSampleContact = sample;
    await updatePreview();
    toast(`Preview updated for ${sample.first_name}${sample.company ? ` at ${sample.company}` : ''}`);
    showPage('compose');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function dashPreviewTest() {
  try {
    const sample = getTestSampleContact('dashboard');
    const content = await getEmailContentForTest('dashboard');
    const preview = await api('/campaigns/preview', {
      method: 'POST',
      body: JSON.stringify({
        subject: content.subject,
        body: content.body,
        preheader: content.preheader,
        smtp_account_id: preferredTestAccountId(),
        sample_contact: sample,
      }),
    });
    showPage('compose');
    document.getElementById('campaignSubject').value = content.subject;
    setEditorHtml(content.body);
    previewSampleContact = sample;
    document.getElementById('previewFrom').textContent = `${preview.fromName} <${preview.from}>`;
    document.getElementById('previewTo').textContent = sample.email;
    document.getElementById('previewSubject').textContent = preview.subject;
    document.getElementById('previewPlain').textContent = preview.text;
    document.getElementById('previewFrame').srcdoc = preview.html;
    setTestMode('compose', 'manual');
    document.getElementById('testFirstName').value = sample.first_name;
    document.getElementById('testLastName').value = sample.last_name || '';
    document.getElementById('testTitle').value = sample.title;
    document.getElementById('testCompany').value = sample.company;
    document.getElementById('testCity').value = sample.city || '';
    document.getElementById('testIndustry').value = sample.industry || '';
    document.getElementById('testCompanyProfile').value = sample.company_profile || '';
    document.getElementById('testTo').value = sample.email;
    toast(`Preview loaded for ${sample.first_name}${sample.company ? ` at ${sample.company}` : ''}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('sendTestEmail')?.addEventListener('click', () => sendTestFromPanel('compose'));
document.getElementById('dashSendTestEmail')?.addEventListener('click', () => sendTestFromPanel('dashboard'));
document.getElementById('previewManualTest')?.addEventListener('click', previewWithManualFields);
document.getElementById('dashPreviewTest')?.addEventListener('click', dashPreviewTest);

function fillManualTestDefaults(sample) {
  if (!sample) return;
  const fields = [
    ['testFirstName', 'dashTestFirstName', sample.first_name],
    ['testLastName', 'dashTestLastName', sample.last_name],
    ['testTitle', 'dashTestTitle', sample.title],
    ['testCompany', 'dashTestCompany', sample.company],
    ['testCity', 'dashTestCity', sample.city],
    ['testIndustry', 'dashTestIndustry', sample.industry],
    ['testCompanyProfile', 'dashTestCompanyProfile', sample.company_profile],
  ];
  for (const [composeId, dashId, val] of fields) {
    if (val && document.getElementById(composeId)) document.getElementById(composeId).value = val;
    if (val && document.getElementById(dashId)) document.getElementById(dashId).value = val;
  }
}

async function loadDefaultEmail(silent = false, force = false) {
  try {
    const tpl = await api('/campaigns/templates/default');
    const needsReload = force
      || !templateLoaded
      || (tpl.version && tpl.version !== loadedTemplateVersion);
    if (!needsReload && getEditorText()) {
      await updatePreview();
      return;
    }
    document.getElementById('campaignSubject').value = tpl.subject;
    document.getElementById('campaignPreheader').value = tpl.preheader || '';
    setEditorHtml(tpl.body_html);
    document.getElementById('campaignName').value = tpl.name;
    previewSampleContact = tpl.sample_contact || null;
    fillManualTestDefaults(tpl.sample_contact);
    templateLoaded = true;
    loadedTemplateVersion = tpl.version || 0;
    document.getElementById('step1')?.classList.add('done');
    runValidation();
    updatePreview();
    if (!silent) toast('Default email loaded — preview, test, then send');
  } catch (err) {
    if (!silent) toast(err.message, 'error');
  }
}

function getComposeFormData() {
  return {
    subject: document.getElementById('campaignSubject').value.trim(),
    body: getEditorHtml(),
    preheader: document.getElementById('campaignPreheader').value.trim(),
    includeUnsubscribe: document.getElementById('includeUnsubscribe').checked,
    attachmentFile: document.getElementById('campaignAttachment').files[0],
  };
}

function buildFormData(data) {
  const acc = getSelectedAccount();
  const formData = new FormData();
  formData.append('name', data.name || 'Abdullah Yaseen — service outreach');
  formData.append('subject', data.subject);
  formData.append('body', data.body);
  formData.append('preheader', data.preheader);
  formData.append('include_unsubscribe', data.includeUnsubscribe);
  formData.append('smtp_account_id', selectedAccountId);
  formData.append('list_id', acc?.listId || 'list1');
  if (data.attachmentFile) formData.append('attachment', data.attachmentFile);
  return formData;
}

document.getElementById('campaignSubject').addEventListener('input', debounce(() => { runValidation(); updatePreview(); }, 400));
document.getElementById('campaignPreheader').addEventListener('input', debounce(() => { runValidation(); updatePreview(); }, 400));

document.getElementById('loadDefaultEmail').addEventListener('click', () => loadDefaultEmail(false));

document.getElementById('composeForm').addEventListener('submit', (e) => e.preventDefault());

document.getElementById('saveAndSend').addEventListener('click', async () => {
  if (editingCampaignId) {
    await saveCampaignEdits(true);
    return;
  }
  await saveCampaign(true);
});

document.getElementById('saveCampaignEdits')?.addEventListener('click', () => saveCampaignEdits(false));
document.getElementById('saveAndResumeCampaign')?.addEventListener('click', () => saveCampaignEdits(true));
document.getElementById('cancelEditCampaign')?.addEventListener('click', cancelEditCampaign);

async function saveCampaign(andSend) {
  if (editingCampaignId) {
    await saveCampaignEdits(andSend);
    return;
  }

  // Always pull latest template so bold + copy survive Quill/editor cache
  try {
    const tpl = await api('/campaigns/templates/default');
    if (tpl?.body_html) {
      setEditorHtml(tpl.body_html);
      document.getElementById('campaignSubject').value = tpl.subject;
      document.getElementById('campaignPreheader').value = tpl.preheader || '';
      document.getElementById('campaignName').value = tpl.name || 'Abdullah Yaseen — service outreach';
      templateLoaded = true;
      loadedTemplateVersion = tpl.version || 0;
    }
  } catch {
    if (!templateLoaded && !getEditorText()) {
      await loadDefaultEmail(true, true);
    }
  }

  const data = getComposeFormData();
  const name = document.getElementById('campaignName')?.value.trim() || 'Abdullah Yaseen — service outreach';

  if (!data.subject || !getEditorText()) {
    toast('Click "Load Default Email" first', 'error');
    return;
  }

  // Prefer server template HTML so <strong> is never stripped by the editor
  let bodyHtml = data.body;
  try {
    const tpl = await api('/campaigns/templates/default');
    if (tpl?.body_html) bodyHtml = tpl.body_html;
  } catch { /* keep editor body */ }

  const acc = getSelectedAccount();
  const lists = await api('/accounts');
  const activeCount = countActiveContacts(lists.lists, acc?.listId);

  if (andSend && activeCount === 0) {
    toast('Upload contacts in the Contacts tab first', 'error');
    showPage('contacts');
    return;
  }

  if (andSend && !confirm(
    selectedAccountId === 'all'
      ? `Send from all ${accountsData.length} inboxes to ${activeCount.toLocaleString()} contacts?\n\nCSV is split across accounts. If one inbox hits its daily limit, remaining emails move to the next inbox.\nCombined limit: ${acc?.dailyLimit}/day`
      : `Send campaign from ${acc?.email} to ${activeCount.toLocaleString()} contacts?\n\nDuplicates & bounced addresses will be skipped.\nLimit: ${acc?.dailyLimit}/day`
  )) {
    return;
  }

  const validation = await api('/campaigns/validate', {
    method: 'POST',
    body: JSON.stringify({ subject: data.subject, body: bodyHtml, preheader: data.preheader }),
  });

  if (!validation.valid) {
    toast(validation.errors.join('. '), 'error');
    return;
  }

  const formData = buildFormData({ ...data, body: bodyHtml, name });

  try {
    const res = await fetch('/api/campaigns', { method: 'POST', body: formData });
    const campaign = await res.json();
    if (!res.ok) throw new Error(campaign.error || 'Failed to save campaign');

    if (andSend) {
      const result = await api(`/campaigns/${campaign.id}/send`, { method: 'POST' });
      toast(result.message);
      document.getElementById('step3')?.classList.add('done');
      showPage('dashboard');
    } else {
      toast('Campaign saved');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('campaignAttachment').addEventListener('change', (e) => {
  const file = e.target.files[0];
  document.getElementById('attachmentName').textContent = file
    ? `${file.name} (${(file.size / 1024).toFixed(1)} KB)`
    : 'Max 25 MB';
});

// --- Contacts ---

function renderListTabs(accounts, lists) {
  const el = document.getElementById('listTabs');
  if (!el) return;
  el.innerHTML = accounts.map(a => {
    const c = lists[a.listId] || { active: 0, total: 0 };
    return `<button class="list-tab ${selectedListId === a.listId ? 'active' : ''}" data-list="${a.listId}" data-account="${a.id}">
      ${escapeHtml(a.listLabel)} <span style="opacity:0.7">(${c.total.toLocaleString()})</span>
    </button>`;
  }).join('');
  el.querySelectorAll('.list-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      selectedListId = tab.dataset.list;
      renderListTabs(accounts, lists);
      renderListSummary(lists);
      loadContacts(1);
    });
  });
}

function renderListSummary(lists) {
  const el = document.getElementById('listSummary');
  const acc = accountsData.find(a => a.listId === selectedListId);
  const c = lists[selectedListId] || { active: 0, total: 0, bounced: 0, blocked: 0 };
  if (!el) return;
  el.innerHTML = `<strong>${acc?.listLabel || selectedListId}</strong> → sends via <strong>${acc?.email || '—'}</strong>
    · ${c.active.toLocaleString()} active · ${c.bounced || 0} bounced · ${c.blocked || 0} blocked · ${c.total.toLocaleString()} total`;
  const uploadLabel = document.getElementById('uploadBtnLabel');
  if (uploadLabel) uploadLabel.childNodes[0].textContent = `Upload & split evenly `;
  const hint = document.getElementById('uploadSplitHint');
  if (hint) {
    hint.textContent = accountsData.length > 1
      ? `Uploads split evenly across ${accountsData.length} inboxes (1,000 emails → about ${Math.ceil(1000 / accountsData.length)} each). If one inbox hits its daily limit, remaining mail moves to the next.`
      : '';
  }
}

async function loadContacts(page = 1) {
  currentPage = page;
  const search = document.getElementById('contactSearch').value;

  try {
    const accountData = await loadAccounts();
    renderListTabs(accountData.accounts, accountData.lists);
    renderListSummary(accountData.lists);

    const data = await api(`/contacts?page=${page}&limit=50&search=${encodeURIComponent(search)}&list_id=${selectedListId}`);
    const tbody = document.getElementById('contactsTable');

    if (data.contacts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No contacts in this list. Upload your .xlsx or .csv file.</td></tr>';
    } else {
      tbody.innerHTML = data.contacts.map(c => `
        <tr>
          <td>${escapeHtml(c.email)}</td>
          <td>${escapeHtml(c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '—')}</td>
          <td>${escapeHtml(c.title || '—')}</td>
          <td>${escapeHtml(c.company || '—')}</td>
          <td><span class="status-badge ${c.status}">${c.status}</span></td>
          <td style="font-size:0.8rem;color:var(--text-muted)">${escapeHtml((c.failure_reason || '').slice(0, 60) || '—')}</td>
          <td><button class="btn btn-sm btn-danger" onclick="deleteContact(${c.id})">Delete</button></td>
        </tr>
      `).join('');
    }

    renderPagination(data.total, data.page, data.limit);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderPagination(total, page, limit) {
  const pages = Math.ceil(total / limit);
  const el = document.getElementById('contactsPagination');
  if (pages <= 1) { el.innerHTML = ''; return; }

  let html = '';
  for (let i = 1; i <= pages; i++) {
    html += `<button class="btn btn-sm ${i === page ? 'btn-primary' : ''}" onclick="loadContacts(${i})">${i}</button>`;
  }
  el.innerHTML = html;
}

document.getElementById('contactSearch').addEventListener('input', debounce(() => loadContacts(1), 300));

document.getElementById('csvUpload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('list_id', selectedListId);
  // Split evenly across all sender lists (equal volume per inbox)
  formData.append('split', 'true');

  try {
    const res = await fetch('/api/contacts/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const msg = data.split && data.message
      ? `Added ${data.added.toLocaleString()} contacts — ${data.message} (${data.skipped} skipped)`
      : `Added ${data.added.toLocaleString()} to ${data.listLabel || selectedListId} (${data.skipped} duplicates skipped)`;
    toast(msg);
    document.getElementById('step2')?.classList.add('done');
    // Refresh list tabs + current table
    const accounts = await loadAccounts();
    renderListTabs(accountsData, accounts.lists || {});
    renderListSummary(accounts.lists || {});
    loadContacts();
  } catch (err) {
    toast(err.message, 'error');
  }
  e.target.value = '';
});

document.getElementById('addContactBtn').addEventListener('click', () => {
  document.getElementById('addContactModal').classList.remove('hidden');
});

document.getElementById('closeModal').addEventListener('click', () => {
  document.getElementById('addContactModal').classList.add('hidden');
});

document.getElementById('addContactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('newContactEmail').value.trim();
  const name = document.getElementById('newContactName').value.trim();

  try {
    const contact = await api('/contacts', {
      method: 'POST',
      body: JSON.stringify({ email, name, list_id: selectedListId, split: true }),
    });
    toast(`Contact added to ${contact.list_id || 'list'} (balanced)`);
    document.getElementById('addContactModal').classList.add('hidden');
    document.getElementById('addContactForm').reset();
    const accounts = await loadAccounts();
    renderListTabs(accountsData, accounts.lists || {});
    renderListSummary(accounts.lists || {});
    loadContacts();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('clearContacts').addEventListener('click', async () => {
  const acc = accountsData.find(a => a.listId === selectedListId);
  if (!confirm(`Delete ALL contacts in ${acc?.listLabel || selectedListId}? This cannot be undone.`)) return;
  try {
    await api(`/contacts?list_id=${selectedListId}`, { method: 'DELETE' });
    toast('List cleared');
    loadContacts();
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function deleteContact(id) {
  if (!confirm('Delete this contact?')) return;
  try {
    await api(`/contacts/${id}`, { method: 'DELETE' });
    loadContacts(currentPage);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// --- Campaigns ---

async function loadCampaigns() {
  try {
    const campaigns = await api('/campaigns');
    const tbody = document.getElementById('campaignsTable');

    if (campaigns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-state">No campaigns yet. Compose one to get started.</td></tr>';
      return;
    }

    tbody.innerHTML = campaigns.map(c => {
      const acc = accountsData.find(a => a.id === c.smtp_account_id);
      const typeBadge = c.campaign_type === 'follow_up'
        ? '<span class="badge-follow">Follow-up</span>'
        : '';
      return `<tr class="row-animate">
        <td>${escapeHtml(c.name)}${c.attachment ? ' 📎' : ''} ${typeBadge}</td>
        <td style="font-size:0.8rem">${acc ? escapeHtml(acc.email.split('@')[0]) : c.smtp_account_id || '—'}</td>
        <td>${c.list_id || '—'}</td>
        <td>${escapeHtml(c.subject)}</td>
        <td><span class="status-badge ${c.status}">${c.status}</span></td>
        <td>${c.sent_count}</td>
        <td>${c.failed_count}</td>
        <td>${c.total_recipients}</td>
        <td>${formatDate(c.created_at)}</td>
        <td><div class="campaign-actions-cell">${campaignActions(c)}</div></td>
      </tr>`;
    }).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function campaignActions(c) {
  const followUpBtn = (c.sent_count > 0 && c.campaign_type !== 'follow_up')
    ? `<button class="btn btn-sm btn-3d btn-follow" onclick="createFollowUp(${c.id})" title="Send follow-up to successful recipients">Follow-up</button>`
    : '';
  const deleteBtn = `<button class="btn btn-sm btn-danger btn-3d" onclick="deleteCampaign(${c.id})" title="Delete campaign">Delete</button>`;
  if (c.status === 'draft') {
    return `<button class="btn btn-sm btn-success btn-3d" onclick="sendCampaign(${c.id})">Send</button>${followUpBtn}${deleteBtn}`;
  }
  if (c.status === 'paused') {
    return `<button class="btn btn-sm btn-3d" onclick="editCampaign(${c.id})">Edit</button>
      <button class="btn btn-sm btn-primary btn-3d" onclick="resumeCampaign(${c.id})">Resume</button>
      ${followUpBtn}${deleteBtn}`;
  }
  if (c.status === 'sending' || c.status === 'queued') {
    return `<button class="btn btn-sm btn-3d" onclick="pauseAndEditCampaign(${c.id})">Pause &amp; Edit</button>
      <button class="btn btn-sm btn-3d" onclick="pauseCampaign(${c.id})">Pause</button>
      ${followUpBtn}${deleteBtn}`;
  }
  if (c.status === 'completed') {
    return `${followUpBtn}${deleteBtn}`;
  }
  return `${followUpBtn}${deleteBtn}`;
}

async function createFollowUp(id) {
  try {
    const preview = await api(`/campaigns/${id}/follow-up-preview`);
    if (!preview.eligible) {
      toast('No successful sends yet for this campaign', 'error');
      return;
    }
    if (!confirm(`Create follow-up for ${preview.eligible.toLocaleString()} people who received campaign #${id}?\n\nEach follow-up sends from the same inbox as the first email.\nOnly successful recipients are included.`)) {
      return;
    }
    const calendarInput = document.getElementById('followUpCalendarLink');
    const result = await api(`/campaigns/${id}/follow-up`, {
      method: 'POST',
      body: JSON.stringify({
        send_now: true,
        calendar_link: calendarInput?.value || '',
      }),
    });
    toast(result.message);
    loadCampaigns();
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function editCampaign(id) {
  try {
    const campaign = await api(`/campaigns/${id}`);
    if (!['draft', 'paused'].includes(campaign.status)) {
      toast('Pause the campaign before editing', 'error');
      return;
    }

    editingCampaignId = id;
    initEditor();
    showPage('compose');

    document.getElementById('campaignSubject').value = campaign.subject || '';
    document.getElementById('campaignPreheader').value = campaign.preheader || '';
    document.getElementById('includeUnsubscribe').checked = campaign.include_unsubscribe === true;
    setEditorHtml(campaign.body_html || '');

    if (campaign.smtp_account_id) {
      selectedAccountId = campaign.smtp_account_id;
      const sel = document.getElementById('smtpAccountSelect');
      if (sel) sel.value = campaign.smtp_account_id;
    }

    const attachLabel = campaign.attachment?.filename
      ? `${campaign.attachment.filename} (on server — upload a new file to replace)`
      : 'Resume is attached automatically on every email';
    document.getElementById('attachmentName').textContent = attachLabel;

    const banner = document.getElementById('editCampaignBanner');
    const title = document.getElementById('editCampaignTitle');
    const hint = document.getElementById('editCampaignHint');
    banner?.classList.remove('hidden');
    if (title) {
      title.textContent = campaign.status === 'paused'
        ? `Editing paused campaign #${id} (${campaign.sent_count.toLocaleString()} already sent)`
        : `Editing draft campaign #${id}`;
    }
    if (hint) {
      hint.textContent = campaign.status === 'paused'
        ? `${(campaign.total_recipients - campaign.sent_count).toLocaleString()} emails still queued — updated content applies when you resume.`
        : 'Save your changes before sending.';
    }

    previewSampleContact = null;
    await updatePreview();
    toast(campaign.status === 'paused' ? 'Campaign loaded — edit, save, then resume' : 'Draft loaded for editing');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function cancelEditCampaign() {
  editingCampaignId = null;
  document.getElementById('editCampaignBanner')?.classList.add('hidden');
  toast('Edit cancelled');
}

async function saveCampaignEdits(andResume = false) {
  if (!editingCampaignId) {
    toast('No campaign selected for editing', 'error');
    return;
  }

  const data = getComposeFormData();
  if (!data.subject || !getEditorText()) {
    toast('Subject and body are required', 'error');
    return;
  }

  const validation = await api('/campaigns/validate', {
    method: 'POST',
    body: JSON.stringify({ subject: data.subject, body: data.body, preheader: data.preheader }),
  });
  if (!validation.valid) {
    toast(validation.errors.join('. '), 'error');
    return;
  }

  const formData = new FormData();
  formData.append('subject', data.subject);
  formData.append('body', data.body);
  formData.append('preheader', data.preheader);
  formData.append('include_unsubscribe', data.includeUnsubscribe);
  if (data.attachmentFile) formData.append('attachment', data.attachmentFile);

  try {
    const res = await fetch(`/api/campaigns/${editingCampaignId}`, { method: 'PUT', body: formData });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update campaign');

    toast(result.message || 'Campaign updated');

    if (andResume) {
      await resumeCampaign(editingCampaignId);
      editingCampaignId = null;
      document.getElementById('editCampaignBanner')?.classList.add('hidden');
      showPage('dashboard');
    }

    loadCampaigns();
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pauseAndEditCampaign(id) {
  try {
    const result = await api(`/campaigns/${id}/pause`, { method: 'POST' });
    toast(result.message || 'Campaign paused');
    loadCampaigns();
    loadDashboard();
    await editCampaign(id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function sendCampaign(id) {
  if (!confirm('Send this campaign to all active contacts?')) return;
  try {
    const result = await api(`/campaigns/${id}/send`, { method: 'POST' });
    toast(result.message);
    loadCampaigns();
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pauseCampaign(id) {
  try {
    const result = await api(`/campaigns/${id}/pause`, { method: 'POST' });
    toast(result.message || 'Campaign paused — open Campaigns or Compose to edit');
    loadCampaigns();
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteCampaign(id) {
  if (!confirm('Delete this campaign?\n\nRemaining queued emails will be removed. Already-sent emails stay in history.')) {
    return;
  }
  try {
    const result = await api(`/campaigns/${id}`, { method: 'DELETE' });
    toast(result.message || 'Campaign deleted');
    if (editingCampaignId === id) {
      editingCampaignId = null;
      document.getElementById('editCampaignBanner')?.classList.add('hidden');
    }
    loadCampaigns();
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function resumeCampaign(id) {
  try {
    await api(`/campaigns/${id}/resume`, { method: 'POST' });
    toast('Campaign resumed — remaining emails use the latest content');
    editingCampaignId = null;
    document.getElementById('editCampaignBanner')?.classList.add('hidden');
    loadCampaigns();
    loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// --- Settings ---

async function loadSettings() {
  try {
    const data = await loadAccounts();
    const el = document.getElementById('settingsAccounts');
    if (!el) return;

    el.innerHTML = data.accounts.map(a => `
      <div class="card account-card ${a.protected ? 'protected' : ''}">
        <h2>${escapeHtml(a.label)}</h2>
        <p class="account-card-email">${escapeHtml(a.email)}</p>
        <ul class="tips-list">
          <li><strong>${a.dailyLimit}/day</strong> limit · <strong>${a.sendDelayMs / 1000}s</strong> delay between sends</li>
          <li>List: <strong>${escapeHtml(a.listLabel)}</strong> (${(data.lists[a.listId]?.total || 0).toLocaleString()} contacts)</li>
          <li>Today: ${a.todaySent}/${a.dailyLimit} sent · ${a.remainingToday} remaining</li>
          ${a.protected ? '<li>🛡 <strong>Protected mode</strong> — extended pauses on blocks</li>' : ''}
        </ul>
        <div class="form-actions">
          <button type="button" class="btn btn-primary" onclick="testAccountSmtp('${a.id}')">Test Connection</button>
        </div>
        <div id="smtpStatus-${a.id}" class="alert hidden"></div>
      </div>
    `).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function testAccountSmtp(accountId) {
  const statusEl = document.getElementById(`smtpStatus-${accountId}`);
  try {
    const result = await api('/smtp/test', { method: 'POST', body: JSON.stringify({ account: accountId }) });
    statusEl.className = 'alert success';
    statusEl.textContent = result.message;
    statusEl.classList.remove('hidden');
  } catch (err) {
    statusEl.className = 'alert error';
    statusEl.textContent = err.message;
    statusEl.classList.remove('hidden');
  }
}

// --- Utils ---

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str.endsWith('Z') ? str : str + 'Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// --- Follow-up CSV ---

let followUpFile = null;
let followUpPreview = null;

function applyFollowUpMessage(data) {
  const subjectEl = document.getElementById('followUpSubjectPreview');
  const frame = document.getElementById('followUpMessageFrame');
  const calendarInput = document.getElementById('followUpCalendarLink');
  if (calendarInput && data.calendar_link != null && calendarInput !== document.activeElement) {
    calendarInput.value = data.calendar_link;
  }
  if (subjectEl) subjectEl.textContent = data.preview?.subject || data.subject || '—';
  if (frame) frame.srcdoc = data.preview?.html || data.body_html || '';
}

async function loadFollowUpPage() {
  try {
    const data = await api('/follow-up/message');
    applyFollowUpMessage(data);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveFollowUpCalendar() {
  const raw = document.getElementById('followUpCalendarLink')?.value || '';
  try {
    const data = await api('/follow-up/calendar', {
      method: 'PUT',
      body: JSON.stringify({ url: raw }),
    });
    applyFollowUpMessage(data);
    toast(data.calendar_link ? 'Calendar link saved — it will appear in the follow-up' : 'Calendar link cleared');
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('saveFollowUpCalendar')?.addEventListener('click', saveFollowUpCalendar);
document.getElementById('followUpCalendarLink')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveFollowUpCalendar();
  }
});

function renderFollowUpPreview(data) {
  const card = document.getElementById('followUpPreviewCard');
  const stats = document.getElementById('followUpStats');
  const tbody = document.getElementById('followUpSampleTable');
  if (!card || !stats || !tbody) return;

  card.classList.remove('hidden');
  const byAccount = (data.byAccount || [])
    .map(a => `${escapeHtml(a.email || a.id)}: ${a.count}`)
    .join(' · ') || '—';
  stats.innerHTML = `<strong>${(data.ready || 0).toLocaleString()} ready</strong>
    · skipped never sent: ${(data.neverSent || []).length}
    · already followed: ${(data.alreadyFollowed || []).length}
    · bounced: ${(data.bounced || []).length}
    <br>Same original inbox: ${byAccount}`;

  const sample = data.sample || [];
  if (sample.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">No matching people who already received a first email.</td></tr>';
    return;
  }
  tbody.innerHTML = sample.map(row => {
    const acc = accountsData.find(a => a.id === row.smtpAccountId);
    return `<tr>
      <td>${escapeHtml(row.email)}</td>
      <td>${escapeHtml(row.name || row.first_name || '—')}</td>
      <td>${escapeHtml(acc?.email || row.smtpAccountId)}</td>
    </tr>`;
  }).join('');
}

document.getElementById('followUpCsvUpload')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  followUpFile = file;
  document.getElementById('followUpFileName').textContent = file.name;

  const formData = new FormData();
  formData.append('file', file);
  try {
    await loadAccounts();
    const res = await fetch('/api/follow-up/preview', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Preview failed');
    followUpPreview = data;
    renderFollowUpPreview(data);
    const sendBtn = document.getElementById('sendFollowUpCsv');
    if (sendBtn) sendBtn.disabled = !(data.ready > 0);
    toast(`${(data.ready || 0).toLocaleString()} ready — ${(data.neverSent || []).length} never received a first email`);
  } catch (err) {
    toast(err.message, 'error');
    document.getElementById('sendFollowUpCsv').disabled = true;
  }
  e.target.value = '';
});

document.getElementById('sendFollowUpCsv')?.addEventListener('click', async () => {
  if (!followUpFile || !(followUpPreview?.ready > 0)) {
    toast('Upload a follow-up CSV first', 'error');
    return;
  }
  if (!confirm(`Send follow-up to ${followUpPreview.ready.toLocaleString()} people?\n\nEach follow-up goes from the same inbox that sent their first email.`)) {
    return;
  }

  const btn = document.getElementById('sendFollowUpCsv');
  btn.disabled = true;
  const formData = new FormData();
  formData.append('file', followUpFile);
  formData.append('calendar_link', document.getElementById('followUpCalendarLink')?.value || '');
  try {
    const res = await fetch('/api/follow-up/send', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    toast(data.message || `Queued ${data.queued} follow-ups`);
    followUpFile = null;
    followUpPreview = null;
    document.getElementById('followUpFileName').textContent = 'CSV or Excel — email column required';
    showPage('dashboard');
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
});

// Auto-refresh — every 2 seconds on dashboard for live monitoring
function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    const dash = document.getElementById('page-dashboard');
    if (dash.classList.contains('active')) loadDashboard();
    const camps = document.getElementById('page-campaigns');
    if (camps.classList.contains('active')) loadCampaigns();
  }, 2000);
}

// Init
initEditor();
loadDashboard();
startAutoRefresh();
