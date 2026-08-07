/**
 * Tenant provisioning — everything a new company needs to exist.
 */
import 'server-only';
import { get, id, now, run, tx } from './db';
import { audit, hashPassword } from './auth';
import { DEFAULT_ESCALATION, DEFAULT_HOURS } from './engine/conversation';
import type { Locale, Role } from './types';
import { slugify } from './utils';

const GREETINGS: Record<Locale, (company: string) => string> = {
  uz: (c) => `Assalomu alaykum! ${c} ga qo‘ng‘iroq qilganingiz uchun rahmat. Sizga qanday yordam bera olaman?`,
  ru: (c) => `Здравствуйте! Вы позвонили в ${c}. Чем я могу помочь?`,
  en: (c) => `Hello, thank you for calling ${c}. How can I help you today?`,
};

const FALLBACKS: Record<Locale, string> = {
  uz: 'Kechirasiz, bu savolga aniq javob topa olmadim. Mutaxassisga ulab qo‘yaymi?',
  ru: 'К сожалению, точного ответа у меня нет. Соединить вас со специалистом?',
  en: "I couldn't find a confident answer to that. Shall I connect you to a colleague?",
};

function uniqueSlug(base: string) {
  const root = slugify(base) || 'company';
  let candidate = root;
  let n = 1;
  while (get('SELECT id FROM tenants WHERE slug=?', candidate)) {
    candidate = `${root}-${++n}`;
  }
  return candidate;
}

function localNumber(seed: number) {
  const line = String(1000000 + (seed % 8999999)).slice(0, 7);
  return `+9987871${line.slice(0, 5)}`;
}

export interface ProvisionInput {
  company: string;
  industry: string;
  fullName: string;
  email: string;
  password: string;
  locale?: Locale;
  primaryLang?: Locale;
}

export function provisionTenant(input: ProvisionInput) {
  const email = input.email.trim().toLowerCase();
  if (get('SELECT id FROM users WHERE email=?', email)) {
    throw new Error('An account with this email already exists.');
  }

  const tenantId = id('ten');
  const userId = id('usr');
  const agentId = id('agt');
  const numberId = id('num');
  const locale = input.locale ?? 'uz';
  const primaryLang = input.primaryLang ?? 'uz';
  const stamp = now();
  const trialEnds = new Date(Date.now() + 14 * 864e5).toISOString();

  tx(() => {
    run(
      `INSERT INTO tenants (id, name, slug, industry, country, timezone, plan, plan_started,
         trial_ends_at, locale, status, onboarded, settings_json, created_at, updated_at)
       VALUES (?,?,?,?, 'UZ', 'Asia/Tashkent', 'trial', ?, ?, ?, 'active', 0, '{}', ?, ?)`,
      tenantId,
      input.company.trim(),
      uniqueSlug(input.company),
      input.industry,
      stamp,
      trialEnds,
      locale,
      stamp,
      stamp,
    );

    run(
      `INSERT INTO users (id, tenant_id, email, name, password_hash, role, avatar_hue, locale,
         status, presence, created_at, updated_at)
       VALUES (?,?,?,?,?, 'owner', ?, ?, 'active', 'online', ?, ?)`,
      userId,
      tenantId,
      email,
      input.fullName.trim(),
      hashPassword(input.password),
      Math.floor(Math.random() * 360),
      locale,
      stamp,
      stamp,
    );

    run(
      `INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
         languages_json, primary_lang, voice_id, speaking_rate, temperature, max_turns,
         confidence_threshold, escalation_json, hours_json, tools_json, version, created_at, updated_at)
       VALUES (?,?,?, 'draft', 'professional', ?, ?, '', ?, ?, 'nilufar', 1.0, 0.3, 24, 0.45, ?, ?, '[]', 1, ?, ?)`,
      agentId,
      tenantId,
      `${input.company.trim()} Assistant`,
      GREETINGS[primaryLang](input.company.trim()),
      FALLBACKS[primaryLang],
      JSON.stringify(['uz', 'ru', 'en']),
      primaryLang,
      JSON.stringify(DEFAULT_ESCALATION),
      JSON.stringify(DEFAULT_HOURS),
      stamp,
      stamp,
    );

    run(
      `INSERT INTO phone_numbers (id, tenant_id, e164, label, provider, region, agent_id, status,
         capabilities, monthly_cost, created_at)
       VALUES (?,?,?, 'Main line', 'simulator', 'Tashkent', ?, 'active', 'voice', 3.0, ?)`,
      numberId,
      tenantId,
      localNumber(Date.now()),
      agentId,
      stamp,
    );
  });

  audit(tenantId, { id: userId, name: input.fullName }, 'tenant.created', tenantId, {
    industry: input.industry,
  });

  return { tenantId, userId, agentId, numberId };
}

export function inviteMember(params: {
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  password: string;
  actor: { id: string; name: string };
}) {
  const email = params.email.trim().toLowerCase();
  if (get('SELECT id FROM users WHERE email=?', email)) {
    throw new Error('That email is already in use.');
  }
  const userId = id('usr');
  run(
    `INSERT INTO users (id, tenant_id, email, name, password_hash, role, avatar_hue, locale,
       status, presence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'en', 'active', 'offline', ?, ?)`,
    userId,
    params.tenantId,
    email,
    params.name.trim(),
    hashPassword(params.password),
    params.role,
    Math.floor(Math.random() * 360),
    now(),
    now(),
  );
  audit(params.tenantId, params.actor, 'team.invited', userId, { email, role: params.role });
  return userId;
}
