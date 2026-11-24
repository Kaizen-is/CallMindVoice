import json

import httpx

from brb_scraper.config import GroupInfo
from brb_scraper.models import Page
from brb_scraper.sinks import CallMindSink, FileSink

GROUPS = {"loans": GroupInfo("loans", "Loans", "d", ["kredit"])}


class FakeCallMind:
    """A tiny stand-in for CallMind's /knowledge API, keeping pages by URL."""

    def __init__(self, pages: dict[str, str] | None = None):
        self.pages = dict(pages or {})  # url → fingerprint
        self.calls: list[tuple[str, str]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer key"
        path = request.url.path
        self.calls.append((request.method, path))
        body = json.loads(request.content) if request.content else {}
        if request.method == "PUT" and path == "/knowledge/pages":
            created = sum(1 for p in body["pages"] if p["url"] not in self.pages)
            for p in body["pages"]:
                self.pages[p["url"]] = p["fingerprint"]
            return httpx.Response(200, json={"created": created, "updated": len(body["pages"]) - created, "unchanged": 0})
        if request.method == "POST" and path == "/knowledge/pages/delete":
            removed = sum(1 for u in body["urls"] if self.pages.pop(u, None))
            return httpx.Response(200, json={"removed": removed})
        if request.method == "GET" and path == "/knowledge/pages":
            return httpx.Response(200, json={"pages": [{"url": u, "fingerprint": f} for u, f in self.pages.items()]})
        if request.method == "PUT" and path == "/knowledge/groups":
            return httpx.Response(200, json={"groups": len(body["groups"])})
        return httpx.Response(404)


def make_page(n: int, text: str = "matn") -> Page:
    return Page(url=f"https://brb.uz/p{n}", site="brb", lang="uz", group="loans", kind="page",
                title=f"P{n}", breadcrumb=[], text=text, source_lastmod=None)


def setup(tmp_path, remote: FakeCallMind) -> tuple[FileSink, CallMindSink]:
    files = FileSink(tmp_path, GROUPS)
    sink = CallMindSink("http://cm", "key", files, GROUPS, 0.2, transport=httpx.MockTransport(remote.handler))
    return files, sink


def manifest(pages: list[Page]) -> list[dict]:
    return [{"id": p.page_id, "url": p.url, "site": p.site, "fingerprint": p.fingerprint} for p in pages]


def test_new_pages_are_sent_and_missing_ones_resent(tmp_path):
    remote = FakeCallMind()
    files, sink = setup(tmp_path, remote)
    old, new = make_page(1), make_page(2)
    files.upsert(old)          # written on an earlier run, never reached CallMind
    files.upsert(new)
    sink.upsert(new)           # changed in this run
    sink.finalize(manifest([old, new]), allow_deletes=True)
    assert remote.pages == {old.url: old.fingerprint, new.url: new.fingerprint}
    assert sink.stats["resent"] == 1 and sink.stats["errors"] == 0
    assert ("PUT", "/knowledge/groups") in remote.calls


def test_pages_no_longer_live_are_removed(tmp_path):
    live = [make_page(i) for i in range(10)]
    remote = FakeCallMind({p.url: p.fingerprint for p in live} | {"https://brb.uz/gone": "x"})
    files, sink = setup(tmp_path, remote)
    sink.finalize(manifest(live), allow_deletes=True)
    assert "https://brb.uz/gone" not in remote.pages and sink.stats["removed"] == 1


def test_partial_runs_and_the_safety_brake_remove_nothing(tmp_path):
    live = [make_page(1)]
    remote = FakeCallMind({f"https://brb.uz/x{i}": "f" for i in range(20)})
    files, sink = setup(tmp_path, remote)
    files.upsert(live[0])
    sink.finalize(manifest(live), allow_deletes=False)
    assert len(remote.pages) == 21 and "partial run" in sink.notes[-1]

    files, sink = setup(tmp_path, remote)
    sink.finalize(manifest(live), allow_deletes=True)
    assert len(remote.pages) == 21 and "safety brake" in sink.notes[-1]


def test_callmind_down_is_reported_not_raised(tmp_path):
    files = FileSink(tmp_path, GROUPS)

    def down(request):
        raise httpx.ConnectError("refused")

    sink = CallMindSink("http://cm", "key", files, GROUPS, 0.2, transport=httpx.MockTransport(down))
    sink.upsert(make_page(1))
    sink.finalize(manifest([make_page(1)]), allow_deletes=True)
    assert sink.stats["errors"] >= 1 and sink.notes


def test_mass_removal_flag_releases_the_brake(tmp_path):
    live = [make_page(1)]
    remote = FakeCallMind({f"https://brb.uz/x{i}": "f" for i in range(20)})
    files, sink = setup(tmp_path, remote)
    files.upsert(live[0])
    sink.finalize(manifest(live), allow_deletes=True, allow_mass=True)
    assert set(remote.pages) == {live[0].url}
