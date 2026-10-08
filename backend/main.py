import os
from dotenv import load_dotenv

load_dotenv()
import csv
import hashlib
import hmac
import html as html_lib
import io
import ipaddress
import json
import logging
import re
import smtplib
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections import Counter, deque
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Literal
from urllib.parse import urlencode, urlparse
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request, Response
from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, HttpUrl, Field, TypeAdapter, ValidationError
from sqlalchemy import Boolean, create_engine, Column, DateTime, ForeignKey, Integer, String, and_, func, inspect, or_, update
from sqlalchemy import false as sa_false, true as sa_true
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime, timedelta, timezone
import secrets
import string

logger = logging.getLogger(__name__)
app = FastAPI(
    title="LinkShortener API",
    version="2.0.0",
    description=(
        "URL shortener with accounts, custom aliases, link management and click analytics.\n\n"
        "**Auth:** sign in with `POST /auth/login`, then send `Authorization: Bearer <token>`.\n\n"
        "**Guests** can create a limited number of plain short links; accounts unlock aliases, expiry, "
        "passwords, tags, editing, analytics and CSV import/export.\n\n"
        "**Rate limits** apply per client IP and return `429` with a `Retry-After` header."
    ),
    openapi_tags=[
        {"name": "Auth", "description": "Sign up, verification, sign in and password reset."},
        {"name": "Links", "description": "Create, list, edit, delete and organise short links."},
        {"name": "Analytics", "description": "Click statistics and CSV export."},
        {"name": "Redirect", "description": "Resolve a short code and redirect to the destination."},
        {"name": "Meta", "description": "Health and public statistics."},
    ],
)

DEFAULT_FRONTEND_URL = "https://linkshortner-1-ex3g.onrender.com"
FRONTEND_URL = (
    os.getenv("FRONTEND_URL") or DEFAULT_FRONTEND_URL
).strip().rstrip("/")
BACKEND_URL = os.getenv(
    "BACKEND_URL",
    "https://linkshortner-backend-uwgj.onrender.com",
).strip().rstrip("/")

# --------------------------------------------------
# SETTINGS (all optional environment variables)
# --------------------------------------------------

GUEST_LINK_LIMIT = int(os.getenv("GUEST_LINK_LIMIT", "5"))  # free links per guest network
SAME_URL_LIMIT = 5  # copies of one URL per account or guest
MAX_CSV_ROWS = 100
RATE_LIMIT_DISABLED = os.getenv("RATE_LIMIT_DISABLED", "").strip() == "1"
SAFE_BROWSING_API_KEY = os.getenv("SAFE_BROWSING_API_KEY", "").strip()
GEO_LOOKUP_URL = os.getenv("GEO_LOOKUP_URL", "https://api.country.is/{ip}")
GEO_LOOKUP_DISABLED = os.getenv("GEO_LOOKUP_DISABLED", "").strip() == "1"
ALLOW_PRIVATE_URLS = os.getenv("ALLOW_PRIVATE_URLS", "").strip() == "1"
# Google's own Safe Browsing test pages are always blocked; add more with BLOCKED_DOMAINS=a.com,b.com
BLOCKED_DOMAINS = {
    domain.strip().lower()
    for domain in (os.getenv("BLOCKED_DOMAINS", "") + ",malware.testing.google.test,testsafebrowsing.appspot.com").split(",")
    if domain.strip()
}

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        DEFAULT_FRONTEND_URL,
        FRONTEND_URL,
    ],
    # Vite falls back to 5174, 5175, ... when 5173 is busy.
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Total-Count", "Retry-After", "Content-Disposition"],
)

# --------------------------------------------------
# DATABASE
# --------------------------------------------------

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./links.db")
# Render and Heroku hand out "postgres://" URLs, which SQLAlchemy no longer accepts.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
    # Hosted Postgres drops idle connections; check them before reuse.
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()
security = HTTPBearer(auto_error=False)


class Link(Base):
    __tablename__ = "links"

    id = Column(Integer, primary_key=True, index=True)
    original_url = Column(String, nullable=False)
    short_code = Column(
        String,
        unique=True,
        index=True,
        nullable=False
    )
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    guest_key = Column(String, index=True, nullable=True)
    created_at = Column(DateTime, nullable=False, default=lambda: utcnow())
    clicks = Column(Integer, nullable=False, default=0)
    # Link management
    is_active = Column(Boolean, nullable=False, default=True, server_default=sa_true())
    is_archived = Column(Boolean, nullable=False, default=False, server_default=sa_false())
    expires_at = Column(DateTime, nullable=True)  # naive UTC
    max_clicks = Column(Integer, nullable=True)
    redirect_type = Column(Integer, nullable=False, default=302, server_default="302")
    password_hash = Column(String, nullable=True)
    folder = Column(String, nullable=True)
    tags = Column(String, nullable=True)  # ",tag1,tag2," so an exact tag is a LIKE '%,tag,%'


class ClickEvent(Base):
    __tablename__ = "click_events"

    id = Column(Integer, primary_key=True, index=True)
    link_id = Column(Integer, ForeignKey("links.id"), nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=lambda: utcnow(), index=True)
    # Visitor details. The IP address itself is never stored, only the country derived from it.
    referrer = Column(String(120), nullable=True)
    device = Column(String(20), nullable=True)
    browser = Column(String(30), nullable=True)
    os = Column(String(30), nullable=True)
    country = Column(String(2), nullable=True)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    is_verified = Column(Boolean, nullable=False, default=False)


class EmailVerification(Base):
    __tablename__ = "email_verifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)


class PasswordReset(Base):
    __tablename__ = "password_resets"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)


class AuthToken(Base):
    __tablename__ = "auth_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)


Base.metadata.create_all(bind=engine)


def ensure_columns(table: str, columns: dict[str, str]) -> None:
    """Add columns that older databases don't have yet (a small, idempotent migration)."""
    existing = {column["name"] for column in inspect(engine).get_columns(table)}
    with engine.begin() as connection:
        for name, definition in columns.items():
            if name not in existing:
                connection.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


# Keep existing databases usable as features add columns.
ensure_columns("users", {"is_verified": "BOOLEAN NOT NULL DEFAULT FALSE"})
ensure_columns("links", {
    "user_id": "INTEGER REFERENCES users(id)",
    "guest_key": "VARCHAR",
    "created_at": "TIMESTAMP",
    "clicks": "INTEGER NOT NULL DEFAULT 0",
    "is_active": "BOOLEAN NOT NULL DEFAULT TRUE",
    "is_archived": "BOOLEAN NOT NULL DEFAULT FALSE",
    "expires_at": "TIMESTAMP",
    "max_clicks": "INTEGER",
    "redirect_type": "INTEGER NOT NULL DEFAULT 302",
    "password_hash": "VARCHAR",
    "folder": "VARCHAR",
    "tags": "VARCHAR",
})
ensure_columns("click_events", {
    "referrer": "VARCHAR(120)",
    "device": "VARCHAR(20)",
    "browser": "VARCHAR(30)",
    "os": "VARCHAR(30)",
    "country": "VARCHAR(2)",
})
try:
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE INDEX IF NOT EXISTS ix_links_user_id ON links (user_id)")
except Exception:  # an index is an optimisation; never stop the app from starting over it
    logger.exception("Could not create index ix_links_user_id")

# --------------------------------------------------
# REQUEST MODEL
# --------------------------------------------------

class URLRequest(BaseModel):
    url: HttpUrl
    # Options below are for signed-in users.
    alias: str | None = Field(default=None, max_length=64)
    expires_at: datetime | None = None
    max_clicks: int | None = Field(default=None, ge=1, le=10_000_000)
    redirect_type: Literal[301, 302] = 302
    password: str | None = Field(default=None, min_length=4, max_length=128)
    folder: str | None = Field(default=None, max_length=40)
    tags: list[str] | None = Field(default=None, max_length=10)


class LinkUpdate(BaseModel):
    """Partial update: only the fields you send change; send null to clear expiry, limit, password, folder or tags."""

    url: HttpUrl | None = None
    alias: str | None = Field(default=None, max_length=64)
    expires_at: datetime | None = None
    max_clicks: int | None = Field(default=None, ge=1, le=10_000_000)
    redirect_type: Literal[301, 302] | None = None
    password: str | None = Field(default=None, min_length=4, max_length=128)
    folder: str | None = Field(default=None, max_length=40)
    tags: list[str] | None = Field(default=None, max_length=10)
    is_active: bool | None = None
    is_archived: bool | None = None


class BulkAction(BaseModel):
    action: Literal["delete", "archive", "unarchive", "enable", "disable"]
    codes: list[str] = Field(min_length=1, max_length=200)


class ImportRequest(BaseModel):
    csv: str = Field(min_length=1, max_length=300_000)


class UnlockRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class AccountRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)


class EmailRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class PasswordResetRequest(BaseModel):
    token: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=8, max_length=128)


def normalize_email(email: str) -> str:
    normalized = email.strip().lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", normalized):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    return normalized


def verification_token(db, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.query(EmailVerification).filter(
        EmailVerification.user_id == user.id
    ).delete(synchronize_session=False)
    db.add(
        EmailVerification(
            user_id=user.id,
            token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=24),
        )
    )
    return token


def password_reset_token(db, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.query(PasswordReset).filter(
        PasswordReset.user_id == user.id
    ).delete(synchronize_session=False)
    db.add(
        PasswordReset(
            user_id=user.id,
            token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=1),
        )
    )
    return token


def send_with_gmail_script(script_url: str, secret: str, sender: str, email: str, subject: str, text: str, html: str) -> None:
    # Posts to the Google Apps Script in gmail_sender.gs, which sends from your own Gmail.
    # It goes over HTTPS, so it works on hosts that block outbound SMTP (e.g. Render's free tier).
    sender_name, _ = parseaddr(sender)
    payload = {
        "secret": secret,
        "to": email,
        "name": sender_name or "LinkShortener",
        "subject": subject,
        "text": text,
        "html": html,
    }
    request = urllib.request.Request(
        script_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    # Apps Script answers with a redirect to the result, which urllib follows as a GET.
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read().decode("utf-8")
    try:
        result = json.loads(body)
    except ValueError:
        raise RuntimeError("Gmail script returned an unexpected response; check its deployment access.") from None
    # Apps Script cannot set HTTP status codes, so errors come back as {"ok": false}.
    if not result.get("ok"):
        raise RuntimeError(f"Gmail script error: {result.get('error', 'unknown error')}")


def send_with_smtp(host: str, sender: str, email: str, subject: str, text: str, html: str) -> None:
    port = int(str(os.getenv("SMTP_PORT", "465")).strip())
    username = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = email
    message.set_content(text)
    message.add_alternative(html, subtype="html")

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=12) as smtp:
            if username and password:
                smtp.login(username, password)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=12) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            if username and password:
                smtp.login(username, password)
            smtp.send_message(message)


def send_email(email: str, subject: str, text: str, html: str, dev_link: str) -> None:
    script_url = os.getenv("GMAIL_SCRIPT_URL", "").strip()
    script_secret = os.getenv("GMAIL_SCRIPT_SECRET", "").strip()
    host = os.getenv("SMTP_HOST", "").strip()
    sender = (os.getenv("EMAIL_FROM") or os.getenv("SMTP_FROM", "")).strip()
    use_script = bool(script_url and script_secret)

    if not use_script and not (host and sender):
        print("\n" + "=" * 60)
        print(f" [DEV MODE] {subject}")
        print(f" To: {email}")
        print(f" Link: {dev_link}")
        print("=" * 60 + "\n")
        logger.info("Dev mode email link for %s: %s", email, dev_link)
        return

    provider = "Gmail script" if use_script else f"SMTP {host}"
    try:
        if use_script:
            send_with_gmail_script(script_url, script_secret, sender, email, subject, text, html)
        else:
            send_with_smtp(host, sender, email, subject, text, html)
    except Exception as exc:
        logger.error("Failed sending email via %s for %s: %s", provider, email, exc)
        raise


def send_verification_email(email: str, token: str) -> None:
    verification_url = f"{BACKEND_URL}/auth/verify?{urlencode({'token': token})}"
    send_email(
        email,
        "Verify your LinkShortener email",
        "Verify your LinkShortener account by opening this link within 24 hours:\n\n"
        f"{verification_url}\n\n"
        "If you did not request this account, you can ignore this email.",
        "<p>Verify your LinkShortener account by clicking the button below. "
        "This link expires in 24 hours.</p>"
        f'<p><a href="{verification_url}">Verify my email</a></p>'
        "<p>If you did not request this account, you can ignore this email.</p>",
        verification_url,
    )


def send_password_reset_email(email: str, token: str) -> None:
    reset_url = f"{FRONTEND_URL}/?{urlencode({'reset': token})}"
    send_email(
        email,
        "Reset your LinkShortener password",
        "Reset your LinkShortener password by opening this link within 1 hour:\n\n"
        f"{reset_url}\n\n"
        "If you did not ask to reset your password, you can ignore this email.",
        "<p>Reset your LinkShortener password by clicking the button below. "
        "This link expires in 1 hour.</p>"
        f'<p><a href="{reset_url}">Choose a new password</a></p>'
        "<p>If you did not ask to reset your password, you can ignore this email.</p>",
        reset_url,
    )


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000)
    return f"{salt.hex()}${digest.hex()}"


def password_matches(password: str, stored_hash: str) -> bool:
    salt_hex, digest_hex = stored_hash.split("$", 1)
    candidate = hash_password(password, bytes.fromhex(salt_hex)).split("$", 1)[1]
    return hmac.compare_digest(candidate, digest_hex)


def create_auth_token(db, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(
        AuthToken(
            user_id=user.id,
            token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
            expires_at=datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=30),
        )
    )
    db.commit()
    return token


def authenticate_token(db, credentials: HTTPAuthorizationCredentials | None):
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Please sign in to continue.")
    token_hash = hashlib.sha256(credentials.credentials.encode("utf-8")).hexdigest()
    session_token = db.query(AuthToken).filter(AuthToken.token_hash == token_hash).first()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if not session_token or session_token.expires_at <= now:
        raise HTTPException(status_code=401, detail="Your session has expired. Please sign in again.")
    user = db.query(User).filter(User.id == session_token.user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Account not found. Please sign in again.")
    if not user.is_verified:
        raise HTTPException(
            status_code=403,
            detail="Please verify your email before using your account.",
        )
    return user, session_token


def account_response(user: User, token: str) -> dict:
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"id": user.id, "email": user.email},
    }


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def short_url_for(request: Request, short_code: str) -> str:
    if request.url.hostname in LOCAL_HOSTS:
        # Point local links at the dev frontend: cross-origin calls carry an Origin
        # header, and the Vite dev proxy sends X-Forwarded-Host.
        origin = request.headers.get("origin", "").rstrip("/")
        forwarded_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
        if urlparse(origin).hostname in LOCAL_HOSTS:
            base_url = origin
        elif urlparse(f"//{forwarded_host}").hostname in LOCAL_HOSTS:
            base_url = f"http://{forwarded_host}"
        else:
            base_url = "http://localhost:5173"
    else:
        base_url = FRONTEND_URL
    return f"{base_url}/?{urlencode({'r': short_code})}"

def client_ip(request: Request) -> str:
    # Behind Render's proxy request.client is the proxy itself, which would put every
    # guest in the same bucket. These headers are client-controllable, so they are only
    # good enough for the soft per-guest limit, not for anything security-sensitive.
    for header in ("cf-connecting-ip", "true-client-ip"):
        if request.headers.get(header):
            return request.headers[header].strip()
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

# --------------------------------------------------
# SHORT CODE GENERATOR
# --------------------------------------------------

def generate_code(length=6):
    characters = string.ascii_letters + string.digits

    return "".join(
        secrets.choice(characters)
        for _ in range(length)
    )


# --------------------------------------------------
# LINK HELPERS
# --------------------------------------------------

def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_utc(value: datetime | None) -> str | None:
    # Timestamps are stored as naive UTC; the trailing Z lets browsers convert them to local time.
    return value.isoformat() + "Z" if value else None


# Rate limiting: a small in-memory sliding window per client IP. It is per process, so with several
# backend instances you would move this to a shared store such as Redis.
_rate_hits: dict[str, deque] = {}
_rate_lock = threading.Lock()


def rate_limit(name: str, limit: int, window: int = 60):
    """FastAPI dependency: allow `limit` calls per `window` seconds for each client IP."""

    def check(request: Request) -> None:
        if RATE_LIMIT_DISABLED:
            return
        key = f"{name}:{client_ip(request)}"
        now = time.monotonic()
        with _rate_lock:
            hits = _rate_hits.setdefault(key, deque())
            while hits and hits[0] <= now - window:
                hits.popleft()
            if len(hits) >= limit:
                retry_after = max(1, int(hits[0] + window - now) + 1)
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many requests. Please try again in {retry_after} seconds.",
                    headers={"Retry-After": str(retry_after)},
                )
            hits.append(now)
            if len(_rate_hits) > 20_000:  # keep memory bounded
                for stale in [k for k, v in _rate_hits.items() if not v or v[-1] <= now - window]:
                    del _rate_hits[stale]

    return check


# Aliases ---------------------------------------------------
ALIAS_RE = re.compile(r"^[A-Za-z0-9-]{3,30}$")
RESERVED_ALIASES = {
    "auth", "shorten", "stats", "resolve", "docs", "redoc", "openapi", "openapi.json", "favicon.ico",
    "robots.txt", "api", "admin", "login", "logout", "signup", "register", "health", "assets", "static",
    "guest-quota", "verify", "reset", "links", "my-links", "linkshortener",
}


def validate_alias(db, alias: str, exclude_id: int | None = None) -> str:
    alias = alias.strip()
    if not ALIAS_RE.fullmatch(alias):
        raise HTTPException(status_code=422, detail="An alias needs 3-30 characters: letters, numbers and hyphens only.")
    lowered = alias.lower()
    if lowered in RESERVED_ALIASES:
        raise HTTPException(status_code=422, detail="That alias is reserved. Please choose another one.")
    taken = db.query(Link.id).filter(func.lower(Link.short_code) == lowered)
    if exclude_id is not None:
        taken = taken.filter(Link.id != exclude_id)
    if taken.first():
        raise HTTPException(status_code=409, detail="That alias is already taken.")
    return alias


def normalize_expiry(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    if value <= utcnow():
        raise HTTPException(status_code=422, detail="The expiry date must be in the future.")
    return value


# Tags and folders -------------------------------------------
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9 _-]{0,23}$")


def clean_tags(tags: list[str] | None) -> list[str]:
    cleaned: list[str] = []
    for raw in tags or []:
        tag = " ".join(raw.strip().lower().split())
        if not tag:
            continue
        if not TAG_RE.fullmatch(tag):
            raise HTTPException(
                status_code=422,
                detail=f'Invalid tag "{raw[:24]}": use up to 24 letters, numbers, spaces, hyphens or underscores.',
            )
        if tag not in cleaned:
            cleaned.append(tag)
    return cleaned[:10]


def tags_to_db(tags: list[str]) -> str | None:
    return "," + ",".join(tags) + "," if tags else None


def tags_from_db(value: str | None) -> list[str]:
    return [tag for tag in (value or "").split(",") if tag]


def clean_folder(folder: str | None) -> str | None:
    if folder is None:
        return None
    folder = " ".join(folder.strip().split())
    if not folder:
        return None
    if len(folder) > 40 or "<" in folder or ">" in folder:
        raise HTTPException(status_code=422, detail="Folder names can be up to 40 characters, without < or >.")
    return folder


# URL safety --------------------------------------------------
def assess_url(url: str) -> str | None:
    """Return a reason to refuse this destination, or None when it looks fine."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        return "Enter a valid URL."
    if parsed.username or parsed.password:
        return "Links that contain a username or password are not allowed."
    if host in BLOCKED_DOMAINS or any(host.endswith("." + domain) for domain in BLOCKED_DOMAINS):
        return "This website is on the blocklist because it is known for malware or phishing."
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if not address.is_global:
            if ALLOW_PRIVATE_URLS:
                return None
            return "Links to private or local addresses are not allowed."
        return "Links to raw IP addresses are not allowed."
    if not ALLOW_PRIVATE_URLS and (host == "localhost" or host.endswith((".local", ".localhost", ".internal", ".lan"))):
        return "Links to private or local addresses are not allowed."
    own_frontend = urlparse(FRONTEND_URL).hostname
    own_backend = urlparse(BACKEND_URL).hostname
    if host == own_frontend and "r=" in (parsed.query or ""):
        return "That is already a LinkShortener link."
    if host == own_backend:
        first_segment = parsed.path.strip("/")
        if first_segment and "/" not in first_segment and first_segment not in {"docs", "redoc", "openapi.json"}:
            return "That is already a LinkShortener link."
    return None


def flagged_by_safe_browsing(url: str) -> bool:
    """Ask Google Safe Browsing about a URL. Only runs when SAFE_BROWSING_API_KEY is set; fails open."""
    if not SAFE_BROWSING_API_KEY:
        return False
    body = {
        "client": {"clientId": "linkshortener", "clientVersion": "2.0"},
        "threatInfo": {
            "threatTypes": ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
            "platformTypes": ["ANY_PLATFORM"],
            "threatEntryTypes": ["URL"],
            "threatEntries": [{"url": url}],
        },
    }
    request = urllib.request.Request(
        f"https://safebrowsing.googleapis.com/v4/threatMatches:find?key={SAFE_BROWSING_API_KEY}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return bool(json.loads(response.read().decode("utf-8")).get("matches"))
    except Exception as exc:
        logger.warning("Safe Browsing check failed, allowing the URL: %s", exc)
        return False


def ensure_url_is_safe(url: str) -> None:
    reason = assess_url(url)
    if reason is None and flagged_by_safe_browsing(url):
        reason = "Google Safe Browsing flagged this website as unsafe."
    if reason:
        raise HTTPException(status_code=400, detail=reason)


# Link state and serialisation -------------------------------
def link_status(link: Link, now: datetime | None = None) -> str:
    now = now or utcnow()
    if not link.is_active:
        return "disabled"
    if link.expires_at and link.expires_at <= now:
        return "expired"
    if link.max_clicks is not None and link.clicks >= link.max_clicks:
        return "limit_reached"
    return "active"


def direct_url_for(request: Request, short_code: str) -> str:
    """The backend's own redirect URL: it answers with an HTTP 301/302 straight away."""
    if request.url.hostname in LOCAL_HOSTS:
        return f"{request.url.scheme}://{request.url.netloc}/{short_code}"
    return f"{BACKEND_URL}/{short_code}"


def link_to_dict(request: Request, link: Link, now: datetime | None = None) -> dict:
    return {
        "original_url": link.original_url,
        "short_url": short_url_for(request, link.short_code),
        "direct_url": direct_url_for(request, link.short_code),
        "short_code": link.short_code,
        "created_at": iso_utc(link.created_at),
        "clicks": link.clicks or 0,
        "status": link_status(link, now),
        "is_active": bool(link.is_active),
        "is_archived": bool(link.is_archived),
        "expires_at": iso_utc(link.expires_at),
        "max_clicks": link.max_clicks,
        "redirect_type": link.redirect_type or 302,
        "has_password": bool(link.password_hash),
        "folder": link.folder,
        "tags": tags_from_db(link.tags),
    }


# Visitor details ----------------------------------------------
def parse_user_agent(user_agent: str | None) -> tuple[str, str, str]:
    """Return (device, browser, operating system) from a User-Agent string, without extra packages."""
    ua = (user_agent or "")[:300]
    if not ua.strip():
        return "Unknown", "Unknown", "Unknown"
    low = ua.lower()
    if any(word in low for word in ("bot", "crawler", "spider", "slurp", "preview", "curl/", "wget", "python-", "headless")):
        device = "Bot"
    elif "ipad" in low or "tablet" in low or ("android" in low and "mobile" not in low):
        device = "Tablet"
    elif "mobi" in low or "iphone" in low or "android" in low:
        device = "Mobile"
    else:
        device = "Desktop"
    if "edg/" in low or "edga/" in low or "edgios/" in low:
        browser = "Edge"
    elif "opr/" in low or "opera" in low:
        browser = "Opera"
    elif "samsungbrowser" in low:
        browser = "Samsung Internet"
    elif "firefox/" in low or "fxios" in low:
        browser = "Firefox"
    elif "chrome/" in low or "crios" in low:
        browser = "Chrome"
    elif "safari/" in low:
        browser = "Safari"
    else:
        browser = "Other"
    if "windows" in low:
        os_name = "Windows"
    elif "android" in low:
        os_name = "Android"
    elif "iphone" in low or "ipad" in low or "ipod" in low:
        os_name = "iOS"
    elif "mac os x" in low or "macintosh" in low:
        os_name = "macOS"
    elif "cros" in low:
        os_name = "ChromeOS"
    elif "linux" in low:
        os_name = "Linux"
    else:
        os_name = "Other"
    return device, browser, os_name


def referrer_host(value: str | None) -> str | None:
    """Reduce a referrer URL to its host. Visits from this app itself count as direct."""
    if not value:
        return None
    host = (urlparse(value.strip()[:500]).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    own = {urlparse(url).hostname for url in (FRONTEND_URL, BACKEND_URL, DEFAULT_FRONTEND_URL)}
    if not host or host in own or host in LOCAL_HOSTS:
        return None
    return host[:120]


def edge_country(request: Request) -> str | None:
    code = (request.headers.get("cf-ipcountry") or "").strip().upper()
    return code if re.fullmatch(r"[A-Z]{2}", code) and code not in {"XX", "T1"} else None


_country_cache: dict[str, tuple[float, str | None]] = {}
_country_lock = threading.Lock()


def lookup_country(ip: str) -> str | None:
    """Two-letter country code for a public IP, using a free lookup service (cached for a day)."""
    if GEO_LOOKUP_DISABLED or not ip:
        return None
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if not address.is_global:
        return None
    now = time.monotonic()
    with _country_lock:
        cached = _country_cache.get(ip)
        if cached and now - cached[0] < 86_400:
            return cached[1]
    country = None
    try:
        request = urllib.request.Request(
            GEO_LOOKUP_URL.format(ip=ip),
            headers={"User-Agent": "LinkShortener/2.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            data = json.loads(response.read().decode("utf-8"))
        code = str(data.get("country") or data.get("countryCode") or data.get("country_code") or "").upper()
        country = code if re.fullmatch(r"[A-Z]{2}", code) else None
    except Exception as exc:
        logger.info("Country lookup failed: %s", exc)
    with _country_lock:
        if len(_country_cache) > 5000:
            _country_cache.clear()
        _country_cache[ip] = (now, country)
    return country


def log_click_event(link_id: int, clicked_at: datetime, referrer: str | None, user_agent: str | None,
                    ip: str, country: str | None) -> None:
    """Store the details of one click. Runs after the redirect has been sent, so it never slows it down."""
    try:
        device, browser, os_name = parse_user_agent(user_agent)
        db = SessionLocal()
        try:
            db.add(ClickEvent(
                link_id=link_id,
                created_at=clicked_at,
                referrer=referrer,
                device=device,
                browser=browser,
                os=os_name,
                country=country or lookup_country(ip),
            ))
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("Could not record click event for link %s", link_id)

# --------------------------------------------------
# HOME
# --------------------------------------------------

@app.get("/", tags=["Meta"], summary="Health check")
def home():
    return {
        "message": "LinkShortener is running!"
    }

# --------------------------------------------------
# ACCOUNTS
# --------------------------------------------------

@app.post("/auth/register", tags=["Auth"], dependencies=[Depends(rate_limit("register", 5))])
def register_account(data: AccountRequest):
    email = normalize_email(data.email)
    db = SessionLocal()
    try:
        if db.query(User).filter(User.email == email).first():
            raise HTTPException(status_code=409, detail="An account with this email already exists.")
        user = User(email=email, password_hash=hash_password(data.password))
        db.add(user)
        try:
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(
                status_code=409,
                detail="An account with this email already exists.",
            ) from error
        db.refresh(user)
        token = verification_token(db, user)
        db.commit()
        try:
            send_verification_email(email, token)
        except Exception as error:
            logger.exception("Unable to send email verification to %s: %s", email, error)
            db.query(EmailVerification).filter(
                EmailVerification.user_id == user.id
            ).delete(synchronize_session=False)
            db.delete(user)
            db.commit()
            raise HTTPException(
                status_code=503,
                detail=f"Unable to send verification email: {str(error) or 'connection failed'}",
            ) from error
        return {"message": "Check your inbox for a verification link. It expires in 24 hours."}
    finally:
        db.close()


@app.post("/auth/login", tags=["Auth"], dependencies=[Depends(rate_limit("login", 10))])
def login_account(data: AccountRequest):
    email = normalize_email(data.email)
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if not user or not password_matches(data.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Email or password is incorrect.")
        if not user.is_verified:
            raise HTTPException(
                status_code=403,
                detail="Please verify your email before signing in. You can resend the verification link.",
            )
        return account_response(user, create_auth_token(db, user))
    finally:
        db.close()


@app.post("/auth/resend-verification", tags=["Auth"], dependencies=[Depends(rate_limit("resend", 5))])
def resend_verification(data: EmailRequest):
    email = normalize_email(data.email)
    generic_response = {
        "message": "If this email belongs to an unverified account, a verification link has been sent."
    }
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if not user or user.is_verified:
            return generic_response

        token = verification_token(db, user)
        db.commit()
        try:
            send_verification_email(email, token)
        except Exception as error:
            logger.exception("Unable to resend email verification to %s", email)
            raise HTTPException(
                status_code=503,
                detail="Unable to send the verification email. Please try again later.",
            ) from error
        return generic_response
    finally:
        db.close()


@app.get("/auth/verify", tags=["Auth"])
def verify_email(token: str):
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    db = SessionLocal()
    try:
        verification = db.query(EmailVerification).filter(
            EmailVerification.token_hash == token_hash
        ).first()
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        user = verification and db.query(User).filter(User.id == verification.user_id).first()
        if not verification or verification.expires_at <= now or not user:
            if verification:
                db.delete(verification)
                db.commit()
            # This endpoint is opened from an email, so send the user back to the app
            # instead of showing a raw JSON error.
            return RedirectResponse(f"{FRONTEND_URL}/?verified=0")

        user.is_verified = True
        db.query(EmailVerification).filter(
            EmailVerification.user_id == user.id
        ).delete(synchronize_session=False)
        db.commit()
        return RedirectResponse(f"{FRONTEND_URL}/?verified=1")
    finally:
        db.close()


@app.post("/auth/forgot-password", tags=["Auth"], dependencies=[Depends(rate_limit("forgot", 5))])
def forgot_password(data: EmailRequest):
    email = normalize_email(data.email)
    # Same answer whether or not the account exists, so this can't be used to probe emails.
    generic_response = {
        "message": "If an account exists for this email, a password reset link has been sent. It expires in 1 hour."
    }
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        if not user:
            return generic_response

        token = password_reset_token(db, user)
        db.commit()
        try:
            send_password_reset_email(email, token)
        except Exception as error:
            logger.exception("Unable to send password reset email to %s", email)
            raise HTTPException(
                status_code=503,
                detail="Unable to send the password reset email. Please try again later.",
            ) from error
        return generic_response
    finally:
        db.close()


@app.post("/auth/reset-password", tags=["Auth"], dependencies=[Depends(rate_limit("reset", 10))])
def reset_password(data: PasswordResetRequest):
    token_hash = hashlib.sha256(data.token.encode("utf-8")).hexdigest()
    db = SessionLocal()
    try:
        reset = db.query(PasswordReset).filter(PasswordReset.token_hash == token_hash).first()
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        user = reset and db.query(User).filter(User.id == reset.user_id).first()
        if not reset or reset.expires_at <= now or not user:
            if reset:
                db.delete(reset)
                db.commit()
            raise HTTPException(
                status_code=400,
                detail="This reset link is invalid or expired. Request a new one and try again.",
            )

        user.password_hash = hash_password(data.password)
        # The link was opened from the inbox, which also proves the user owns the email.
        user.is_verified = True
        db.query(PasswordReset).filter(PasswordReset.user_id == user.id).delete(synchronize_session=False)
        db.query(EmailVerification).filter(EmailVerification.user_id == user.id).delete(synchronize_session=False)
        # Sign out every existing session in case the old password was compromised.
        db.query(AuthToken).filter(AuthToken.user_id == user.id).delete(synchronize_session=False)
        db.commit()
        return {"message": "Your password has been changed. You can now sign in."}
    finally:
        db.close()


@app.get("/auth/me", tags=["Auth"])
def current_account(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        return {"id": user.id, "email": user.email}
    finally:
        db.close()


@app.post("/auth/logout", tags=["Auth"])
def logout_account(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    db = SessionLocal()
    try:
        _, session_token = authenticate_token(db, credentials)
        db.delete(session_token)
        db.commit()
        return {"message": "Signed out successfully."}
    finally:
        db.close()

# --------------------------------------------------
# CREATE SHORT URL
# --------------------------------------------------

def guest_key_for(request: Request) -> str:
    """Guests are told apart by a hash of their network address (the address itself is never stored)."""
    return hashlib.sha256(client_ip(request).encode("utf-8")).hexdigest()


def guest_link_count(db, guest_key: str) -> int:
    return db.query(func.count(Link.id)).filter(Link.user_id.is_(None), Link.guest_key == guest_key).scalar() or 0


def create_link(
    db,
    *,
    url: str,
    user: User | None = None,
    guest_key: str | None = None,
    alias: str | None = None,
    expires_at: datetime | None = None,
    max_clicks: int | None = None,
    redirect_type: int = 302,
    password: str | None = None,
    folder: str | None = None,
    tags: list[str] | None = None,
) -> Link:
    ensure_url_is_safe(url)

    same_url = db.query(func.count(Link.id)).filter(Link.original_url == url)
    if user:
        same_url = same_url.filter(Link.user_id == user.id)
    else:
        same_url = same_url.filter(Link.user_id.is_(None), Link.guest_key == guest_key)
    if (same_url.scalar() or 0) >= SAME_URL_LIMIT:
        raise HTTPException(
            status_code=429,
            detail="Limit reached: the same URL can be shortened up to 5 times.",
        )

    fields = dict(
        original_url=url,
        user_id=user.id if user else None,
        guest_key=guest_key,
        expires_at=normalize_expiry(expires_at),
        max_clicks=max_clicks,
        redirect_type=redirect_type,
        password_hash=hash_password(password) if password else None,
        folder=clean_folder(folder),
        tags=tags_to_db(clean_tags(tags)),
    )

    if alias:
        link = Link(short_code=validate_alias(db, alias), **fields)
        db.add(link)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="That alias is already taken.") from None
        return link

    for _ in range(3):
        link = Link(short_code=generate_code(), **fields)
        db.add(link)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if db.query(Link).filter(Link.short_code == link.short_code).first():
                continue
            raise
        return link
    raise HTTPException(
        status_code=503,
        detail="Could not generate a unique short link. Please try again.",
    )


@app.get("/guest-quota", tags=["Links"], summary="Free links left for this visitor")
def guest_quota(request: Request):
    db = SessionLocal()
    try:
        used = guest_link_count(db, guest_key_for(request))
        return {"limit": GUEST_LINK_LIMIT, "used": used, "remaining": max(0, GUEST_LINK_LIMIT - used)}
    finally:
        db.close()


@app.post("/shorten", tags=["Links"], summary="Create a short link",
          dependencies=[Depends(rate_limit("shorten", 30))])
def shorten_url(
    data: URLRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    """Guests can create a limited number of plain links; signed-in users also get the options."""
    db = SessionLocal()
    try:
        user = None
        if credentials:
            user, _ = authenticate_token(db, credentials)

        if user is not None:
            link = create_link(
                db,
                url=str(data.url),
                user=user,
                alias=data.alias,
                expires_at=data.expires_at,
                max_clicks=data.max_clicks,
                redirect_type=data.redirect_type,
                password=data.password,
                folder=data.folder,
                tags=data.tags,
            )
            return link_to_dict(request, link)

        uses_options = bool(
            data.alias or data.expires_at or data.max_clicks or data.password
            or data.folder or data.tags or data.redirect_type != 302
        )
        if uses_options:
            raise HTTPException(
                status_code=401,
                detail="Sign in to use custom aliases, expiry, passwords, tags and other link options.",
            )

        guest_key = guest_key_for(request)
        used = guest_link_count(db, guest_key)
        if used >= GUEST_LINK_LIMIT:
            return JSONResponse(
                status_code=403,
                content={
                    "detail": (
                        f"You've used your {GUEST_LINK_LIMIT} free links. "
                        "Sign in or create an account to keep shortening."
                    ),
                    "code": "guest_limit",
                    "limit": GUEST_LINK_LIMIT,
                    "used": used,
                },
            )

        link = create_link(db, url=str(data.url), guest_key=guest_key)
        result = link_to_dict(request, link)
        result["guest_limit"] = GUEST_LINK_LIMIT
        result["guest_remaining"] = max(0, GUEST_LINK_LIMIT - used - 1)
        return result
    finally:
        db.close()


# --------------------------------------------------
# MY LINKS (signed-in users)
# --------------------------------------------------

def owned_link(db, user: User, short_code: str) -> Link:
    link = db.query(Link).filter(Link.short_code == short_code, Link.user_id == user.id).first()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found.")
    return link


@app.get("/my-links", tags=["Links"], summary="List my links (search, filter, sort)")
def list_account_links(
    request: Request,
    response: Response,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    q: str | None = Query(default=None, max_length=100, description="Search destination, code, folder or tag"),
    status_filter: Literal["all", "active", "disabled", "expired", "limit_reached"] = Query("all", alias="status"),
    archived: Literal["exclude", "only", "all"] = "exclude",
    tag: str | None = Query(default=None, max_length=24),
    folder: str | None = Query(default=None, max_length=40),
    sort: Literal["newest", "oldest", "clicks", "alias", "expiring"] = "newest",
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        now = utcnow()
        query = db.query(Link).filter(Link.user_id == user.id)

        if archived == "exclude":
            query = query.filter(Link.is_archived.is_(False))
        elif archived == "only":
            query = query.filter(Link.is_archived.is_(True))
        if q and q.strip():
            term = q.strip()
            query = query.filter(or_(
                Link.original_url.icontains(term, autoescape=True),
                Link.short_code.icontains(term, autoescape=True),
                Link.folder.icontains(term, autoescape=True),
                Link.tags.icontains(term, autoescape=True),
            ))
        if tag:
            query = query.filter(Link.tags.contains(f",{tag.strip().lower()},", autoescape=True))
        if folder:
            query = query.filter(Link.folder == folder)

        not_expired = or_(Link.expires_at.is_(None), Link.expires_at > now)
        under_limit = or_(Link.max_clicks.is_(None), Link.clicks < Link.max_clicks)
        if status_filter == "active":
            query = query.filter(Link.is_active.is_(True), not_expired, under_limit)
        elif status_filter == "disabled":
            query = query.filter(Link.is_active.is_(False))
        elif status_filter == "expired":
            query = query.filter(Link.is_active.is_(True), Link.expires_at.is_not(None), Link.expires_at <= now)
        elif status_filter == "limit_reached":
            query = query.filter(
                Link.is_active.is_(True), not_expired,
                Link.max_clicks.is_not(None), Link.clicks >= Link.max_clicks,
            )

        total = query.count()
        order = {
            "newest": [Link.id.desc()],
            "oldest": [Link.id.asc()],
            "clicks": [Link.clicks.desc(), Link.id.desc()],
            "alias": [func.lower(Link.short_code).asc()],
            "expiring": [Link.expires_at.is_(None), Link.expires_at.asc(), Link.id.desc()],
        }[sort]
        links = query.order_by(*order).offset(offset).limit(limit).all()
        response.headers["X-Total-Count"] = str(total)
        return [link_to_dict(request, link, now) for link in links]
    finally:
        db.close()


@app.get("/my-links/filters", tags=["Links"], summary="My tags and folders, with counts")
def link_filters(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        tag_counts: Counter = Counter()
        folder_counts: Counter = Counter()
        for tags, folder in db.query(Link.tags, Link.folder).filter(Link.user_id == user.id).all():
            tag_counts.update(tags_from_db(tags))
            if folder:
                folder_counts[folder] += 1
        return {
            "tags": [{"name": name, "count": count} for name, count in sorted(tag_counts.items())],
            "folders": [{"name": name, "count": count} for name, count in sorted(folder_counts.items())],
        }
    finally:
        db.close()


@app.post("/my-links/bulk", tags=["Links"], summary="Delete, archive or enable/disable many links",
          dependencies=[Depends(rate_limit("link-write", 60))])
def bulk_update_links(
    data: BulkAction,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        links = db.query(Link).filter(Link.user_id == user.id, Link.short_code.in_(data.codes)).all()
        found = {link.short_code for link in links}
        if data.action == "delete":
            ids = [link.id for link in links]
            if ids:
                db.query(ClickEvent).filter(ClickEvent.link_id.in_(ids)).delete(synchronize_session=False)
                db.query(Link).filter(Link.id.in_(ids)).delete(synchronize_session=False)
        else:
            for link in links:
                if data.action == "archive":
                    link.is_archived = True
                elif data.action == "unarchive":
                    link.is_archived = False
                elif data.action == "enable":
                    link.is_active = True
                elif data.action == "disable":
                    link.is_active = False
        db.commit()
        return {"affected": len(links), "not_found": [code for code in data.codes if code not in found]}
    finally:
        db.close()


def parse_import_rows(text: str) -> list[dict]:
    rows = [row for row in csv.reader(io.StringIO(text)) if any(cell.strip() for cell in row)]
    if not rows:
        raise HTTPException(status_code=422, detail="The CSV file is empty.")
    fields = ("url", "alias", "tags", "folder")
    header = [cell.strip().lower() for cell in rows[0]]
    if "url" in header:  # first row is a header: columns can be in any order
        index = {name: header.index(name) for name in fields if name in header}
        rows = rows[1:]
    else:  # no header: url, alias, tags, folder
        index = {name: position for position, name in enumerate(fields)}
    if len(rows) > MAX_CSV_ROWS:
        raise HTTPException(status_code=422, detail=f"Too many rows: the limit is {MAX_CSV_ROWS} per upload.")

    def cell(row: list[str], name: str) -> str:
        position = index.get(name)
        return row[position].strip() if position is not None and position < len(row) else ""

    return [
        {
            "url": cell(row, "url"),
            "alias": cell(row, "alias") or None,
            "tags": [tag for tag in re.split(r"[;|]", cell(row, "tags")) if tag.strip()],
            "folder": cell(row, "folder") or None,
        }
        for row in rows
    ]


@app.post("/my-links/import", tags=["Links"], summary="Create many links from CSV text",
          dependencies=[Depends(rate_limit("import", 10))])
def import_links(
    data: ImportRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    """CSV columns: `url`, optional `alias`, `tags` (separated by `;`) and `folder`. Up to 100 rows."""
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        results = []
        for number, row in enumerate(parse_import_rows(data.csv), start=1):
            try:
                try:
                    url = str(TypeAdapter(HttpUrl).validate_python(row["url"]))
                except ValidationError:
                    raise HTTPException(status_code=422, detail="Not a valid http(s) URL.") from None
                link = create_link(db, url=url, user=user, alias=row["alias"], folder=row["folder"], tags=row["tags"])
                results.append({"row": number, "ok": True, **link_to_dict(request, link)})
            except HTTPException as error:
                db.rollback()
                results.append({"row": number, "ok": False, "original_url": row["url"], "error": error.detail})
        created = sum(1 for result in results if result["ok"])
        return {"created": created, "failed": len(results) - created, "results": results}
    finally:
        db.close()


@app.patch("/my-links/{short_code}", tags=["Links"], summary="Edit a link",
           dependencies=[Depends(rate_limit("link-write", 60))])
def update_link(
    short_code: str,
    data: LinkUpdate,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    """Change the destination, alias, expiry, click limit, redirect type, password, folder, tags or state."""
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        link = owned_link(db, user, short_code)
        sent = data.model_fields_set
        for required in ("url", "alias", "redirect_type", "is_active", "is_archived"):
            if required in sent and getattr(data, required) is None:
                raise HTTPException(status_code=422, detail=f"{required} cannot be empty.")

        if "url" in sent:
            new_url = str(data.url)
            ensure_url_is_safe(new_url)
            link.original_url = new_url
        if "alias" in sent and data.alias.strip() != link.short_code:
            link.short_code = validate_alias(db, data.alias, exclude_id=link.id)
        if "expires_at" in sent:
            link.expires_at = normalize_expiry(data.expires_at)
        if "max_clicks" in sent:
            link.max_clicks = data.max_clicks
        if "redirect_type" in sent:
            link.redirect_type = data.redirect_type
        if "password" in sent:
            link.password_hash = hash_password(data.password) if data.password else None
        if "folder" in sent:
            link.folder = clean_folder(data.folder)
        if "tags" in sent:
            link.tags = tags_to_db(clean_tags(data.tags))
        if "is_active" in sent:
            link.is_active = data.is_active
        if "is_archived" in sent:
            link.is_archived = data.is_archived
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="That alias is already taken.") from None
        db.refresh(link)
        return link_to_dict(request, link)
    finally:
        db.close()


@app.delete("/my-links/{short_code}", tags=["Links"], summary="Delete a link and its statistics",
            dependencies=[Depends(rate_limit("link-write", 60))])
def delete_link(short_code: str, credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        link = owned_link(db, user, short_code)
        db.query(ClickEvent).filter(ClickEvent.link_id == link.id).delete(synchronize_session=False)
        db.delete(link)
        db.commit()
        return {"deleted": short_code}
    finally:
        db.close()


# --------------------------------------------------
# ANALYTICS
# --------------------------------------------------

def csv_safe(value) -> str:
    """Stop spreadsheet programs from running a cell that starts with = + - @ as a formula."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


@app.get("/my-links/{short_code}/analytics", tags=["Analytics"], summary="Click statistics for one link")
def get_link_analytics(
    short_code: str,
    days: int = Query(default=7, ge=1, le=90),
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        link = owned_link(db, user, short_code)

        today = utcnow().date()
        first_day = today - timedelta(days=days - 1)
        window = (
            ClickEvent.link_id == link.id,
            ClickEvent.created_at >= datetime.combine(first_day, datetime.min.time()),
        )
        day_column = func.date(ClickEvent.created_at)
        per_day = {
            str(day)[:10]: count
            for day, count in db.query(day_column, func.count()).filter(*window).group_by(day_column).all()
        }
        clicks_by_day = [
            {"date": (first_day + timedelta(days=offset)).isoformat(),
             "clicks": per_day.get((first_day + timedelta(days=offset)).isoformat(), 0)}
            for offset in range(days)
        ]

        def breakdown(column, empty_label: str, top: int = 8) -> list[dict]:
            rows = (
                db.query(column, func.count().label("n"))
                .filter(*window)
                .group_by(column)
                .order_by(func.count().desc())
                .limit(top)
                .all()
            )
            return [{"name": value or empty_label, "clicks": count} for value, count in rows]

        return {
            "short_code": link.short_code,
            "total_clicks": link.clicks,
            "days": days,
            "period_clicks": sum(day["clicks"] for day in clicks_by_day),
            "clicks_by_day": clicks_by_day,
            "referrers": breakdown(ClickEvent.referrer, "Direct"),
            "devices": breakdown(ClickEvent.device, "Unknown"),
            "browsers": breakdown(ClickEvent.browser, "Unknown"),
            "operating_systems": breakdown(ClickEvent.os, "Unknown"),
            "countries": breakdown(ClickEvent.country, "Unknown"),
        }
    finally:
        db.close()


@app.get("/my-links/{short_code}/analytics/export", tags=["Analytics"], summary="Download click events as CSV")
def export_link_analytics(
    short_code: str,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        link = owned_link(db, user, short_code)
        events = (
            db.query(ClickEvent)
            .filter(ClickEvent.link_id == link.id)
            .order_by(ClickEvent.created_at.desc())
            .limit(50_000)
            .all()
        )
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["timestamp_utc", "referrer", "device", "browser", "os", "country"])
        for event in events:
            writer.writerow([
                event.created_at.strftime("%Y-%m-%d %H:%M:%S"),
                csv_safe(event.referrer or "Direct"),
                csv_safe(event.device),
                csv_safe(event.browser),
                csv_safe(event.os),
                csv_safe(event.country),
            ])
        return Response(
            content=buffer.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{link.short_code}-analytics.csv"'},
        )
    finally:
        db.close()


@app.get("/stats", tags=["Meta"], summary="Public statistics")
def get_public_stats(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    db = SessionLocal()
    try:
        user = None
        if credentials:
            try:
                user = authenticate_token(db, credentials)[0]
            except HTTPException:
                # Public stats still load with a stale or revoked token; the frontend
                # clears that token when /auth/me rejects it.
                pass
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        today = now.date()
        week_start = datetime.combine(today - timedelta(days=6), datetime.min.time())
        events = db.query(ClickEvent).filter(ClickEvent.created_at >= week_start).all()
        daily_clicks = {today - timedelta(days=offset): 0 for offset in range(6, -1, -1)}
        for event in events:
            event_day = event.created_at.date()
            if event_day in daily_clicks:
                daily_clicks[event_day] += 1

        top_links = []
        if user:
            top_links = (
                db.query(Link)
                .filter(Link.user_id == user.id, Link.clicks > 0)
                .order_by(Link.clicks.desc(), Link.id.desc())
                .limit(5)
                .all()
            )
        return {
            "total_links": db.query(func.count(Link.id)).scalar() or 0,
            "total_users": db.query(func.count(User.id)).filter(User.is_verified.is_(True)).scalar() or 0,
            "total_clicks": db.query(func.coalesce(func.sum(Link.clicks), 0)).scalar() or 0,
            "clicks_by_day": [
                {"date": day.isoformat(), "clicks": count}
                for day, count in daily_clicks.items()
            ],
            "top_links": [
                {
                    "short_code": link.short_code,
                    "original_url": link.original_url,
                    "clicks": link.clicks,
                }
                for link in top_links
            ],
        }
    finally:
        db.close()

# --------------------------------------------------
# REDIRECT
# --------------------------------------------------

PAGE_STYLE = """
:root{color-scheme:light dark;--bg:#04080f;--card:#0b1430;--text:#e8f0ff;--muted:#8aa0c4;--line:#26355f;--accent:#2f6bff}
@media (prefers-color-scheme:light){:root{--bg:#f4f7fc;--card:#fff;--text:#172844;--muted:#5b6b88;--line:#d6deee}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);
color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(100%,440px);padding:36px 28px;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:18px}
h1{margin:0 0 8px;font-size:24px}p{margin:0 0 20px;color:var(--muted)}
a.btn,button{display:inline-block;padding:12px 22px;border:0;border-radius:10px;background:var(--accent);color:#fff;
font:600 15px system-ui,sans-serif;text-decoration:none;cursor:pointer}
input{width:100%;margin-bottom:14px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:transparent;
color:inherit;font:16px system-ui,sans-serif}[role=alert]{margin-top:14px;color:#ff6b8a;min-height:1.4em}
"""

STATUS_PAGES = {
    "not_found": (404, "Link not found", "Short URL not found."),
    "disabled": (410, "This link is turned off", "The owner has disabled this link."),
    "expired": (410, "This link has expired", "This link passed its expiry date and no longer redirects."),
    "limit_reached": (410, "This link is used up", "This link reached its maximum number of clicks."),
}


def render_page(title: str, body: str) -> str:
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{html_lib.escape(title)}</title><style>{PAGE_STYLE}</style></head>"
        f'<body><main class="card">{body}</main></body></html>'
    )


def inactive_response(request: Request, code: str, as_json: bool = False) -> Response:
    status_code, title, message = STATUS_PAGES[code]
    if as_json or "text/html" not in request.headers.get("accept", ""):
        return JSONResponse(status_code=status_code, content={"detail": message, "code": code})
    body = (
        f"<h1>{html_lib.escape(title)}</h1><p>{html_lib.escape(message)}</p>"
        f'<a class="btn" href="{html_lib.escape(FRONTEND_URL)}">Go to LinkShortener</a>'
    )
    return HTMLResponse(render_page(title, body), status_code=status_code)


UNLOCK_SCRIPT = """
const code = __CODE__;
const form = document.getElementById("f"), input = document.getElementById("p"), error = document.getElementById("e");
form.addEventListener("submit", async (event) => {
  event.preventDefault(); error.textContent = "";
  try {
    const response = await fetch("/resolve/" + encodeURIComponent(code), {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({password: input.value})});
    const data = await response.json();
    if (!response.ok) { error.textContent = data.detail || "Something went wrong."; return; }
    window.location.replace(data.original_url);
  } catch (problem) { error.textContent = "Unable to reach the server. Please try again."; }
});
"""


def password_page(short_code: str) -> HTMLResponse:
    body = (
        "<h1>This link is protected</h1><p>Enter the password to continue.</p>"
        '<form id="f"><input id="p" type="password" placeholder="Password" required autofocus autocomplete="off">'
        '<button type="submit">Open link</button></form><p id="e" role="alert"></p>'
        "<script>" + UNLOCK_SCRIPT.replace("__CODE__", json.dumps(short_code)) + "</script>"
    )
    return HTMLResponse(render_page("Password required", body))


def register_click(db, link_id: int) -> bool:
    """Count the click atomically, and only while the link is still usable (active, not expired, under its limit)."""
    now = utcnow()
    result = db.execute(
        update(Link)
        .where(
            Link.id == link_id,
            Link.is_active.is_(True),
            or_(Link.expires_at.is_(None), Link.expires_at > now),
            or_(Link.max_clicks.is_(None), Link.clicks < Link.max_clicks),
        )
        .values(clicks=Link.clicks + 1)
    )
    db.commit()
    return result.rowcount == 1


def visit(request: Request, background_tasks: BackgroundTasks, short_code: str, ref: str | None,
          password: str | None, as_json: bool):
    """Shared by every way of following a link. Returns (response, None) on failure or (None, link) to redirect."""
    db = SessionLocal()
    try:
        link = db.query(Link).filter(Link.short_code == short_code).first()
        if not link:
            return inactive_response(request, "not_found", as_json), None
        state = link_status(link)
        if state != "active":
            return inactive_response(request, state, as_json), None
        if link.password_hash:
            if password is None:
                if as_json or "text/html" not in request.headers.get("accept", ""):
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "This link is password protected.", "code": "password_required"},
                    ), None
                return password_page(short_code), None
            if not password_matches(password, link.password_hash):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Incorrect password.", "code": "wrong_password"},
                ), None
        link_id, destination, redirect_type = link.id, link.original_url, link.redirect_type or 302
        if not register_click(db, link_id):  # became unusable between the check and the count
            db.refresh(link)
            state = link_status(link)
            return inactive_response(request, state if state != "active" else "limit_reached", as_json), None
        background_tasks.add_task(
            log_click_event,
            link_id,
            utcnow(),
            referrer_host(ref if ref is not None else request.headers.get("referer")),
            request.headers.get("user-agent"),
            client_ip(request),
            edge_country(request),
        )
        return None, (destination, redirect_type)
    finally:
        db.close()


@app.get("/resolve/{short_code}", tags=["Redirect"], summary="Resolve a short code (used by the web app)",
         dependencies=[Depends(rate_limit("resolve", 120))])
def resolve_short_url(
    short_code: str,
    request: Request,
    background_tasks: BackgroundTasks,
    ref: str | None = Query(default=None, max_length=500, description="Where the visitor came from"),
):
    failure, target = visit(request, background_tasks, short_code, ref, None, as_json=True)
    return failure if failure is not None else {"original_url": target[0]}


@app.post("/resolve/{short_code}", tags=["Redirect"], summary="Resolve a password-protected link",
          dependencies=[Depends(rate_limit("unlock", 10))])
def unlock_short_url(
    short_code: str,
    data: UnlockRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    ref: str | None = Query(default=None, max_length=500),
):
    failure, target = visit(request, background_tasks, short_code, ref, data.password, as_json=True)
    return failure if failure is not None else {"original_url": target[0]}


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


@app.get("/{short_code}", tags=["Redirect"], summary="Follow a short link (HTTP 301/302 redirect)",
         dependencies=[Depends(rate_limit("redirect", 120))])
def redirect_to_original(short_code: str, request: Request, background_tasks: BackgroundTasks):
    failure, target = visit(request, background_tasks, short_code, None, None, as_json=False)
    if failure is not None:
        return failure
    return RedirectResponse(url=target[0], status_code=target[1])
