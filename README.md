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
2. In Render, choose **New → Blueprint** and select the repository. The blueprint uses Render's Free instance plan, does not create a paid persistent disk, and generates a production login password.
3. After the first deployment, open the service's **Environment** settings to retrieve the generated `APP_PASSWORD`. Sign in with username `quickreach-admin` and that password.
4. The deployed service starts in demo mode, so it can be hosted without Meta credentials and campaign runs never send real messages.

Render Free services use an ephemeral filesystem and may spin down after inactivity. Imported files, uploaded media, and campaign/contact state can be lost when the service restarts or redeploys, and the service may take time to wake up. Use a paid persistent disk or an external database/object store if you need durable production data. To enable actual Meta messaging later, configure provider credentials and the public HTTPS URL in Render's environment settings, switch `QUICKREACH_MODE` to `live`, and complete Meta webhook configuration.

## Persistence and security

Campaign/contact state and uploaded files are stored under `DATA_DIR` (default `./data`). On Render Free this is ephemeral storage, so data may disappear after a restart or redeploy. Imported CSV/XLSX files are not served publicly; campaign media is served from `/media` for Meta to fetch. Production requires HTTP Basic authentication using `APP_USERNAME` and `APP_PASSWORD`; the Render blueprint generates the password. Use HTTPS, limit account access, rotate tokens, and collect/store only recipient data you are authorized to process.
