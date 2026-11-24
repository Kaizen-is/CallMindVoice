"""
The banking agent every account gets in its Playground — port of src/lib/bank-agent.ts: the
public `/demo` page's loan reminder call (Isomiddin from Biznesni rivojlantirish banki ringing a
borrower about an overdue payment), as an ordinary draft agent with a "Who to call" card.

Added once per account, the first time the Playground opens; a note in the tenant's settings
records that, so an agent the team deletes stays deleted.
"""

from app import db
from app.agent_studio import FALLBACKS
from app.engine.conversation import DEFAULT_ESCALATION, DEFAULT_HOURS
from app.ids import new_id, now_iso
from app.jscompat import js_json, js_truthy
from app.llm.choice import safe_json

# From src/lib/demo.ts: how the demo names the agent and its bank, and the borrower the visitor plays.
DEMO_IDENTITY = {
    "agent": {"uz": "Isomiddin", "ru": "Исомиддин"},
    "org": {"uz": "Biznesni rivojlantirish banki", "ru": "Банк развития бизнеса"},
}
DEMO_PERSONA = {
    "name": {"uz": "Aziz Karimov", "ru": "Азиз Каримов"},
    "birthYear": "1992",
    "loanAmount": "7 800 000 so'm",
}
DEFAULT_CALL_PROMPT = (
    "Siz Biznesni rivojlantirish banki nomidan qoʻngʻiroq qilyapsiz. Mijozga kredit boʻyicha "
    "muddati oʻtgan toʻlovni eslating. Agar u toʻliq toʻlay olmasa, summani uch oyga boʻlib "
    "toʻlashni taklif qiling. Toʻlovni bank ilovasi orqali yoki istalgan filialda qilish mumkin."
)

SEEDED_FLAG = "bankAgentSeeded"

BANK_AGENT_NAME = f"{DEMO_IDENTITY['agent']['uz']} — bank kredit eslatmasi"
# The agent is the one calling, and says so in those words.
BANK_AGENT_GREETING = (
    f"Assalomu alaykum! Men {DEMO_IDENTITY['agent']['uz']}, {DEMO_IDENTITY['org']['uz']}dan qoʻngʻiroq qilyapman."
)
BANK_AGENT_INSTRUCTIONS = (
    'When you introduce yourself, say that you are CALLING from the bank — in Uzbek "… bankidan qoʻngʻiroq '
    'qilyapman", in Russian "звоню из банка". Never describe yourself as just talking ("gaplashyapman").'
)


def _settings(raw: str | None) -> dict:
    value = safe_json(raw, {})
    return value if isinstance(value, dict) else {}


def ensure_bank_agent(tenant_id: str) -> None:
    with db.connect() as conn:
        tenant = db.fetch_one(conn, "SELECT settings_json FROM tenants WHERE id = :id", id=tenant_id)
    if not tenant:
        return
    if js_truthy(_settings(tenant["settings_json"]).get(SEEDED_FLAG)):
        return

    stamp = now_iso()
    target = {
        "fullName": DEMO_PERSONA["name"]["uz"],
        "birthYear": DEMO_PERSONA["birthYear"],
        "loanAmount": DEMO_PERSONA["loanAmount"],
        "prompt": DEFAULT_CALL_PROMPT,
    }
    with db.transaction() as tx:
        # Re-read inside the transaction: two tabs opening the Playground at once must not both add it.
        fresh = db.fetch_one(tx, "SELECT settings_json FROM tenants WHERE id = :id", id=tenant_id)
        current = _settings(fresh["settings_json"] if fresh else "{}")
        if js_truthy(current.get(SEEDED_FLAG)):
            return
        db.execute(
            tx,
            """INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
                 languages_json, primary_lang, voice_id, speaking_rate, temperature, max_turns,
                 confidence_threshold, escalation_json, hours_json, tools_json, target_json, version,
                 created_at, updated_at)
               VALUES (:id, :t, :name, 'draft', 'professional', :greeting, :fallback, :instructions, :languages,
                 'uz', 'isomiddin', 1.0, 0.3, 40, 0.45, :escalation, :hours, '[]', :target, 1, :stamp, :stamp)""",
            id=new_id("agt"),
            t=tenant_id,
            name=BANK_AGENT_NAME,
            greeting=BANK_AGENT_GREETING,
            fallback=FALLBACKS["uz"],
            instructions=BANK_AGENT_INSTRUCTIONS,
            languages=js_json(["uz", "ru"]),
            escalation=js_json(DEFAULT_ESCALATION),
            hours=js_json(DEFAULT_HOURS),
            target=js_json(target),
            stamp=stamp,
        )
        db.execute(
            tx,
            "UPDATE tenants SET settings_json = :s, updated_at = :stamp WHERE id = :id",
            s=js_json({**current, SEEDED_FLAG: stamp}),
            stamp=stamp,
            id=tenant_id,
        )
