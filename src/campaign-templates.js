const SITE_URL = 'https://abdullah-yaseen.vercel.app/';

const SERVICES_LIST_HTML = `<p>The work I take on:<br>
• Full-Stack Web Development<br>
• Python Automation<br>
• AI-Powered Solutions<br>
• SaaS Development</p>`;

const DEFAULT_EMAIL = {
  id: 'default',
  version: 39,
  name: 'Abdullah Yaseen — service outreach',
  subject: '{{personalized_subject}}',
  preheader: '',
  body_html: `<p>Hey {{first_name}},</p>

<p>{{personalized_opener}}</p>

<p>{{personalized_background}}</p>

${SERVICES_LIST_HTML}

<p>{{stack_line}}</p>

<p>A few live examples are here:</p>

<p>${SITE_URL}</p>

<p>{{personalized_closing}}</p>

<p>Thanks,<br>
Abdullah Yaseen</p>`,
  test_email: 'ahmadjutt463@gmail.com',
  sample_contact: {
    first_name: 'Richard',
    last_name: '',
    name: 'Richard',
    title: 'CTO',
    company: 'Everpay Corporation',
    city: '',
    country: '',
    industry: '',
    company_profile: '',
    website: '',
    linkedin: '',
    email: 'ahmadjutt463@gmail.com',
  },
};

const FOLLOW_UP_EMAIL = {
  id: 'follow-up',
  version: 30,
  name: 'Abdullah Yaseen — Follow-up',
  subject: '{{personalized_subject}}',
  preheader: '',
  body_html: `<p>Hey {{first_name}},</p>

<p>{{personalized_opener}}</p>

<p>{{personalized_background}}</p>

${SERVICES_LIST_HTML}

<p>{{stack_line}}</p>

<p>Live work is here:</p>

<p>${SITE_URL}</p>
{{calendar_html}}
<p>{{personalized_closing}}</p>

<p>Thanks,<br>
Abdullah Yaseen</p>`,
  sample_contact: {
    first_name: 'Richard',
    last_name: '',
    name: 'Richard',
    title: 'CTO',
    company: 'Everpay Corporation',
    city: '',
    country: '',
    industry: '',
    company_profile: '',
    website: '',
    linkedin: '',
    email: 'ahmadjutt463@gmail.com',
  },
};

function normalizeCalendarUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function calendarHtml(calendarUrl) {
  const url = normalizeCalendarUrl(calendarUrl);
  if (!url) return '';
  return `
<p>If a short call would help, my calendar is here:</p>

<p>${url}</p>
`;
}

function buildFollowUpHtml(calendarUrl) {
  return FOLLOW_UP_EMAIL.body_html.replace('{{calendar_html}}', calendarHtml(calendarUrl));
}

const TEMPLATES = { default: DEFAULT_EMAIL, 'job-outreach': DEFAULT_EMAIL, 'follow-up': FOLLOW_UP_EMAIL };

function getTemplate(id) {
  return TEMPLATES[id] || TEMPLATES.default;
}

function listTemplates() {
  return [
    { id: 'default', name: DEFAULT_EMAIL.name, subject: DEFAULT_EMAIL.subject },
    { id: 'follow-up', name: FOLLOW_UP_EMAIL.name, subject: FOLLOW_UP_EMAIL.subject },
  ];
}

module.exports = {
  getTemplate,
  listTemplates,
  DEFAULT_EMAIL,
  FOLLOW_UP_EMAIL,
  SITE_URL,
  normalizeCalendarUrl,
  buildFollowUpHtml,
};
