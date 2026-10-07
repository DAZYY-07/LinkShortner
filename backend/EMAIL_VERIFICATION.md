# Email verification

Registration now sends a one-time verification link. New accounts cannot sign in
until the link is opened; verification links expire after 24 hours. Existing
accounts are marked unverified during the database migration and must request a
verification email before signing in again.

Configure these environment variables on the backend before enabling signup.
Emails go through the Gmail Apps Script when `GMAIL_SCRIPT_URL` and
`GMAIL_SCRIPT_SECRET` are set, otherwise through SMTP. With neither configured,
the verification link is printed to the backend log.

## Gmail Apps Script (free; works on Render's free tier)

Render's free web services block outbound SMTP ports (25, 465, 587), so SMTP
times out there. Instead, the backend calls a small Google Apps Script over
HTTPS, and the script sends the email from your own Gmail account. It is free;
consumer Gmail accounts can send about 100 emails a day this way.

1. Open https://script.google.com while signed in to the Gmail account you
   want to send from, and create a **New project**.
2. Replace the editor contents with `backend/gmail_sender.gs` and save.
3. **Project Settings** (gear icon) > **Script properties** > add property
   `SECRET` with a long random value (e.g. from
   `python -c "import secrets; print(secrets.token_urlsafe(32))"`).
4. **Deploy** > **New deployment** > type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Authorize when asked. Google warns the app is unverified because you wrote
   it yourself: choose **Advanced** > **Go to (project name)** > **Allow**.
5. Copy the Web app URL (ends in `/exec`).
6. On the backend set `GMAIL_SCRIPT_URL` to that URL, `GMAIL_SCRIPT_SECRET` to
   the same value as the `SECRET` property, and optionally `EMAIL_FROM`
   (only its display name is used, e.g. `LinkShortener <you@gmail.com>`).

If you edit the script later, use **Deploy** > **Manage deployments** > edit >
**New version**, so the URL stays the same.

## SMTP

- `SMTP_HOST`: SMTP server hostname.
- `SMTP_PORT`: SMTP port; use `587` for STARTTLS or `465` for SSL.
- `SMTP_USERNAME` and `SMTP_PASSWORD`: SMTP credentials, when required by the
  provider. For Gmail, use an app password rather than the account password.
- `SMTP_FROM`: verified sender address, such as `LinkShortener <no-reply@example.com>`.
  `EMAIL_FROM` takes precedence when both are set. Not needed with the Gmail script.

## URLs and database

- `BACKEND_URL`: public backend base URL. Verification links are sent to this
  host.
- `FRONTEND_URL`: public frontend base URL. Users return here after verifying.
- `DATABASE_URL`: Postgres connection string, e.g. from Render Postgres or Neon.
  Without it the backend uses SQLite on local disk, which Render wipes on every
  deploy and restart.

For local testing, set `BACKEND_URL=http://localhost:8088` and
`FRONTEND_URL=http://localhost:5173`. Keep SMTP credentials in backend
environment settings; do not commit real credentials to source control.
