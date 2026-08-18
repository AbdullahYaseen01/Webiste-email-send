/**
 * Personalized subject / opener / closing for Abdullah Yaseen outreach.
 * Sounds like a 1-to-1 note. No salesy or bulk-mail language.
 * Do not repeat first name right after "Hey Name,".
 */

const SITE_URL = 'https://abdullah-yaseen.vercel.app/';

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function pickVariant(seed, variants) {
  const idx = hashCode(seed || 'default') % variants.length;
  return variants[idx];
}

function firstName(contact) {
  const raw = contact.first_name || (contact.name || '').split(' ')[0] || 'there';
  if (!raw || raw.toLowerCase() === 'there') return 'there';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function hasCompany(contact) {
  return Boolean(contact.company && String(contact.company).trim());
}

function companyName(contact) {
  if (hasCompany(contact)) return contact.company.trim();
  return '';
}

function possessive(name) {
  if (!name) return '';
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function profileSnippet(profile, max = 110) {
  if (!profile || profile.length < 20) return '';
  const clean = profile.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + '...';
}

function contactBlob(contact) {
  return [
    contact.title,
    contact.industry,
    contact.company,
    contact.company_profile,
    contact.website,
  ].filter(Boolean).join(' ').toLowerCase();
}

function detectServiceFit(contact) {
  const blob = contactBlob(contact);
  if (/\b(ai|ml|machine learning|openai|llm|computer vision|yolo|opencv|chatbot|nlp)\b/.test(blob)) {
    return 'ai';
  }
  if (/\b(saas|subscription|platform|startup|product owner|product manager)\b/.test(blob)) {
    return 'saas';
  }
  if (/\b(automat|python|workflow|ops|spreadsheet|scraping|script|rpa)\b/.test(blob)) {
    return 'automation';
  }
  if (/\b(web|website|frontend|backend|full.?stack|react|next\.?js|ecommerce|landing)\b/.test(blob)) {
    return 'fullstack';
  }
  return 'general';
}

function servicePhrase(fit) {
  if (fit === 'ai') return 'AI features that can run in production';
  if (fit === 'saas') return 'shipping a product people can log into';
  if (fit === 'automation') return 'Python automation for repeat work';
  if (fit === 'fullstack') return 'a full-stack web build';
  return 'web, automation, AI, or product work';
}

const NAME_ONLY_OPENERS = [
  () => `I wanted to reach out because a lot of teams need a site, a product, or an automation, and they do not have an in-house person to ship it.`,
  () => `Hope you are doing well. I write software for teams that need something live, not another plan.`,
  () => `I am reaching out because I spend most of my week building web apps, automations, and AI features that actually go into production.`,
  () => `Wanted to introduce myself. I have been shipping full-stack, Python, AI, and product work for a little over five years.`,
  () => `I put this together for people who already know what they want built and just need someone to finish it.`,
  () => `A lot of the work I see is stuck in docs. The idea is clear. Getting it live is the slow part.`,
  () => `I am a full-stack and AI engineer. If you have a site, a product, or a manual process that still needs building, that is the work I take on.`,
  () => `Hope this is relevant. I work with teams who need a live app or automation without hiring a full engineering group.`,
  () => `I wanted to send a short note on the kind of work I ship: web apps, Python automation, AI systems, and SaaS products.`,
  () => `Curious whether you still have a product, site, or internal workflow sitting on the backlog.`,
  () => `I am writing because I can take a short brief and turn it into something running in production.`,
  () => `A lot of teams stall after planning. If that sounds familiar, this may be useful.`,
  () => `I wanted to check in about software I can help ship: interfaces, automations, and AI systems that are already in production elsewhere.`,
  () => `Sharing this because one builder who can do the web app, the automation, and the AI layer together is often faster than assembling a team.`,
  () => `I thought this might help if a rebuild, a product, or a Python workflow has been sitting unfinished.`,
  () => `Hope your week is going well. I wanted to send a short note about getting a site, an automation, or an AI feature into production.`,
  () => `I wrote this around a simple problem: good ideas, slow shipping.`,
  () => `Wanted to connect because most companies need more than a landing page. They need something that keeps working after launch.`,
  () => `I have been building production software for 5+ years and wanted to see if any of that work is useful for you right now.`,
  () => `I am reaching out as a builder, not a recruiter. I ship the work myself.`,
];

const NAME_ONLY_CLOSINGS = [
  () => `If any of this is relevant, a short reply is enough and I can send a matching example.`,
  () => `No pressure. If the timing is better later, the work is there when you need it.`,
  () => `If you take a look, I would like to know what you think.`,
  () => `If a site, product, or automation is on your list, I am happy to talk through it.`,
  () => `One project is usually enough to see whether we are a fit.`,
  () => `I will leave this with you. If even one of those four areas is relevant, it was worth sending.`,
  () => `Appreciate you reading this.`,
  () => `If a rebuild or an internal workflow is still taking too long, I can help.`,
  () => `No need to reply if this is not useful. Thanks for your time either way.`,
  () => `Hope this is useful for something you have been meaning to ship.`,
  () => `If you want, I can share one live project closest to what you need.`,
  () => `If timing is off right now, no worries at all.`,
  () => `Thanks for reading. Happy to answer anything if useful.`,
  () => `Curious what one unfinished item would look like if it actually shipped.`,
  () => `Thanks again for your time.`,
  () => `I will leave the link with you in case it helps this month.`,
  () => `If this is useful, just reply and tell me what you are trying to ship.`,
  () => `Happy to keep this short. A reply with one sentence is plenty.`,
  () => `If nothing here fits, feel free to ignore this.`,
  () => `Thanks for considering it.`,
];

const NAME_ONLY_SUBJECTS = [
  (f) => `${f}, a thought on your next build`,
  (f) => `${f}, wanted to introduce myself`,
  (f) => `${f}, question on your product`,
  (f) => `${f}, thought this might help`,
  (f) => `${f}, about shipping your software`,
  (f) => `${f}, a note from Abdullah`,
  (f) => `${f}, on getting work live`,
  (f) => `${f}, may be useful for your team`,
  (f) => `${f}, hope this is relevant`,
  (f) => `${f}, wanted to share this`,
  (f) => `${f}, about your site or product`,
  (f) => `${f}, a short note`,
  (f) => `${f}, thought of your backlog`,
  (f) => `${f}, on your next project`,
  (f) => `${f}, a builder note`,
  (f) => `Hey ${f}`,
  (f) => `${f}, about a web or AI build`,
  (f) => `${f}, one practical thought`,
  (f) => `${f}, wanted to reach out`,
  (f) => `${f}, for when you need a builder`,
];

const FOLLOW_UP_SUBJECTS = [
  (f) => `${f}, following up`,
  (f) => `${f}, looping back once`,
  (f) => `${f}, did my last note come through?`,
  (f) => `${f}, one more note`,
  (f) => `Re: my earlier note, ${f}`,
];

const FOLLOW_UP_OPENERS = [
  () => `Just looping back once in case my first note got buried.`,
  () => `Sending a short follow-up. No need to reply if the timing is not right.`,
  () => `One more brief note from me, then I will leave it with you.`,
  () => `Wanted to bump this once in case it was easy to miss.`,
];

function generatePersonalizedOpener(contact) {
  const first = firstName(contact);
  const email = contact.email || first;
  const company = companyName(contact);
  const snippet = profileSnippet(contact.company_profile, 90);
  const fit = detectServiceFit(contact);
  const phrase = servicePhrase(fit);
  const isFollowUp = contact._is_follow_up === true;

  if (isFollowUp) {
    return pickVariant(email + '|fu-opener', FOLLOW_UP_OPENERS.map((fn) => fn()));
  }

  if (company) {
    const rich = [
      `I came across ${company} and wanted to reach out about ${phrase}.`,
      `Your work around ${company} stood out, so I thought a personal note made sense.`,
      `I wanted to share something that may help ${company} with ${phrase}.`,
      `Teams like ${company} often have a site, a product, or a manual process that still needs a builder.`,
    ];
    if (snippet) {
      rich.push(`Noticed ${possessive(company)} focus: ${snippet} That usually needs a solid web layer, automation, or an AI feature on top.`);
    }
    if (fit === 'ai') {
      rich.push(`I saw ${company} in a space where AI can help, so I wanted to mention the production systems I have already shipped.`);
    } else if (fit === 'saas') {
      rich.push(`${company} looks like a product business, so I thought a note about shipping software without a full engineering team might help.`);
    } else if (fit === 'automation') {
      rich.push(`If ${company} still has work living in spreadsheets or repeatable handoffs, Python automation is usually the fastest place to start.`);
    } else if (fit === 'fullstack') {
      rich.push(`If ${company} needs a site or app that stays maintainable, that is the full-stack work I take on.`);
    }
    return pickVariant(email + '|opener-rich', rich);
  }

  return pickVariant(email + '|opener', NAME_ONLY_OPENERS.map((fn) => fn()));
}

function generatePersonalizedClosing(contact) {
  const first = firstName(contact);
  const email = contact.email || first;
  const company = companyName(contact);

  if (company) {
    return pickVariant(email + '|close-company', [
      `If this helps ${company}, a short reply is enough and we can start from one project.`,
      `Happy to hear what you think if you look at the live work with ${company} in mind.`,
      `No rush. Sharing in case it fits how ${company} already builds software.`,
      `Appreciate your time either way, and hope this is useful for ${company}.`,
    ]);
  }

  return pickVariant(email + '|closing', NAME_ONLY_CLOSINGS.map((fn) => fn()));
}

function generatePersonalizedSubject(contact) {
  const first = firstName(contact);
  const email = contact.email || first;
  const company = companyName(contact);
  const isFollowUp = contact._is_follow_up === true;

  if (isFollowUp) {
    return pickVariant(email + '|fu-subject', FOLLOW_UP_SUBJECTS.map((fn) => fn(first)));
  }

  if (company) {
    const subjects = [
      `${first}, a thought on ${company}`,
      `${first}, about ${company}`,
      `${first}, note for ${company}`,
      `${first}, wanted to reach out`,
      `${first}, ${company} and a possible build`,
    ].filter((s) => s.length <= 60);
    return pickVariant(email + '|subject-company', subjects);
  }

  return pickVariant(email + '|subject', NAME_ONLY_SUBJECTS.map((fn) => fn(first)));
}

module.exports = {
  generatePersonalizedOpener,
  generatePersonalizedClosing,
  generatePersonalizedSubject,
  detectServiceFit,
  detectCreatorType: detectServiceFit,
  detectRoleType: detectServiceFit,
  SITE_URL,
};
