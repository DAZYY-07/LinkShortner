# LinkShortener

A full-stack URL shortener: shorten single or bulk URLs, generate QR codes, and track clicks per link. Accounts are optional, use email verification, and support password reset.

**Live demo:** https://linkshortner-1-ex3g.onrender.com

## Features

**For everyone (no account)**
- Shorten one URL or up to 20 at once, with CSV export and QR codes
- Optional UTM campaign tags
- **5 free links per network**, then a prompt to sign in (the same URL can also only be shortened 5 times)

**With a free account**
- **Custom aliases** (3-30 letters, numbers, hyphens), unique and case-insensitive
- **Edit** a link's destination, alias or settings without changing the short link
- **Expiry** by date and/or maximum number of clicks, with friendly pages for expired, disabled or used-up links
- **Password-protected links**, **301/302** redirect choice, enable/disable
- **Tags and folders**, plus search, filters and sorting in the My Links dashboard
- **Bulk actions**: archive, enable, disable, delete; **CSV import** (up to 100 rows)
- **Click analytics** per link: clicks over 7/30/90 days, top referrers, countries, devices, browsers and operating systems, with **CSV export**
- Email verification, password reset and server-side sessions

**Platform**
- Malicious-URL protection: blocklist, private/local/raw-IP and credential-in-URL checks, optional Google Safe Browsing
- Per-IP rate limiting on sign-in, shortening, imports, edits, redirects and password attempts
- Adapts to the device: 280px phones to 4K, light/dark theme, reduced motion, touch-sized controls
- Interactive API docs at `/docs` (OpenAPI) and an automated backend test suite (56 tests)

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite; served by nginx in Docker |
| Backend | Python, FastAPI, SQLAlchemy, Pydantic |
| Database | PostgreSQL (SQLite fallback for quick local runs) |
| Email | Google Apps Script web app sending through Gmail (SMTP fallback) |
| Hosting | Render (frontend static site, backend web service, Postgres) |

## How it works

1. The frontend sends `POST /shorten` with the long URL.
2. The backend validates it, checks it isn't dangerous, enforces the limits (5 free links per guest network, 5 copies of one URL), generates a random 6-character code with `secrets.choice` (or uses the alias you chose), and stores it in the `links` table. A unique index on `short_code` plus a retry handles collisions.
3. Short links look like `https://<frontend>/youtube/4ee97l`: the first part is just the destination's site name, to make the link recognisable, and the code after it decides where it goes. Older `/?r=<code>` links keep working. Opening one makes the frontend call `GET /resolve/<code>`. The backend atomically counts the click (only while the link is active, unexpired and under its click limit) and returns the destination; the click's details (referrer, device, browser, OS, country) are logged **after** the response, in the background, so they never slow the redirect.
4. The backend also redirects directly: `GET /<code>` or `GET /<site>/<code>` answers with an HTTP **302** (or 301, per link). In local Docker tests this takes a median of about 10 ms.

Guests are told apart by a hash of their network address; the address itself is never stored, and neither is the visitor's IP in click events, only the country derived from it.

Passwords are hashed with PBKDF2-SHA256 (310,000 iterations). Session, verification and reset tokens are stored only as SHA-256 hashes.

## API

Interactive documentation is served at `/docs`. Main endpoints:

| Area | Endpoints |
|---|---|
| Links | `POST /shorten`, `GET /guest-quota`, `GET /my-links` (search/filter/sort/paging), `PATCH` and `DELETE /my-links/{code}`, `POST /my-links/bulk`, `POST /my-links/import`, `GET /my-links/filters` |
| Analytics | `GET /my-links/{code}/analytics?days=30` (7, 30 or 90 days), `GET /my-links/{code}/analytics/export` (CSV) |
| Redirect | `GET /{code}` (HTTP 301/302), `GET` and `POST /resolve/{code}` (used by the web app; POST unlocks a password-protected link) |
| Accounts | `/auth/register`, `/auth/login`, `/auth/verify`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/me`, `/auth/logout` |

Calls are rate-limited per IP and answer `429` with a `Retry-After` header when exceeded.

## Run with Docker

The app runs as three containers:

| Container | Image | Host port |
|---|---|---|
| `linksnip-frontend` | nginx serving the Vite build | http://localhost:3000 |
| `linksnip-backend` | FastAPI + uvicorn | http://localhost:8001 (API docs at `/docs`) |
| `linksnip-db` | PostgreSQL 17 | `localhost:5433` |

**Requirements:** [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
docker compose up --build -d
```

Open http://localhost:3000. The backend waits for the database health check and creates its tables on startup. Data is kept in the `db-data` volume across restarts.

Without email settings, verification and password-reset links are printed in the backend log:

```bash
docker compose logs -f backend
```

To send real emails, copy `.env.example` to `.env` and set `GMAIL_SCRIPT_URL` and `GMAIL_SCRIPT_SECRET` (see [backend/EMAIL_VERIFICATION.md](backend/EMAIL_VERIFICATION.md)). Ports, database credentials, the guest link allowance and an optional Google Safe Browsing key can be changed in the same file.

Useful commands:

```bash
docker compose ps            # container status
docker compose down          # stop (keeps data)
docker compose down -v       # stop and delete the database volume
```

### Connect to the database (pgAdmin / DBeaver)

| Setting | Value |
|---|---|
| Host | `localhost` |
| Port | `5433` |
| Database | `linksnip` |
| Username | `linksnip` |
| Password | `linksnip` |
| SSL | disabled / `prefer` (the local container has no SSL) |

- **pgAdmin:** Register → Server. Fill in the values on the Connection tab; on the Parameters tab set SSL mode to `prefer`. Tables are under Databases → linksnip → Schemas → public → Tables.
- **DBeaver:** New Database Connection → PostgreSQL. Fill in the values above and download the driver if prompted.
- **Command line:** `docker exec -it linksnip-db psql -U linksnip -d linksnip`

Tables: `users`, `links`, `click_events`, `auth_tokens`, `email_verifications`, `password_resets`.

## Run without Docker

```bash
# Backend (http://localhost:8088)
cd backend
python -m venv venv
venv\Scripts\activate            # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8088 --reload

# Frontend (http://localhost:5173), in a second terminal
cd frontend
npm install
npm run dev
```

The Vite dev server proxies API calls to `http://127.0.0.1:8088` (override with `BACKEND_PROXY_TARGET`). Without `DATABASE_URL` the backend uses SQLite (`backend/links.db`). For local email links, set `BACKEND_URL=http://localhost:8088` and `FRONTEND_URL=http://localhost:5173` in `backend/.env`.

## Deploying the frontend on Render

`/youtube/4ee97l`-style links need the static site to serve the app for any path. In the Render dashboard open the static site, go to **Redirects/Rewrites** and add a rule: source `/*`, destination `/index.html`, action **Rewrite**. Until that rule exists the backend detects it (`SHORT_LINK_STYLE=auto`) and keeps producing `/?r=code` links, so nothing breaks; once it exists the new links appear automatically. The Docker setup (nginx) and the Vite dev server already do this.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest                                  # SQLite, no network needed
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/test pytest   # the same tests on PostgreSQL
```

The suite covers the guest limit, aliases, redirects, expiry and click limits, password-protected links, editing, bulk actions, CSV import/export, analytics, URL safety, rate limiting, the account flows and the in-place upgrade of an older database.

## Configuration (all optional)

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | SQLite file |
| `GUEST_LINK_LIMIT` | Free links per guest network | `5` |
| `SAFE_BROWSING_API_KEY` | Enables Google Safe Browsing checks | off |
| `BLOCKED_DOMAINS` | Extra comma-separated domains to refuse | none |
| `GEO_LOOKUP_URL` / `GEO_LOOKUP_DISABLED` | Country lookup service (`{ip}` placeholder) / turn it off | api.country.is / on |
| `SHORT_LINK_STYLE` | `path` (`/youtube/abc123`), `query` (`/?r=abc123`) or `auto` | `auto` |
| `RATE_LIMIT_DISABLED` | Set to `1` to switch rate limiting off (tests) | off |
| `GMAIL_SCRIPT_URL`, `GMAIL_SCRIPT_SECRET`, `EMAIL_FROM` | Email sending | dev mode: links printed in the log |

## Project structure

```
backend/
  main.py              FastAPI app: models, auth, links, analytics, redirects
  tests/               pytest suite
  gmail_sender.gs      Google Apps Script used to send emails
  Dockerfile
frontend/
  src/App.jsx          Shortener, bulk tools and page layout
  src/MyLinks.jsx      My Links dashboard (search, filters, bulk actions)
  src/LinkAnalytics.jsx, EditLinkDialog.jsx, LinkOptions.jsx, GuestQuota.jsx, RedirectPage.jsx
  src/api.js           Shared API helpers
  nginx.conf           nginx config for the Docker image
  Dockerfile
docker-compose.yml     db + backend + frontend
```
