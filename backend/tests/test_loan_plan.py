"""L6: the loan call's split figures and its promise to pay, worked out and checked in code (app/llm/loan_plan.py)."""

from datetime import UTC, datetime

from app.engine.live_turn import playground_turn
from app.llm import prompts
from app.llm.loan_plan import plan_lines, promise_from_turn, split_plan, sums_in

NOW = datetime(2026, 11, 27, 9, 0, tzinfo=UTC)  # a Friday in Tashkent
TARGET = {
    "fullName": "Aziz Karimov",
    "birthYear": "1992",
    "loanAmount": "7 850 000 so'm",
    "prompt": "Agar u to'liq to'lay olmasa, summani uch oyga bo'lib to'lashni taklif qiling.",
}


def test_split_adds_up_and_rounds() -> None:
    assert split_plan(7_800_000, 3) == [2_600_000] * 3
    assert split_plan(7_850_000, 3) == [2_616_000, 2_616_000, 2_618_000]
    assert sum(split_plan(1_234_567, 4)) == 1_234_567
    assert split_plan(500_000, 1) == [500_000]


def test_sums_in_digits_and_words() -> None:
    assert sums_in("yetti million sakkiz yuz ming so'm") == [7_800_000]
    assert sums_in("500.000 so'm, keyin 1 200 000") == [500_000, 1_200_000]
    assert sums_in("1992-yil, 25-dekabr, 3 oy") == []  # years, days and counts are not money
    assert sums_in("Ertaga 500 ming so'm, keyin 1,5 mln") == [500_000, 1_500_000]
    assert sums_in("Ha 1992 Ertaga 500 ming so'm") == [500_000]


def test_plan_lines_follow_the_brief() -> None:
    lines = plan_lines(TARGET)
    assert "3 parts: 2 616 000 so'm each, last one 2 618 000 so'm" in lines[-1]
    assert plan_lines({"loanAmount": ""}) == []


def test_the_prompt_has_the_figures_only_in_the_playground() -> None:
    inp = prompts.target_block  # the loan flow's block, once the person is confirmed
    outside = "\n".join(str(x) for x in [inp(TARGET, "uz", ["Ha", "1992"])])
    with playground_turn():
        inside = "\n".join(str(x) for x in [inp(TARGET, "uz", ["Ha", "1992"])])
    assert "2 616 000" in inside and "2 616 000" not in outside
    assert "work out each" in outside


def test_a_promise_needs_the_day_said_back() -> None:
    said = ["Ha, men.", "1992-yil", "25-dekabrda hammasini to'layman"]
    promise = promise_from_turn(TARGET, said, "Rahmat! Demak, 25-dekabr kuni to'liq summani to'laysiz.", now=NOW)
    assert promise is not None
    assert promise["date"] == "2026-12-25" and promise["amount"] == 7_850_000 and promise["parts"] == 1
    assert promise_from_turn(TARGET, said, "Rahmat, yaxshi.", now=NOW) is None  # not said back
    assert promise_from_turn(TARGET, said, "Demak, 26-dekabr kuni.", now=NOW) is None  # a different day


def test_a_split_promise_is_its_first_part() -> None:
    said = ["Ha", "1992", "Bo'lib to'lasam bo'ladimi? Birinchisini 5-dekabrda to'layman"]
    promise = promise_from_turn(TARGET, said, "Yaxshi, 5-dekabr kuni birinchi qism, 2 616 000 so'm.", now=NOW)
    assert promise is not None and promise["parts"] == 3 and promise["amount"] == 2_616_000


def test_their_own_figure_wins_and_is_checked() -> None:
    said = ["Ha", "1992", "Ertaga 500 ming so'm to'layman"]
    promise = promise_from_turn(TARGET, said, "Yaxshi, ertaga, 28-noyabr kuni 500 000 so'm.", now=NOW)
    assert promise is not None and promise["amount"] == 500_000
    too_much = ["Ha", "1992", "Ertaga 90 million to'layman"]
    promise = promise_from_turn(TARGET, too_much, "Ertaga, 28-noyabr kuni.", now=NOW)
    assert promise is not None and promise["amount"] == 7_850_000  # a sum above the debt is not taken


def test_no_promise_without_identity_or_too_far() -> None:
    assert promise_from_turn(TARGET, ["Ha", "1987", "ertaga"], "Ertaga, 28-noyabr.", now=NOW) is None
    far = ["Ha", "1992", "15-may kuni to'layman"]
    assert promise_from_turn(TARGET, far, "15-may kuni, yaxshi.", now=NOW) is None  # beyond 90 days
