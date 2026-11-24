"""
The logistics demo's lookup (`app/logistics_data.py`) against the original TypeScript
(src/lib/logistics-data.ts): number reading, the shipment lookup, the day labels and the whole
prompt part, replayed from `fixtures/golden_logistics.json` (make-golden-logistics.cjs) at the
same pinned moments.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from app import logistics_data as ld
from app.ids import parse_iso

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_logistics.json").read_text(encoding="utf-8"))


@pytest.fixture
def pin(monkeypatch: pytest.MonkeyPatch):
    def at(iso: str) -> None:
        moment: datetime = parse_iso(iso)
        monkeypatch.setattr(ld, "_now", lambda: moment)

    return at


def test_constants() -> None:
    assert list(ld.TRY_TRACKS) == GOLDEN["tryTracks"]
    assert list(ld.LOGISTICS_VOCABULARY) == GOLDEN["vocabulary"]


@pytest.mark.parametrize("case", GOLDEN["readings"], ids=lambda c: c["line"][:30])
def test_number_reading(case: dict) -> None:
    line = case["line"]
    assert ld._spelled_digits(line) == case["spelled"]
    assert ld._joined_digits(line) == case["joined"]
    assert ld._numbers_in(line) == case["numbers"]


def test_day_labels(pin) -> None:  # noqa: ANN001
    for case in GOLDEN["dayLabels"]:
        pin(case["now"])
        assert ld.day_label(case["offset"], case["zone"]) == case["label"], case


def test_lookup_note_and_context(pin) -> None:  # noqa: ANN001
    contexts = 0
    for case in GOLDEN["cases"]:
        pin(case["now"])
        lines = case["lines"]
        lookup = ld.lookup_shipments(lines)
        got = {
            "found": [s["track"] for s in lookup.found],
            "matchedBy": [list(kv) for kv in lookup.matched_by.items()],
            "unknownNumber": lookup.unknown_number,
            "partial": lookup.partial,
        }
        assert got == case["lookup"], lines
        assert ld.lookup_note(lines) == case["note"], lines
        if case["context"] is not None:
            assert ld.logistics_context(lines, case["agentName"]) == case["context"], lines
            contexts += 1
        if case["contextRu"] is not None:
            assert ld.logistics_context(lines, "Laylo", "Europe/Moscow") == case["contextRu"], lines
    assert contexts >= 20
