"""
L3 step 1: how well an end-of-turn model hears that an Uzbek caller has finished, on the turn lab's
recordings (`data/turn-lab/`, made on /app/dev/turn-lab with TURN_LAB=on).

Every pause of 0.3 s or more inside a recorded phrase is a place where the caller had NOT finished; the
end of the phrase is where they had. At each of those points the model hears the phrase so far (plus
0.3 s of quiet) and says how sure it is that the caller is done. Three ways of ending a turn are then
compared on the same points:

  Q4 today        the word rules' wait (src/lib/voice/endpointing.ts), from the words said so far
  model           ends at 0.3 s when the model is sure (≥ threshold), else waits up to 2.5 s
  model + Q4      ends at 0.3 s when the model is sure, else Q4 decides as today

For each: how often the caller is cut off at a mid-phrase pause, and how long the agent waits after the
caller has really finished (median and 90th percentile).

The model: Smart Turn v3.2 (pipecat-ai/smart-turn-v3, `smart-turn-v3.2-cpu.onnx`, BSD-2-Clause), run
with onnxruntime; its input is Whisper's 80-band log-mel of the last 8 s, computed here with numpy (the
same steps as transformers' WhisperFeatureExtractor; app/speech/turn_model.py, shared with the Playground).

  python tools/turn_lab_eval.py --model path/to/smart-turn-v3.2-cpu.onnx [--lab data/turn-lab] [--csv out.csv]
"""

import argparse
import csv
import json
import os
import statistics
import subprocess
import sys
import time
import wave
from pathlib import Path

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np  # noqa: E402

RATE = 16000
DECIDE_AFTER_S = 0.3  # the model is asked after this much quiet
MAX_WAIT_S = 2.5  # the longest the agent waits when the model says "not finished"
MIN_PAUSE_S = 0.3  # shorter gaps never reach a decision
REPO = Path(__file__).resolve().parents[2]


sys.path.insert(0, str(REPO / "backend"))
from app.speech.turn_model import features  # noqa: E402 - the same input the Playground's model gets

# ── the recordings ──


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{path.name}: not 16 kHz mono 16-bit")
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def speech_spans(audio: np.ndarray) -> list[tuple[float, float]]:
    """Where the speaker is talking (seconds), from 10 ms frame energy against the clip's own noise floor."""
    hop = RATE // 100
    n = len(audio) // hop
    if n == 0:
        return []
    frames = audio[: n * hop].reshape(n, hop)
    db = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9)
    floor, peak = np.percentile(db, 10), np.percentile(db, 95)
    voiced = db > floor + max(9.0, 0.3 * (peak - floor))
    spans, start = [], None
    for i, v in enumerate([*voiced, False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= 8:  # 80 ms: a click or a breath is not speech
                spans.append((start / 100, i / 100))
            start = None
    merged: list[tuple[float, float]] = []
    for s, e in spans:  # gaps under 0.15 s are inside a word
        if merged and s - merged[-1][1] < 0.15:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged


def latest_clips(lab: Path) -> list[dict]:
    """The last clip of each phrase per speaker (a phrase recorded again replaces the earlier take)."""
    rows: dict[tuple[str, str], dict] = {}
    for line in (lab / "labels.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if (lab / row["file"]).is_file():
            rows[(row.get("speaker", ""), row["promptId"])] = row
    return sorted(rows.values(), key=lambda r: (r.get("speaker", ""), r["promptId"]))


def q4_waits(points: list[dict]) -> list[float]:
    """The Q4 wait (s) for each point's words, from src/lib/voice/endpointing.ts."""
    payload = json.dumps([{"heard": p["heard"], "asked": p["asked"]} for p in points], ensure_ascii=False)
    out = subprocess.run(
        ["node", "--no-warnings", "--experimental-strip-types", str(REPO / "backend/tools/turn_lab_q4.mjs")],
        input=payload.encode("utf-8"),
        capture_output=True,
        check=True,
        cwd=REPO,
    )
    return [ms / 1000 for ms in json.loads(out.stdout)]


# ── scoring ──


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="smart-turn-v3.2-cpu.onnx")
    ap.add_argument("--lab", default=str(REPO / "data" / "turn-lab"))
    ap.add_argument("--csv", help="write every point here")
    sys.stdout.reconfigure(encoding="utf-8")  # the report has ≥ and · in it
    args = ap.parse_args()

    import onnxruntime as ort  # noqa: PLC0415 - only this tool needs it

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    session = ort.InferenceSession(args.model, sess_options=opts, providers=["CPUExecutionProvider"])

    lab = Path(args.lab)
    points: list[dict] = []
    took: list[float] = []
    for clip in latest_clips(lab):
        audio = read_wav(lab / clip["file"])
        spans = speech_spans(audio)
        if not spans:
            print(f"  skipped {clip['file']}: no speech found", file=sys.stderr)
            continue
        pieces = [s.strip() for s in clip["text"].split("…")]
        asked = clip.get("asked") or ""
        gaps = [(spans[i][1], spans[i + 1][0] - spans[i][1]) for i in range(len(spans) - 1)]
        mids = [(end, gap) for end, gap in gaps if gap >= MIN_PAUSE_S]
        # The words said at each mid pause are known when the pauses fall where the text's "…" are.
        words_known = len(mids) == len(pieces) - 1
        for k, (end, gap) in enumerate(mids):
            heard = " ".join(pieces[: k + 1]) if words_known else ""
            points.append({"clip": clip, "at": end, "gap": gap, "done": False, "heard": heard, "asked": asked})
        points.append(
            {"clip": clip, "at": spans[-1][1], "gap": None, "done": True, "heard": " ".join(pieces), "asked": asked}
        )
    if not points:
        sys.exit(f"no recordings with speech in {lab}")

    for p in points:
        audio = read_wav(lab / p["clip"]["file"])
        cut = audio[: int(min(len(audio), (p["at"] + DECIDE_AFTER_S) * RATE))]
        t0 = time.perf_counter()
        p["prob"] = float(session.run(None, {"input_features": features(cut)})[0].reshape(-1)[0])
        took.append((time.perf_counter() - t0) * 1000)

    known = [p for p in points if p["done"] or p["heard"]]
    for p, wait in zip(known, q4_waits(known), strict=True):
        p["q4"] = wait
    # Live recognisers often end a mid-phrase piece with a full stop: Q4 read that way too.
    known_mids = [p for p in known if not p["done"]]
    stopped = [{"heard": p["heard"].rstrip(".?!,") + ".", "asked": p["asked"]} for p in known_mids]
    for p, wait in zip(known_mids, q4_waits(stopped), strict=True):
        p["q4_stop"] = wait

    mids = [p for p in points if not p["done"]]
    finals = [p for p in points if p["done"]]
    speakers = {p["clip"].get("speaker") for p in points}
    print(
        f"\n{len({id(p['clip']) for p in points})} clips, {len(speakers)} speaker(s): "
        f"{len(mids)} mid-phrase pauses (≥{MIN_PAUSE_S} s), {len(finals)} phrase ends"
    )
    print(f"model time per decision: median {statistics.median(took):.0f} ms, worst {max(took):.0f} ms\n")

    def report(name: str, cut_off: list[bool], waits: list[float]) -> None:
        rate = 100 * sum(cut_off) / len(cut_off) if cut_off else float("nan")
        waits = sorted(waits)
        p90 = waits[min(len(waits) - 1, int(0.9 * len(waits)))] if waits else float("nan")
        print(
            f"  {name:<26} cut off {rate:5.1f}% of mid pauses ({sum(cut_off)}/{len(cut_off)})   "
            f"wait after the end: median {statistics.median(waits):.2f} s, p90 {p90:.2f} s"
        )

    q4_mids = [p for p in mids if "q4" in p]
    print("Q4 today (words known at", len(q4_mids), "of", len(mids), "mid pauses):")
    report("as typed", [p["gap"] >= p["q4"] for p in q4_mids], [p["q4"] for p in finals])
    report("with STT full stops", [p["gap"] >= p["q4_stop"] for p in q4_mids], [p["q4"] for p in finals])
    for threshold in (0.5, 0.7, 0.8, 0.9):
        print(f"\nthreshold {threshold}:")
        sure = lambda p, t=threshold: p["prob"] >= t  # noqa: E731
        report(
            "model",
            [sure(p) or p["gap"] >= MAX_WAIT_S for p in mids],
            [DECIDE_AFTER_S if sure(p) else MAX_WAIT_S for p in finals],
        )
        report(
            "model + Q4",
            [sure(p) or p["gap"] >= p["q4"] for p in q4_mids],
            [DECIDE_AFTER_S if sure(p) else p["q4"] for p in finals],
        )

    print("\nby kind (model sure at 0.7 — mid pauses called finished / ends called finished):")
    for kind in ("short", "full", "pause", "number", "mixed"):
        km = [p for p in mids if p["clip"]["kind"] == kind]
        kf = [p for p in finals if p["clip"]["kind"] == kind]
        if kf:
            print(
                f"  {kind:<7} {sum(p['prob'] >= 0.7 for p in km)}/{len(km)} mid · "
                f"{sum(p['prob'] >= 0.7 for p in kf)}/{len(kf)} ends"
            )

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["file", "promptId", "kind", "speaker", "point", "at_s", "gap_s", "prob", "q4_s", "heard"])
            for p in points:
                c = p["clip"]
                w.writerow(
                    [
                        c["file"],
                        c["promptId"],
                        c["kind"],
                        c.get("speaker"),
                        "end" if p["done"] else "mid",
                        round(p["at"], 2),
                        "" if p["gap"] is None else round(p["gap"], 2),
                        round(p["prob"], 3),
                        p.get("q4", ""),
                        p["heard"],
                    ]
                )
        print(f"\nevery point: {args.csv}")


if __name__ == "__main__":
    main()
