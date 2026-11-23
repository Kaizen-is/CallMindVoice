# ruff: noqa: E501 - scenario and prompt text kept on one line each
"""
Set up the BRB website agents: `python -m app.brb_setup --password <login password>`.

Creates (or updates — safe to run again):
  • the company "BRB — website agents" (its own tenant: the website pages never mix
    with any other company's knowledge, and the live agents elsewhere are untouched);
  • a login for it (default brb@callmind.uz) so the Playground can be used;
  • two agents:
      - "BRB ma'lumot xizmati" — answers questions about BRB bank and BRB-TECH (inbound);
      - "Isomiddin — kredit arizasi" — calls a person about the online loan application
        they left on brb.uz (a goal-led call, see app/llm/goal_call.py);
  • with --new-key, an API key (read, write) for the scraper; printed once.

Needs migration 0002 (`alembic upgrade head`).
"""

import argparse
import json
import secrets
import sys

from app import db
from app.auth import api_key_hash, hash_password
from app.engine.conversation import DEFAULT_ESCALATION, DEFAULT_HOURS
from app.ids import new_id, now_iso
from app.rag.pages import table_ready

TENANT_ID = "ten_brb_website"
INFO_AGENT_ID = "agt_brb_info"
CALL_AGENT_ID = "agt_brb_loanapp"

INFO_GREETING = (
    "Assalomu alaykum! BRB bank va BRB-TECH haqida savollaringizga javob beraman. Sizga qanday yordam bera olaman?"
)
INFO_INSTRUCTIONS = (
    "You answer callers' questions about BRB bank (Biznesni rivojlantirish banki, brb.uz) and its IT company "
    "BRB-TECH (brb-tech.uz). Everything you know about them comes from their websites, given to you as knowledge "
    "base excerpts: products, rates, terms, documents, branches, contacts, news. Quote figures exactly as written. "
    "If several products match, name the two or three that fit best and ask which one they mean. "
    "The bank's call centre is 1254. Never ask for card numbers, PIN, CVV, SMS codes or passwords."
)

CALL_GREETING = "Assalomu alaykum! Men Isomiddin, Biznesni rivojlantirish bankidan qo'ng'iroq qilyapman."
CALL_INSTRUCTIONS = (
    "When you introduce yourself, say that you are CALLING from the bank (Uzbek: '… bankidan qo'ng'iroq "
    "qilyapman', Russian: 'звоню из банка'). You are a loan specialist's assistant: warm, patient and brief."
)

LOAN_APPLICATION_GOAL = {
    "purpose": (
        "The person left an online loan application on the bank's website (brb.uz). Clarify what they need so a "
        "loan officer can prepare an offer, and answer their questions about the bank's loans."
    ),
    "person": {"fullName": "Aziz Karimov", "birthYear": "1988"},
    "facts": [
        "They filled in the online loan application form on brb.uz yesterday.",
        "The form did not say which loan type, amount or term they want.",
    ],
    "collect": [
        {
            "key": "loan_type",
            "label": "Loan type",
            "ask": "Which loan do you need: car, consumer, mortgage, education, microloan for business or Islamic financing?",
        },
        {"key": "amount", "label": "Loan amount", "ask": "About how much would you like to borrow?"},
        {"key": "term", "label": "Term", "ask": "For how long — how many months or years?"},
        {
            "key": "monthly_income",
            "label": "Monthly income",
            "ask": "What is your approximate official monthly income?",
        },
        {"key": "employment", "label": "Where they work", "ask": "Where do you work, or are you self-employed?"},
        {
            "key": "region",
            "label": "City / branch",
            "ask": "Which city or district is convenient for you to visit a branch?",
        },
        {
            "key": "callback_time",
            "label": "Good time for the loan officer to call",
            "ask": "When is it convenient for our loan officer to call you?",
        },
    ],
    "closing": (
        "a loan officer from the branch they chose will call them within one working day with an offer; they should "
        "have their passport and income documents ready."
    ),
    "personas": [
        {
            "situation": "Siz 150 million so'mlik avtokredit (Chevrolet Tracker) xohlaysiz, 4 yilga. Maktabda o'qituvchisiz, oyligingiz 9 million. Toshkent, Chilonzor.",
            "questions": [
                "Boshlang'ich badal 40% bo'lsa foiz qancha?",
                "Qanday hujjatlar kerak?",
                "Muddatidan oldin to'lasa bo'ladimi?",
            ],
        },
        {
            "situation": "Siz Toshkentdan 600 million so'mlik kvartira uchun ipoteka olmoqchisiz, 30% boshlang'ich badal bor. IT kompaniyada dasturchisiz, oyligingiz 15 million.",
            "questions": ["Ipoteka necha yilga beriladi?", "Subsidiya bormi?", "Foiz stavkasi qancha?"],
        },
        {
            "situation": "Siz Samarqanddagi kichik tikuvchilik sexingiz uchun 50 million so'm mikroqarz xohlaysiz. O'zingizni o'zi band qilgansiz.",
            "questions": ["Garov kerakmi?", "Onlayn ariza bersa bo'ladimi?", "Pul qachon tushadi?"],
        },
        {
            "situation": "Farzandingizning universitet kontrakti uchun 30 million so'm ta'lim krediti kerak. Siz shifokorsiz, Farg'ona.",
            "questions": ["Imtiyozli davr bormi?", "Foiz qancha?", "Kim qarz oluvchi bo'ladi — men yoki farzandim?"],
        },
        {
            "situation": "Siz arizani qoldirgansiz, lekin qaysi kredit kerakligini hali bilmaysiz. Avval qanday kreditlar borligini so'rang, keyin iste'mol kreditini tanlang (20 million, 1 yil).",
            "questions": ["Sizda qanday kreditlar bor?", "Eng arzoni qaysi?", "BRB-TECH nima bilan shug'ullanadi?"],
        },
    ],
}


def ensure(email: str, password: str | None, new_key: bool) -> dict[str, str]:
    stamp = now_iso()
    out: dict[str, str] = {}
    with db.transaction() as tx:
        if not table_ready(tx):
            sys.exit("The database needs migration 0002 first: alembic upgrade head")

        if not db.fetch_one(tx, "SELECT id FROM tenants WHERE id = :id", id=TENANT_ID):
            db.execute(
                tx,
                """INSERT INTO tenants (id, name, slug, industry, country, timezone, plan, locale, status, onboarded,
                     settings_json, created_at, updated_at)
                   VALUES (:id, 'BRB — website agents', 'brb-website', 'finance', 'UZ', 'Asia/Tashkent', 'pro',
                     'uz', 'active', 1, '{}', :now, :now)""",
                id=TENANT_ID,
                now=stamp,
            )
            out["tenant"] = "created"
        else:
            out["tenant"] = "exists"

        user = db.fetch_one(tx, "SELECT id, tenant_id FROM users WHERE lower(email) = lower(:e)", e=email)
        if user and user["tenant_id"] != TENANT_ID:
            sys.exit(f"{email} already belongs to another company; pick another --email")
        if not user:
            if not password:
                sys.exit("A new login needs --password")
            db.execute(
                tx,
                """INSERT INTO users (id, tenant_id, email, name, password_hash, role, locale, status, created_at,
                     updated_at)
                   VALUES (:id, :t, :e, 'BRB tester', :h, 'owner', 'uz', 'active', :now, :now)""",
                id=new_id("usr"),
                t=TENANT_ID,
                e=email,
                h=hash_password(password),
                now=stamp,
            )
            out["login"] = f"created {email}"
        elif password:
            db.execute(tx, "UPDATE users SET password_hash = :h, updated_at = :now WHERE id = :id",
                       h=hash_password(password), now=stamp, id=user["id"])  # fmt: skip
            out["login"] = f"password reset for {email}"
        else:
            out["login"] = f"exists {email}"

        _agent(tx, INFO_AGENT_ID, "BRB ma'lumot xizmati", "professional", INFO_GREETING, INFO_INSTRUCTIONS, {}, stamp)
        _agent(
            tx,
            CALL_AGENT_ID,
            "Isomiddin — kredit arizasi",
            "friendly",
            CALL_GREETING,
            CALL_INSTRUCTIONS,
            LOAN_APPLICATION_GOAL,
            stamp,
        )
        out["agents"] = f"{INFO_AGENT_ID}, {CALL_AGENT_ID}"

        if new_key:
            raw = "ovoz_sk_" + secrets.token_hex(20)
            db.execute(
                tx,
                """INSERT INTO api_keys (id, tenant_id, name, prefix, hash, scopes, created_at)
                   VALUES (:id, :t, 'BRB knowledge scraper', :p, :h, 'read,write', :now)""",
                id=new_id("key"),
                t=TENANT_ID,
                p=raw[:12],
                h=api_key_hash(raw),
                now=stamp,
            )
            out["api_key"] = raw
    return out


def _agent(
    tx, agent_id: str, name: str, persona: str, greeting: str, instructions: str, goal: dict, stamp: str
) -> None:  # noqa: ANN001, E501
    fields = {
        "id": agent_id,
        "t": TENANT_ID,
        "name": name,
        "persona": persona,
        "greeting": greeting,
        "instructions": instructions,
        "goal": json.dumps(goal, ensure_ascii=False),
        "esc": json.dumps(DEFAULT_ESCALATION),
        "hours": json.dumps(DEFAULT_HOURS),
        "now": stamp,
    }
    if db.fetch_one(tx, "SELECT id FROM agents WHERE id = :id", id=agent_id):
        db.execute(
            tx,
            """UPDATE agents SET name = :name, persona = :persona, greeting = :greeting, instructions = :instructions,
                 goal_json = :goal, updated_at = :now WHERE id = :id AND tenant_id = :t""",
            **fields,
        )
        return
    db.execute(
        tx,
        """INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
             languages_json, primary_lang, voice_id, confidence_threshold, escalation_json, hours_json, goal_json,
             created_at, updated_at)
           VALUES (:id, :t, :name, 'live', :persona, :greeting, '', :instructions, '["uz","ru","en"]', 'uz',
             'isomiddin', 0.45, :esc, :hours, :goal, :now, :now)""",
        **fields,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--email", default="brb@callmind.uz")
    ap.add_argument("--password", help="login password (needed the first time; resets it later)")
    ap.add_argument("--new-key", action="store_true", help="create an API key for the scraper and print it once")
    args = ap.parse_args()
    for k, v in ensure(args.email, args.password, args.new_key).items():
        print(f"{k:8} {v}")
    if args.new_key:
        print("\nKeep the API key: it is shown only now. The scraper reads it from CALLMIND_API_KEY.")


if __name__ == "__main__":
    main()
