"""
The TTS layer — port of src/lib/speech/tts.ts. Every voice is rendered here:
the own TTS server's `generate_v2/stream` (8 kHz s16le as it is generated) or
ElevenLabs through Speko. On top of it:

1. A disk cache shared with the TypeScript app: `data/tts-cache/<sha1>.pcm`,
   sha1 over `spoken text + ' ' + voice descriptor`, written tmp + rename. The
   same line renders once for both apps.
2. Streaming: `synthesize_stream` splits the reply into sentences and hands each
   on in pieces as the server produces them.
3. Telephone-native output: 8 kHz mono signed-16 PCM unless a web page asked
   ElevenLabs for more.
"""

import asyncio
import hashlib
import logging
import os
import struct
import time
from collections.abc import AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from pathlib import Path

import regex as re

from app import http
from app.config import get_settings
from app.env import env, env_raw
from app.jscompat import js_number_str, js_round, js_trim, utf16_len
from app.speech import brb, speko
from app.speech.normalize import normalize_for_speech, split_for_speech
from app.streams import error_body, read_until
from app.usage_log import UsageEntry, record_usage
from app.voices import ResolvedVoice, build_tts_form, resolve_voice

log = logging.getLogger("callmind.tts")

SAMPLE_RATE = 8000
WEB_SAMPLE_RATES = (8000, 16000, 24000)
BYTES_PER_SAMPLE = 2


class TtsError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


# ── configuration ───────────────────────────────────────────────────


def _internal_configured() -> bool:
    return bool(env("TTS_BASE_URL") and (env("TTS_CLIENT_SECRET") or env("TTS_JWT_TOKEN")))


def tts_engines() -> dict[str, bool]:
    """Which engines this deployment can run (`default` = the own TTS server, `brb` = our model via the VPN)."""
    ready = speko.speko_configured()
    return {
        "default": _internal_configured(),
        "brb": brb.brb_configured(),
        **{m: ready for m in speko.SPEKO_TTS_MODELS},
    }


def is_tts_engine(value: object) -> bool:
    return value in ("default", "brb") or value in speko.SPEKO_TTS_MODELS


def tts_configured(engine: str = "default") -> bool:
    return tts_engines().get(engine, False)


def _base_url() -> str:
    base = env("TTS_BASE_URL")
    if not base:
        raise TtsError("tts_not_configured", 503)
    return re.sub(r"/+$", "", base)


# ── auth: mint and cache the service JWT ────────────────────────────

_token: tuple[str, float] | None = None  # (token, expires at, epoch seconds)


async def _tts_token() -> str:
    global _token
    secret = env("TTS_CLIENT_SECRET")
    if not secret:
        fixed = js_trim(env_raw("TTS_JWT_TOKEN") or "")
        if not fixed:
            raise TtsError("tts_not_configured", 503)
        return fixed
    if _token and time.time() < _token[1]:
        return _token[0]
    from app.jscompat import js_json

    async with asyncio.timeout(10):
        res = await http.client().post(
            f"{_base_url()}/api/v1/auth/token",
            headers={"Content-Type": "application/json"},
            content=js_json({"client_id": env("TTS_CLIENT_ID", "frontend"), "client_secret": secret}).encode(),
        )
    if not res.is_success:
        log.warning("[tts] auth %s: %s", res.status_code, res.text[:160])
        raise TtsError("tts_auth_failed", 502)
    data = res.json()
    # Refresh two minutes early so a token never expires mid-call.
    _token = (data["access_token"], time.time() + (data["expires_in"] - 120))
    return _token[0]


# ── options ─────────────────────────────────────────────────────────


@dataclass
class SynthOptions:
    tenant_id: str
    voice_id: str | None = None
    language: str | None = None
    # Short label for upstream tracing.
    tag: str | None = None
    # Cache the result on disk: right for fixed lines and recurring sentences.
    cache: bool = False
    # `default` (own server) or an ElevenLabs model through Speko.
    engine: str = "default"
    # ElevenLabs only: the web asks for 24 kHz; phone calls leave it unset (8 kHz).
    sample_rate: int | None = None
    # First 0.1 s of audio out at once, then 0.25 s pieces (the audio itself is identical).
    quick_start: bool = False


def output_rate(engine: str = "default", sample_rate: int | None = None) -> int:
    """8 kHz unless an ElevenLabs model was asked for one of the web rates."""
    if (engine or "default") == "default" or not sample_rate:
        return SAMPLE_RATE
    return sample_rate if sample_rate in WEB_SAMPLE_RATES else SAMPLE_RATE


def _rate(opts: SynthOptions) -> int:
    return output_rate(opts.engine, opts.sample_rate)


# ── the network: one render, as a stream of PCM pieces ──────────────

FIRST_PIECE_BYTES = 4000  # 0.25 s
PIECE_BYTES = 8000  # 0.5 s
QUICK_FIRST_PIECE_BYTES = 1600  # 0.1 s
QUICK_PIECE_BYTES = 4000  # 0.25 s


async def _stream_pcm(text: str, voice: ResolvedVoice, quick_start: bool = False) -> AsyncIterator[bytes]:
    """`generate_v2/stream`: raw 8 kHz s16le (`format=l16`) sent as it is generated."""
    first_piece = QUICK_FIRST_PIECE_BYTES if quick_start else FIRST_PIECE_BYTES
    piece = QUICK_PIECE_BYTES if quick_start else PIECE_BYTES
    token = await _tts_token()
    # The stream keeps no file to download, so it needs no user_id or phone.
    parts = [p for p in build_tts_form(user_id="stream", text=text, voice=voice) if p[0] not in ("user_id", "phone")]
    parts.append(("format", "l16"))
    if env("TTS_STREAM_CHUNK_SEC"):
        parts.append(("chunk_sec", env("TTS_STREAM_CHUNK_SEC")))  # smaller pieces start sooner; server default 2 s
    deadline = asyncio.get_running_loop().time() + 60
    res = await http.open_stream(
        "POST",
        f"{_base_url()}/api/v1/tts/generate_v2/stream",
        deadline,
        headers={"Authorization": f"Bearer {token}"},
        files=http.multipart(parts),
    )
    try:
        if not res.is_success:
            log.warning("[tts] stream %s: %s", res.status_code, await error_body(res, 160))
            raise TtsError("tts_stream_failed", 502)
        # A stream cut short raises while reading, so reaching the end means the audio is complete.
        async for out in speko.pcm_pieces(read_until(res, deadline), first_piece, piece):
            yield out
    finally:
        await res.aclose()


async def _brb_pcm(text: str, rate: int) -> AsyncIterator[bytes]:
    """The BRB proxy answers with the whole WAV: decoded to mono PCM at `rate`, handed on in half-second pieces."""
    try:
        wav = await brb.brb_speech(text)
    except brb.BrbError as err:
        raise TtsError(str(err), err.status) from err
    pcm = wav_to_pcm(wav, rate)
    for at in range(0, len(pcm), rate):  # 16-bit mono: `rate` bytes are half a second
        yield pcm[at : at + rate]


async def _raw_engine_pcm(text: str, voice: ResolvedVoice, opts: SynthOptions) -> AsyncIterator[bytes]:
    engine = opts.engine or "default"
    if engine == "default":
        async with aclosing(_stream_pcm(text, voice, opts.quick_start)) as pieces:
            async for piece in pieces:
                yield piece
        return
    if engine == "brb":
        async with aclosing(_brb_pcm(text, _rate(opts))) as pieces:
            async for piece in pieces:
                yield piece
        return
    try:
        async with aclosing(
            speko.speko_stream_pcm(
                text, engine, opts.language or "uz", speko.eleven_voice(opts.voice_id), _rate(opts), opts.quick_start
            )
        ) as pieces:
            async for piece in pieces:
                yield piece
    except speko.SpekoError as err:
        raise TtsError(str(err), err.status) from err


async def _engine_pcm(text: str, voice: ResolvedVoice, opts: SynthOptions) -> AsyncIterator[bytes]:
    """The PCM stream with one usage row per render; a render stopped early (barge-in) counts as done."""
    engine = opts.engine or "default"
    started = time.perf_counter()
    first_ms: float | None = None
    size = 0
    error: str | None = None
    try:
        async with aclosing(_raw_engine_pcm(text, voice, opts)) as pieces:
            async for piece in pieces:
                if first_ms is None:
                    first_ms = (time.perf_counter() - started) * 1000
                size += len(piece)
                yield piece
    except Exception as err:
        error = str(err) or type(err).__name__
        raise
    finally:
        record_usage(
            UsageEntry(
                kind="tts",
                engine=engine,
                model=None if engine == "default" else engine,
                ms=(time.perf_counter() - started) * 1000,
                first_ms=first_ms,
                audio_ms=(size / (_rate(opts) * BYTES_PER_SAMPLE)) * 1000,
                chars=utf16_len(text),
                ok=error is None,
                error=error,
                tenant_id=opts.tenant_id,
            )
        )


async def _render_pcm(text: str, voice: ResolvedVoice, opts: SynthOptions) -> bytes:
    parts = [piece async for piece in _engine_pcm(text, voice, opts)]
    if not parts:
        raise TtsError("tts_empty_audio", 502)
    return b"".join(parts)


# ── the disk cache ──────────────────────────────────────────────────


def mtime_ms(path: str) -> float:
    """Node's `fs.statSync(path).mtimeMs`: seconds * 1e3 + nanoseconds / 1e6, in doubles."""
    sec, nsec = divmod(os.stat(path).st_mtime_ns, 1_000_000_000)
    return sec * 1e3 + nsec / 1e6


def cache_key(
    text: str, voice: ResolvedVoice, engine: str = "default", voice_id: str | None = None, rate: int = SAMPLE_RATE
) -> str:
    """
    The exact text plus the exact voice. A clone is keyed by its sample's path and mtime, so
    replacing the sample invalidates every line rendered from the old one.
    """
    h = hashlib.sha1()
    h.update(text.encode("utf-8", "surrogatepass"))
    h.update(b" ")
    # The BRB model has one voice: only the sample rate (when not 8 kHz) keys it.
    if engine == "brb":
        h.update(f"brb{'' if rate == SAMPLE_RATE else f':{rate}'}".encode())
        return h.hexdigest()
    # ElevenLabs renders ignore the internal voice: the model, voice and (when not 8 kHz) rate key them.
    if engine != "default":
        suffix = "" if rate == SAMPLE_RATE else f":{rate}"
        h.update(f"speko:{engine}:{speko.eleven_voice(voice_id)}{suffix}".encode())
        return h.hexdigest()
    if voice.kind == "speaker":
        h.update(f"speaker:{voice.speaker}".encode())
    elif voice.kind == "design":
        h.update(f"design:{voice.design}".encode())
    else:
        try:
            stamp = js_number_str(mtime_ms(voice.ref_audio_path))
        except OSError:
            stamp = ""  # a missing sample keys stably; the render will fail loudly
        h.update(f"clone:{voice.ref_audio_path}:{stamp}:{voice.ref_text}".encode())
    return h.hexdigest()


def cache_dir() -> Path:
    return get_settings().callmind_data_dir / "tts-cache"


def _cache_read(key: str) -> bytes | None:
    try:
        return (cache_dir() / f"{key}.pcm").read_bytes()
    except OSError:
        return None


def _cache_write(key: str, pcm: bytes) -> None:
    try:
        folder = cache_dir()
        folder.mkdir(parents=True, exist_ok=True)
        # Write-then-rename so a concurrent reader never sees a half-written file.
        tmp = folder / f"{key}.{os.getpid()}.tmp"
        tmp.write_bytes(pcm)
        os.replace(tmp, folder / f"{key}.pcm")
    except OSError as err:
        log.warning("[tts] cache write failed: %s", err)


def _key_for(spoken: str, voice: ResolvedVoice, opts: SynthOptions) -> str:
    return cache_key(spoken, voice, opts.engine or "default", opts.voice_id, _rate(opts))


# ── public API ──────────────────────────────────────────────────────


async def synthesize_pcm(text: str, opts: SynthOptions) -> bytes:
    """Render `text` to mono PCM at the output rate, consulting the disk cache when asked."""
    spoken = normalize_for_speech(text, opts.language or "uz")
    if not spoken:
        raise TtsError("empty_text", 400)
    voice = resolve_voice(opts.tenant_id, opts.voice_id)
    if opts.cache:
        key = _key_for(spoken, voice, opts)
        hit = _cache_read(key)
        if hit:
            return hit
        pcm = await _render_pcm(spoken, voice, opts)
        _cache_write(key, pcm)
        return pcm
    return await _render_pcm(spoken, voice, opts)


def cached_pcm(text: str, opts: SynthOptions) -> bytes | None:
    """The disk-cached rendering of `text`, or None. Never renders."""
    spoken = normalize_for_speech(text, opts.language or "uz")
    if not spoken:
        return None
    return _cache_read(_key_for(spoken, resolve_voice(opts.tenant_id, opts.voice_id), opts))


async def render_timed(text: str, opts: SynthOptions) -> dict:
    """One uncached render, timed — for the model lab. {pcm, firstMs, totalMs, spoken}."""
    spoken = normalize_for_speech(text, opts.language or "uz")
    if not spoken:
        raise TtsError("empty_text", 400)
    voice = resolve_voice(opts.tenant_id, opts.voice_id)
    started = time.perf_counter()
    first_ms = 0.0
    parts: list[bytes] = []
    async for piece in _engine_pcm(spoken, voice, opts):
        if not parts:
            first_ms = (time.perf_counter() - started) * 1000
        parts.append(piece)
    if not parts:
        raise TtsError("tts_empty_audio", 502)
    return {
        "pcm": b"".join(parts),
        "firstMs": first_ms,
        "totalMs": (time.perf_counter() - started) * 1000,
        "spoken": spoken,
    }


async def synthesize_wav(text: str, opts: SynthOptions) -> bytes:
    return pcm_to_wav(await synthesize_pcm(text, opts), _rate(opts))


async def synthesize_stream(text: str, opts: SynthOptions) -> AsyncIterator[bytes]:
    """
    PCM pieces in reading order, sentence by sentence, each as the server produces it. Cached
    sentences come from disk; a streamed one is cached once complete (a stream cut short raises,
    so a partial line is never cached).
    """
    spoken = normalize_for_speech(text, opts.language or "uz")
    if not spoken:
        return
    voice = resolve_voice(opts.tenant_id, opts.voice_id)
    for chunk in split_for_speech(spoken):
        key = _key_for(chunk, voice, opts) if opts.cache else None
        hit = _cache_read(key) if key else None
        if hit:
            yield hit
            continue
        parts: list[bytes] = []
        async with aclosing(_engine_pcm(chunk, voice, opts)) as pieces:
            async for piece in pieces:
                parts.append(piece)
                yield piece
        if key and parts:
            _cache_write(key, b"".join(parts))


# ── container helpers ───────────────────────────────────────────────


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Raw mono 16-bit PCM in a canonical 44-byte WAV header."""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        1,  # mono
        sample_rate,
        sample_rate * BYTES_PER_SAMPLE,
        BYTES_PER_SAMPLE,
        16,
        b"data",
        len(pcm),
    )
    return header + pcm


def wav_to_pcm8k(buf: bytes) -> bytes:
    """Any WAV the TTS returns → 8 kHz mono 16-bit PCM (not a WAV: assumed raw already)."""
    return wav_to_pcm(buf, SAMPLE_RATE)


def wav_to_pcm(buf: bytes, rate: int) -> bytes:
    """A WAV → mono 16-bit PCM at `rate` (anything that is not a WAV is passed through)."""
    if len(buf) < 44 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        return buf
    offset = 12
    fmt: tuple[int, int, int] | None = None
    data: bytes | None = None
    while offset + 8 <= len(buf):
        chunk_id = buf[offset : offset + 4]
        size = struct.unpack_from("<I", buf, offset + 4)[0]
        body = buf[offset + 8 : offset + 8 + size]
        if chunk_id == b"fmt " and len(body) >= 16:
            fmt = (
                struct.unpack_from("<H", body, 2)[0],
                struct.unpack_from("<I", body, 4)[0],
                struct.unpack_from("<H", body, 14)[0],
            )
        elif chunk_id == b"data":
            data = body
        offset += 8 + size + (size % 2)  # chunks are word-aligned
        if fmt and data is not None:
            break
    if data is None:
        return b""
    if not fmt or fmt[2] != 16:
        return data
    pcm = data
    if fmt[0] == 2:
        pcm = _downmix_stereo16(pcm)
    if fmt[1] != rate:
        pcm = _resample16(pcm, fmt[1], rate)
    return pcm


def _downmix_stereo16(pcm: bytes) -> bytes:
    frames = len(pcm) // 4
    samples = struct.unpack_from(f"<{frames * 2}h", pcm)
    return struct.pack(f"<{frames}h", *((samples[2 * i] + samples[2 * i + 1]) >> 1 for i in range(frames)))


def _resample16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Linear-interpolation resample of 16-bit mono PCM."""
    src_n = len(pcm) // 2
    if src_n < 2:
        return pcm
    src = struct.unpack_from(f"<{src_n}h", pcm)
    dst_n = max(1, (src_n * dst_rate) // src_rate)
    out = []
    for i in range(dst_n):
        pos = (i * src_rate) / dst_rate
        i0 = int(pos)
        i1 = min(i0 + 1, src_n - 1)
        frac = pos - i0
        s0, s1 = src[i0], src[i1]
        out.append(max(-32768, min(32767, js_round(s0 + (s1 - s0) * frac))))
    return struct.pack(f"<{dst_n}h", *out)
