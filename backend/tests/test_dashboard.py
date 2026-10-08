"""Dashboard: search, filters, sorting, bulk actions, CSV import and analytics."""
import csv
import io
from datetime import datetime, timedelta, timezone

import main
from conftest import database

CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"


def make_link(client, user, url, **options):
    response = client.post("/shorten", json={"url": url, **options}, headers=user["headers"])
    assert response.status_code == 200, response.text
    return response.json()["short_code"]


def codes(client, user, **params):
    response = client.get("/my-links", params=params, headers=user["headers"])
    assert response.status_code == 200, response.text
    return [link["short_code"] for link in response.json()]


# ── list, search, filter, sort ──────────────────────────────

def test_list_has_total_count_header_and_pages(client, user):
    created = [make_link(client, user, f"https://example.com/p{n}") for n in range(5)]
    first = client.get("/my-links", params={"limit": 2}, headers=user["headers"])
    assert first.headers["x-total-count"] == "5" and len(first.json()) == 2
    second = client.get("/my-links", params={"limit": 2, "offset": 2}, headers=user["headers"])
    assert [l["short_code"] for l in first.json() + second.json()] == created[::-1][:4]


def test_search_matches_destination_code_folder_and_tag(client, user):
    docs = make_link(client, user, "https://docs.python.org/3/", folder="Reading", tags=["python"])
    shop = make_link(client, user, "https://shop.example.com/", alias="summer-shop", tags=["promo"])
    assert codes(client, user, q="python") == [docs]
    assert codes(client, user, q="summer") == [shop]
    assert codes(client, user, q="reading") == [docs]
    assert codes(client, user, q="promo") == [shop]
    assert codes(client, user, q="no-such-thing") == []
    assert codes(client, user, q="%") == []  # wildcard characters are matched literally


def test_filter_by_tag_folder_and_status(client, user):
    a = make_link(client, user, "https://example.com/a", tags=["red", "blue"], folder="One")
    b = make_link(client, user, "https://example.com/b", tags=["red"], folder="Two")
    c = make_link(client, user, "https://example.com/c", max_clicks=1)
    client.get(f"/resolve/{c}")
    client.patch(f"/my-links/{b}", json={"is_active": False}, headers=user["headers"])
    assert sorted(codes(client, user, tag="red")) == sorted([a, b])
    assert codes(client, user, tag="blue") == [a]
    assert codes(client, user, folder="Two") == [b]
    assert codes(client, user, status="disabled") == [b]
    assert codes(client, user, status="limit_reached") == [c]
    assert codes(client, user, status="active") == [a]


def test_sorting(client, user):
    first = make_link(client, user, "https://example.com/1", alias="bravo")
    second = make_link(client, user, "https://example.com/2", alias="alpha")
    third = make_link(client, user, "https://example.com/3", alias="charlie")
    for _ in range(3):
        client.get(f"/resolve/{second}")
    client.get(f"/resolve/{third}")
    assert codes(client, user, sort="newest") == [third, second, first]
    assert codes(client, user, sort="oldest") == [first, second, third]
    assert codes(client, user, sort="clicks") == [second, third, first]
    assert codes(client, user, sort="alias") == ["alpha", "bravo", "charlie"]


def test_sort_by_expiry_puts_soonest_first_and_no_expiry_last(client, user):
    soon = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    later = (datetime.now(timezone.utc) + timedelta(days=9)).isoformat()
    never = make_link(client, user, "https://example.com/never")
    far = make_link(client, user, "https://example.com/far", expires_at=later)
    near = make_link(client, user, "https://example.com/near", expires_at=soon)
    assert codes(client, user, sort="expiring") == [near, far, never]


def test_tags_and_folders_endpoint_counts(client, user):
    make_link(client, user, "https://example.com/1", tags=["a", "b"], folder="X")
    make_link(client, user, "https://example.com/2", tags=["a"], folder="X")
    filters = client.get("/my-links/filters", headers=user["headers"]).json()
    assert filters["tags"] == [{"name": "a", "count": 2}, {"name": "b", "count": 1}]
    assert filters["folders"] == [{"name": "X", "count": 2}]


def test_invalid_tags_are_rejected(client, user):
    for bad in (["a,b"], ["<script>"], ["x" * 30], ["ok", "no!"]):
        response = client.post("/shorten", json={"url": "https://example.com/t", "tags": bad}, headers=user["headers"])
        assert response.status_code == 422, bad


# ── bulk actions ────────────────────────────────────────────

def test_archive_hides_links_but_they_keep_working(client, user):
    keep = make_link(client, user, "https://example.com/keep")
    hide = make_link(client, user, "https://example.com/hide")
    result = client.post("/my-links/bulk", json={"action": "archive", "codes": [hide, "missing"]}, headers=user["headers"]).json()
    assert result == {"affected": 1, "not_found": ["missing"]}
    assert codes(client, user) == [keep]
    assert codes(client, user, archived="only") == [hide]
    assert sorted(codes(client, user, archived="all")) == sorted([keep, hide])
    assert client.get(f"/resolve/{hide}").status_code == 200  # archived is only hidden from the dashboard
    client.post("/my-links/bulk", json={"action": "unarchive", "codes": [hide]}, headers=user["headers"])
    assert sorted(codes(client, user)) == sorted([keep, hide])


def test_bulk_disable_enable_and_delete(client, user):
    one, two = (make_link(client, user, f"https://example.com/b{n}") for n in range(2))
    client.get(f"/resolve/{one}")
    client.post("/my-links/bulk", json={"action": "disable", "codes": [one, two]}, headers=user["headers"])
    assert client.get(f"/resolve/{one}").status_code == 410
    client.post("/my-links/bulk", json={"action": "enable", "codes": [one, two]}, headers=user["headers"])
    assert client.get(f"/resolve/{two}").status_code == 200
    assert client.post("/my-links/bulk", json={"action": "delete", "codes": [one, two]}, headers=user["headers"]).json()["affected"] == 2
    assert codes(client, user) == []
    assert client.get(f"/resolve/{one}").status_code == 404


def test_bulk_requires_at_least_one_code(client, user):
    assert client.post("/my-links/bulk", json={"action": "delete", "codes": []}, headers=user["headers"]).status_code == 422
    assert client.post("/my-links/bulk", json={"action": "explode", "codes": ["a"]}, headers=user["headers"]).status_code == 422


# ── CSV import ──────────────────────────────────────────────

def test_csv_import_with_header_and_per_row_errors(client, user):
    text = (
        "url,alias,tags,folder\n"
        "https://example.com/one,csv-one,a;b,Imports\n"
        "not a url,,,\n"
        "https://example.com/two,csv-one,,\n"          # alias already taken by row 1
        "http://127.0.0.1/private,,,\n"                 # rejected by the safety check
        "https://example.com/three,,,\n"
    )
    result = client.post("/my-links/import", json={"csv": text}, headers=user["headers"]).json()
    assert result["created"] == 2 and result["failed"] == 3
    assert [r["ok"] for r in result["results"]] == [True, False, False, False, True]
    assert result["results"][0]["short_code"] == "csv-one" and result["results"][0]["tags"] == ["a", "b"]
    assert "valid" in result["results"][1]["error"] and "taken" in result["results"][2]["error"]
    assert codes(client, user, folder="Imports") == ["csv-one"]


def test_csv_import_without_header_and_column_order(client, user):
    plain = client.post("/my-links/import", json={"csv": "https://example.com/x1\nhttps://example.com/x2,my-x2\n"}, headers=user["headers"]).json()
    assert plain["created"] == 2 and plain["results"][1]["short_code"] == "my-x2"
    reordered = client.post("/my-links/import", json={"csv": "folder,url\nShop,https://example.com/shop\n"}, headers=user["headers"]).json()
    assert reordered["created"] == 1 and reordered["results"][0]["folder"] == "Shop"


def test_csv_import_limits(client, user):
    too_many = "\n".join(f"https://example.com/{n}" for n in range(main.MAX_CSV_ROWS + 1))
    assert client.post("/my-links/import", json={"csv": too_many}, headers=user["headers"]).status_code == 422
    assert client.post("/my-links/import", json={"csv": "\n\n"}, headers=user["headers"]).status_code == 422


# ── analytics ───────────────────────────────────────────────

def visit(client, code, user_agent, referer=None, country=None):
    headers = {"User-Agent": user_agent}
    if referer:
        headers["Referer"] = referer
    if country:
        headers["CF-IPCountry"] = country
    assert client.get(f"/{code}", headers=headers, follow_redirects=False).status_code in (301, 302)


def test_analytics_breaks_clicks_down_by_referrer_device_browser_os_and_country(client, user):
    code = make_link(client, user, "https://example.com/stats")
    visit(client, code, CHROME_WINDOWS, "https://www.twitter.com/post/1", "IN")
    visit(client, code, CHROME_WINDOWS, "https://twitter.com/other", "IN")
    visit(client, code, IPHONE_SAFARI, None, "US")
    report = client.get(f"/my-links/{code}/analytics", headers=user["headers"]).json()
    assert report["total_clicks"] == 3 and report["period_clicks"] == 3 and report["days"] == 7
    assert report["referrers"] == [{"name": "twitter.com", "clicks": 2}, {"name": "Direct", "clicks": 1}]
    assert report["devices"] == [{"name": "Desktop", "clicks": 2}, {"name": "Mobile", "clicks": 1}]
    assert {"name": "Chrome", "clicks": 2} in report["browsers"] and {"name": "Safari", "clicks": 1} in report["browsers"]
    assert {"name": "Windows", "clicks": 2} in report["operating_systems"] and {"name": "iOS", "clicks": 1} in report["operating_systems"]
    assert report["countries"] == [{"name": "IN", "clicks": 2}, {"name": "US", "clicks": 1}]
    assert len(report["clicks_by_day"]) == 7 and report["clicks_by_day"][-1]["clicks"] == 3


def test_web_app_passes_the_real_referrer_and_own_pages_count_as_direct(client, user):
    code = make_link(client, user, "https://example.com/ref")
    client.get(f"/resolve/{code}", params={"ref": "https://news.ycombinator.com/item?id=1"}, headers={"User-Agent": CHROME_WINDOWS})
    client.get(f"/resolve/{code}", params={"ref": "http://frontend.test/?r=" + code}, headers={"User-Agent": CHROME_WINDOWS})
    referrers = client.get(f"/my-links/{code}/analytics", headers=user["headers"]).json()["referrers"]
    assert {"name": "news.ycombinator.com", "clicks": 1} in referrers and {"name": "Direct", "clicks": 1} in referrers


def test_country_comes_from_the_ip_lookup_when_no_edge_header(client, user, monkeypatch):
    monkeypatch.setattr(main, "lookup_country", lambda ip: "DE" if ip == "8.8.8.8" else None)
    code = make_link(client, user, "https://example.com/geo")
    client.get(f"/{code}", headers={"X-Forwarded-For": "8.8.8.8"}, follow_redirects=False)
    client.get(f"/{code}", headers={"X-Forwarded-For": "10.0.0.5"}, follow_redirects=False)
    countries = client.get(f"/my-links/{code}/analytics", headers=user["headers"]).json()["countries"]
    assert {"name": "DE", "clicks": 1} in countries and {"name": "Unknown", "clicks": 1} in countries


def test_raw_ip_addresses_are_never_stored(client, user):
    code = make_link(client, user, "https://example.com/privacy")
    client.get(f"/{code}", headers={"X-Forwarded-For": "8.8.4.4"}, follow_redirects=False)
    with database() as db:
        event = db.query(main.ClickEvent).order_by(main.ClickEvent.id.desc()).first()
        stored = " ".join(str(getattr(event, column.name)) for column in main.ClickEvent.__table__.columns)
    assert "8.8.4.4" not in stored


def test_analytics_range_option(client, user):
    code = make_link(client, user, "https://example.com/range")
    visit(client, code, CHROME_WINDOWS)
    month = client.get(f"/my-links/{code}/analytics", params={"days": 30}, headers=user["headers"]).json()
    assert len(month["clicks_by_day"]) == 30 and month["period_clicks"] == 1
    assert client.get(f"/my-links/{code}/analytics", params={"days": 91}, headers=user["headers"]).status_code == 422


def test_csv_export_lists_every_click_and_neutralises_formulas(client, user):
    code = make_link(client, user, "https://example.com/export")
    visit(client, code, IPHONE_SAFARI, "https://t.co/abc", "GB")
    with database() as db:  # a hostile referrer that would run as a spreadsheet formula
        link = db.query(main.Link).filter_by(short_code=code).one()
        db.add(main.ClickEvent(link_id=link.id, referrer="=HYPERLINK(1)", device="Desktop", browser="Chrome", os="Windows", country="FR"))
        db.commit()
    response = client.get(f"/my-links/{code}/analytics/export", headers=user["headers"])
    assert response.headers["content-type"].startswith("text/csv")
    assert f'{code}-analytics.csv' in response.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0] == ["timestamp_utc", "referrer", "device", "browser", "os", "country"]
    assert len(rows) == 3
    assert any(row[1] == "t.co" and row[2] == "Mobile" and row[5] == "GB" for row in rows[1:])
    assert any(row[1] == "'=HYPERLINK(1)" for row in rows[1:])


def test_user_agent_parsing():
    assert main.parse_user_agent(CHROME_WINDOWS) == ("Desktop", "Chrome", "Windows")
    assert main.parse_user_agent(IPHONE_SAFARI) == ("Mobile", "Safari", "iOS")
    assert main.parse_user_agent("Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 Chrome/126.0 Safari/537.36")[:1] == ("Tablet",)
    assert main.parse_user_agent("Mozilla/5.0 Windows NT 10.0 Edg/126.0 Chrome/126.0")[1] == "Edge"
    assert main.parse_user_agent("Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0") == ("Desktop", "Firefox", "Linux")
    assert main.parse_user_agent("Googlebot/2.1 (+http://www.google.com/bot.html)")[0] == "Bot"
    assert main.parse_user_agent(None) == ("Unknown", "Unknown", "Unknown")
