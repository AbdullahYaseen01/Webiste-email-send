/**
 * Personalized subject / opener / closing for Abdullah Yaseen outreach.
 * Sounds like a 1-to-1 note. Greeting stays Hey. Subject is the company name.
 */

const SITE_URL = 'https://abdullah-yaseen.vercel.app/';

const FAKE_COMPANY = /^(example(\s+(technologies?|tech|inc|llc|co))?|acme(\s+inc)?|test(\s+co(mpany)?)?|demo(\s+company)?|sample(\s+company)?|your\s+(company|organization)|foo(\s+bar)?|asdf|xyz)$/i;

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

function firstNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  const token = local.split(/[._+\-]/)[0].replace(/\d+/g, '');
  if (token.length >= 2 && /^[a-zA-Z]+$/.test(token)) {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }
  return '';
}

function firstName(contact) {
  const raw = String(contact.first_name || (contact.name || '').split(' ')[0] || '').trim();
  if (raw && raw.toLowerCase() !== 'there') {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return firstNameFromEmail(contact.email) || 'there';
}

function hasCompany(contact) {
  const raw = String(contact.company || '').trim();
  if (!raw) return false;
  if (FAKE_COMPANY.test(raw)) return false;
  return true;
}

function companyName(contact) {
  if (!hasCompany(contact)) return '';
  return contact.company.trim();
}

function shortCompany(contact) {
  const name = companyName(contact);
  if (!name) return '';
  return name.length > 60 ? `${name.slice(0, 57).trim()}...` : name;
}

function hasTitle(contact) {
  const raw = String(contact.title || '').trim();
  if (!raw) return false;
  if (/^(title|job title|n\/?a|-)$/i.test(raw)) return false;
  return true;
}

function jobTitle(contact) {
  return hasTitle(contact) ? String(contact.title).trim() : '';
}

function detectRole(contact) {
  const t = String(contact.title || '').toLowerCase();
  if (/\b(founder|co-?founder|ceo|owner|proprietor|principal)\b/.test(t)) return 'founder';
  if (/\b(cto|chief technology|vp of eng|vp,? engineering|head of eng|director of eng|engineering manager|tech lead)\b/.test(t)) return 'eng';
  if (/\b(cpo|chief product|vp of product|head of product|product manager|product owner)\b/.test(t)) return 'product';
  if (/\b(cmo|marketing|growth|demand gen)\b/.test(t)) return 'marketing';
  return 'general';
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

function generatePersonalizedOpener(contact) {
  const email = contact.email || firstName(contact);
  const company = companyName(contact);
  const title = jobTitle(contact);
  const isFollowUp = contact._is_follow_up === true;

  if (isFollowUp) {
    if (company) {
      return pickVariant(email + '|fu-opener', [
        `Looping back once in case my first note about ${company} was easy to miss.`,
        `One short follow-up for ${company}, then I will leave it with you.`,
      ]);
    }
    return 'Looping back once in case my first note was easy to miss.';
  }

  if (company && title) {
    return pickVariant(email + '|opener-ct', [
      `I came across your profile as ${title} at ${company} and wanted to reach out. Over the past years I have built production systems and helped teams shorten the path from idea to a shipped site, product, or internal tool.`,
      `I came across your profile as ${title} at ${company} and thought a direct note made sense. I build production software myself and help teams get from idea to something people can actually use.`,
    ]);
  }
  if (company) {
    return `I came across ${company} and wanted to reach out. Over the past years I have built production systems and helped teams shorten the path from idea to a shipped site, product, or internal tool.`;
  }
  if (title) {
    return `I came across your profile as ${title} and wanted to reach out. Over the past years I have built production systems and helped teams shorten the path from idea to a shipped site, product, or internal tool.`;
  }
  return 'Over the past years I have built production systems and helped teams shorten the path from idea to a shipped site, product, or internal tool.';
}

function generatePersonalizedBackground(contact) {
  const email = contact.email || firstName(contact);
  const company = companyName(contact);
  const role = detectRole(contact);
  const industry = String(contact.industry || '').trim();
  const who = company || 'your team';

  let fit = `I take on the build myself so ${who} is not waiting on a large crew. That means the web app, the automation, the AI layer, and the product people can log into can sit with one person instead of a handoff chain.`;
  if (role === 'founder') {
    fit = `If you are still shipping ${who} without a large engineering bench, I take on the build myself. The web app, the automation, the AI layer, and the product people can log into can sit with one person instead of a handoff chain.`;
  } else if (role === 'eng') {
    fit = `If engineering at ${who} still needs extra build capacity, I take on the work myself. The web app, the automation, the AI layer, and the APIs can sit with one person instead of a handoff chain.`;
  }

  const industryLine = industry
    ? ` I have shipped this kind of work for ${industry.toLowerCase()} teams before, so I know where projects usually get stuck.`
    : '';

  return pickVariant(email + '|bg', [
    `${fit}${industryLine} I would rather cover web, automation, and AI on the same product than wait on three separate teams.`,
    `${fit}${industryLine} I work across full-stack, automation, and AI on the same product so you do not have to stitch those layers together later.`,
  ]);
}

function generatePersonalizedClosing(contact) {
  const email = contact.email || firstName(contact);
  const company = companyName(contact);
  const city = String(contact.city || '').trim();
  const tz = city ? ` I can align working hours with ${city}.` : '';

  if (company) {
    return pickVariant(email + '|close-company', [
      `It would be great to connect and explore how this could help ${company} deliver faster without sacrificing quality.${tz} If the timing is off, no need to reply.`,
      `Happy to agree on scope directly and hand over full source so ${company} owns what we build.${tz} If this is not useful right now, no need to reply.`,
    ]);
  }

  return `It would be great to connect if you still need a builder for a live app, an automation, or an AI layer.${tz} If the timing is off, no need to reply.`;
}

function generatePersonalizedSubject(contact) {
  const company = shortCompany(contact);
  const isFollowUp = contact._is_follow_up === true;
  if (company) return company;
  const title = jobTitle(contact);
  if (isFollowUp) return title || 'following up';
  return title || firstName(contact);
}

const STACK_LINE = 'On the web side that is React, Next.js, JavaScript, Node.js, and Express. For automation and APIs I use Python and FastAPI. Data usually sits in PostgreSQL or MongoDB. For shipping and hosting I use AWS, Docker, and Kubernetes. If the product needs it, I also add computer vision, chatbots, or LLM integrations.';

function generateStackLine() {
  return STACK_LINE;
}

module.exports = {
  generatePersonalizedOpener,
  generatePersonalizedBackground,
  generatePersonalizedClosing,
  generatePersonalizedSubject,
  generateStackLine,
  detectServiceFit,
  detectCreatorType: detectServiceFit,
  detectRoleType: detectServiceFit,
  firstNameFromEmail,
  SITE_URL,
};
