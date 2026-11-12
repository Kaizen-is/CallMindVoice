"""
The Python speech-text and answer helpers must reproduce the TypeScript exactly.

`fixtures/golden_text.json` was produced by the ORIGINAL modules
(src/lib/speech/{numbers,normalize}.ts, src/lib/llm/{local,loan-call,json-stream}.ts).
`normalize_for_speech` output is part of every TTS cache key, the intent drives
fillers and escalation, and the local engine is the last-resort answer.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from app.llm.json_stream import answer_extractor
from app.llm.loan_call import calendar_block, identity_check, named_day
from app.llm.local import classify_intent, sentiment_of, summarize_local, synthesize_local
from app.speech.normalize import normalize_for_speech, split_for_speech
from app.speech.numbers import uzbek_numbers_to_digits

G = json.loads((Path(__file__).parent / "fixtures" / "golden_text.json").read_text(encoding="utf-8"))


def ids(prefix: str, cases: list) -> list[str]:
    return [f"{prefix}{i}" for i in range(len(cases))]


@pytest.mark.parametrize("case", G["numbers"], ids=ids("n", G["numbers"]))
def test_uzbek_numbers_to_digits(case):
    assert uzbek_numbers_to_digits(case["input"]) == case["output"]


@pytest.mark.parametrize("case", G["speech"], ids=ids("sp", G["speech"]))
def test_normalize_for_speech(case):
    assert normalize_for_speech(case["input"], case["language"]) == case["output"]


@pytest.mark.parametrize("case", G["split"], ids=ids("sf", G["split"]))
def test_split_for_speech(case):
    assert split_for_speech(case["input"]) == case["output"]


@pytest.mark.parametrize("case", G["intents"], ids=ids("i", G["intents"]))
def test_intent_and_sentiment(case):
    assert classify_intent(case["input"]) == case["intent"]
    assert sentiment_of(case["input"]) == case["sentiment"]


@pytest.mark.parametrize("case", G["synth"], ids=ids("sy", G["synth"]))
def test_local_answer(case):
    out = synthesize_local(
        case["question"],
        case["hits"],
        case["confidence"],
        case["language"],
        "Nadya",
        case["threshold"],
        history=case["history"],
        max_chars=case.get("maxChars", 340),
    )
    out["usedHits"] = [h["chunkId"] for h in out["usedHits"]]
    assert out == case["output"]


@pytest.mark.parametrize("case", G["summaries"], ids=ids("su", G["summaries"]))
def test_handoff_summary(case):
    assert summarize_local(case["turns"], case["language"], case["reason"]) == case["output"]


@pytest.mark.parametrize("case", G["identity"], ids=ids("id", G["identity"]))
def test_identity_check(case):
    got = identity_check(case["birthYear"], case["lines"])
    assert {"status": got.status, "justWrong": got.just_wrong, "wrongTries": got.wrong_tries} == case["output"]


@pytest.mark.parametrize("case", G["namedDay"], ids=ids("day", G["namedDay"]))
def test_named_day(case):
    now = datetime.fromisoformat(case["now"].replace("Z", "+00:00"))
    assert named_day(case["line"], case["timeZone"], now) == case["output"]


@pytest.mark.parametrize("case", G["calendar"], ids=ids("cal", G["calendar"]))
def test_calendar_block(case):
    now = datetime.fromisoformat(case["now"].replace("Z", "+00:00"))
    assert calendar_block(case["timeZone"], now) == case["output"]


@pytest.mark.parametrize("case", G["stream"], ids=ids("st", G["stream"]))
def test_answer_extractor(case):
    deltas: list[str] = []
    feed = answer_extractor(deltas.append)
    for cut in [*case["cuts"], len(case["raw"])]:
        feed(case["raw"][:cut])
    assert deltas == case["deltas"]
