# Email verification

Registration now sends a one-time verification link. New accounts cannot sign in
until the link is opened; verification links expire after 24 hours. Existing
accounts are marked unverified during the database migration and must request a
verification email before signing in again.

Configure these environment variables on the backend before enabling signup:

- `SMTP_HOST`: SMTP server hostname.
- `SMTP_PORT`: SMTP port; use `587` for STARTTLS or `465` for SSL.
- `SMTP_USERNAME` and `SMTP_PASSWORD`: SMTP credentials, when required by the
  provider. For Gmail, use an app password rather than the account password.
- `SMTP_FROM`: verified sender address, such as `LinkShortener <no-reply@example.com>`.
- `BACKEND_URL`: public backend base URL. Verification links are sent to this
  host.
- `FRONTEND_URL`: public frontend base URL. Users return here after verifying.

For local testing, set `BACKEND_URL=http://localhost:8000` and
`FRONTEND_URL=http://localhost:5173`. Keep SMTP credentials in backend
environment settings; do not commit real credentials to source control.
