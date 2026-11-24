from brb_scraper.config import HtmlRules
from brb_scraper.extract import extract_html, text_from_fragment

RULES = HtmlRules(
    main_selector="main",
    breadcrumb_selector=".crumbs",
    breadcrumb_home=["bosh sahifa"],
    drop_selectors=[".form"],
    drop_lines=["Batafsil"],
    title_suffixes=[" | BRB"],
)


def page(body: str, title: str = "Kredit | BRB") -> str:
    return f"""<html lang="uz"><head><title>{title}</title></head><body>
    <nav>Menu Kredit Omonat Karta</nav>
    <main>{body}</main>
    <footer>Footer 1254</footer></body></html>"""


def test_keeps_main_content_only():
    ex = extract_html(page("<p>Asosiy matn</p>"), RULES)
    assert "Asosiy matn" in ex.text
    assert "Menu" not in ex.text and "Footer" not in ex.text


def test_inline_tags_stay_on_one_line():
    ex = extract_html(page("<p>Kredit miqdori <b>75%</b> gacha</p>"), RULES)
    assert ex.text == "Kredit miqdori 75% gacha"


def test_label_and_value_are_joined():
    ex = extract_html(page("<div>FOIZ STAVKASI</div><div>0%-19,5%</div>"), RULES)
    assert ex.text == "Foiz stavkasi: 0%-19,5%"


def test_small_heading_label_joined_but_tagline_kept():
    html = "<h3>Kredit muddati</h3><div>60 oygacha</div><h3>Vklad Mechta</h3><p>Godovoy doxod 16% v mobilnom prilojenii</p>"
    ex = extract_html(page(html), RULES)
    assert "Kredit muddati: 60 oygacha" in ex.text
    assert "### Vklad Mechta" in ex.text


def test_definition_list():
    ex = extract_html(page("<dl><dt>Turi:</dt><dd>Miniven</dd></dl>"), RULES)
    assert ex.text == "Turi: Miniven"


def test_table_rows_keep_column_names():
    html = """<table><tr><th>Badal</th><th>12 oy</th><th>24 oy</th></tr>
              <tr><td>25%</td><td>0%</td><td>5,5%</td></tr></table>"""
    ex = extract_html(page(html), RULES)
    assert ex.text == "Badal: 25%; 12 oy: 0%; 24 oy: 5,5%"


def test_two_column_table_is_pairs():
    html = "<table><tr><td>Kim uchun</td><td>Fuqarolar</td></tr><tr><td>1</td><td>Pasport</td></tr></table>"
    ex = extract_html(page(html), RULES)
    assert ex.text.splitlines() == ["Kim uchun: Fuqarolar", "- Pasport"]


def test_breadcrumb_title_and_drops():
    html = """<section class="crumbs"><a>Bosh sahifa</a><a>Jismoniy shaxslarga</a><span>Ipoteka</span></section>
              <p>Matn</p><div class="form">Ariza</div><a>Batafsil</a>"""
    ex = extract_html(page(html), RULES)
    assert ex.breadcrumb == ["Jismoniy shaxslarga", "Ipoteka"]
    assert ex.title == "Ipoteka"  # no h1 → last breadcrumb item
    assert ex.text == "Matn"
    assert ex.html_lang == "uz"


def test_heading_without_content_is_dropped():
    ex = extract_html(page("<h2>Bo'sh</h2><h2>To'la</h2><p>Bor</p>"), RULES)
    assert ex.text.splitlines() == ["## To'la", "Bor"]


def test_fragment_plain_and_html():
    assert text_from_fragment("Bir\n\n Ikki ") == "Bir\nIkki"
    assert text_from_fragment("<p>Bir</p><ul><li>Ikki</li></ul>") == "Bir\n- Ikki"
