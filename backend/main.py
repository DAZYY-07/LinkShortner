import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, HttpUrl
from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.orm import declarative_base, sessionmaker
import secrets
import string

app = FastAPI()

DEFAULT_FRONTEND_URL = "https://linkshortner-1-ex3g.onrender.com"
FRONTEND_URL = (
    os.getenv("FRONTEND_URL") or DEFAULT_FRONTEND_URL
).strip().rstrip("/")
BACKEND_URL = os.getenv(
    "BACKEND_URL",
    "https://linkshortner-backend-uwgj.onrender.com",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
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

DATABASE_URL = "sqlite:///./links.db"

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


Base.metadata.create_all(bind=engine)

# --------------------------------------------------
# REQUEST MODEL
# --------------------------------------------------

class URLRequest(BaseModel):
    url: HttpUrl

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
        "message": "LinkSnip-AI URL Shortener is running!"
    }

# --------------------------------------------------
# CREATE SHORT URL
# --------------------------------------------------

@app.post("/shorten")
def shorten_url(data: URLRequest):

    db = SessionLocal()

    try:

        short_code = generate_code()

        # Make sure code is unique
        while db.query(Link).filter(
            Link.short_code == short_code
        ).first():

            short_code = generate_code()

        # Save link
        link = Link(
            original_url=str(data.url),
            short_code=short_code
        )

        db.add(link)
        db.commit()
        db.refresh(link)

        # Backend URL used for the generated short link
        short_url = f"{BACKEND_URL}/{short_code}"

        return {
            "original_url": str(data.url),
            "short_url": short_url,
            "short_code": short_code
        }

    finally:
        db.close()

# --------------------------------------------------
# REDIRECT
# --------------------------------------------------

@app.get("/{short_code}")
def redirect_to_original(short_code: str):

    db = SessionLocal()

    try:

        link = db.query(Link).filter(
            Link.short_code == short_code
        ).first()

        if not link:
            raise HTTPException(status_code=404, detail="Short URL not found.")

        return RedirectResponse(
            url=link.original_url
        )

    finally:
        db.close()
