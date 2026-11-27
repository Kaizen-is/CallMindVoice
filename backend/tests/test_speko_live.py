"""
Live words through Speko (app/speech/speko_live.py, POST /speech/live with engine=gemini_live or
scribe_live), against a local fake of Speko's streaming socket.
"""

import asyncio
import json
import socket

import pytest
import websockets

from app.speech import speko_live


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeSpeko:
    """Speko's /v1/stt/stream: session.ready, a delta per audio frame, a final per commit."""

    def __init__(self, words: list[str], commit_ids: bool = True) -> None:
        self.words = words
        self.commit_ids = commit_ids
        self.configures: list[dict] = []
        self.headers: list[dict] = []
        self.audio_bytes = 0
        self.said = 0  # words spoken so far (across commits)

    async def handler(self, ws) -> None:  # noqa: ANN001
        self.headers.append(dict(ws.request.headers))
        configure = json.loads(await ws.recv())
        self.configures.append(configure)
        await ws.send(
            json.dumps(
                {
                    "type": "session.ready",
                    "request_id": "r1",
                    "commit_ids": self.commit_ids,
                    "route": {"provider": "x", "model": "y", "region": "z", "attempt_id": "a"},
                }
            )
        )
        heard: list[str] = []
        async for msg in ws:
            if isinstance(msg, bytes):
                self.audio_bytes += len(msg)
                if self.said < len(self.words):
                    heard.append(self.words[self.said])
                    self.said += 1
                    await ws.send(json.dumps({"type": "transcript.delta", "text": " ".join(heard)}))
                continue
            event = json.loads(msg)
            if event["type"] == "input.commit":
                final = {"type": "transcript.final", "text": " ".join(heard)}
                if self.commit_ids and event.get("commit_id"):
                    final["commit_id"] = event["commit_id"]
                heard = []
                await ws.send(json.dumps(final))
            elif event["type"] == "session.close":
                await ws.send(json.dumps({"type": "session.closed", "usage": {"duration_ms": 1234}}))
                return


@pytest.fixture
def fake_speko(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SPEKO_API_KEY", "test-key")
    port = _free_port()
    monkeypatch.setenv("SPEKO_BASE_URL", f"http://127.0.0.1:{port}/v1")

    async def start(fake: FakeSpeko):
        return await websockets.serve(fake.handler, "127.0.0.1", port)

    return start


def test_words_stream_and_the_phrase_finishes(fake_speko) -> None:  # noqa: ANN001
    fake = FakeSpeko(["Salom", "dunyo", "qalaysiz"])

    async def scenario() -> tuple[list[str], str, str]:
        server = await fake_speko(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-test-0001", "scribe_live", "t1")
            await stream.reset()  # opens the socket ahead of the words
            seen = [await stream.feed(b"\x00\x01" * 100) for _ in range(3)]
            await asyncio.sleep(0.05)
            now = await stream.feed(b"")
            seen.append(now)
            final = await stream.finish(b"")
            after = await stream.feed(b"")  # a new utterance starts empty
            await speko_live.close_stream("u1", "sid-test-0001")
            return seen, final, after
        finally:
            server.close()

    seen, final, after = asyncio.run(scenario())
    assert seen[-1] == "Salom dunyo qalaysiz"  # the words arrived while "speaking"
    assert final == "Salom dunyo qalaysiz"
    assert after == ""
    configure = fake.configures[0]
    assert configure["type"] == "session.configure"
    assert configure["routing"] == {"mode": "explicit", "provider": "elevenlabs", "model": "scribe_v3_live"}
    assert configure["audio"] == {"encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}
    assert fake.headers[0]["authorization"] == "Bearer test-key" and fake.headers[0]["idempotency-key"]
    assert fake.audio_bytes == 600


def test_gemini_live_route_and_reset_drops_old_words(fake_speko) -> None:  # noqa: ANN001
    fake = FakeSpeko(["eski", "gap", "yangi"])

    async def scenario() -> str:
        server = await fake_speko(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-test-0002", "gemini_live", "t1")
            await stream.feed(b"\x00\x01" * 50)  # the agent's echo, say
            await stream.feed(b"\x00\x01" * 50)
            await stream.reset()  # its final ("eski gap") must not reach the next phrase
            await asyncio.sleep(0.05)
            await stream.feed(b"\x00\x01" * 50)
            heard = await stream.finish(b"")
            await speko_live.close_stream("u1", "sid-test-0002")
            return heard
        finally:
            server.close()

    assert asyncio.run(scenario()) == "yangi"
    assert fake.configures[0]["routing"]["model"] == "gemini-3.5-transcribe-live"


def test_route_checks(client, sql, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    monkeypatch.delenv("SPEKO_API_KEY", raising=False)
    from tests.test_account_routes import _login, _seed  # a signed-in owner

    _seed(sql)
    _login(sql, client)
    form = {"sid": "sid-test-0003", "op": "reset", "engine": "scribe_live"}
    res = client.post("/speech/live", data=form)
    assert (res.status_code, res.json()) == (503, {"error": "engine_not_available"})
    monkeypatch.setenv("SPEKO_API_KEY", "test-key")
    res = client.post("/speech/live", data={**form, "sid": "x"})
    assert (res.status_code, res.json()) == (400, {"error": "bad_session"})
    res = client.post("/speech/live", data={**form, "op": "dance"})
    assert res.status_code in (400, 502)


class ScriptedSpeko(FakeSpeko):
    """Sends a fixed list of deltas, one per audio frame (as Scribe does, including re-guesses)."""

    def __init__(self, deltas: list[str], final: str) -> None:
        super().__init__([])
        self.deltas = deltas
        self.final = final

    async def handler(self, ws) -> None:  # noqa: ANN001
        self.configures.append(json.loads(await ws.recv()))
        await ws.send(
            json.dumps(
                {
                    "type": "session.ready",
                    "request_id": "r",
                    "commit_ids": True,
                    "route": {"provider": "x", "model": "y", "region": "z", "attempt_id": "a"},
                }
            )
        )
        sent = 0
        async for msg in ws:
            if isinstance(msg, bytes):
                if sent < len(self.deltas):
                    await ws.send(json.dumps({"type": "transcript.delta", "text": self.deltas[sent]}))
                    sent += 1
                continue
            event = json.loads(msg)
            if event["type"] == "input.commit":
                final = {"type": "transcript.final", "text": self.final}
                if event.get("commit_id"):
                    final["commit_id"] = event["commit_id"]
                await ws.send(json.dumps(final))
            elif event["type"] == "session.close":
                await ws.send(json.dumps({"type": "session.closed", "usage": {}}))
                return


def test_live_words_never_move_backwards_and_use_one_spelling(fake_speko) -> None:  # noqa: ANN001
    fake = ScriptedSpeko(
        [
            "Кузатув",
            "Kuzatuvchilarning",
            "Kuzatuvchilarning fikricha, bu O‘zbekiston",
            "Kuzatuvchilarning fikricha, bu O’zbek",
            "Kuzatuvchilarning fikri baland",
        ],
        "Kuzatuvchilarning fikricha, bu O‘zbekistonning qadami.",
    )  # fmt: skip

    async def scenario() -> tuple[list[str], str]:
        server = await fake_speko(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-test-0004", "scribe_live", "t1")
            seen = []
            for _ in range(5):
                await stream.feed(b"\x00\x01" * 10)
                await asyncio.sleep(0.03)
                seen.append(await stream.feed(b""))
            final = await stream.finish(b"")
            await speko_live.close_stream("u1", "sid-test-0004")
            return seen, final
        finally:
            server.close()

    seen, final = asyncio.run(scenario())
    assert seen[0] == "Kuzatuv"  # Cyrillic shown in Latin
    assert seen[2] == "Kuzatuvchilarning fikricha, bu O'zbekiston"  # one apostrophe
    assert seen[3] == seen[2]  # a cut-off re-guess keeps the longer text
    assert seen[4] == "Kuzatuvchilarning fikri baland"  # a real change of words replaces it
    assert final == "Kuzatuvchilarning fikricha, bu O'zbekistonning qadami."


class GeminiThroughSpeko(FakeSpeko):
    """
    Gemini through Speko as measured on 2026-11-20: no words while speaking; every commit is
    answered, but the words of a phrase spoken after a commit come back with the NEXT commit (the
    one right after them is answered empty).
    """

    def __init__(self, words: list[str]) -> None:
        super().__init__(words)
        self.owed: list[str] = []  # words heard, not yet sent back

    async def handler(self, ws) -> None:  # noqa: ANN001
        self.configures.append(json.loads(await ws.recv()))
        await ws.send(json.dumps({"type": "session.ready", "request_id": "r", "commit_ids": True, "route": {}}))
        heard: list[str] = []
        commits = 0
        async for msg in ws:
            if isinstance(msg, bytes):
                if msg.strip(b"\x00") and self.said < len(self.words):
                    heard.append(self.words[self.said])
                    self.said += 1
                continue
            event = json.loads(msg)
            if event["type"] == "input.commit":
                commits += 1
                late = commits > 1 and heard  # after the first phrase, its words come one commit late
                text = "" if late else " ".join(heard)
                if late:
                    self.owed, heard = heard, []
                elif not heard and self.owed:
                    text, self.owed = " ".join(self.owed), []
                else:
                    heard = []
                await ws.send(json.dumps({"type": "transcript.final", "text": text, "commit_id": event["commit_id"]}))
            elif event["type"] == "session.close":
                return


def test_a_phrase_that_goes_on_after_the_early_settle_is_heard_whole(fake_speko) -> None:  # noqa: ANN001
    fake = GeminiThroughSpeko(["Hozir", "pulim", "yo'q.", "Lekin", "ertaga", "to'layman."])
    speech, quiet = b"\x00\x40" * 800, b"\x00" * 1600

    async def scenario() -> tuple[str, str, str]:
        server = await fake_speko(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-test-0005", "gemini_live", "t1")
            for _ in range(3):
                await stream.feed(speech)
            await stream.feed(quiet)
            first = await stream.flush(b"")  # the early settle at 0.35 s of quiet
            for _ in range(3):  # ...but the caller goes on
                await stream.feed(speech)
            await stream.feed(quiet)
            second = await stream.flush(b"")  # settled again: answered empty, its words come later
            await stream.feed(quiet)
            whole = await stream.finish(b"")  # only quiet since, yet the words are still owed
            await speko_live.close_stream("u1", "sid-test-0005")
            return first, second, whole
        finally:
            server.close()

    first, second, whole = asyncio.run(scenario())
    assert first == "Hozir pulim yo'q."
    assert second == "Hozir pulim yo'q."
    assert whole == "Hozir pulim yo'q. Lekin ertaga to'layman."


def test_finish_after_a_settle_and_silence_does_not_wait(fake_speko) -> None:  # noqa: ANN001
    fake = FakeSpeko(["Salom", "dunyo"])

    async def scenario() -> tuple[str, float]:
        server = await fake_speko(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-test-0006", "scribe_live", "t1")
            await stream.feed(b"\x00\x40" * 800)
            await stream.feed(b"\x00\x40" * 800)
            await asyncio.sleep(0.05)
            await stream.flush(b"")
            await stream.feed(b"\x00" * 1600)  # quiet only
            loop = asyncio.get_running_loop()
            t = loop.time()
            whole = await stream.finish(b"")
            took = loop.time() - t
            await speko_live.close_stream("u1", "sid-test-0006")
            return whole, took
        finally:
            server.close()

    whole, took = asyncio.run(scenario())
    assert whole == "Salom dunyo" and took < 0.3


class CommitOnly(FakeSpeko):
    """
    Gemini through Speko: no words while speaking; each commit is answered (in order) with the words
    spoken since the commit before, `delay` seconds later; logs every commit it got.
    """

    def __init__(self, words: list[str], delay: float = 0.0) -> None:
        super().__init__(words)
        self.delay = delay
        self.commits: list[str] = []

    async def handler(self, ws) -> None:  # noqa: ANN001
        self.configures.append(json.loads(await ws.recv()))
        await ws.send(json.dumps({"type": "session.ready", "request_id": "r", "commit_ids": True, "route": {}}))
        answers: asyncio.Queue = asyncio.Queue()

        async def answer() -> None:
            while True:
                at, final = await answers.get()
                await asyncio.sleep(max(0.0, at - asyncio.get_running_loop().time()))
                await ws.send(json.dumps(final))

        sender = asyncio.create_task(answer())
        heard: list[str] = []
        try:
            async for msg in ws:
                if isinstance(msg, bytes):
                    if msg.strip(b"\x00") and self.said < len(self.words):
                        heard.append(self.words[self.said])
                        self.said += 1
                    continue
                event = json.loads(msg)
                if event["type"] == "input.commit":
                    self.commits.append(event["commit_id"])
                    final = {"type": "transcript.final", "text": " ".join(heard), "commit_id": event["commit_id"]}
                    heard = []
                    await answers.put((asyncio.get_running_loop().time() + self.delay, final))
                elif event["type"] == "session.close":
                    return
        finally:
            sender.cancel()


SPEECH = b"\x00\x40" * 800  # 50 ms, loud
QUIET = b"\x00" * 3200  # 100 ms


def test_speech_no_turn_took_up_is_not_joined_to_the_next_phrase(fake_speko) -> None:  # noqa: ANN001
    # The end of a sentence said over the agent's voice, too late to interrupt it: the voice detector
    # makes no turn of it. Its words must not open the caller's next phrase (seen in the Playground on
    # 2026-11-20: "olganimda to'layman. Hozir pulim yo'q...").
    fake = CommitOnly(["olganimda", "to'layman.", "Hozir", "pulim", "yo'q."])

    async def scenario() -> tuple[str, int, str, str]:
        server = await fake_speko(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-test-0007", "gemini_live", "t1")
            await stream.reset()  # open
            await stream.reset()  # the agent finished: listening
            for _ in range(2):
                await stream.feed(SPEECH)  # the rest of the sentence
            for _ in range(7):
                await stream.feed(QUIET)  # 0.6 s of quiet with no commit: committed on its own
            await asyncio.sleep(0.05)
            shown = await stream.feed(b"")
            commits = len(fake.commits)
            started = await stream.begin()  # the caller starts a new phrase
            for _ in range(3):
                await stream.feed(SPEECH)
            await stream.feed(QUIET)
            heard = await stream.finish(b"")
            await speko_live.close_stream("u1", "sid-test-0007")
            return shown, commits, started, heard
        finally:
            server.close()

    shown, commits, started, heard = asyncio.run(scenario())
    assert shown == "olganimda to'layman."  # its words came back on their own
    assert commits == 2  # the reset, and the one after the quiet
    assert started == ""
    assert heard == "Hozir pulim yo'q."


def test_late_answers_to_commits_before_a_reset_never_reach_the_next_phrase(
    fake_speko, monkeypatch: pytest.MonkeyPatch
) -> None:  # noqa: ANN001
    # Speko answers commits after silence slowly (about 2.2 s); two resets in a row: the answer to the
    # first, carrying the old audio's words, comes after the second reset's moment has passed.
    monkeypatch.setattr(speko_live, "RESET_DROP_S", 0.05)
    fake = CommitOnly(["eski", "gap", "yangi", "gap"], delay=0.25)

    async def scenario() -> str:
        server = await fake_speko(fake)
        try:
            stream = await speko_live.stream_for("u1", "sid-test-0008", "gemini_live", "t1")
            await stream.reset()  # open
            await stream.feed(SPEECH)  # said over the agent; the turn went by the recording
            await stream.feed(SPEECH)
            await stream.reset()  # the phrase ended
            await asyncio.sleep(0.1)
            await stream.reset()  # the reply starts
            await asyncio.sleep(0.4)  # both answers arrive, well after the drop moment
            await stream.feed(SPEECH)
            await stream.feed(SPEECH)
            heard = await stream.finish(b"")
            await speko_live.close_stream("u1", "sid-test-0008")
            return heard
        finally:
            server.close()

    assert asyncio.run(scenario()) == "yangi gap"
