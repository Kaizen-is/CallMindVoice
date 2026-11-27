"""
L7: how the in-app live recogniser (Zipformer) holds up with several callers at once.

N simulated callers each stream the same recorded phrase in real time (a 100 ms piece every 100 ms, as
the Playground does) into their own live session, all at once, in threads — the way the API's worker
threads call it. Reported: how long a piece takes to come back with the words (median, 95th percentile,
worst) for each N. Every session shares one model; the question is how much they wait for each other.

  python tools/live_load.py --pcm <16 kHz mono PCM file> [--callers 1,4,8]
"""

import argparse
import os
import statistics
import sys
import threading
import time
import uuid
from pathlib import Path

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from app.speech import zipformer  # noqa: E402

PIECE = 1600  # 100 ms at 16 kHz


def caller(samples: np.ndarray, took: list[float], texts: list[str], start: threading.Event) -> None:
    sid = f"load-{uuid.uuid4().hex[:12]}"
    start.wait()
    next_at = time.perf_counter()
    for i in range(0, len(samples), PIECE):
        t = time.perf_counter()
        zipformer.feed_live("load", sid, samples[i : i + PIECE])
        took.append((time.perf_counter() - t) * 1000)
        next_at += PIECE / 16000
        time.sleep(max(0.0, next_at - time.perf_counter()))
    texts.append(zipformer.finish_live("load", sid))
    zipformer.close_live("load", sid)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pcm", required=True)
    ap.add_argument("--callers", default="1,4,8")
    args = ap.parse_args()
    raw = np.frombuffer(Path(args.pcm).read_bytes(), dtype="<i2").astype(np.float32) / 32768
    samples = np.concatenate([raw, np.zeros(8000, dtype=np.float32)])
    zipformer.feed_live("load", "warm-up-session", samples[:PIECE])  # load the model before timing
    zipformer.close_live("load", "warm-up-session")
    batch = "on" if os.environ.get("ZIPFORMER_BATCH", "on") != "off" else "off"
    print(f"batched decoding: {batch}")
    for n in [int(x) for x in args.callers.split(",")]:
        took: list[float] = []
        texts: list[str] = []
        start = threading.Event()
        threads = [threading.Thread(target=caller, args=(samples, took, texts, start)) for _ in range(n)]
        for t in threads:
            t.start()
        start.set()
        for t in threads:
            t.join()
        took.sort()
        p95 = took[int(0.95 * (len(took) - 1))]
        same = len(set(texts)) == 1
        print(
            f"  {n:>2} callers: piece back in median {statistics.median(took):5.1f} ms, p95 {p95:6.1f} ms, "
            f"worst {took[-1]:6.1f} ms · all heard the same words: {same} ({texts[0]!r})"
        )


if __name__ == "__main__":
    main()
