"""Accounts (regression), rate limiting, API docs, public stats and database upgrades."""
import json
import os
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

import main

BACKEND = Path(__file__).resolve().parents[1]


# ── accounts still work ─────────────────────────────────────

def test_register_verify_login_logout(client, sent_emails):
    email = f"flow-{uuid.uuid4().hex[:8]}@example.com"
    assert client.post("/auth/register", json={"email": email, "password": "password-123"}).status_code == 200
    assert client.post("/auth/login", json={"email": email, "password": "password-123"}).status_code == 403  # not verified yet
    client.get(sent_emails[-1][1].replace("http://backend.test", ""), follow_redirects=False)
    token = client.post("/auth/login", json={"email": email, "password": "password-123"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/auth/me", headers=headers).json()["email"] == email
    assert client.post("/auth/logout", headers=headers).status_code == 200
    assert client.get("/auth/me", headers=headers).status_code == 401


def test_wrong_password_and_duplicate_email(client, user):
    assert client.post("/auth/login", json={"email": user["email"], "password": "not-the-password"}).status_code == 401
    assert client.post("/auth/register", json={"email": user["email"], "password": "password-123"}).status_code == 409


def test_password_reset_signs_out_other_sessions(client, user, sent_emails):
    client.post("/auth/forgot-password", json={"email": user["email"]})
    token = sent_emails[-1][1].split("reset=")[1]
    assert client.post("/auth/reset-password", json={"token": token, "password": "brand-new-pass-1"}).status_code == 200
    assert client.get("/auth/me", headers=user["headers"]).status_code == 401
    assert client.post("/auth/reset-password", json={"token": token, "password": "another-pass-22"}).status_code == 400  # single use
    assert client.post("/auth/login", json={"email": user["email"], "password": "brand-new-pass-1"}).status_code == 200


def test_forgot_password_does_not_reveal_which_emails_exist(client):
    known = client.post("/auth/forgot-password", json={"email": "nobody-here@example.com"})
    assert known.status_code == 200 and "If an account exists" in known.json()["message"]


# ── rate limiting ───────────────────────────────────────────

def test_login_is_rate_limited_per_ip(client, monkeypatch):
    monkeypatch.setattr(main, "RATE_LIMIT_DISABLED", False)
    main._rate_hits.clear()
    attacker = {"X-Forwarded-For": "198.51.100.200"}
    statuses = [
        client.post("/auth/login", json={"email": "a@example.com", "password": "wrong-password"}, headers=attacker).status_code
        for _ in range(12)
    ]
    assert statuses[:10] == [401] * 10 and statuses[10:] == [429, 429]
    blocked = client.post("/auth/login", json={"email": "a@example.com", "password": "wrong-password"}, headers=attacker)
    assert int(blocked.headers["retry-after"]) >= 1 and "Too many requests" in blocked.json()["detail"]
    other = client.post("/auth/login", json={"email": "a@example.com", "password": "wrong-password"}, headers={"X-Forwarded-For": "198.51.100.201"})
    assert other.status_code == 401  # a different address isn't affected
    main._rate_hits.clear()


def test_shorten_and_unlock_are_rate_limited(client, monkeypatch):
    monkeypatch.setattr(main, "RATE_LIMIT_DISABLED", False)
    main._rate_hits.clear()
    ip = {"X-Forwarded-For": "198.51.100.210"}
    results = [client.post("/shorten", json={"url": "https://example.com/rl"}, headers=ip).status_code for _ in range(31)]
    assert 429 in results and results.index(429) >= 30 - 5  # guests hit the free-link cap first, then the rate limit
    unlock = [client.post("/resolve/whatever", json={"password": "x"}, headers=ip).status_code for _ in range(12)]
    assert unlock[:10] == [404] * 10 and unlock[10] == 429
    main._rate_hits.clear()


# ── API documentation and public stats ──────────────────────

def test_openapi_documents_every_group_of_endpoints(client):
    spec = client.get("/openapi.json").json()
    assert spec["info"]["title"] == "LinkShortener API"
    paths = spec["paths"]
    assert set(paths["/my-links/{short_code}"]) == {"patch", "delete"}
    for path in ("/shorten", "/my-links", "/my-links/bulk", "/my-links/import", "/my-links/filters", "/guest-quota",
                 "/my-links/{short_code}/analytics", "/my-links/{short_code}/analytics/export", "/resolve/{short_code}", "/{short_code}"):
        assert path in paths, path
    tags = {tag for operations in paths.values() for operation in operations.values() for tag in operation["tags"]}
    assert tags == {"Auth", "Links", "Analytics", "Redirect", "Meta"}
    assert client.get("/docs").status_code == 200


def test_public_stats_and_health_still_work(client, user):
    assert client.get("/").json() == {"message": "LinkShortener is running!"}
    stats = client.get("/stats").json()
    assert {"total_links", "total_users", "total_clicks", "clicks_by_day", "top_links"} <= stats.keys()
    assert client.get("/stats", headers={"Authorization": "Bearer stale"}).status_code == 200


def test_favicon_has_no_content(client):
    assert client.get("/favicon.ico").status_code == 204


# ── upgrading an existing database ──────────────────────────

def test_old_database_is_upgraded_in_place_without_losing_data(tmp_path):
    database = tmp_path / "old.db"
    with sqlite3.connect(database) as old:
        old.executescript(
            """
            CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR NOT NULL UNIQUE, password_hash VARCHAR NOT NULL, is_verified BOOLEAN NOT NULL DEFAULT 0);
            CREATE TABLE links (id INTEGER PRIMARY KEY, original_url VARCHAR NOT NULL, short_code VARCHAR NOT NULL UNIQUE,
                user_id INTEGER, guest_key VARCHAR, created_at DATETIME, clicks INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE click_events (id INTEGER PRIMARY KEY, link_id INTEGER NOT NULL, created_at DATETIME NOT NULL);
            INSERT INTO users VALUES (1, 'old@example.com', 'x$y', 1);
            INSERT INTO links VALUES (1, 'https://old.example.com/', 'OLD123', 1, NULL, '2026-01-01 10:00:00', 7);
            INSERT INTO click_events VALUES (1, 1, '2026-01-02 10:00:00');
            """
        )
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{database.as_posix()}", "RATE_LIMIT_DISABLED": "1"}
    check = (
        "import json, main\n"
        "from sqlalchemy import inspect\n"
        "i = inspect(main.engine)\n"
        "cols = {t: sorted(c['name'] for c in i.get_columns(t)) for t in ('links', 'click_events')}\n"
        "db = main.SessionLocal()\n"
        "link = db.query(main.Link).one()\n"
        "print(json.dumps({'cols': cols, 'url': link.original_url, 'clicks': link.clicks, 'active': link.is_active,"
        " 'redirect': link.redirect_type, 'archived': link.is_archived, 'events': db.query(main.ClickEvent).count()}))\n"
    )
    for _ in range(2):  # the second start must also work: the upgrade is idempotent
        result = subprocess.run([sys.executable, "-c", check], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout.strip().splitlines()[-1])
    assert {"is_active", "is_archived", "expires_at", "max_clicks", "redirect_type", "password_hash", "folder", "tags"} <= set(report["cols"]["links"])
    assert {"referrer", "device", "browser", "os", "country"} <= set(report["cols"]["click_events"])
    assert report["url"] == "https://old.example.com/" and report["clicks"] == 7 and report["events"] == 1
    assert report["active"] is True and report["redirect"] == 302 and report["archived"] is False
