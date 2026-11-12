"""
The Playground's live voice: voicing a reply while it is written (`SpeakAsWritten`), stopping when
the caller talks over it, the NDJSON event stream, fillers and the prefetched transcript.
The segmentation itself is checked against the TypeScript in test_speech_parity.py.
"""

import asyncio
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import playground_voice as pv

AGENT = {"tenant_id": "t1", "voice_id": "laylo", "tts_voice_id": None, "greeting": "Salom", "name": "Laylo"}
PICK = pv.VoicePick("default", "laylo")


@pytest.fixture
def fake_tts(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every segment handed to the TTS renders as two small PCM pieces; returns the segments seen."""
    rendered: list[str] = []

    async def synth(text: str, opts):  # noqa: ANN001
        rendered.append(text)
        for i in range(2):
            await asyncio.sleep(0.005)
            yield f"{text[:8]}#{i}".encode()

    monkeypatch.setattr(pv, "synthesize_stream", synth)
    monkeypatch.setattr(pv, "tts_configured", lambda engine="default": True)
    return rendered


def _run_reply(deltas: list[str], reply: str, fast: bool = True, abort_after_audio: int | None = None):
    sent: list[dict] = []
    marks: list[str] = []

    async def main() -> None:
        signal = pv.Signal()

        def send(event: dict) -> None:
            sent.append(event)
            if abort_after_audio is not None and sum(e["t"] == "audio" for e in sent) >= abort_after_audio:
                signal.abort()

        voice = pv.SpeakAsWritten(
            AGENT,
            "uz",
            PICK,
            send,
            signal,
            pv.SpeakOptions(
                fast=fast,
                on_first_segment=lambda: marks.append("segment"),
                on_first_audio=lambda: marks.append("audio"),
            ),
        )
        for d in deltas:
            voice.push(d)
            await asyncio.sleep(0.002)
        await voice.finish(reply)

    asyncio.run(main())
    return sent, marks


def test_reply_is_voiced_sentence_by_sentence(fake_tts: list[str]) -> None:
    reply = "Assalomu alaykum, men Laylo, bankdan qo‘ng‘iroq qilyapman. Kredit foizi yillik 24 foiz. Yana savol bormi?"
    deltas = [reply[i : i + 9] for i in range(0, len(reply), 9)]
    sent, marks = _run_reply(deltas, reply)

    assert fake_tts[0] == "Assalomu alaykum, men Laylo,"  # fast: the first clause goes at once
    assert "".join(fake_tts).replace(" ", "") == reply.replace(" ", "")
    texts = [e for e in sent if e["t"] in ("reply", "more")]
    assert texts[0]["t"] == "reply" and texts[0]["lang"] == "uz" and texts[0]["end"] is None
    assert all(e["t"] == "more" for e in texts[1:])
    assert texts[-1]["text"] == reply
    audio = [e for e in sent if e["t"] == "audio"]
    assert len(audio) == 2 * len(fake_tts)
    assert marks == ["segment", "audio"]
    assert not any(e["t"] == "voice" for e in sent)


def test_legacy_mode_waits_for_whole_sentences(fake_tts: list[str]) -> None:
    reply = "Assalomu alaykum, men Laylo, bankdan qo‘ng‘iroq qilyapman. Rahmat."
    _run_reply([reply[:30], reply[30:]], reply, fast=False)
    assert fake_tts[0] == "Assalomu alaykum, men Laylo, bankdan qo‘ng‘iroq qilyapman."


def test_talking_over_the_reply_stops_the_voice(fake_tts: list[str]) -> None:
    reply = "Birinchi gap juda uzun bo‘ladi. Ikkinchi gap ham bor. Uchinchi gap esa oxirgisi."
    sent, _ = _run_reply([reply], reply, abort_after_audio=1)
    assert sum(e["t"] == "audio" for e in sent) == 1
    assert not any(e["t"] == "voice" for e in sent)


def test_without_a_voice_the_text_still_arrives(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pv, "tts_configured", lambda engine="default": False)
    reply = "Kredit foizi yillik 24 foiz. Muddat 36 oy."
    sent, marks = _run_reply([reply], reply)
    assert [e["t"] for e in sent][-1] == "voice"
    assert sent[-1] == {"t": "voice", "ok": False}
    assert [e for e in sent if e["t"] in ("reply", "more")][-1]["text"] == reply
    assert marks == ["segment"]


def test_finish_extends_but_never_contradicts_what_was_streamed(fake_tts: list[str]) -> None:
    sent, _ = _run_reply(["Kredit foizi "], "Kredit foizi yillik 24 foiz.")
    assert [e for e in sent if e["t"] in ("reply", "more")][-1]["text"] == "Kredit foizi yillik 24 foiz."
    # A final answer that does not start with what was already said keeps what was said, as in TypeScript.
    sent, _ = _run_reply(["Partial answ"], "Completely different final answer here.")
    assert [e for e in sent if e["t"] in ("reply", "more")][-1]["text"] == "Partial answ"


def test_event_stream_sends_ndjson_and_reports_errors() -> None:
    app = FastAPI()

    @app.get("/ok")
    async def ok():
        async def work(send, signal):  # noqa: ANN001
            send({"t": "call", "callId": "c1"})
            await asyncio.sleep(0.01)
            send({"t": "reply", "text": "Salom ü", "lang": "uz", "end": None})
            send({"t": "done"})

        return pv.event_stream(work)

    @app.get("/boom")
    async def boom():
        async def work(send, signal):  # noqa: ANN001
            send({"t": "heard", "text": "x"})
            raise RuntimeError("kaput")

        return pv.event_stream(work)

    client = TestClient(app)
    res = client.get("/ok")
    assert res.headers["content-type"].startswith("application/x-ndjson")
    assert res.headers["x-accel-buffering"] == "no"
    assert res.text.splitlines() == [
        '{"t":"call","callId":"c1"}',
        '{"t":"reply","text":"Salom ü","lang":"uz","end":null}',
        '{"t":"done"}',
    ]
    lines = [json.loads(line) for line in client.get("/boom").text.splitlines()]
    assert lines == [{"t": "heard", "text": "x"}, {"t": "error", "code": "server"}]


def test_filler_rotates_and_skips_greetings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pv, "tts_configured", lambda engine="default": True)
    seen: list[str] = []
    monkeypatch.setattr(pv, "cached_pcm", lambda text, opts: seen.append(text) or b"\x01\x02")
    assert pv.filler_for(AGENT, "call-f", "Assalomu alaykum", PICK) is None  # a greeting gets no "let me check"
    first = pv.filler_for(AGENT, "call-f", "Kredit foizi qancha?", PICK)
    pv.filler_for(AGENT, "call-f", "Muddat qancha?", PICK)
    assert first == "AQI="
    assert seen == ["Bir daqiqa.", "Hozir tekshiraman."]


def test_prefetched_transcript_is_reused_once(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[bytes] = []

    async def fake_transcribe(audio: bytes, **kw):  # noqa: ANN003
        calls.append(audio)
        return {"text": f"heard {len(calls)}", "engine": "gapi", "language": "uz"}

    monkeypatch.setattr(pv, "transcribe", fake_transcribe)

    async def main() -> list[dict]:
        pv.prefetch_heard("call-p", b"RIFF-a", "uz", "gapi")
        same = await pv.heard_in("call-p", b"RIFF-a", "uz", "gapi")
        other = await pv.heard_in("call-p", b"RIFF-a", "uz", "gapi")  # used up: transcribed again
        changed = await pv.heard_in("call-p", b"RIFF-b", "uz", "gapi")
        return [same, other, changed]

    same, other, changed = asyncio.run(main())
    assert same["text"] == "heard 1" and other["text"] == "heard 2" and changed["text"] == "heard 3"


def test_speaking_agent_takes_the_voice_name(sql, data_dir) -> None:  # noqa: ANN001
    loan = {**AGENT, "target_json": '{"fullName": "Aziz"}', "greeting": "Salom, men Laylo. Laylo sizga…"}
    nadya = pv.VoicePick("eleven_v4_turbo", "lZSeoYcz4phdvms888pn")
    spoken = pv.speaking_agent(loan, nadya)
    assert spoken["name"] == "Nadya" and spoken["greeting"] == "Salom, men Nadya. Nadya sizga…"
    assert pv.speaking_agent(AGENT, nadya) is AGENT  # a receptionist keeps its own name
