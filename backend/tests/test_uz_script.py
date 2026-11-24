"""Uzbek live words in one spelling (app/speech/uz_script.py)."""

import pytest

from app.speech.uz_script import to_latin, uz_display


@pytest.mark.parametrize(
    ("cyrillic", "latin"),
    [
        ("Кузатувчиларнинг фикрича, бу Ўзбекистоннинг жуда муваффақиятли қадами бўлди.",
         "Kuzatuvchilarning fikricha, bu O'zbekistonning juda muvaffaqiyatli qadami bo'ldi."),
        ("Ёшлар Европага поездда кетди", "Yoshlar Yevropaga poyezdda ketdi"),
        ("ЎЗБЕКИСТОН ШАҲРИ", "O'ZBEKISTON SHAHRI"),
        ("Цирк ва лицей", "Sirk va litsey"),
        ("Ғафур, ҳа, юз", "G'afur, ha, yuz"),
    ],
)  # fmt: skip
def test_cyrillic_becomes_latin(cyrillic: str, latin: str) -> None:
    assert uz_display(cyrillic) == latin


def test_apostrophes_become_one() -> None:
    assert uz_display("O‘zbekiston, Gʻafur, oʼzbek, tilʼ") == "O'zbekiston, G'afur, o'zbek, til'"


def test_latin_passes_through() -> None:
    text = "Kuzatuvchilarning fikricha, 2026-yil: 15 000 so'm!"
    assert to_latin(text) == text and uz_display(text) == text
