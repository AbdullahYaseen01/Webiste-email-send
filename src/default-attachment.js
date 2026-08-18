const fs = require('fs');
const path = require('path');
const { projectRoot } = require('./paths');

const DEFAULT_RESUME_FILENAME = 'Abdullah_Yaseen_Resume.pdf';

function getDefaultAttachment() {
  const candidates = [
    path.join(projectRoot, 'assets', DEFAULT_RESUME_FILENAME),
    path.join(projectRoot, DEFAULT_RESUME_FILENAME),
    path.join(projectRoot, 'Abdullah_Yaseen_Resume  .pdf'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return { filename: DEFAULT_RESUME_FILENAME, path: filePath };
    }
  }
  return null;
}

function mergeAttachments(campaignAttachment) {
  const attachments = [];
  const resume = getDefaultAttachment();
  if (resume) attachments.push(resume);

  if (campaignAttachment?.path && fs.existsSync(campaignAttachment.path)) {
    const samePath = resume && path.resolve(campaignAttachment.path) === path.resolve(resume.path);
    const sameName = resume && String(campaignAttachment.filename || '').replace(/\s+/g, '_') === DEFAULT_RESUME_FILENAME;
    if (!samePath && !sameName) {
      attachments.push({
        filename: campaignAttachment.filename,
        path: campaignAttachment.path,
      });
    }
  }

  return attachments;
}

module.exports = {
  DEFAULT_RESUME_FILENAME,
  getDefaultAttachment,
  mergeAttachments,
};
