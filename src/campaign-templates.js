const SITE_URL = 'https://abdullah-yaseen.vercel.app/';

const SERVICES_LIST_HTML = `<p>The work I take on:</p>
<ul style="margin:6px 0 16px 18px;padding:0;">
<li style="margin:0 0 6px;"><b>Full-Stack Web Development</b></li>
<li style="margin:0 0 6px;"><b>Python Automation</b></li>
<li style="margin:0 0 6px;"><b>AI-Powered Solutions</b></li>
<li style="margin:0;"><b>SaaS Development</b></li>
</ul>`;

const DEFAULT_EMAIL = {
  id: 'default',
  version: 32,
  name: 'Abdullah Yaseen — service outreach',
  subject: '{{personalized_subject}}',
  preheader: '',
  body_html: `<p>Hey {{first_name}},</p>

<p>{{personalized_opener}}</p>

<p>I have 5+ years of experience shipping production software. That includes 30+ delivered projects, 8 live sites, and 12+ AI systems already in use.</p>

${SERVICES_LIST_HTML}

<p>Day to day I work in React, Next.js, JavaScript, Node.js, Express, Python, FastAPI, PostgreSQL, MongoDB, AWS, and Docker, including computer vision, chatbots, and LLM integrations when the product needs them.</p>

<p>A few live examples are here:</p>

<p>${SITE_URL}</p>

<p>I attached my resume as well.</p>

<p>{{personalized_closing}}</p>

<p>Thanks,<br>
Abdullah Yaseen</p>`,
  test_email: 'ahmadjutt463@gmail.com',
  sample_contact: {
    first_name: 'Alex',
    last_name: '',
    name: 'Alex',
    title: 'CTO',
    company: 'Example Technologies',
    city: '',
    country: '',
    industry: '',
    company_profile: '',
    website: '',
    linkedin: '',
    email: 'alex@example.com',
  },
};

const FOLLOW_UP_EMAIL = {
  id: 'follow-up',
  version: 23,
  name: 'Abdullah Yaseen — Follow-up',
  subject: '{{personalized_subject}}',
  preheader: '',
  body_html: `<p>Hey {{first_name}},</p>

<p>{{personalized_opener}}</p>

<p>I have 5+ years of experience shipping this kind of work:</p>
<ul style="margin:6px 0 16px 18px;padding:0;">
<li style="margin:0 0 6px;"><b>Full-Stack Web Development</b></li>
<li style="margin:0 0 6px;"><b>Python Automation</b></li>
<li style="margin:0 0 6px;"><b>AI-Powered Solutions</b></li>
<li style="margin:0;"><b>SaaS Development</b></li>
</ul>

<p>React, Next.js, Node.js, Python, FastAPI, PostgreSQL, and AWS are the tools I ship with.</p>

<p>Live work is here:</p>

<p>${SITE_URL}</p>

<p>Resume is attached if a short background helps.</p>
{{calendar_html}}
<p>{{personalized_closing}}</p>

<p>Thanks,<br>
Abdullah Yaseen</p>`,
  sample_contact: {
    first_name: 'Alex',
    last_name: '',
    name: 'Alex',
    title: 'CTO',
    company: 'Example Technologies',
    city: '',
    country: '',
    industry: '',
    company_profile: '',
    website: '',
    linkedin: '',
    email: 'alex@example.com',
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
