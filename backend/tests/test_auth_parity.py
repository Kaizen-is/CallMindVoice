"""
Parity with the TypeScript auth code (src/lib/auth.ts).

The reference values below were produced by Node with exactly the calls the
TypeScript app makes (crypto.createHmac(...).digest('base64url'),
crypto.scryptSync(..., 64, {N:16384, r:8, p:1}), sha256 hex). If Python
disagrees with any of them, a login made in one app would fail in the other.
"""

import re

from app.auth import api_key_hash, decode_session, encode_session, hash_password, sign, verify_password
from app.ids import new_id, now_iso, parse_iso, to_iso

TS = {
    "secret": "test-secret-öçü-2026",
    "sid": "ses_0a1b2c3d4e5f6g7h",
    "token": "ses_0a1b2c3d4e5f6g7h.O5wClQGDH6hhI8iHmNUuAeDQzZVYqspZIrqSEYaiU0I",
    "password": "Parol-123!ўқ",
    "password_hash": (
        "scrypt$16384$8$1$ABEiM0RVZneImaq7zN3u/w==$"
        "MOGo1I9Rj67F3BxJLd1GSZU4TUCY2QLZ+Bh4VzVgp7yfwCj+mmPOKWFYjkJs+flBtF8/Pud2Q2HdufJzTYqG2Q=="
    ),
    "api_key": "ovoz_sk_yv66vgARIjNEVWZ3iJmqu8zd7v8AESIz",
    "api_key_sha256": "f0d7ad95dcf04781e0f0755e5069a519c9f9da68414a9bf4cfb65e8d89067b82",
}


def test_cookie_signature_matches_typescript():
    assert encode_session(TS["sid"], TS["secret"]) == TS["token"]


def test_typescript_cookie_is_accepted():
    assert decode_session(TS["token"], TS["secret"]) == TS["sid"]


def test_tampered_or_foreign_cookies_are_refused():
    sid, mac = TS["token"].rsplit(".", 1)
    assert decode_session(f"{sid}x.{mac}", TS["secret"]) is None  # different session id
    assert decode_session(f"{sid}.{mac[:-1]}A", TS["secret"]) is None  # altered signature
    assert decode_session(TS["token"], "another-secret") is None  # signed elsewhere
    assert decode_session("no-dot-here", TS["secret"]) is None
    assert decode_session(f".{mac}", TS["secret"]) is None  # empty id (dot at position 0)


def test_signature_has_no_base64_padding():
    assert "=" not in sign("ses_anything", TS["secret"])


def test_typescript_password_hash_verifies():
    assert verify_password(TS["password"], TS["password_hash"])
    assert not verify_password("wrong", TS["password_hash"])
    assert not verify_password(TS["password"], "bcrypt$whatever")
    assert not verify_password(TS["password"], "garbage")


def test_python_password_hash_has_typescript_format_and_verifies():
    stored = hash_password("Yangi parol 2026")
    assert re.fullmatch(r"scrypt\$16384\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==", stored)
    assert verify_password("Yangi parol 2026", stored)


def test_api_key_hash_matches_typescript():
    assert api_key_hash(TS["api_key"]) == TS["api_key_sha256"]


def test_ids_and_timestamps_match_typescript_format():
    assert re.fullmatch(r"ses_[0-9a-z]{16}", new_id("ses"))
    stamp = now_iso()
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", stamp)
    assert to_iso(parse_iso("2026-11-12T07:01:54.123Z")) == "2026-11-12T07:01:54.123Z"
