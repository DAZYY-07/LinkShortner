"""Shortening, guest limits, aliases, editing, redirects and safety checks."""
from datetime import datetime, timedelta, timezone

import main
from conftest import database


def shorten(client, url, headers=None, **options):
    return client.post("/shorten", json={"url": url, **options}, headers=headers or {})


# ── guests ──────────────────────────────────────────────────

def test_guest_gets_five_links_then_must_sign_in(client, guest):
    for number in range(5):
        response = shorten(client, f"https://example.com/page-{number}", guest)
        assert response.status_code == 200
        assert response.json()["guest_remaining"] == 4 - number
    sixth = shorten(client, "https://example.com/page-6", guest)
    assert sixth.status_code == 403
    body = sixth.json()
    assert body["code"] == "guest_limit" and body["limit"] == 5 and body["used"] == 5
    assert "Sign in" in body["detail"]


def test_guest_quota_endpoint_counts_down(client, guest):
    assert client.get("/guest-quota", headers=guest).json() == {"limit": 5, "used": 0, "remaining": 5}
    shorten(client, "https://example.com/a", guest)
    shorten(client, "https://example.com/b", guest)
    assert client.get("/guest-quota", headers=guest).json() == {"limit": 5, "used": 2, "remaining": 3}


def test_guest_limit_is_per_network(client, guest):
    for number in range(5):
        shorten(client, f"https://example.com/n-{number}", guest)
    other_network = {"X-Forwarded-For": "198.51.100.77"}
    assert shorten(client, "https://example.com/n-0", other_network).status_code == 200


def test_guest_cannot_use_link_options(client, guest):
    for options in ({"alias": "my-sale"}, {"max_clicks": 3}, {"password": "secret"}, {"tags": ["x"]}, {"redirect_type": 301}):
        response = shorten(client, "https://example.com/opts", guest, **options)
        assert response.status_code == 401, options


def test_signed_in_users_are_not_limited_by_the_guest_cap(client, user):
    for number in range(8):
        assert shorten(client, f"https://example.com/u-{number}", user["headers"]).status_code == 200


def test_same_url_can_be_shortened_five_times(client, user):
    for _ in range(5):
        assert shorten(client, "https://example.com/same", user["headers"]).status_code == 200
    assert shorten(client, "https://example.com/same", user["headers"]).status_code == 429


def test_plain_shorten_response_keeps_its_original_fields(client, guest):
    body = shorten(client, "https://example.com/compat", guest).json()
    assert {"original_url", "short_url", "short_code"} <= body.keys()
    assert body["short_url"] == f"http://frontend.test/?r={body['short_code']}"
    assert len(body["short_code"]) == 6


# ── aliases ─────────────────────────────────────────────────

def test_custom_alias_works_and_must_be_unique(client, user, make_user):
    created = shorten(client, "https://example.com/sale", user["headers"], alias="My-Sale")  # the PRD's own example style
    assert created.status_code == 200 and created.json()["short_code"] == "My-Sale"
    other = make_user()
    assert shorten(client, "https://example.com/x", other["headers"], alias="my-sale").status_code == 409


def test_invalid_and_reserved_aliases_are_rejected(client, user):
    for alias in ("ab", "x" * 31, "has space", "under_score", "docs", "stats", "my-links", "AUTH"):
        response = shorten(client, "https://example.com/alias", user["headers"], alias=alias)
        assert response.status_code == 422, alias


# ── redirects ───────────────────────────────────────────────

def test_redirect_defaults_to_302_and_can_be_301(client, user):
    plain = shorten(client, "https://example.com/r1", user["headers"]).json()["short_code"]
    permanent = shorten(client, "https://example.com/r2", user["headers"], redirect_type=301).json()["short_code"]
    first = client.get(f"/{plain}", follow_redirects=False)
    assert first.status_code == 302 and first.headers["location"] == "https://example.com/r1"
    assert client.get(f"/{permanent}", follow_redirects=False).status_code == 301


def test_resolve_returns_destination_and_counts_clicks(client, user):
    code = shorten(client, "https://example.com/count", user["headers"]).json()["short_code"]
    assert client.get(f"/resolve/{code}").json() == {"original_url": "https://example.com/count"}
    client.get(f"/{code}", follow_redirects=False)
    listed = client.get("/my-links", headers=user["headers"]).json()
    assert [link["clicks"] for link in listed if link["short_code"] == code] == [2]


def test_unknown_code_is_404_json_or_html(client):
    assert client.get("/resolve/nope-nope").status_code == 404
    assert client.get("/nope-nope").json()["detail"] == "Short URL not found."
    page = client.get("/nope-nope", headers={"Accept": "text/html"})
    assert page.status_code == 404 and "Link not found" in page.text


def test_expired_link_shows_friendly_page(client, user):
    code = shorten(client, "https://example.com/exp", user["headers"]).json()["short_code"]
    with database() as db:
        link = db.query(main.Link).filter_by(short_code=code).one()
        link.expires_at = main.utcnow() - timedelta(hours=1)
        db.commit()
    assert client.get(f"/resolve/{code}").json()["code"] == "expired"
    page = client.get(f"/{code}", headers={"Accept": "text/html"}, follow_redirects=False)
    assert page.status_code == 410 and "expired" in page.text.lower()
    assert client.get("/my-links", headers=user["headers"]).json()[0]["status"] == "expired"


def test_expiry_must_be_in_the_future(client, user):
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert shorten(client, "https://example.com/p", user["headers"], expires_at=past).status_code == 422
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    created = shorten(client, "https://example.com/p", user["headers"], expires_at=future)
    assert created.status_code == 200 and created.json()["expires_at"].endswith("Z")


def test_click_limit_stops_the_link(client, user):
    code = shorten(client, "https://example.com/lim", user["headers"], max_clicks=2).json()["short_code"]
    assert client.get(f"/resolve/{code}").status_code == 200
    assert client.get(f"/{code}", follow_redirects=False).status_code == 302
    third = client.get(f"/resolve/{code}")
    assert third.status_code == 410 and third.json()["code"] == "limit_reached"
    assert client.get("/my-links", headers=user["headers"]).json()[0]["clicks"] == 2


def test_disabled_link_does_not_redirect_until_enabled(client, user):
    code = shorten(client, "https://example.com/off", user["headers"]).json()["short_code"]
    client.patch(f"/my-links/{code}", json={"is_active": False}, headers=user["headers"])
    assert client.get(f"/resolve/{code}").json()["code"] == "disabled"
    client.patch(f"/my-links/{code}", json={"is_active": True}, headers=user["headers"])
    assert client.get(f"/resolve/{code}").status_code == 200


def test_password_protected_link(client, user):
    code = shorten(client, "https://example.com/secret", user["headers"], password="open-sesame").json()["short_code"]
    locked = client.get(f"/resolve/{code}")
    assert locked.status_code == 401 and locked.json()["code"] == "password_required"
    page = client.get(f"/{code}", headers={"Accept": "text/html"}, follow_redirects=False)
    assert page.status_code == 200 and "<form" in page.text and "protected" in page.text
    assert client.post(f"/resolve/{code}", json={"password": "wrong"}).status_code == 403
    unlocked = client.post(f"/resolve/{code}", json={"password": "open-sesame"})
    assert unlocked.status_code == 200 and unlocked.json()["original_url"] == "https://example.com/secret"
    stored = client.get("/my-links", headers=user["headers"]).json()[0]
    assert stored["has_password"] is True and "password" not in str(stored).replace("has_password", "")


# ── editing ─────────────────────────────────────────────────

def test_edit_destination_without_changing_the_short_link(client, user):
    code = shorten(client, "https://example.com/old", user["headers"]).json()["short_code"]
    edited = client.patch(f"/my-links/{code}", json={"url": "https://example.com/new"}, headers=user["headers"])
    assert edited.status_code == 200 and edited.json()["short_code"] == code
    assert client.get(f"/resolve/{code}").json()["original_url"] == "https://example.com/new"


def test_edit_alias_expiry_limit_and_clearing_options(client, user):
    code = shorten(client, "https://example.com/e", user["headers"], max_clicks=5, password="abcd").json()["short_code"]
    future = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    changed = client.patch(
        f"/my-links/{code}",
        json={"alias": "renamed-link", "expires_at": future, "redirect_type": 301, "folder": "Campaigns", "tags": ["Sale", "sale", " promo "]},
        headers=user["headers"],
    ).json()
    assert changed["short_code"] == "renamed-link" and changed["redirect_type"] == 301
    assert changed["tags"] == ["sale", "promo"] and changed["folder"] == "Campaigns"
    assert client.get("/resolve/" + code).status_code == 404  # the old code stops working
    cleared = client.patch(
        "/my-links/renamed-link",
        json={"expires_at": None, "max_clicks": None, "password": None, "folder": None, "tags": None},
        headers=user["headers"],
    ).json()
    assert cleared["expires_at"] is None and cleared["max_clicks"] is None
    assert cleared["has_password"] is False and cleared["folder"] is None and cleared["tags"] == []


def test_edit_rejects_taken_alias_and_unsafe_url(client, user):
    first = shorten(client, "https://example.com/1", user["headers"], alias="first-link").json()["short_code"]
    second = shorten(client, "https://example.com/2", user["headers"]).json()["short_code"]
    assert client.patch(f"/my-links/{second}", json={"alias": "FIRST-link"}, headers=user["headers"]).status_code == 409
    assert client.patch(f"/my-links/{first}", json={"url": "http://127.0.0.1/admin"}, headers=user["headers"]).status_code == 400
    assert client.patch(f"/my-links/{first}", json={"alias": None}, headers=user["headers"]).status_code == 422


def test_users_cannot_touch_each_others_links(client, user, make_user):
    code = shorten(client, "https://example.com/mine", user["headers"]).json()["short_code"]
    intruder = make_user()["headers"]
    assert client.patch(f"/my-links/{code}", json={"is_active": False}, headers=intruder).status_code == 404
    assert client.delete(f"/my-links/{code}", headers=intruder).status_code == 404
    assert client.get(f"/my-links/{code}/analytics", headers=intruder).status_code == 404
    assert client.post("/my-links/bulk", json={"action": "delete", "codes": [code]}, headers=intruder).json()["affected"] == 0
    assert client.get(f"/resolve/{code}").status_code == 200


def test_delete_removes_link_and_its_clicks(client, user):
    code = shorten(client, "https://example.com/del", user["headers"]).json()["short_code"]
    client.get(f"/resolve/{code}")
    assert client.delete(f"/my-links/{code}", headers=user["headers"]).json() == {"deleted": code}
    assert client.get(f"/resolve/{code}").status_code == 404
    with database() as db:
        assert db.query(main.ClickEvent).join(main.Link, isouter=True).filter(main.Link.id.is_(None)).count() == 0


def test_options_require_a_valid_token(client):
    assert client.get("/my-links").status_code == 401
    assert client.patch("/my-links/abc", json={"is_active": False}).status_code == 401
    assert client.post("/my-links/import", json={"csv": "https://example.com"}).status_code == 401


# ── safety ──────────────────────────────────────────────────

def test_unsafe_destinations_are_rejected(client, guest):
    unsafe = [
        "http://user:pass@example.com/login",
        "http://127.0.0.1/admin",
        "http://192.168.1.10/router",
        "http://93.184.216.34/raw-ip",
        "http://localhost:8000/x",
        "http://printer.local/",
        "https://malware.testing.google.test/testing/malware/",
        "https://sub.testsafebrowsing.appspot.com/",
        "http://frontend.test/?r=abc123",
        "http://backend.test/abc123",
    ]
    for url in unsafe:
        response = shorten(client, url, guest)
        assert response.status_code == 400, url
    assert shorten(client, "https://example.com/fine", guest).status_code == 200
    assert client.get("/guest-quota", headers=guest).json()["used"] == 1  # rejected URLs don't use up the free links


def test_safe_browsing_hit_blocks_and_outage_does_not(client, guest, monkeypatch):
    monkeypatch.setattr(main, "SAFE_BROWSING_API_KEY", "key")
    monkeypatch.setattr(main, "flagged_by_safe_browsing", lambda url: "bad" in url)
    assert shorten(client, "https://example.com/bad-page", guest).status_code == 400
    assert shorten(client, "https://example.com/good-page", guest).status_code == 200


def test_flagged_check_fails_open_when_the_service_is_down(monkeypatch):
    monkeypatch.setattr(main, "SAFE_BROWSING_API_KEY", "key")
    monkeypatch.setattr(main.urllib.request, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("offline")))
    assert main.flagged_by_safe_browsing("https://example.com") is False
