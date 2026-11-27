"""
Live words straight from Google (app/speech/gemini_live.py, through speko_live.stream_for), against a
local fake of the Gemini Live API socket: word-by-word interim text, the final on `audioStreamEnd`
(flush keeps the utterance, finish ends it), stale words dropped after a reset, and Speko taking
over when Google refuses the session.
"""

import asyncio
import json

import pytest
import websockets

from app.speech import speko_live
from app.speech.gemini_live import GeminiLiveStream
from tests.test_speko_live import FakeSpeko, _free_port


class FakeGoogle:
    """The Live API: setupComplete; an interim per audio piece; on audioStreamEnd, the final (with a full stop)."""

    def __init__(self, words: list[str], refuse: str | None = None) -> None:
        self.words = words
        self.refuse = refuse
        self.setups: list[dict] = []
        self.headers: list[dict] = []
        self.said = 0
        self.stream_ends = 0

    async def handler(self, ws) -> None:  # noqa: ANN001
        self.headers.append(dict(ws.request.headers))
        self.setups.append(json.loads(await ws.recv()))
        if self.refuse:
            await ws.close(1011, self.refuse)
            return
        await ws.send(json.dumps({"setupComplete": {}}))
        heard: list[str] = []
        async for raw in ws:
            msg = json.loads(raw).get("realtimeInput") or {}
            if "audio" in msg and self.said < len(self.words):
                heard.append(self.words[self.said])
                self.said += 1
                text = " ".join(heard)
                await ws.send(json.dumps({"serverContent": {"interimInputTranscription": {"text": text}}}))
            if msg.get("audioStreamEnd"):
                self.stream_ends += 1
                if heard:
                    final = " ".join(heard) + "."
                    heard = []
                    await ws.send(json.dumps({"serverContent": {"inputTranscription": {"text": final}}}))


@pytest.fixture
def servers(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    monkeypatch.setenv("GEMINI_SPEECH_VIA", "google")
    port = _free_port()
    monkeypatch.setenv("GEMINI_LIVE_URL", f"ws://127.0.0.1:{port}")

    async def start(fake: FakeGoogle):
        return await websockets.serve(fake.handler, "127.0.0.1", port)

    return start


PIECE = b"\x00\x01" * 800  # 100 ms


async def _settle() -> None:
    await asyncio.sleep(0.05)


def test_word_by_word_then_flush_settles_and_keeps_the_utterance(servers) -> None:  # noqa: ANN001
    fake = FakeGoogle(["Hozir", "pulim", "yo'q", "lekin", "ertaga"])

    async def scenario() -> tuple:
        server = await servers(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-gemini-0001", "gemini_live", "t1")
            assert isinstance(stream, speko_live.GoogleFirst)
            await stream.reset()  # opens the session ahead of the words
            seen = []
            for _ in range(3):
                await stream.feed(PIECE)
                await _settle()
                seen.append(await stream.feed(b""))
            flushed = await stream.flush(b"")  # the caller paused
            after = await stream.feed(b"")  # the utterance is kept
            for _ in range(2):  # ...and goes on
                await stream.feed(PIECE)
                await _settle()
            going_on = await stream.feed(b"")
            final = await stream.finish(b"")
            empty = await stream.feed(b"")
            await speko_live.close_stream("u1", "sid-gemini-0001")
            return seen, flushed, after, going_on, final, empty
        finally:
            server.close()

    seen, flushed, after, going_on, final, empty = asyncio.run(scenario())
    assert seen == ["Hozir", "Hozir pulim", "Hozir pulim yo'q"]  # word by word
    assert flushed == "Hozir pulim yo'q." and after == flushed  # settled (the final), not reset
    assert going_on == "Hozir pulim yo'q. lekin ertaga"
    assert final == "Hozir pulim yo'q. lekin ertaga." and empty == ""
    setup = fake.setups[0]["setup"]
    assert setup["model"] == "models/gemini-3.5-transcribe-live"
    assert setup["inputAudioTranscription"] == {"languageCodes": ["uz-UZ"]}
    assert fake.headers[0]["x-goog-api-key"] == "g-key"


def test_flush_with_nothing_pending_does_not_wait(servers) -> None:  # noqa: ANN001
    fake = FakeGoogle(["Salom"])

    async def scenario() -> tuple[str, float, int]:
        server = await servers(fake)
        try:
            stream = GeminiLiveStream("uz", None)
            await stream.feed(PIECE)
            await _settle()
            await stream.flush(b"")
            ends = fake.stream_ends
            loop = asyncio.get_running_loop()
            t = loop.time()
            again = await stream.flush(b"")  # already final: answered at once, nothing sent
            took = loop.time() - t
            await stream.close()
            return again, took, fake.stream_ends - ends
        finally:
            server.close()

    again, took, sent = asyncio.run(scenario())
    assert again == "Salom." and took < 0.2 and sent == 0


def test_reset_drops_the_old_audios_words(servers) -> None:  # noqa: ANN001
    fake = FakeGoogle(["eski", "gap", "yangi"])

    async def scenario() -> str:
        server = await servers(fake)
        try:
            stream = GeminiLiveStream("uz", None)
            await stream.feed(PIECE)  # the agent's echo, say: still interim when the turn changes
            await stream.feed(PIECE)
            await _settle()
            await stream.reset()  # its final ("eski gap.") must not reach the next phrase
            await _settle()
            await stream.feed(PIECE)
            await _settle()
            heard = await stream.finish(b"")
            await stream.close()
            return heard
        finally:
            server.close()

    assert asyncio.run(scenario()) == "yangi."


def test_speko_takes_over_when_google_refuses(servers, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    google = FakeGoogle(["x"], refuse="Quota exceeded for quota metric 'Live sessions' (free tier)")
    speko = FakeSpeko(["Salom", "dunyo"])
    monkeypatch.setenv("SPEKO_API_KEY", "s-key")
    speko_port = _free_port()
    monkeypatch.setenv("SPEKO_BASE_URL", f"http://127.0.0.1:{speko_port}/v1")

    async def scenario() -> str:
        g = await servers(google)
        s = await websockets.serve(speko.handler, "127.0.0.1", speko_port)
        try:
            stream = await speko_live.stream_for("u1", "sid-gemini-0002", "gemini_live", "t1")
            await stream.feed(PIECE)
            await stream.feed(PIECE)
            heard = await stream.finish(b"")
            await speko_live.close_stream("u1", "sid-gemini-0002")
            return heard
        finally:
            g.close()
            s.close()

    assert asyncio.run(scenario()) == "Salom dunyo"
    assert speko.configures[0]["routing"]["model"] == "gemini-3.5-transcribe-live"


def test_refusal_without_speko_is_an_error(servers) -> None:  # noqa: ANN001
    google = FakeGoogle([], refuse="API key not valid. Please pass a valid API key.")

    async def scenario() -> None:
        g = await servers(google)
        try:
            stream = await speko_live.stream_for("u1", "sid-gemini-0003", "gemini_live", "t1")
            await stream.feed(PIECE)
        finally:
            g.close()

    with pytest.raises(speko_live.LiveSttError, match="API key not valid"):
        asyncio.run(scenario())


def test_begin_drops_words_settled_before_the_new_phrase(servers) -> None:  # noqa: ANN001
    fake = FakeGoogle(["eski", "gap", "yangi"])

    async def scenario() -> tuple[str, str]:
        server = await servers(fake)
        try:
            stream = GeminiLiveStream("uz", None)
            await stream.feed(PIECE)  # speech no turn took up
            await stream.feed(PIECE)
            await _settle()
            await stream.flush(b"")  # settled: "eski gap."
            started = await stream.begin()  # the caller starts a new phrase
            await stream.feed(PIECE)
            await _settle()
            heard = await stream.finish(b"")
            await stream.close()
            return started, heard
        finally:
            server.close()

    assert asyncio.run(scenario()) == ("", "yangi.")


def test_the_word_list_goes_into_the_setup(servers) -> None:  # noqa: ANN001
    """Q9: Google takes the bias words as plain strings (`customVocabulary`); asked for once per session."""
    fake = FakeGoogle(["Qancha", "qarzim", "qoldi"])
    asked: list[int] = []

    def words() -> list[str]:
        asked.append(1)
        return ["qarzim", "to'lov", "Isomiddin"]

    async def scenario() -> None:
        server = await servers(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-gemini-vocab1", "gemini_live", "t1", "uz", words)
            await stream.reset()
            await stream.feed(PIECE)
            await speko_live.stream_for("u1", "sid-gemini-vocab1", "gemini_live", "t1", "uz", words)  # same session
            await speko_live.close_stream("u1", "sid-gemini-vocab1")
        finally:
            server.close()

    asyncio.run(scenario())
    assert fake.setups[0]["setup"]["inputAudioTranscription"] == {
        "languageCodes": ["uz-UZ"],
        "customVocabulary": ["qarzim", "to'lov", "Isomiddin"],
    }
    assert asked == [1]  # built once, when the session opened


def test_live_words_call_terms_names_and_the_debtor(data_dir, sql) -> None:  # noqa: ANN001
    import json as _json

    from app.speech.vocabulary import CALL_TERMS, MAX_LIVE_WORDS, live_words

    sql("INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('t1','Kapital Bank','kb','x','x')")
    agent = {
        "id": "a1",
        "tenant_id": "t1",
        "name": "Isomiddin",
        "target_json": _json.dumps({"fullName": "Aliyev Jasur"}),
    }
    words = live_words("t1", agent)
    assert words[: len(CALL_TERMS)] == list(CALL_TERMS)  # the call terms first
    assert {"Isomiddin", "Aliyev", "Jasur"} <= set(words)  # the agent's name and the debtor's
    assert len(words) == len({w.lower() for w in words}) <= MAX_LIVE_WORDS  # no repeats, capped
    assert live_words("t1", None)[: len(CALL_TERMS)] == list(CALL_TERMS)  # the STT page: no agent
