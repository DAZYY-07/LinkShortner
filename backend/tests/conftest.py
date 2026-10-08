"""Test setup: a throw-away SQLite database and no network access, configured before the app is imported."""
import itertools
import os
import pathlib
import sys
import tempfile
import uuid

import pytest

_database = pathlib.Path(tempfile.mkdtemp()) / "test.db"
os.environ.update({
    # Set TEST_DATABASE_URL to run the same tests against PostgreSQL.
    "DATABASE_URL": os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_database.as_posix()}",
    "RATE_LIMIT_DISABLED": "1",
    "SHORT_LINK_STYLE": "query",  # tests switch to path style where they need it; no network probes
    "GEO_LOOKUP_DISABLED": "1",
    "FRONTEND_URL": "http://frontend.test",
    "BACKEND_URL": "http://backend.test",
    # Empty values stop backend/.env from supplying real email or API credentials.
    "SMTP_HOST": "", "SMTP_FROM": "", "EMAIL_FROM": "",
    "GMAIL_SCRIPT_URL": "", "GMAIL_SCRIPT_SECRET": "", "SAFE_BROWSING_API_KEY": "",
})
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="session")
def client():
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def sent_emails(monkeypatch):
    """Collect (recipient, link) pairs instead of sending email."""
    captured = []
    monkeypatch.setattr(main, "send_email", lambda email, subject, text, html, dev_link: captured.append((email, dev_link)))
    return captured


_ips = itertools.count(1)


@pytest.fixture
def guest():
    """Headers for a guest on its own network address, so tests don't share the guest limit."""
    n = next(_ips)
    return {"X-Forwarded-For": f"203.0.{n // 250}.{n % 250 + 1}"}


@pytest.fixture
def make_user(client, sent_emails):
    def create(password="correct-horse-1"):
        email = f"user-{uuid.uuid4().hex[:10]}@example.com"
        assert client.post("/auth/register", json={"email": email, "password": password}).status_code == 200
        link = sent_emails[-1][1]
        assert client.get(link.replace("http://backend.test", ""), follow_redirects=False).status_code == 307
        token = client.post("/auth/login", json={"email": email, "password": password}).json()["access_token"]
        return {"email": email, "password": password, "headers": {"Authorization": f"Bearer {token}"}}

    return create


@pytest.fixture
def user(make_user):
    return make_user()


def database():
    return main.SessionLocal()
