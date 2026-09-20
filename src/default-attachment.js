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

/** Only attach a file the user chose. Auto-PDF on cold mail is a Gmail spam trigger. */
function mergeAttachments(campaignAttachment) {
  if (!campaignAttachment?.path || !fs.existsSync(campaignAttachment.path)) return [];
  return [{
    filename: campaignAttachment.filename || DEFAULT_RESUME_FILENAME,
    path: campaignAttachment.path,
  }];
}

module.exports = {
  DEFAULT_RESUME_FILENAME,
  getDefaultAttachment,
  mergeAttachments,
};
