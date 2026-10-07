import os
from dotenv import load_dotenv

load_dotenv()
import hashlib
import hmac
import json
import logging
import re
import smtplib
import ssl
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import parseaddr
from urllib.parse import urlencode, urlparse
from fastapi import FastAPI, HTTPException, Request
from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, HttpUrl, Field
from sqlalchemy import Boolean, create_engine, Column, DateTime, ForeignKey, Integer, String, func, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime, timedelta, timezone
import secrets
import string

logger = logging.getLogger(__name__)
app = FastAPI()

DEFAULT_FRONTEND_URL = "https://linkshortner-1-ex3g.onrender.com"
FRONTEND_URL = (
    os.getenv("FRONTEND_URL") or DEFAULT_FRONTEND_URL
).strip().rstrip("/")
BACKEND_URL = os.getenv(
    "BACKEND_URL",
    "https://linkshortner-backend-uwgj.onrender.com",
).strip().rstrip("/")

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
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    guest_key = Column(String, index=True, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    clicks = Column(Integer, nullable=False, default=0)


class ClickEvent(Base):
    __tablename__ = "click_events"

    id = Column(Integer, primary_key=True, index=True)
    link_id = Column(Integer, ForeignKey("links.id"), nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)


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


class AuthToken(Base):
    __tablename__ = "auth_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)


Base.metadata.create_all(bind=engine)

# Keep existing databases usable as the account feature adds ownership columns.
link_columns = {column["name"] for column in inspect(engine).get_columns("links")}
with engine.begin() as connection:
    user_columns = {column["name"] for column in inspect(engine).get_columns("users")}
    if "is_verified" not in user_columns:
        connection.exec_driver_sql(
            "ALTER TABLE users ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT FALSE"
        )
    if "user_id" not in link_columns:
        connection.exec_driver_sql(
            "ALTER TABLE links ADD COLUMN user_id INTEGER REFERENCES users(id)"
        )
    if "guest_key" not in link_columns:
        connection.exec_driver_sql("ALTER TABLE links ADD COLUMN guest_key VARCHAR")
    if "created_at" not in link_columns:
        connection.exec_driver_sql("ALTER TABLE links ADD COLUMN created_at TIMESTAMP")
    if "clicks" not in link_columns:
        connection.exec_driver_sql(
            "ALTER TABLE links ADD COLUMN clicks INTEGER NOT NULL DEFAULT 0"
        )

# --------------------------------------------------
# REQUEST MODEL
# --------------------------------------------------

class URLRequest(BaseModel):
    url: HttpUrl


class AccountRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=128)


class EmailRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)


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


def send_verification_email(email: str, token: str) -> None:
    script_url = os.getenv("GMAIL_SCRIPT_URL", "").strip()
    script_secret = os.getenv("GMAIL_SCRIPT_SECRET", "").strip()
    host = os.getenv("SMTP_HOST", "").strip()
    sender = (os.getenv("EMAIL_FROM") or os.getenv("SMTP_FROM", "")).strip()
    verification_url = f"{BACKEND_URL}/auth/verify?{urlencode({'token': token})}"
    use_script = bool(script_url and script_secret)

    if not use_script and not (host and sender):
        print("\n" + "=" * 60)
        print(" [DEV MODE] EMAIL VERIFICATION LINK:")
        print(f" To: {email}")
        print(f" Verify URL: {verification_url}")
        print("=" * 60 + "\n")
        logger.info("Dev mode verification link: %s", verification_url)
        return

    subject = "Verify your LinkShortener email"
    text = (
        "Verify your LinkShortener account by opening this link within 24 hours:\n\n"
        f"{verification_url}\n\n"
        "If you did not request this account, you can ignore this email."
    )
    html = (
        "<p>Verify your LinkShortener account by clicking the button below. "
        "This link expires in 24 hours.</p>"
        f'<p><a href="{verification_url}">Verify my email</a></p>'
        "<p>If you did not request this account, you can ignore this email.</p>"
    )

    provider = "Gmail script" if use_script else f"SMTP {host}"
    try:
        if use_script:
            send_with_gmail_script(script_url, script_secret, sender, email, subject, text, html)
        else:
            send_with_smtp(host, sender, email, subject, text, html)
    except Exception as exc:
        logger.error("Failed sending email via %s for %s: %s", provider, email, exc)
        raise


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
# HOME
# --------------------------------------------------

@app.get("/")
def home():
    return {
        "message": "LinkShortener is running!"
    }

# --------------------------------------------------
# ACCOUNTS
# --------------------------------------------------

@app.post("/auth/register")
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


@app.post("/auth/login")
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


@app.post("/auth/resend-verification")
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


@app.get("/auth/verify")
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


@app.get("/auth/me")
def current_account(credentials: HTTPAuthorizationCredentials | None = Depends(security)):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        return {"id": user.id, "email": user.email}
    finally:
        db.close()


@app.post("/auth/logout")
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

@app.post("/shorten")
def shorten_url(
    data: URLRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):

    db = SessionLocal()

    try:
        user = None
        if credentials:
            user, _ = authenticate_token(db, credentials)

        guest_key = None
        if user is None:
            client_host = client_ip(request)
            guest_key = hashlib.sha256(client_host.encode("utf-8")).hexdigest()

        existing_links = db.query(Link).filter(
            Link.original_url == str(data.url)
        )
        if user:
            existing_links = existing_links.filter(Link.user_id == user.id)
        else:
            existing_links = existing_links.filter(
                Link.user_id.is_(None),
                Link.guest_key == guest_key,
            )
        if existing_links.count() >= 5:
            raise HTTPException(
                status_code=429,
                detail="Limit reached: the same URL can be shortened up to 5 times.",
            )

        for _ in range(3):
            short_code = generate_code()
            link = Link(
                original_url=str(data.url),
                short_code=short_code,
                user_id=user.id if user else None,
                guest_key=guest_key,
            )
            db.add(link)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                if db.query(Link).filter(Link.short_code == short_code).first():
                    continue
                raise
            break
        else:
            raise HTTPException(
                status_code=503,
                detail="Could not generate a unique short link. Please try again.",
            )

        short_url = short_url_for(request, short_code)

        return {
            "original_url": str(data.url),
            "short_url": short_url,
            "short_code": short_code
        }

    finally:
        db.close()


@app.get("/my-links")
def list_account_links(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        links = db.query(Link).filter(Link.user_id == user.id).order_by(Link.id.desc()).limit(100).all()
        return [
            {
                "original_url": link.original_url,
                "short_url": short_url_for(request, link.short_code),
                "short_code": link.short_code,
                "created_at": link.created_at.isoformat() if link.created_at else None,
            }
            for link in links
        ]
    finally:
        db.close()


@app.get("/my-links/{short_code}/analytics")
def get_link_analytics(
    short_code: str,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    db = SessionLocal()
    try:
        user, _ = authenticate_token(db, credentials)
        link = db.query(Link).filter(
            Link.short_code == short_code,
            Link.user_id == user.id,
        ).first()
        if not link:
            raise HTTPException(status_code=404, detail="Link not found.")

        today = datetime.now(timezone.utc).date()
        first_day = today - timedelta(days=6)
        first_event = datetime.combine(first_day, datetime.min.time())
        events = db.query(ClickEvent.created_at).filter(
            ClickEvent.link_id == link.id,
            ClickEvent.created_at >= first_event,
        ).all()
        daily_clicks = {first_day + timedelta(days=offset): 0 for offset in range(7)}
        for (created_at,) in events:
            event_day = created_at.date()
            if event_day in daily_clicks:
                daily_clicks[event_day] += 1

        return {
            "short_code": link.short_code,
            "total_clicks": link.clicks,
            "clicks_by_day": [
                {"date": day.isoformat(), "clicks": count}
                for day, count in daily_clicks.items()
            ],
        }
    finally:
        db.close()


@app.get("/stats")
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

@app.get("/resolve/{short_code}")
def resolve_short_url(short_code: str):
    db = SessionLocal()

    try:
        link = db.query(Link).filter(Link.short_code == short_code).first()
        if not link:
            raise HTTPException(status_code=404, detail="Short URL not found.")

        link.clicks += 1
        db.add(ClickEvent(link_id=link.id))
        db.commit()
        return {"original_url": link.original_url}
    finally:
        db.close()


@app.get("/{short_code}")
def redirect_to_original(short_code: str):

    db = SessionLocal()

    try:

        link = db.query(Link).filter(
            Link.short_code == short_code
        ).first()

        if not link:
            raise HTTPException(status_code=404, detail="Short URL not found.")

        link.clicks += 1
        db.add(ClickEvent(link_id=link.id))
        db.commit()

        return RedirectResponse(
            url=link.original_url
        )

    finally:
        db.close()
