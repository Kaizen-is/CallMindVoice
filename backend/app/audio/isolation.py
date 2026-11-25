"""
Voice isolation: keep the primary speaker, suppress competing voices. Pluggable providers.

Provider "inworld" — Inworld voice-isolator (Apache-2.0 code and weights, 48 kHz mono, PyTorch,
offline 64M / realtime 58M parameters). It needs torch and downloads its weights from Hugging Face,
so it runs as a separate sidecar (`tools/voice_isolator_sidecar.py`) instead of inside this process;
this provider posts the clip to it. Its own model card: it keeps the LOUDER voice and is "not a
speaker selector" — dominant-speaker isolation, not identification of the caller.

Other candidates checked (Nov 2026), not wired up:
  - Krisp VIVA (voice isolation incl. background voices, CPU, ~20 ms): SDK and .kef models by
    request through the Krisp developer portal.
  - NVIDIA Maxine AFX Speaker Focus (removes other speakers, 16/48 kHz): early access, NVIDIA GPU,
    C++ SDK.
A new provider implements `VoiceIsolationProcessor` (app/audio/types.py) and joins PROVIDERS.

Model rates: a 48 kHz model given 16 kHz audio gets it upsampled, which restores no high band, and
8 kHz phone audio even less; the stage says so in its notes. The STT lab sends files at their own
rate so the model sees the full band.
"""

import logging
import time
from urllib.parse import urljoin

import numpy as np

from app import http
from app.audio.dsp import level_db, resample, to_wav
from app.audio.types import StageResult
from app.env import env
from app.speech.wav import decode_wav

log = logging.getLogger("callmind.audio.isolation")


def timeout_s() -> float:
    try:
        return max(0.2, int(env("VOICE_ISOLATION_TIMEOUT_MS", "1500")) / 1000)
    except ValueError:
        return 1.5


class InworldSidecar:
    """POST /isolate (multipart `file`, a WAV) → the isolated WAV, at VOICE_ISOLATION_URL."""

    name = "inworld"
    native_rates = (48000,)

    @property
    def model(self) -> str:
        return env("VOICE_ISOLATION_MODEL", "inworld/voice-isolator")

    def available(self) -> bool:
        return bool(env("VOICE_ISOLATION_URL"))

    async def process_clip(self, samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, StageResult]:
        stage = StageResult(
            "voice_isolation",
            "failed",
            provider=self.name,
            model=self.model,
            sample_rate_in=sample_rate,
            level_in_db=level_db(samples),
        )
        rate = self.native_rates[0]
        if sample_rate < rate:
            stage.notes.append(
                f"input is {sample_rate} Hz; the model runs at {rate} Hz: upsampled, the missing band is not restored"
            )
        if sample_rate <= 8000:
            stage.notes.append("telephone audio: no telephony-specific isolation model is configured")
        started = time.perf_counter()
        try:
            audio = resample(samples, sample_rate, rate)
            url = urljoin(env("VOICE_ISOLATION_URL"), "/isolate")
            res = await http.client().post(
                url,
                files=[("file", ("speech.wav", to_wav(audio, rate), "audio/wav"))],
                data={"model": self.model},
                timeout=timeout_s(),
            )
            if not res.is_success:
                raise RuntimeError(f"isolator_{res.status_code}")
            out, out_rate = decode_wav(res.content)
            out = resample(out, out_rate, sample_rate)
            # Same length as the input, so the original and isolated waveforms line up.
            if len(out) >= len(samples):
                out = out[: len(samples)]
            else:
                out = np.concatenate([out, np.zeros(len(samples) - len(out), dtype=np.float32)])
            stage.status = "ran"
            stage.sample_rate_out = sample_rate
            stage.level_out_db = level_db(out)
            return out.astype(np.float32), stage
        except Exception as err:  # noqa: BLE001
            stage.error = str(err) or type(err).__name__
            stage.sample_rate_out = sample_rate
            log.warning("[isolation] %s failed: %s", self.name, stage.error)
            return samples, stage
        finally:
            stage.ms = (time.perf_counter() - started) * 1000


PROVIDERS = {"inworld": InworldSidecar()}


def provider(name: str | None = None):  # noqa: ANN201
    """The configured provider (VOICE_ISOLATION_PROVIDER, default inworld), or None if unknown."""
    return PROVIDERS.get(name or env("VOICE_ISOLATION_PROVIDER", "inworld"))
