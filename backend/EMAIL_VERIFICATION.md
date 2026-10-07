# Email verification

Registration now sends a one-time verification link. New accounts cannot sign in
until the link is opened; verification links expire after 24 hours. Existing
accounts are marked unverified during the database migration and must request a
verification email before signing in again.

Configure these environment variables on the backend before enabling signup.
Emails go through Brevo when `BREVO_API_KEY` is set, otherwise through SMTP.
With neither configured, the verification link is printed to the backend log.

## Brevo (recommended on Render's free tier)

Render's free web services block outbound SMTP ports (25, 465, 587), so SMTP
times out there. Brevo sends over HTTPS instead.

1. Create a free account at brevo.com.
2. Under Senders, add and verify the address you send from (a Gmail address works).
3. Under SMTP & API > API Keys, create a key.
4. Set `BREVO_API_KEY` and `EMAIL_FROM` (e.g. `LinkShortener <you@gmail.com>`).

## SMTP

- `SMTP_HOST`: SMTP server hostname.
- `SMTP_PORT`: SMTP port; use `587` for STARTTLS or `465` for SSL.
- `SMTP_USERNAME` and `SMTP_PASSWORD`: SMTP credentials, when required by the
  provider. For Gmail, use an app password rather than the account password.
- `SMTP_FROM`: verified sender address, such as `LinkShortener <no-reply@example.com>`.
  `EMAIL_FROM` takes precedence when both are set.

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
