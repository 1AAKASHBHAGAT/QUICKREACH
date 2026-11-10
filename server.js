const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const importDir = path.join(dataDir, 'imports');
const mediaDir = path.join(dataDir, 'media');
const stateFile = path.join(dataDir, 'state.json');
const graphVersion = process.env.META_GRAPH_API_VERSION || 'v24.0';
const mode = process.env.QUICKREACH_MODE || 'demo';
if (!['demo', 'live'].includes(mode)) throw new Error('QUICKREACH_MODE must be demo or live.');
fs.mkdirSync(importDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

function createStorage(destination, useMimeExtension = false) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, destination),
    filename: (_req, file, cb) => {
      const imageExtensions = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
      };
      const extension = useMimeExtension
        ? imageExtensions[file.mimetype]
        : path.extname(path.basename(file.originalname)).toLowerCase();
      cb(null, `${crypto.randomUUID()}${extension}`);
    },
  });
}
const importUpload = multer({
  storage: createStorage(importDir),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!['.csv', '.xlsx'].includes(extension)) {
      return cb(new Error('Unsupported file type. Please upload CSV or XLSX.'));
    }
    return cb(null, true);
  },
});
const imageUpload = multer({
  storage: createStorage(mediaDir, true),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Image must be JPG, PNG, or WEBP.'));
    }
    return cb(null, true);
  },
});

let state = {
  imports: [],
  campaigns: [],
};

if (fs.existsSync(stateFile)) {
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function saveState() {
  const temporaryFile = `${stateFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, stateFile);
}

function normalizeValue(value) {
  return String(value ?? '').trim();
}

function normalizeKey(key) {
  return String(key ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function extractKeyedRow(row) {
  const result = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    result[normalizeKey(key)] = value;
  });
  return result;
}

function buildWhatsappContact(row) {
  const normalized = extractKeyedRow(row);
  const fullName = normalizeValue(normalized.fullname || normalized.name || normalized.contactname || normalized.fullnamewhatsapp);
  const phoneNumber = normalizeValue(normalized.phonenumber || normalized.phone || normalized.mobile || normalized.mobilephone);
  const countryCode = normalizeValue(normalized.countrycode || normalized.country || normalized.code || normalized.areacode);
  const consentStatus = normalizeValue(normalized.whatsappconsentstatus || normalized.consentstatus || normalized.consent || normalized.optin);
  const messagingWindowExpiresAt = normalizeValue(normalized.messagingwindowexpiresat || normalized.conversationwindowexpiresat || normalized.windowexpiresat);
  const organization = normalizeValue(normalized.organization || normalized.org);

  return {
    fullName,
    phoneNumber,
    countryCode,
    whatsappConsentStatus: consentStatus,
    messagingWindowExpiresAt,
    organization,
    valid: Boolean(fullName && phoneNumber && consentStatus && countryCode),
  };
}

function buildInstagramContact(row) {
  const normalized = extractKeyedRow(row);
  const displayName = normalizeValue(normalized.displayname || normalized.name || normalized.username || normalized.handle || normalized.profile);
  const recipientId = normalizeValue(normalized.authorizedinstagramrecipientid || normalized.recipientid || normalized.instagramrecipientid || normalized.conversationid);
  const eligibility = normalizeValue(normalized.conversationeligibilitystatus || normalized.eligibilitystatus || normalized.status || normalized.conversationstatus);
  const messagingWindowExpiresAt = normalizeValue(normalized.messagingwindowexpiresat || normalized.conversationwindowexpiresat || normalized.windowexpiresat);
  const organization = normalizeValue(normalized.organization || normalized.org);

  return {
    displayName,
    authorizedInstagramRecipientId: recipientId,
    conversationEligibilityStatus: eligibility,
    messagingWindowExpiresAt,
    organization,
    valid: Boolean(recipientId && eligibility),
  };
}

function sanitizeImportRow(rawRow, platform) {
  if (platform === 'whatsapp') {
    const contact = buildWhatsappContact(rawRow);
    return {
      ...contact,
      email: normalizeValue(rawRow.email || ''),
      platform,
    };
  }

  const contact = buildInstagramContact(rawRow);
  return {
    ...contact,
    platform,
  };
}

function getConsentState(value) {
  const normalized = normalizeValue(value).toLowerCase();
  if (!normalized) return 'unknown';
  if (['approved', 'yes', 'true', '1', 'opted_in', 'consented', 'allowed', 'eligible'].includes(normalized)) return 'approved';
  if (['pending', 'needs_verification', 'review', 'waiting', 'not_confirmed'].includes(normalized)) return 'pending';
  if (['rejected', 'no', 'false', '0', 'opted_out', 'declined', 'unavailable'].includes(normalized)) return 'rejected';
  return 'unknown';
}

function getEligibilityState(value) {
  const normalized = normalizeValue(value).toLowerCase();
  if (!normalized) return 'unknown';
  if (['eligible', 'active', 'approved', 'allowed', 'connected', 'verified'].includes(normalized)) return 'eligible';
  if (['pending', 'review', 'needs_verification', 'waiting'].includes(normalized)) return 'pending';
  if (['ineligible', 'blocked', 'not_allowed', 'rejected', 'inactive', 'restricted'].includes(normalized)) return 'ineligible';
  return 'unknown';
}

function buildImportSummary(rows, platform) {
  const contacts = [];
  let valid = 0;
  let duplicate = 0;
  let invalid = 0;
  let ineligible = 0;
  let consentPending = 0;

  const seen = new Set();

  rows.forEach((row) => {
    const normalizedRow = sanitizeImportRow(row, platform);
    const isWhatsapp = platform === 'whatsapp';

    if (!normalizedRow.valid) {
      invalid += 1;
      return;
    }

    const key = isWhatsapp ? normalizedRow.phoneNumber : normalizedRow.authorizedInstagramRecipientId;
    if (seen.has(key)) {
      duplicate += 1;
      return;
    }

    if (isWhatsapp) {
      const consentState = getConsentState(normalizedRow.whatsappConsentStatus);
      if (consentState !== 'approved') {
        ineligible += consentState === 'rejected' ? 1 : 0;
        consentPending += consentState === 'pending' || consentState === 'unknown' ? 1 : 0;
      }
      if (consentState === 'rejected' || consentState === 'pending' || consentState === 'unknown') {
        normalizedRow.status = consentState;
      } else {
        normalizedRow.status = 'eligible';
      }
      normalizedRow.phoneNumber = `${normalizeValue(normalizedRow.countryCode)}${normalizeValue(normalizedRow.phoneNumber)}`;
    } else {
      const eligibilityState = getEligibilityState(normalizedRow.conversationEligibilityStatus);
      if (eligibilityState !== 'eligible') {
        ineligible += eligibilityState === 'ineligible' ? 1 : 0;
        consentPending += eligibilityState === 'pending' || eligibilityState === 'unknown' ? 1 : 0;
      }
      normalizedRow.status = eligibilityState === 'eligible' ? 'eligible' : eligibilityState;
    }

    seen.add(key);
    contacts.push(normalizedRow);
    valid += 1;
  });

  return {
    total: rows.length,
    validRecords: valid,
    duplicateRecords: duplicate,
    invalidRecords: invalid,
    ineligibleRecords: ineligible,
    recordsRequiringConsentVerification: consentPending,
    records: contacts,
    preview: contacts.slice(0, 5),
  };
}

function extractPlaceholders(message) {
  return Array.from(new Set((message.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) || []).map((item) => item.replace(/[{}]/g, ''))));
}

function parseUploadedWorkbook(filePath) {
  return readUploadedWorkbook(filePath);
}

async function readUploadedWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  if (path.extname(filePath).toLowerCase() === '.csv') {
    await workbook.csv.readFile(filePath);
  } else {
    await workbook.xlsx.readFile(filePath);
  }

  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 1) return [];
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? '').trim());
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row.getCell(index + 1).text || '';
    });
    rows.push(record);
  });
  return rows;
}

app.use(express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use('/media', express.static(mediaDir));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

function authenticate(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();
  if (req.method === 'POST' && req.path.startsWith('/api/')) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          return res.status(403).send('Cross-origin requests are not allowed.');
        }
      } catch {
        return res.status(403).send('Invalid request origin.');
      }
    }
  }
  const expectedUsername = process.env.APP_USERNAME;
  const expectedPassword = process.env.APP_PASSWORD;
  if (!expectedUsername || !expectedPassword) {
    return res.status(503).send('Production authentication is not configured.');
  }

  const authorization = req.get('authorization') || '';
  const encoded = authorization.startsWith('Basic ') ? authorization.slice(6) : '';
  let credentials = '';
  try {
    credentials = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    credentials = '';
  }
  const separator = credentials.indexOf(':');
  const username = separator >= 0 ? credentials.slice(0, separator) : '';
  const password = separator >= 0 ? credentials.slice(separator + 1) : '';
  const usernameBuffer = Buffer.from(username);
  const expectedUsernameBuffer = Buffer.from(expectedUsername);
  const passwordBuffer = Buffer.from(password);
  const expectedPasswordBuffer = Buffer.from(expectedPassword);
  const usernameMatches = usernameBuffer.length === expectedUsernameBuffer.length
    && crypto.timingSafeEqual(usernameBuffer, expectedUsernameBuffer);
  const passwordMatches = passwordBuffer.length === expectedPasswordBuffer.length
    && crypto.timingSafeEqual(passwordBuffer, expectedPasswordBuffer);

  if (usernameMatches && passwordMatches) return next();
  res.set('WWW-Authenticate', 'Basic realm="QuickReach", charset="UTF-8"');
  return res.status(401).send('Authentication required.');
}

app.get('/webhooks/meta', (req, res) => {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken || req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== verifyToken) {
    return res.sendStatus(403);
  }
  return res.status(200).send(req.query['hub.challenge']);
});

app.post('/webhooks/meta', (req, res) => {
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.get('x-hub-signature-256') || '';
  if (!appSecret || !signature.startsWith('sha256=')) return res.sendStatus(401);
  const rawBody = req.rawBody || Buffer.alloc(0);
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return res.sendStatus(401);
  }

  const statuses = [];
  for (const entry of req.body.entry || []) {
    for (const change of entry.changes || []) {
      for (const status of change.value?.statuses || []) statuses.push(status);
    }
  }
  for (const status of statuses) {
    for (const campaign of state.campaigns) {
      for (const result of campaign.results || []) {
        if (result.providerMessageId !== status.id && !(result.providerMessageIds || []).includes(status.id)) continue;
        result.providerStatuses = result.providerStatuses || {};
        result.providerStatuses[status.id] = status.status || result.providerStatuses[status.id];
        const statuses = Object.values(result.providerStatuses);
        const hasFailure = statuses.some((value) => ['failed', 'undelivered'].includes(value));
        const hasSuccess = statuses.some((value) => ['sent', 'delivered', 'read'].includes(value));
        if (result.partialFailure || (hasFailure && hasSuccess)) result.status = 'partial';
        else if (hasFailure) result.status = 'failed';
        else if (statuses.length && statuses.every((value) => ['delivered', 'read'].includes(value))) result.status = 'delivered';
        else if (statuses.some((value) => ['sent', 'delivered', 'read'].includes(value))) result.status = 'sent';
        result.providerUpdatedAt = status.timestamp || null;
        result.providerError = status.errors?.[0]?.title || null;
        if (campaign.summary) {
          campaign.summary.sent = campaign.results.filter((item) => ['accepted', 'sent', 'delivered', 'read'].includes(item.status)).length;
          campaign.summary.failed = campaign.results.filter((item) => ['failed', 'undelivered', 'partial'].includes(item.status)).length;
        }
      }
    }
  }
  if (statuses.length) saveState();
  return res.sendStatus(200);
});

app.use(authenticate);
app.use(express.static(path.join(__dirname, 'public')));

function providerConfiguration() {
  return {
    mode,
    whatsappReady: Boolean(process.env.META_WHATSAPP_ACCESS_TOKEN && process.env.META_WHATSAPP_PHONE_NUMBER_ID),
    instagramReady: Boolean(process.env.META_INSTAGRAM_ACCESS_TOKEN && process.env.META_INSTAGRAM_PAGE_ID),
    webhookReady: Boolean(process.env.META_APP_SECRET && process.env.META_WEBHOOK_VERIFY_TOKEN),
    missing: mode === 'live'
      ? [
          ...(!process.env.PUBLIC_BASE_URL ? ['PUBLIC_BASE_URL (required for image campaigns)'] : []),
          ...(!process.env.META_APP_SECRET ? ['META_APP_SECRET'] : []),
          ...(!process.env.META_WEBHOOK_VERIFY_TOKEN ? ['META_WEBHOOK_VERIFY_TOKEN'] : []),
          ...(!process.env.META_WHATSAPP_ACCESS_TOKEN ? ['META_WHATSAPP_ACCESS_TOKEN'] : []),
          ...(!process.env.META_WHATSAPP_PHONE_NUMBER_ID ? ['META_WHATSAPP_PHONE_NUMBER_ID'] : []),
          ...(!process.env.META_INSTAGRAM_ACCESS_TOKEN ? ['META_INSTAGRAM_ACCESS_TOKEN'] : []),
          ...(!process.env.META_INSTAGRAM_PAGE_ID ? ['META_INSTAGRAM_PAGE_ID'] : []),
        ]
      : [],
  };
}

app.get('/api/config', (_req, res) => {
  const config = providerConfiguration();
  res.json({
    mode: config.mode,
    whatsappReady: config.whatsappReady,
    instagramReady: config.instagramReady,
    webhookReady: config.webhookReady,
    missing: config.missing,
  });
});

async function postToMeta(pathname, accessToken, payload) {
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) {
    const message = result.error?.message || `Meta Graph API returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return result;
}

function windowIsOpen(contact) {
  const expiresAt = Date.parse(contact.messagingWindowExpiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function personalizeMessage(message, contact) {
  return message
    .replace(/\{\{\s*first_name\s*\}\}/g, normalizeValue(contact.fullName || contact.displayName).split(/\s+/)[0] || '')
    .replace(/\{\{\s*organization\s*\}\}/g, normalizeValue(contact.organization));
}

function publicImageUrl(imageUrl) {
  if (!imageUrl) return null;
  const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${baseUrl}${imageUrl}`;
}

function hasPublicHttpsBaseUrl() {
  try {
    return new URL(process.env.PUBLIC_BASE_URL).protocol === 'https:';
  } catch {
    return false;
  }
}

async function sendWhatsApp(campaign, contact) {
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const to = contact.phoneNumber.replace(/[^\d]/g, '');
  let payload;

  if (campaign.templateName) {
    if (campaign.imageUrl || campaign.placeholders.length) {
      throw new Error('Approved-template sending currently supports templates without variables or image headers.');
    }
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: campaign.templateName,
        language: { code: campaign.templateLanguage || 'en_US' },
      },
    };
  } else {
    if (!windowIsOpen(contact)) {
      throw new Error('The WhatsApp customer-service window is closed; use an approved template.');
    }
    const text = personalizeMessage(campaign.messageText, contact);
    payload = campaign.imageUrl
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: { link: publicImageUrl(campaign.imageUrl), caption: text },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  }

  const result = await postToMeta(`${phoneNumberId}/messages`, accessToken, payload);
  return { providerMessageIds: (result.messages || []).map((message) => message.id).filter(Boolean) };
}

async function sendInstagram(campaign, contact) {
  if (!windowIsOpen(contact)) {
    throw new Error('The Instagram messaging window is closed or unverified.');
  }
  const accessToken = process.env.META_INSTAGRAM_ACCESS_TOKEN;
  const pageId = process.env.META_INSTAGRAM_PAGE_ID;
  const recipientId = contact.authorizedInstagramRecipientId;
  const text = personalizeMessage(campaign.messageText, contact);
  if (Buffer.byteLength(text, 'utf8') > 1000) {
    throw new Error('Instagram message text must be 1,000 bytes or less.');
  }

  if (!campaign.imageUrl) {
    const result = await postToMeta(`${pageId}/messages`, accessToken, {
      recipient: { id: recipientId },
      message: { text },
    });
    return { providerMessageIds: result.message_id ? [result.message_id] : [] };
  }

  const mediaResult = await postToMeta(`${pageId}/messages`, accessToken, {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'image',
        payload: { url: publicImageUrl(campaign.imageUrl), is_reusable: false },
      },
    },
  });
  try {
    const textResult = await postToMeta(`${pageId}/messages`, accessToken, {
      recipient: { id: recipientId },
      message: { text },
    });
    return {
      providerMessageIds: [mediaResult.message_id, textResult.message_id].filter(Boolean),
    };
  } catch (error) {
    error.partialProviderMessageIds = [mediaResult.message_id].filter(Boolean);
    throw error;
  }
}

function eligibleForCampaign(campaign, contact) {
  return campaign.platform === 'whatsapp'
    ? getConsentState(contact.whatsappConsentStatus) === 'approved'
    : getEligibilityState(contact.conversationEligibilityStatus) === 'eligible' && windowIsOpen(contact);
}

app.post('/api/import', importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a CSV or XLSX file.' });
    }

    const rows = await parseUploadedWorkbook(req.file.path);
    const platform = normalizeValue(req.body.platform || 'whatsapp');
    if (!['whatsapp', 'instagram'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform selected.' });
    }

    const summary = buildImportSummary(rows, platform);
    const importData = {
      id: `import-${Date.now()}`,
      platform,
      uploadedFile: req.file.filename,
      summary,
      preview: summary.preview,
      contacts: summary.records,
      createdAt: new Date().toISOString(),
    };

    state.imports.push(importData);
    saveState();

    return res.json({
      ok: true,
      importId: importData.id,
      platform,
      summary,
      preview: summary.preview,
      contacts: importData.contacts,
    });
  } catch (error) {
    console.error('Import error:', error);
    return res.status(500).json({ error: 'Unable to read the uploaded file. Please check the format and column names.' });
  }
});

app.get('/api/campaigns', (_req, res) => {
  res.json({ campaigns: state.campaigns });
});

app.post('/api/campaigns', imageUpload.single('image'), (req, res) => {
  try {
    const platform = normalizeValue(req.body.platform || 'whatsapp');
    const name = normalizeValue(req.body.name || 'Untitled Campaign');
    const messageText = normalizeValue(req.body.messageText || '');
    const templateName = normalizeValue(req.body.templateName || '');
    const templateLanguage = normalizeValue(req.body.templateLanguage || 'en_US');
    const contacts = state.imports.at(-1)?.contacts || [];
    const lastImport = state.imports.at(-1);
    const platformMatchesImport = !lastImport || lastImport.platform === platform;
    if (!platformMatchesImport) {
      return res.status(400).json({ error: 'Selected platform must match the most recent imported contact list.' });
    }

    if (!messageText) {
      return res.status(400).json({ error: 'Message text is required.' });
    }
    if (!['whatsapp', 'instagram'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform selected.' });
    }
    if (mode === 'live' && platform === 'whatsapp' && templateName && !/^[a-z0-9_]+$/.test(templateName)) {
      return res.status(400).json({ error: 'Approved template name may contain only lowercase letters, numbers, and underscores.' });
    }
    if (templateName && platform !== 'whatsapp') {
      return res.status(400).json({ error: 'Approved templates are only supported for WhatsApp campaigns.' });
    }

    if (!contacts.length) {
      return res.status(400).json({ error: 'Import valid contacts before creating a campaign.' });
    }

    if (mode === 'live' && req.file) {
      const supportedTypes = ['image/jpeg', 'image/png'];
      const platformLimit = platform === 'whatsapp' ? 5 * 1024 * 1024 : 8 * 1024 * 1024;
      if (!supportedTypes.includes(req.file.mimetype) || req.file.size > platformLimit) {
        return res.status(400).json({
          error: platform === 'whatsapp'
            ? 'Live WhatsApp image attachments must be JPG or PNG and no larger than 5 MB.'
            : 'Live Instagram image attachments must be JPG or PNG and no larger than 8 MB.',
        });
      }
    }

    const imageUrl = req.file ? `/media/${req.file.filename}` : null;
    const placeholders = extractPlaceholders(messageText);
    const supportedPlaceholders = new Set(['first_name', 'organization']);
    const unsupportedPlaceholders = placeholders.filter((placeholder) => !supportedPlaceholders.has(placeholder));
    if (unsupportedPlaceholders.length) {
      return res.status(400).json({ error: `Unsupported message placeholder(s): ${unsupportedPlaceholders.join(', ')}.` });
    }
    if (placeholders.includes('organization') && contacts.some((contact) => !contact.organization)) {
      return res.status(400).json({ error: 'The organization placeholder requires an Organization value for every imported recipient.' });
    }
    if (mode === 'live' && platform === 'whatsapp' && templateName && (req.file || placeholders.length)) {
      return res.status(400).json({ error: 'Approved-template sending currently supports templates without variables or image headers.' });
    }
    const campaign = {
      id: `campaign-${Date.now()}`,
      name,
      platform,
      messageText,
      templateName: templateName || null,
      templateLanguage,
      imageUrl,
      placeholders,
      createdAt: new Date().toISOString(),
      contacts,
      status: 'draft',
    };

    state.campaigns.push(campaign);
    saveState();
    return res.status(201).json({ ok: true, campaign });
  } catch (error) {
    console.error('Campaign creation error:', error);
    return res.status(500).json({ error: 'Unable to create campaign.' });
  }
});

app.post('/api/campaigns/:id/run', async (req, res) => {
  try {
    const campaign = state.campaigns.find((item) => item.id === req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found.' });
    }
    if (campaign.status !== 'draft') {
      return res.status(409).json({ error: 'This campaign has already been processed.' });
    }

    if (mode === 'live') {
      const config = providerConfiguration();
      const platformReady = campaign.platform === 'whatsapp' ? config.whatsappReady : config.instagramReady;
      if (!platformReady) {
        return res.status(503).json({ error: `Live ${campaign.platform} integration is not configured.` });
      }
      if (campaign.imageUrl && !hasPublicHttpsBaseUrl()) {
        return res.status(503).json({ error: 'Set PUBLIC_BASE_URL to a public HTTPS origin before sending image attachments.' });
      }
    }

    campaign.status = 'sending';
    campaign.results = [];
    saveState();

    for (const contact of campaign.contacts) {
      if (!eligibleForCampaign(campaign, contact)) {
        campaign.results.push({
          ...contact,
          status: 'skipped',
          message: campaign.platform === 'whatsapp'
            ? 'WhatsApp opt-in is not approved.'
            : 'Instagram eligibility or messaging window is not verified.',
        });
        continue;
      }

      if (campaign.platform === 'whatsapp' && !campaign.templateName && !windowIsOpen(contact)) {
        campaign.results.push({
          ...contact,
          status: 'skipped',
          message: 'The WhatsApp customer-service window is closed; use an approved template.',
        });
        continue;
      }

      if (mode === 'demo') {
        campaign.results.push({ ...contact, status: 'simulated', message: 'Demo mode only; no message was sent.' });
        continue;
      }

      try {
        const delivery = campaign.platform === 'whatsapp'
          ? await sendWhatsApp(campaign, contact)
          : await sendInstagram(campaign, contact);
        campaign.results.push({
          ...contact,
          status: 'accepted',
          providerMessageId: delivery.providerMessageIds[0] || null,
          providerMessageIds: delivery.providerMessageIds,
          providerStatuses: {},
          message: 'Accepted by Meta; final delivery status may arrive by webhook.',
        });
      } catch (error) {
        const partialProviderMessageIds = error.partialProviderMessageIds || [];
        campaign.results.push({
          ...contact,
          status: partialProviderMessageIds.length ? 'partial' : 'failed',
          providerMessageId: partialProviderMessageIds[0] || null,
          providerMessageIds: partialProviderMessageIds,
          providerStatuses: {},
          partialFailure: partialProviderMessageIds.length > 0,
          message: partialProviderMessageIds.length
            ? `Image was accepted, but the accompanying text failed: ${error.message}`
            : error.message,
        });
      }
      saveState();
    }

    const sent = campaign.results.filter((item) => ['accepted', 'delivered'].includes(item.status)).length;
    const failed = campaign.results.filter((item) => ['failed', 'undelivered', 'partial'].includes(item.status)).length;
    const skipped = campaign.results.filter((item) => item.status === 'skipped').length;
    const simulated = campaign.results.filter((item) => item.status === 'simulated').length;

    campaign.status = 'completed';
    campaign.summary = {
      total: campaign.results.length,
      sent,
      failed,
      skipped,
      simulated,
      processedAt: new Date().toISOString(),
    };
    saveState();

    return res.json({ ok: true, campaign });
  } catch (error) {
    console.error('Campaign execution error:', error);
    return res.status(500).json({ error: 'Unable to execute campaign.' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.NODE_ENV === 'production' && (!process.env.APP_USERNAME || !process.env.APP_PASSWORD)) {
  throw new Error('APP_USERNAME and APP_PASSWORD must be set in production.');
}

app.listen(PORT, () => {
  console.log(`QuickReach MVP running at http://localhost:${PORT}`);
});
