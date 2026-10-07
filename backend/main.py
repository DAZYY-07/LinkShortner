import os
from dotenv import load_dotenv

load_dotenv()
import hashlib
import hmac
import logging
import re
import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import urlencode
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
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------
# DATABASE
# --------------------------------------------------

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./links.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}
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
            "ALTER TABLE users ADD COLUMN is_verified BOOLEAN NOT NULL DEFAULT 0"
        )
    if "user_id" not in link_columns:
        connection.exec_driver_sql(
            "ALTER TABLE links ADD COLUMN user_id INTEGER REFERENCES users(id)"
        )
    if "guest_key" not in link_columns:
        connection.exec_driver_sql("ALTER TABLE links ADD COLUMN guest_key VARCHAR")
    if "created_at" not in link_columns:
        connection.exec_driver_sql("ALTER TABLE links ADD COLUMN created_at DATETIME")
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


def send_verification_email(email: str, token: str) -> None:
    host = os.getenv("SMTP_HOST", "").strip()
    sender = os.getenv("SMTP_FROM", "").strip()
    verification_url = f"{BACKEND_URL}/auth/verify?{urlencode({'token': token})}"

    if not host or not sender:
        print("\n" + "=" * 60)
        print(" [DEV MODE] EMAIL VERIFICATION LINK:")
        print(f" To: {email}")
        print(f" Verify URL: {verification_url}")
        print("=" * 60 + "\n")
        logger.info("Dev mode verification link: %s", verification_url)
        return

    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    message = EmailMessage()
    message["Subject"] = "Verify your LinkShortener email"
    message["From"] = sender
    message["To"] = email
    message.set_content(
        "Verify your LinkShortener account by opening this link within 24 hours:\n\n"
        f"{verification_url}\n\n"
        "If you did not request this account, you can ignore this email."
    )
    message.add_alternative(
        "<p>Verify your LinkShortener account by clicking the button below. "
        "This link expires in 24 hours.</p>"
        f'<p><a href="{verification_url}">Verify my email</a></p>'
        "<p>If you did not request this account, you can ignore this email.</p>",
        subtype="html",
    )

    context = ssl.create_default_context()
    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=15) as smtp:
                if username and password:
                    smtp.login(username, password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=15) as smtp:
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
                if username and password:
                    smtp.login(username, password)
                smtp.send_message(message)
    except Exception as exc:
        logger.error("Failed sending email via %s:%s for %s: %s", host, port, email, exc)
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


def short_url_for(request: Request, short_code: str) -> str:
    host = request.url.hostname
    if host in {"localhost", "127.0.0.1", "::1"}:
        local_host = f"[{host}]" if ":" in host else host
        base_url = f"{request.url.scheme}://{local_host}:5173"
    else:
        base_url = FRONTEND_URL
    return f"{base_url}/?{urlencode({'r': short_code})}"

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
        except (smtplib.SMTPException, OSError, ValueError) as error:
            logger.exception("Unable to send email verification to %s", email)
            db.query(EmailVerification).filter(
                EmailVerification.user_id == user.id
            ).delete(synchronize_session=False)
            db.delete(user)
            db.commit()
            raise HTTPException(
                status_code=503,
                detail="Unable to send the verification email. Please try again later.",
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
        except (smtplib.SMTPException, OSError, ValueError) as error:
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
        if not verification or verification.expires_at <= now:
            if verification:
                db.delete(verification)
                db.commit()
            raise HTTPException(
                status_code=400,
                detail="This verification link is invalid or expired. Request a new one and try again.",
            )

        user = db.query(User).filter(User.id == verification.user_id).first()
        if not user:
            raise HTTPException(status_code=400, detail="This verification link is no longer valid.")
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
            client_host = request.client.host if request.client else "unknown"
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
        user = authenticate_token(db, credentials)[0] if credentials else None
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
