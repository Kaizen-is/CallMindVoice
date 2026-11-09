/**
 * Which language model an agent answers with.
 *
 *   1. The agent's own choice (`agents.llm_model`, set in Agent studio).
 *   2. The account default (`tenants.settings_json.llmModel`, set on the
 *      Models ▸ LLM page).
 *   3. The server default — the first engine with a key (see `resolveLlm`).
 *
 * Choices are `provider:model` strings from the model list
 * (`@/lib/speech/registry` ▸ LLM_MODELS). A choice whose key is not set on
 * this server is skipped at answer time, so it never breaks a call.
 */
import 'server-only';
import { get, now, run } from '@/lib/db';
import { LLM_MODELS, llmModelInfo } from '@/lib/speech/registry';
import type { Agent } from '@/lib/types';
import { safeJson } from '@/lib/utils';
import { engineLabel, llmProviderReady, resolveLlm } from './provider';

const SETTING = 'llmModel';

/** The account default, or null when none is picked. */
export function tenantDefaultLlm(tenantId: string): string | null {
  const row = get<{ settings_json: string }>('SELECT settings_json FROM tenants WHERE id=?', tenantId);
  const value = safeJson<Record<string, unknown>>(row?.settings_json ?? '{}', {})[SETTING];
  return typeof value === 'string' && llmModelInfo(value) ? value : null;
}

/** Set (or with null, clear) the account default. Unknown ids are refused. */
export function setTenantDefaultLlm(tenantId: string, choice: string | null): boolean {
  if (choice !== null && !llmModelInfo(choice)) return false;
  const row = get<{ settings_json: string }>('SELECT settings_json FROM tenants WHERE id=?', tenantId);
  if (!row) return false;
  const settings = safeJson<Record<string, unknown>>(row.settings_json, {});
  if (choice) settings[SETTING] = choice;
  else delete settings[SETTING];
  run('UPDATE tenants SET settings_json=?, updated_at=? WHERE id=?', JSON.stringify(settings), now(), tenantId);
  return true;
}

/** The choice an agent's answers go out with (before the key check). */
export function agentLlm(agent: Pick<Agent, 'tenant_id' | 'llm_model'>): string | null {
  return (agent.llm_model && llmModelInfo(agent.llm_model) ? agent.llm_model : null) ?? tenantDefaultLlm(agent.tenant_id);
}

/** What the agent actually answers with on this server, e.g. "OpenAI gpt-5.5". */
export function agentEngineLabel(agent: Pick<Agent, 'tenant_id' | 'llm_model'>): string {
  return engineLabel(agentLlm(agent));
}

export interface LlmOption {
  id: string;
  name: string;
  vendor: string;
  ready: boolean;
  setup: string;
}

/** Every model in the list, with whether this server can run it — for pickers. */
export function llmOptions(): LlmOption[] {
  return LLM_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    ready: llmProviderReady(m.provider),
    setup: m.setup,
  }));
}

/** `provider:model` the server default resolves to (no account choice). */
export function serverDefaultLlm(): string | null {
  const sel = resolveLlm(null);
  return sel.provider === 'local' ? null : `${sel.provider}:${sel.model}`;
}
