/**
 * The banking agent every account gets in its Playground: the same loan
 * reminder call as the public `/demo` page — Isomiddin from Biznesni
 * rivojlantirish banki ringing a borrower about an overdue payment.
 *
 * It is an ordinary agent with a "Who to call" card (see `agentTarget`), so the
 * Playground runs the demo's conversation without any special path: the agent
 * opens the call, checks the name and year of birth, and follows the script.
 *
 * Added once per account, the first time the Playground opens; a note in the
 * tenant's settings records that, so an agent the team deletes stays deleted.
 * It is created as a draft — never live — so the account's live agent and its
 * phone number are untouched.
 */
import 'server-only';
import { get, id, now, run, tx } from './db';
import { DEFAULT_CALL_PROMPT, DEMO_IDENTITY, DEMO_PERSONA } from './demo';
import { DEFAULT_ESCALATION, DEFAULT_HOURS } from './engine/conversation';
import { FALLBACKS } from './provision';
import { safeJson } from './utils';

const SEEDED_FLAG = 'bankAgentSeeded';

export const BANK_AGENT_NAME = `${DEMO_IDENTITY.agent.uz} — bank kredit eslatmasi`;

/** The agent is the one calling, and says so in those words. */
export const BANK_AGENT_GREETING = `Assalomu alaykum! Men ${DEMO_IDENTITY.agent.uz}, ${DEMO_IDENTITY.org.uz}dan qoʻngʻiroq qilyapman.`;
export const BANK_AGENT_INSTRUCTIONS =
  'When you introduce yourself, say that you are CALLING from the bank — in Uzbek "… bankidan qoʻngʻiroq qilyapman", ' +
  'in Russian "звоню из банка". Never describe yourself as just talking ("gaplashyapman").';

export function ensureBankAgent(tenantId: string): void {
  const tenant = get<{ settings_json: string }>('SELECT settings_json FROM tenants WHERE id=?', tenantId);
  if (!tenant) return;
  const settings = safeJson<Record<string, unknown>>(tenant.settings_json, {});
  if (settings[SEEDED_FLAG]) return;

  const stamp = now();
  const target = {
    fullName: DEMO_PERSONA.name.uz,
    birthYear: DEMO_PERSONA.birthYear,
    loanAmount: DEMO_PERSONA.loanAmount,
    prompt: DEFAULT_CALL_PROMPT,
  };

  tx(() => {
    // Re-read inside the transaction: two tabs opening the Playground at once
    // must not both add the agent.
    const fresh = get<{ settings_json: string }>('SELECT settings_json FROM tenants WHERE id=?', tenantId);
    const current = safeJson<Record<string, unknown>>(fresh?.settings_json ?? '{}', {});
    if (current[SEEDED_FLAG]) return;

    run(
      `INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
         languages_json, primary_lang, voice_id, speaking_rate, temperature, max_turns,
         confidence_threshold, escalation_json, hours_json, tools_json, target_json, version,
         created_at, updated_at)
       VALUES (?,?,?, 'draft', 'professional', ?, ?, ?, ?, 'uz', 'isomiddin', 1.0, 0.3, 40, 0.45, ?, ?, '[]', ?, 1, ?, ?)`,
      id('agt'),
      tenantId,
      BANK_AGENT_NAME,
      BANK_AGENT_GREETING,
      FALLBACKS.uz,
      BANK_AGENT_INSTRUCTIONS,
      JSON.stringify(['uz', 'ru']),
      JSON.stringify(DEFAULT_ESCALATION),
      JSON.stringify(DEFAULT_HOURS),
      JSON.stringify(target),
      stamp,
      stamp,
    );
    run(
      'UPDATE tenants SET settings_json=?, updated_at=? WHERE id=?',
      JSON.stringify({ ...current, [SEEDED_FLAG]: stamp }),
      stamp,
      tenantId,
    );
  });
}
