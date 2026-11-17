"""
Tenant provisioning — port of `provisionTenant` in src/lib/provision.ts: everything a new
company needs to exist (the company, its owner, a first draft agent and a simulator number).
"""

import math
import random
import time
import unicodedata
from datetime import UTC, datetime, timedelta

import regex as re

from app import db
from app.agent_studio import FALLBACKS, GREETINGS
from app.audit import audit
from app.auth import hash_password
from app.engine.conversation import DEFAULT_ESCALATION, DEFAULT_HOURS
from app.ids import new_id, now_iso, to_iso
from app.jscompat import js_json, js_trim, utf16_slice

_COMBINING = re.compile("[̀-ͯ]")
_NOT_SLUG = re.compile("[^a-z0-9]+")


class EmailTaken(Exception):
    """`new Error('An account with this email already exists.')`."""

    def __init__(self) -> None:
        super().__init__("An account with this email already exists.")


def slugify(s: str) -> str:
    """`slugify` (src/lib/utils.ts): lower-case, accents dropped, runs of anything else become one '-'."""
    out = unicodedata.normalize("NFKD", s.lower())
    out = _COMBINING.sub("", out)
    out = _NOT_SLUG.sub("-", out).strip("-")
    return utf16_slice(out, 0, 40)


def _unique_slug(conn, base: str) -> str:  # noqa: ANN001
    root = slugify(base) or "company"
    candidate, n = root, 1
    while db.fetch_one(conn, "SELECT id FROM tenants WHERE slug = :s", s=candidate):
        n += 1
        candidate = f"{root}-{n}"
    return candidate


def _local_number(seed: int) -> str:
    line = str(1000000 + (seed % 8999999))[:7]
    return f"+9987871{line[:5]}"


def provision_tenant(
    *,
    company: str,
    industry: str,
    full_name: str,
    email: str,
    password: str,
    locale: str = "uz",
    primary_lang: str = "uz",
) -> dict[str, str]:
    """Create the company, its owner, a draft agent and a simulator number; raises EmailTaken."""
    email = js_trim(email).lower()
    tenant_id, user_id, agent_id, number_id = new_id("ten"), new_id("usr"), new_id("agt"), new_id("num")
    stamp = now_iso()
    trial_ends = to_iso(datetime.now(UTC) + timedelta(days=14))
    name = js_trim(company)

    with db.transaction() as tx:
        if db.fetch_one(tx, "SELECT id FROM users WHERE email = :e", e=email):
            raise EmailTaken
        db.execute(
            tx,
            """INSERT INTO tenants (id, name, slug, industry, country, timezone, plan, plan_started,
                 trial_ends_at, locale, status, onboarded, settings_json, created_at, updated_at)
               VALUES (:id, :name, :slug, :industry, 'UZ', 'Asia/Tashkent', 'trial', :stamp, :trial, :locale,
                 'active', 0, '{}', :stamp, :stamp)""",
            id=tenant_id,
            name=name,
            slug=_unique_slug(tx, company),
            industry=industry,
            stamp=stamp,
            trial=trial_ends,
            locale=locale,
        )
        db.execute(
            tx,
            """INSERT INTO users (id, tenant_id, email, name, password_hash, role, avatar_hue, locale,
                 status, presence, created_at, updated_at)
               VALUES (:id, :tenant, :email, :name, :hash, 'owner', :hue, :locale, 'active', 'online',
                 :stamp, :stamp)""",
            id=user_id,
            tenant=tenant_id,
            email=email,
            name=js_trim(full_name),
            hash=hash_password(password),
            hue=math.floor(random.random() * 360),
            locale=locale,
            stamp=stamp,
        )
        db.execute(
            tx,
            """INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
                 languages_json, primary_lang, voice_id, speaking_rate, temperature, max_turns,
                 confidence_threshold, escalation_json, hours_json, tools_json, version, created_at, updated_at)
               VALUES (:id, :tenant, :name, 'draft', 'professional', :greeting, :fallback, '', :langs, :lang,
                 'laylo', 1.0, 0.3, 24, 0.45, :escalation, :hours, '[]', 1, :stamp, :stamp)""",
            id=agent_id,
            tenant=tenant_id,
            name=f"{name} Assistant",
            greeting=GREETINGS[primary_lang](name),
            fallback=FALLBACKS[primary_lang],
            langs=js_json(["uz", "ru", "en"]),
            lang=primary_lang,
            escalation=js_json(DEFAULT_ESCALATION),
            hours=js_json(DEFAULT_HOURS),
            stamp=stamp,
        )
        db.execute(
            tx,
            """INSERT INTO phone_numbers (id, tenant_id, e164, label, provider, region, agent_id, status,
                 capabilities, monthly_cost, created_at)
               VALUES (:id, :tenant, :e164, 'Main line', 'simulator', 'Tashkent', :agent, 'active', 'voice', 3.0,
                 :stamp)""",
            id=number_id,
            tenant=tenant_id,
            e164=_local_number(int(time.time() * 1000)),
            agent=agent_id,
            stamp=stamp,
        )

    audit(tenant_id, {"id": user_id, "name": full_name}, "tenant.created", tenant_id, {"industry": industry})
    return {"tenantId": tenant_id, "userId": user_id, "agentId": agent_id, "numberId": number_id}
