# LinkShortener

A full-stack URL shortener: shorten single or bulk URLs, generate QR codes, and track clicks per link. Accounts are optional, use email verification, and support password reset.

**Live demo:** https://linkshortner-1-ex3g.onrender.com

## Features

- Shorten one URL or up to 20 at once, with CSV export and QR codes
- Optional UTM campaign tags
- Accounts with email verification, password reset and server-side sessions
- Per-link click analytics (last 7 days) and site-wide stats
- Guest rate limit: the same URL can be shortened 5 times per account or guest

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
2. The backend validates the URL, enforces the per-user/guest limit, generates a random 6-character code with `secrets.choice`, and stores it in the `links` table. A unique index on `short_code` plus a retry handles collisions.
3. Short links look like `https://<frontend>/?r=<code>`. Opening one makes the frontend call `GET /resolve/<code>`. The backend increments the click counter, records a `click_events` row, and returns the original URL, and the browser redirects.

Passwords are hashed with PBKDF2-SHA256 (310,000 iterations). Session, verification and reset tokens are stored only as SHA-256 hashes.

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

To send real emails, copy `.env.example` to `.env` and set `GMAIL_SCRIPT_URL` and `GMAIL_SCRIPT_SECRET` (see [backend/EMAIL_VERIFICATION.md](backend/EMAIL_VERIFICATION.md)). Ports and database credentials can be changed in the same file.

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

## Project structure

```
backend/
  main.py              FastAPI app: models, auth, shortening, analytics
  gmail_sender.gs      Google Apps Script used to send emails
  Dockerfile
frontend/
  src/App.jsx          React app
  nginx.conf           nginx config for the Docker image
  Dockerfile
docker-compose.yml     db + backend + frontend
```
