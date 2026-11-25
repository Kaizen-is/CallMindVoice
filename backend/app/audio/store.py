"""
Short-lived storage for processed clips (the STT lab's playback and downloads).

In memory only, never on disk: each clip belongs to the tenant and user who made it, expires after
CLIP_TTL_S, and the store is bounded (oldest first out). Nothing survives a restart.
"""

import secrets
import threading
import time
from dataclasses import dataclass

CLIP_TTL_S = 15 * 60
MAX_CLIPS = 200
MAX_BYTES = 256 * 1024 * 1024


@dataclass
class _Clip:
    owner: str
    wav: bytes
    expires: float


_lock = threading.Lock()
_clips: dict[str, _Clip] = {}


def _purge(now: float) -> None:
    for key in [k for k, c in _clips.items() if c.expires <= now]:
        del _clips[key]
    total = sum(len(c.wav) for c in _clips.values())
    while _clips and (len(_clips) > MAX_CLIPS or total > MAX_BYTES):
        oldest = min(_clips, key=lambda k: _clips[k].expires)
        total -= len(_clips[oldest].wav)
        del _clips[oldest]


def put(owner: str, wav: bytes) -> str:
    token = secrets.token_urlsafe(18)
    now = time.time()
    with _lock:
        _clips[token] = _Clip(owner, wav, now + CLIP_TTL_S)
        _purge(now)
    return token


def get(owner: str, token: str) -> bytes | None:
    """The clip, only for its owner and only before it expires."""
    with _lock:
        _purge(time.time())
        clip = _clips.get(token)
        return clip.wav if clip and secrets.compare_digest(clip.owner, owner) else None


def clear() -> None:
    with _lock:
        _clips.clear()
