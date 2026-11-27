"""The turn lab's recorder (`app/routers/turn_lab.py`): off by default, saves only 16 kHz mono WAVs locally."""

import json
import struct
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import COOKIE, encode_session
from tests.conftest import SECRET
from tests.test_system import _seed_user


def _wav(seconds: float, rate: int = 16000, channels: int = 1) -> bytes:
    n = int(seconds * rate) * channels
    body = b"\x00\x00" * n
    return (
        b"RIFF"
        + struct.pack("<I", 36 + len(body))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * channels * 2, channels * 2, 16)
        + b"data"
        + struct.pack("<I", len(body))
        + body
    )


@pytest.fixture
def api(data_dir, sql) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    sid = _seed_user(sql)
    with TestClient(create_app()) as client:
        client.cookies.set(COOKIE, encode_session(sid, SECRET))
        yield client


def _send(api: TestClient, audio: bytes, **fields: str):  # noqa: ANN202
    form = {"promptId": "p26", "text": "Men to'layman… lekin keyingi oyda.", "kind": "pause", **fields}
    return api.post("/turn-lab/clip", data=form, files={"audio": ("clip.wav", audio, "audio/wav")})


def test_off_by_default(api: TestClient, data_dir: Path) -> None:
    assert api.get("/turn-lab/status").json() == {"enabled": False, "saved": 0, "mine": []}
    assert _send(api, _wav(1.0)).status_code == 404
    assert not (data_dir / "turn-lab").exists()


def test_saves_the_clip_and_its_label(api: TestClient, data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TURN_LAB", "on")
    res = _send(api, _wav(2.5), asked="Qachon to'lay olasiz?")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True and body["saved"] == 1
    folder = data_dir / "turn-lab"
    assert (folder / body["file"]).read_bytes() == _wav(2.5)
    row = json.loads((folder / "labels.jsonl").read_text(encoding="utf-8"))
    assert row["promptId"] == "p26" and row["kind"] == "pause" and row["seconds"] == 2.5
    assert row["asked"] == "Qachon to'lay olasiz?" and row["speaker"].startswith("usr_")
    status = api.get("/turn-lab/status").json()
    assert status == {"enabled": True, "saved": 1, "mine": ["p26"]}


@pytest.mark.parametrize(
    ("audio", "fields", "code"),
    [
        (_wav(1.0, rate=48000), {}, 400),  # not 16 kHz
        (_wav(1.0, channels=2), {}, 400),  # not mono
        (_wav(0.1), {}, 400),  # too short
        (b"RIFF" + b"\x00" * 400, {}, 400),  # not a WAV
        (_wav(1.0), {"promptId": "../x"}, 400),
        (_wav(1.0), {"kind": "other"}, 400),
        (_wav(1.0), {"text": ""}, 400),
        (_wav(40.0), {}, 413),
    ],
)
def test_refuses_what_it_cannot_use(
    api: TestClient, data_dir: Path, monkeypatch: pytest.MonkeyPatch, audio: bytes, fields: dict, code: int
) -> None:
    monkeypatch.setenv("TURN_LAB", "on")
    assert _send(api, audio, **fields).status_code == code
    assert not (data_dir / "turn-lab" / "labels.jsonl").exists()
