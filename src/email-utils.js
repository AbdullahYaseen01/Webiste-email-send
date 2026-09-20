function htmlToPlain(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textToGmailHtml(text) {
  const escape = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const face = 'font-family:Arial,Helvetica,sans-serif;font-size:small;color:#000000';
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const inner = lines.map((line) => (
    line === ''
      ? `<div style="${face}"><br></div>`
      : `<div style="${face}">${escape(line)}</div>`
  )).join('');
  return `<div dir="ltr" style="${face}">${inner}</div>`;
}

function textToQuietHtml(text) {
  return textToGmailHtml(text);
}

function wrapHtmlEmail(htmlBody) {
  return htmlBody || '';
}

const SPAM_WORDS = [
  'free', 'winner', 'congratulations', 'act now', 'limited time', 'click here',
  'buy now', 'order now', '100% free', 'no obligation', 'risk free', 'cash',
  'earn money', 'make money', 'double your', 'guarantee', 'no cost',
  'payment after', 'work from home', 'dear friend', 'urgent', 'viagra',
  'unsubscribe', 'opt out', 'special offer', 'lowest price', 'best price',
  'no credit check', 'mlm', 'multi-level', 'weight loss', 'miracle',
  'opportunity of a lifetime', 'once in a lifetime', 'apply now',
  'subscribe', 'discount', 'save big', 'credit card', 'loan',
];

const SPAM_PHRASES = [
  'payment can be arranged',
  'custom saas development',
  'book a time here',
  'click here',
  'act now',
  'book a time',
  'you can also book',
  'calendly link is',
  'this is not spam',
  'not a sales pitch',
];

function validateCampaign({ subject, bodyHtml, preheader = '' }) {
  const warnings = [];
  const errors = [];
  const plain = htmlToPlain(bodyHtml);
  const combined = `${subject} ${plain} ${preheader}`.toLowerCase();

  if (!subject?.trim()) errors.push('Subject line is required');
  if (!plain.trim() && !bodyHtml?.replace(/<[^>]+>/g, '').trim()) {
    errors.push('Email body cannot be empty');
  }

  if (subject) {
    if (subject.length > 60) warnings.push('Subject is longer than 60 characters — shorter subjects land better in inbox');
    if (subject === subject.toUpperCase() && subject.length > 10) {
      warnings.push('ALL CAPS subject triggers spam filters — use normal capitalization');
    }
    if (/^(hey|hi|hello|yo)[\s!.]*$/i.test(subject.trim())) {
      warnings.push('One-word greeting subjects like "hey" often land in Gmail spam');
    }
    if (/!{1,}/.test(subject)) warnings.push('Exclamation marks in the subject look promotional');
    if ((subject.match(/\(/g) || []).length >= 2) {
      warnings.push('Multiple parentheses in the subject look like marketing copy');
    }
    if ((subject.match(/\b(IoT|AI|API|SaaS|SEO)\b/gi) || []).length >= 2) {
      warnings.push('Too many acronyms in the subject — keep it conversational');
    }
    for (const word of SPAM_WORDS) {
      if (subject.toLowerCase().includes(word)) warnings.push(`Subject contains spam trigger word: "${word}"`);
    }
  }

  const linkCount = (bodyHtml.match(/<a\s|https?:\/\//gi) || []).length;
  if (linkCount > 1) warnings.push(`${linkCount} links detected — plain text URLs are safer than clickable links`);

  const strongCount = (bodyHtml.match(/<\/(?:strong|b)>/gi) || []).length;
  // Allow a few product-emphasis bolds; more than 4 starts to look promotional
  if (strongCount > 4) warnings.push('Too much bold text — plain emails look more personal');

  const capsWords = (plain.match(/\b[A-Z]{2,}\b/g) || []).filter(w => !['AI', 'API', 'AWS', 'BLE', 'CAN', 'C', 'CSS', 'GSM', 'HTML', 'HTTP', 'HTTPS', 'I2C', 'IoT', 'LLM', 'ML', 'MQTT', 'NLP', 'OCR', 'OTA', 'REST', 'SPI', 'SQL', 'TCP', 'UART', 'USB', 'VP', 'CTO', 'CEO'].includes(w));
  if (capsWords.length > 8) warnings.push('Too many ALL CAPS words in body — keep acronyms only where needed');

  const imageCount = (bodyHtml.match(/<img\s/gi) || []).length;
  if (imageCount > 0) warnings.push('Images in cold outreach can hurt deliverability — prefer plain text style');

  if (plain.length > 3200) warnings.push('Very long emails can hurt inbox placement — consider trimming if deliverability drops');
  if (plain.length < 80) warnings.push('Very short email body — add a little more context');

  for (const phrase of SPAM_PHRASES) {
    if (combined.includes(phrase)) warnings.push(`Avoid spam-style phrase: "${phrase}"`);
  }

  for (const word of SPAM_WORDS) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(combined)) warnings.push(`Avoid spam trigger word: "${word}"`);
  }

  if (preheader && preheader.length > 90) {
    warnings.push('Preheader text should be short or left empty');
  }

  const score = Math.max(0, 100 - warnings.length * 10 - errors.length * 30);
  let deliverability = 'good';
  if (score < 50) deliverability = 'poor';
  else if (score < 75) deliverability = 'fair';

  return { valid: errors.length === 0, errors, warnings, score, deliverability };
}

function classifySmtpError(err) {
  const msg = (err.message || String(err)).toLowerCase();
  const response = (err.response || '').toLowerCase();
  const full = `${msg} ${response}`;
  const code = err.responseCode || err.code;

  // Invalid / non-existent recipient
  if (
    full.includes('address not found') ||
    full.includes('domain name not found') ||
    full.includes('nxdomain') ||
    full.includes('dns error') ||
    full.includes('bad destination') ||
    full.includes('recipient domain') ||
    full.includes('user unknown') ||
    full.includes('mailbox not found') ||
    full.includes('no such user') ||
    full.includes('recipient address rejected') ||
    full.includes('does not exist') ||
    full.includes('unknown user') ||
    full.includes('invalid recipient') ||
    full.includes('550 5.1.1') ||
    full.includes('550-5.1.1') ||
    full.includes('5.1.1') && (full.includes('user') || full.includes('address')) ||
    (code === 550 && full.includes('5.1.1'))
  ) {
    return {
      type: 'invalid_recipient',
      retry: false,
      suppress: true,
      message: 'Recipient address not found — marked as failed',
    };
  }

  // Message blocked / rejected by recipient server or Gmail
  if (
    full.includes('message rejected') ||
    full.includes('message blocked') ||
    full.includes('was rejected') ||
    full.includes('mailer-daemon') ||
    full.includes('delivery failed') ||
    full.includes('undeliverable') ||
    (full.includes('5.7.1') && !full.includes('rate')) ||
    full.includes('blocked') ||
    full.includes('spam') ||
    full.includes('suspicious') ||
    full.includes('not authorized to send') ||
    full.includes('policy rejection')
  ) {
    return {
      type: 'blocked',
      retry: false,
      suppress: true,
      pauseAll: true,
      message: 'Message blocked or rejected — contact suppressed',
    };
  }

  if (
    code === 421 || code === 450 || code === 451 || code === 452 ||
    full.includes('rate limit') || full.includes('too many') ||
    full.includes('4.2.1') || full.includes('4.7.0') || full.includes('4.3.0') ||
    full.includes('throttl') || full.includes('try again later')
  ) {
    return { type: 'rate_limit', retry: true, pauseMs: 120000, message: 'Gmail rate limit — pausing and retrying' };
  }

  if (
    full.includes('5.4.5') || full.includes('daily sending') ||
    full.includes('daily user sending') || full.includes('sending quota') ||
    (full.includes('limit exceeded') && full.includes('day'))
  ) {
    return { type: 'daily_quota', retry: false, stopDay: true, message: 'Gmail daily sending limit reached — resumes tomorrow' };
  }

  if (code >= 500 || full.includes('temporary') || full.includes('timeout') || full.includes('econnreset')) {
    return { type: 'temporary', retry: true, pauseMs: 60000, message: 'Temporary server error — will retry' };
  }

  if (full.includes('invalid') && full.includes('address')) {
    return { type: 'invalid_recipient', retry: false, suppress: true, message: 'Invalid recipient address' };
  }

  return { type: 'permanent', retry: false, suppress: true, message: err.message || 'Send failed' };
}

module.exports = { htmlToPlain, wrapHtmlEmail, textToQuietHtml, textToGmailHtml, validateCampaign, classifySmtpError };
