from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.orm import declarative_base, sessionmaker
import secrets
import string

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    short_code = Column(String, unique=True, index=True, nullable=False)


Base.metadata.create_all(bind=engine)


class URLRequest(BaseModel):
    url: str


def generate_code(length=6):
    characters = string.ascii_letters + string.digits
    return "".join(secrets.choice(characters) for _ in range(length))


@app.get("/")
def home():
    return {"message": "LinkSnip-AI URL Shortener is running!"}


@app.post("/shorten")
def shorten_url(data: URLRequest):

    db = SessionLocal()

    try:
        short_code = generate_code()

        while db.query(Link).filter(
            Link.short_code == short_code
        ).first():
            short_code = generate_code()

        link = Link(
            original_url=data.url,
            short_code=short_code
        )

        db.add(link)
        db.commit()
        db.refresh(link)

        return {
            "original_url": data.url,
            "short_url": f"http://localhost:8000/{short_code}",
            "short_code": short_code
        }

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
            return {"error": "Short URL not found."}

        return RedirectResponse(url=link.original_url)

    finally:
        db.close()