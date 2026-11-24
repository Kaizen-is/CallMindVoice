"""
What the speech layer is told beyond the audio and the text: the names and terms an agent's calls
should expect (GAPI `vocabulary`, Whisper `prompt`) and the agent's speaking speed (own TTS server).
"""

import asyncio
import math
import struct
from collections.abc import Iterator

import httpx
import pytest

from app import http
from app.speech import stt, tts, vocabulary
from app.speech.vocabulary import echoes_prompt, knowledge_names, recognition_words, whisper_prompt
from app.voices import ResolvedVoice

NOW = "2026-11-19T00:00:00.000Z"


class _Seen(list):
    """Every outgoing request; `answer[0]` makes the response (set per test)."""

    def __init__(self) -> None:
        super().__init__()
        self.answer: list = [lambda request: httpx.Response(200, json={})]


@pytest.fixture
def transport() -> Iterator[_Seen]:
    seen = _Seen()

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return seen.answer[0](request)

    http.set_transport(httpx.MockTransport(handler))
    try:
        yield seen
    finally:
        http.set_transport(None)


def _speech_wav() -> bytes:
    """Half a second of a loud tone: not silence, so the recognisers are asked."""
    pcm = struct.pack("<4000h", *(int(12000 * math.sin(i / 3)) for i in range(4000)))
    return tts.pcm_to_wav(pcm, 8000)


def _field(request: httpx.Request, name: str) -> str | None:
    """A text field of a multipart request body."""
    body = request.content.decode("utf-8", "replace")
    marker = f'name="{name}"\r\n\r\n'
    if marker not in body:
        return None
    return body.split(marker, 1)[1].split("\r\n--", 1)[0]


# ── which names a knowledge base keeps using ────────────────────────


def test_knowledge_names_finds_names_and_abbreviations() -> None:
    texts = [
        "Kartangizni BRB ilovasida ochasiz. Bizning Mastercard kartasi uchun Chilonzor filialiga keling.",
        "Bizda Mastercard va Visa kartalari bor. Bu Chilonzor filiali har kuni ishlaydi. BRB ilovasi bepul.",
        "Biz Visa kartasini ham beramiz. Kartalar haqida so'rang. BRB sizni kutadi.",
    ]
    names = knowledge_names(texts)
    # BRB three times (anywhere); Mastercard, Chilonzor, Visa twice each mid-sentence, in order of first use.
    assert names == ["BRB", "Mastercard", "Chilonzor", "Visa"]


def test_knowledge_names_skips_sentence_starts_and_common_words() -> None:
    texts = [
        "Kredit olish oson. Kredit uchun pasport kerak.",  # only ever at a sentence start
        "Siz kredit olasiz. Biz Kredit beramiz va Kredit hisoblaymiz.",  # also written in lower case
        "Ahmad aka bilan gaplashing.",  # once only
        "Telefon: 1234. Telefon: 5678.",  # after a colon is a new phrase
    ]
    assert knowledge_names(texts) == []


def test_knowledge_names_keeps_uzbek_apostrophes_and_cyrillic() -> None:
    texts = ["Biz O‘zbekiston bo‘ylab va O‘zbekiston tashqarisida. Карта Сбербанк и снова Сбербанк."]
    assert knowledge_names(texts) == ["O‘zbekiston", "Сбербанк"]


def _seed(sql, *, chunks: list[str]) -> None:  # noqa: ANN001
    sql(
        "INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)",
        "t1",
        "Ipak Yo‘li Bank",
        "ipak",
        NOW,
        NOW,
    )
    sql(
        "INSERT INTO documents (id, tenant_id, title, source_type, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        "d1",
        "t1",
        "FAQ",
        "txt",
        "ready",
        NOW,
        NOW,
    )
    for i, text in enumerate(chunks):
        sql(
            "INSERT INTO chunks (id, tenant_id, document_id, ordinal, text, created_at) VALUES (?,?,?,?,?,?)",
            f"c{i}",
            "t1",
            "d1",
            i,
            text,
            NOW,
        )


def test_recognition_words_agent_then_company_then_knowledge(data_dir, sql) -> None:  # noqa: ANN001
    vocabulary._cache.clear()
    _seed(sql, chunks=["Bizda Humo va Uzcard bor.", "Bizning Humo kartasi, Uzcard kartasi va Ipak ilovasi."])
    words = recognition_words("t1", {"name": "Laylo"})
    assert words == ["Laylo", "Ipak Yo‘li Bank", "Humo", "Uzcard"]


def test_recognition_words_follow_knowledge_changes(data_dir, sql) -> None:  # noqa: ANN001
    vocabulary._cache.clear()
    _seed(sql, chunks=["Bizda Humo bor. Yana Humo bor."])
    assert recognition_words("t1") == ["Ipak Yo‘li Bank", "Humo"]
    sql("UPDATE chunks SET text = 'Bizda Payme bor. Yana Payme bor.'")
    assert recognition_words("t1") == ["Ipak Yo‘li Bank", "Humo"]  # cached: no document changed
    sql("UPDATE documents SET updated_at = '2026-11-19T01:00:00.000Z'")
    assert recognition_words("t1") == ["Ipak Yo‘li Bank", "Payme"]


def test_recognition_words_never_raise(data_dir, sql) -> None:  # noqa: ANN001
    vocabulary._cache.clear()
    sql("DROP TABLE chunks")
    assert recognition_words("t1", {"name": "Laylo"}) == []


def test_recognition_words_cap_and_dedupe(data_dir, sql) -> None:  # noqa: ANN001
    vocabulary._cache.clear()
    many = " ".join(f"bu Nom{chr(65 + i)}x va Nom{chr(65 + i)}x." for i in range(25))
    _seed(sql, chunks=[many])
    words = recognition_words("t1", {"name": "ipak yo‘li bank"})
    assert len(words) == 20
    assert words[0] == "ipak yo‘li bank" and "Ipak Yo‘li Bank" not in words


def test_whisper_prompt_and_echo() -> None:
    prompt = whisper_prompt(["Laylo", "BRB", "Mastercard", "Chilonzor"])
    assert prompt == "Laylo, BRB, Mastercard, Chilonzor."
    assert whisper_prompt([]) == "" and whisper_prompt(None) == ""
    assert echoes_prompt("Laylo, BRB, Mastercard.", prompt)
    assert echoes_prompt("brb mastercard chilonzor", prompt)
    assert not echoes_prompt("BRB Mastercard", prompt)  # two words may well be real speech
    assert not echoes_prompt("Mastercard kartam yo'qoldi", prompt)
    assert not echoes_prompt("Laylo BRB Mastercard", "")


# ── the recognisers receive the words ───────────────────────────────


def test_whisper_gets_the_prompt(data_dir, monkeypatch, transport) -> None:  # noqa: ANN001
    monkeypatch.setenv("WHISPER_TRANSCRIBE_URL", "http://whisper.test/v1/audio/transcriptions")
    transport.answer[0] = lambda request: httpx.Response(200, json={"text": "Mastercard kartam", "language": "uz"})
    heard = asyncio.run(stt.transcribe(_speech_wav(), language="uz", vocabulary=["Laylo", "Mastercard"]))
    assert heard["text"] == "Mastercard kartam"
    (request,) = transport
    assert _field(request, "prompt") == "Laylo, Mastercard."


def test_whisper_without_words_sends_no_prompt(data_dir, monkeypatch, transport) -> None:  # noqa: ANN001
    monkeypatch.setenv("WHISPER_TRANSCRIBE_URL", "http://whisper.test/v1/audio/transcriptions")
    transport.answer[0] = lambda request: httpx.Response(200, json={"text": "salom"})
    asyncio.run(stt.transcribe(_speech_wav(), language="uz"))
    assert _field(transport[0], "prompt") is None


def test_whisper_repeating_its_prompt_counts_as_not_heard(data_dir, monkeypatch, transport) -> None:  # noqa: ANN001
    monkeypatch.setenv("WHISPER_TRANSCRIBE_URL", "http://whisper.test/v1/audio/transcriptions")
    transport.answer[0] = lambda request: httpx.Response(200, json={"text": "Laylo, BRB, Mastercard."})
    heard = asyncio.run(stt.transcribe(_speech_wav(), language="uz", vocabulary=["Laylo", "BRB", "Mastercard"]))
    assert heard["text"] == ""


def test_gapi_gets_the_vocabulary(data_dir, monkeypatch, transport) -> None:  # noqa: ANN001
    monkeypatch.setenv("GAPI_API_KEY", "gapi-test")
    transport.answer[0] = lambda request: httpx.Response(200, json={"text": "humo karta", "language": {"code": "uz"}})
    asyncio.run(stt.transcribe(_speech_wav(), language="uz", engine="gapi", vocabulary=["Humo", "Uzcard"]))
    (request,) = transport
    assert _field(request, "vocabulary") == '["Humo","Uzcard"]'


# ── the agent's speaking speed ──────────────────────────────────────


@pytest.mark.parametrize(
    ("rate", "speed"),
    [(1.0, None), (1, None), (1.2, 1.2), (0.7, 0.7), (3, 2.0), (0.2, 0.5), (0, None), (-1, None), (None, None),
     ("1.2", None), (True, None), (math.nan, None), (math.inf, None)],
)  # fmt: skip
def test_speaking_speed(rate, speed) -> None:  # noqa: ANN001
    assert tts.speaking_speed({"speaking_rate": rate}) == speed


def test_speaking_speed_without_agent() -> None:
    assert tts.speaking_speed(None) is None
    assert tts.speaking_speed({}) is None


def test_cache_key_keeps_old_keys_at_normal_pace() -> None:
    voice = ResolvedVoice("speaker", speaker="laylo")
    normal = tts.cache_key("Salom.", voice)
    assert tts.cache_key("Salom.", voice, speed=None) == normal
    assert tts.cache_key("Salom.", voice, speed=1.2) != normal
    assert tts.cache_key("Salom.", voice, speed=1.2) != tts.cache_key("Salom.", voice, speed=1.25)


def test_own_tts_server_gets_the_speed(data_dir, monkeypatch, transport) -> None:  # noqa: ANN001
    monkeypatch.setenv("TTS_BASE_URL", "http://tts.test")
    monkeypatch.setenv("TTS_JWT_TOKEN", "jwt-test")
    transport.answer[0] = lambda request: httpx.Response(200, content=b"\x01\x00" * 800)
    opts = tts.SynthOptions(tenant_id="t1", voice_id="laylo", language="uz", speed=1.2)
    asyncio.run(tts.synthesize_pcm("Salom.", opts))
    asyncio.run(tts.synthesize_pcm("Salom.", tts.SynthOptions(tenant_id="t1", voice_id="laylo", language="uz")))
    fast, normal = transport
    assert _field(fast, "speed") == "1.2"
    assert _field(normal, "speed") is None
