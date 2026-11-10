# QuickReach

QuickReach supports CSV/XLSX contact import, consent/eligibility checks, image campaigns, campaign history, Meta Graph API delivery, and Meta webhook status updates.

## Run locally

```powershell
npm install
npm start
```

Open `http://localhost:3000`. By default the app runs in `demo` mode; campaign execution marks eligible recipients as simulated and never sends messages.

## Enable live Meta messaging

1. Create/configure a Meta app with WhatsApp Business Cloud API and/or Instagram Messaging API access.
2. Copy `.env.example` to `.env` and set the account-specific values. Never commit `.env` or paste tokens into source code.
3. Use a valid long-lived access token, WhatsApp phone-number ID, and Instagram Page ID with a Page access token that has the required messaging permission. Configure `PUBLIC_BASE_URL` as a public HTTPS origin before sending campaigns with images.
4. Set `QUICKREACH_MODE=live` and restart the service.
5. Configure `https://YOUR_PUBLIC_HOST/webhooks/meta` as the Meta webhook URL, use the same `META_WEBHOOK_VERIFY_TOKEN`, subscribe the relevant messaging/status fields, and set `META_APP_SECRET` for signature checks.

Provider references: [WhatsApp Cloud API messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages) and [Instagram Messaging send message](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message).

The app sends only to WhatsApp contacts with approved opt-in and either an open customer-service window or a named approved template. Instagram recipients must be eligible conversation-scoped IDs from a user-initiated conversation with an unexpired messaging window. Instagram usernames are not used as API recipients. The MVP's template sender supports approved templates without variables or image headers. Instagram image campaigns send the image and text as two messages.

### Contact columns for live campaigns

- WhatsApp: `Full Name`, `Phone Number`, `Country Code`, `WhatsApp Consent Status`, `Messaging Window Expires At` (ISO-8601 UTC timestamp). The expiry field is required for free-form text/image sends; otherwise create a campaign with an approved template name.
- Instagram: `Display Name`, `Authorized Instagram Recipient ID`, `Conversation Eligibility Status`, `Messaging Window Expires At` (ISO-8601 UTC timestamp).
- Optional personalization: `Organization`. Supported message placeholders are `{{first_name}}` and `{{organization}}`; organization must be present for every imported recipient when used.

Live image compatibility is restricted to JPG/PNG (up to 5 MB for WhatsApp and 8 MB for Instagram), and Instagram text is limited to 1,000 UTF-8 bytes. Meta may reject messages due to permissions, template state, account limits, or policy enforcement. The campaign history distinguishes acceptance, failure, and subsequent webhook delivery status; an API acceptance is not a delivery guarantee.

## Deploy to Render

The repository includes [render.yaml](./render.yaml) for a Render Free web service. To deploy:

1. Push this project to a Git provider account.
2. In Render, choose **New → Blueprint**, select the repository, and enter the requested secret environment values. The blueprint uses Render's Free instance plan and does not create a paid persistent disk.
3. Set `PUBLIC_BASE_URL` to the HTTPS URL Render assigns to the service, then redeploy.
4. Use the generated service URL and `APP_USERNAME`/`APP_PASSWORD` to access the application.
5. Complete Meta webhook configuration using the URL above.

The blueprint starts in live mode and requires production login credentials. Leave provider credentials unset until configured; corresponding campaigns will remain blocked. Render Free services use an ephemeral filesystem and may spin down after inactivity. Imported files, uploaded media, and campaign/contact state can be lost when the service restarts or redeploys, and the service may take time to wake up. Use a paid persistent disk or an external database/object store if you need durable production data. Render account access and Meta credentials are not available in this workspace, so a public service cannot be provisioned from here.

## Persistence and security

Campaign/contact state and uploaded files are stored under `DATA_DIR` (default `./data`). On Render Free this is ephemeral storage, so data may disappear after a restart or redeploy. Imported CSV/XLSX files are not served publicly; campaign media is served from `/media` for Meta to fetch. Production requires HTTP Basic authentication using `APP_USERNAME` and `APP_PASSWORD`. Use HTTPS, limit account access, rotate tokens, and collect/store only recipient data you are authorized to process.
