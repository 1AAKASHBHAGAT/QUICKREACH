const state = {
  lastImport: null,
  campaigns: [],
};

const importForm = document.getElementById('import-form');
const campaignForm = document.getElementById('campaign-form');
const importSummary = document.getElementById('import-summary');
const importPreviewBody = document.getElementById('import-preview-body');
const campaignPreview = document.getElementById('campaign-preview');
const campaignTableBody = document.getElementById('campaign-table-body');
const integrationStatus = document.getElementById('integration-status');
const campaignPlatform = campaignForm.elements.platform;
const templateFields = document.getElementById('whatsapp-template-fields');

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function updateTemplateFields() {
  templateFields.hidden = campaignPlatform.value !== 'whatsapp';
}

function updateDashboard(campaigns) {
  const totalCampaigns = campaigns.length;
  const eligibleContacts = campaigns.reduce((sum, campaign) => sum + (campaign.contacts || []).filter((contact) => contact.status === 'eligible').length, 0);
  const messagesSent = campaigns.reduce((sum, campaign) => sum + (campaign.summary?.sent || 0), 0);
  const needsReview = campaigns.reduce((sum, campaign) => sum + (campaign.summary?.failed || 0) + (campaign.summary?.skipped || 0), 0);

  document.getElementById('total-campaigns').textContent = String(totalCampaigns);
  document.getElementById('eligible-contacts').textContent = String(eligibleContacts);
  document.getElementById('messages-sent').textContent = String(messagesSent);
  document.getElementById('needs-review').textContent = String(needsReview);
}

function renderImportSummary(summary) {
  if (!summary) {
    importSummary.textContent = 'No import yet.';
    importSummary.classList.add('empty');
    importPreviewBody.innerHTML = '';
    return;
  }

  importSummary.classList.remove('empty');
  importSummary.innerHTML = `
    <strong>Import summary</strong><br />
    Total: ${summary.total}<br />
    Valid: ${summary.validRecords}<br />
    Duplicate: ${summary.duplicateRecords}<br />
    Invalid: ${summary.invalidRecords}<br />
    Ineligible: ${summary.ineligibleRecords}<br />
    Needs verification: ${summary.recordsRequiringConsentVerification}
  `;
}

function renderImportPreview(rows) {
  importPreviewBody.innerHTML = '';

  if (!rows || !rows.length) {
    importPreviewBody.innerHTML = '<tr><td colspan="3">No valid rows found.</td></tr>';
    return;
  }

  rows.forEach((row) => {
    const status = escapeHTML(row.status || 'eligible');
    const name = row.fullName || row.displayName || 'Unnamed';
    const value = row.phoneNumber || row.authorizedInstagramRecipientId || 'Unknown';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHTML(name)}</td>
      <td>${escapeHTML(value)}</td>
      <td><span class="badge ${status}">${status}</span></td>
    `;
    importPreviewBody.appendChild(tr);
  });
}

function renderCampaignPreview(campaign) {
  if (!campaign) {
    campaignPreview.textContent = 'Campaign preview will appear here after creation.';
    campaignPreview.classList.add('empty');
    return;
  }

  campaignPreview.classList.remove('empty');
  const imageMarkup = campaign.imageUrl
    ? `<img src="${escapeHTML(campaign.imageUrl)}" alt="Campaign attachment" style="max-width: 200px; border-radius: 12px; margin-top: 12px; display:block;" />`
    : '<p>No image attached.</p>';

  campaignPreview.innerHTML = `
    <strong>${escapeHTML(campaign.name)}</strong><br />
    Platform: ${escapeHTML(campaign.platform)}<br />
    Recipients: ${campaign.contacts.length}<br />
    Template: ${escapeHTML(campaign.templateName || 'None')}<br />
    Placeholders: ${escapeHTML(campaign.placeholders.join(', ') || 'None')}<br />
    <p>${escapeHTML(campaign.messageText).replace(/\n/g, '<br />')}</p>
    ${imageMarkup}
  `;
}

async function loadCampaigns() {
  const response = await fetch('/api/campaigns');
  const data = await response.json();
  state.campaigns = data.campaigns || [];
  updateDashboard(state.campaigns);

  campaignTableBody.innerHTML = '';

  if (!state.campaigns.length) {
    campaignTableBody.innerHTML = '<tr><td colspan="6">No campaigns yet.</td></tr>';
    renderCampaignPreview(null);
    return;
  }

  state.campaigns.forEach((campaign) => {
    const row = document.createElement('tr');
    const status = escapeHTML(campaign.status || 'draft');
    const isDraft = campaign.status === 'draft';
    row.innerHTML = `
      <td>${escapeHTML(campaign.name)}</td>
      <td>${escapeHTML(campaign.platform)}</td>
      <td><span class="badge ${status}">${status}</span></td>
      <td>${campaign.contacts ? campaign.contacts.length : 0}</td>
      <td>${campaign.summary ? campaign.summary.sent : 0}</td>
      <td>
        <button class="secondary-btn" data-run-id="${escapeHTML(campaign.id)}" ${isDraft ? '' : 'disabled'}>Run</button>
      </td>
    `;
    campaignTableBody.appendChild(row);
  });

  const latestCampaign = state.campaigns[state.campaigns.length - 1];
  renderCampaignPreview(latestCampaign);

  campaignTableBody.querySelectorAll('[data-run-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-run-id');
      button.disabled = true;
      try {
        const res = await fetch(`/api/campaigns/${encodeURIComponent(id)}/run`, { method: 'POST' });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || 'Unable to run campaign.');
        await loadCampaigns();
        renderCampaignPreview(payload.campaign);
      } catch (error) {
        alert(error.message);
        button.disabled = false;
      }
    });
  });
}

async function loadIntegrationConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    const whatsapp = config.whatsappReady ? 'connected' : 'not configured';
    const instagram = config.instagramReady ? 'connected' : 'not configured';
    const webhook = config.webhookReady ? 'configured' : 'not configured';
    integrationStatus.textContent = `Mode: ${config.mode}. WhatsApp: ${whatsapp}. Instagram: ${instagram}. Webhooks: ${webhook}.`;
    if (config.mode === 'live' && config.missing.length) {
      integrationStatus.textContent += ` Missing environment settings: ${config.missing.join(', ')}.`;
    }
  } catch {
    integrationStatus.textContent = 'Unable to read provider configuration.';
  }
}

importForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(importForm);

  try {
    const response = await fetch('/api/import', {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Unable to import contacts.');
    }

    state.lastImport = payload;
    renderImportSummary(payload.summary);
    renderImportPreview(payload.preview || []);
    await loadCampaigns();
  } catch (error) {
    importSummary.textContent = error.message;
    importSummary.classList.remove('empty');
    importPreviewBody.innerHTML = '<tr><td colspan="3">Import failed.</td></tr>';
  }
});

campaignForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!state.lastImport || !state.lastImport.summary || state.lastImport.summary.validRecords === 0) {
    alert('Import valid contacts before creating a campaign.');
    return;
  }

  const formData = new FormData(campaignForm);
  if (formData.get('platform') !== state.lastImport.platform) {
    alert('Campaign platform must match the imported contact list.');
    return;
  }

  try {
    const response = await fetch('/api/campaigns', {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Unable to create campaign.');
    }

    renderCampaignPreview(payload.campaign);
    await loadCampaigns();
  } catch (error) {
    campaignPreview.textContent = error.message;
    campaignPreview.classList.remove('empty');
  }
});

campaignPlatform.addEventListener('change', updateTemplateFields);
updateTemplateFields();
loadCampaigns();
loadIntegrationConfig();
renderImportSummary(null);
renderImportPreview(null);
