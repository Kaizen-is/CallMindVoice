#!/usr/bin/env node
/**
 * Ovoz — seed an empty local datastore with one company and its login.
 *
 * Creates the bank company with the only login, admintest@callmind.uz (owner;
 * password from SEED_ADMIN_PASSWORD in your local .env, never committed), the
 * banking agent from /demo (live, with its "Who to call" borrower and script),
 * and a simulator phone number. Safe to re-run — what already exists is left
 * untouched.
 *
 *   npm run seed
 *
 * Needs node:sqlite (Node ≥ 22.13, or --experimental-sqlite on 22.5–22.12).
 * Run it while the dev server has already booted once, so migrations exist.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'data', 'ovoz.db');

if (!fs.existsSync(dbPath)) {
  console.error('data/ovoz.db does not exist yet — start the app once (npm run dev), then re-run.');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/* Same format as hash_password() in backend/app/auth.py. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/* Same alphabet/shape as new_id() in backend/app/ids.py. */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
function id(prefix) {
  let out = '';
  for (const b of crypto.randomBytes(16)) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

const now = () => new Date().toISOString();

/* Mirrors DEFAULT_ESCALATION / DEFAULT_HOURS in backend/app/engine/conversation.py. */
const DEFAULT_ESCALATION = {
  onLowConfidence: true,
  onExplicitRequest: true,
  onNegativeSentiment: true,
  onRepeatedFailure: true,
  maxFailedTurns: 2,
  afterHoursAction: 'answer_anyway',
  ringTimeoutSec: 30,
  fallbackNumber: '',
};
const DEFAULT_HOURS = {
  enabled: false,
  timezone: 'Asia/Tashkent',
  days: {
    1: { open: '09:00', close: '18:00', closed: false },
    2: { open: '09:00', close: '18:00', closed: false },
    3: { open: '09:00', close: '18:00', closed: false },
    4: { open: '09:00', close: '18:00', closed: false },
    5: { open: '09:00', close: '18:00', closed: false },
    6: { open: '10:00', close: '15:00', closed: false },
    0: { open: '00:00', close: '00:00', closed: true },
  },
};

const DEMO = {
  company: 'Biznesni rivojlantirish banki',
  slug: 'brb-demo',
  industry: 'finance',
};

/* The /demo banking agent — mirrors the BANK_AGENT_* constants and the target in backend/app/bank_agent.py. */
const BANK_AGENT = {
  name: 'Isomiddin — bank kredit eslatmasi',
  greeting: 'Assalomu alaykum! Men Isomiddin, Biznesni rivojlantirish bankidan qoʻngʻiroq qilyapman.',
  instructions:
    'When you introduce yourself, say that you are CALLING from the bank — in Uzbek "… bankidan qoʻngʻiroq qilyapman", ' +
    'in Russian "звоню из банка". Never describe yourself as just talking ("gaplashyapman").',
  target: {
    fullName: 'Aziz Karimov',
    birthYear: '1992',
    loanAmount: "7 800 000 so'm",
    prompt:
      'Siz Biznesni rivojlantirish banki nomidan qoʻngʻiroq qilyapsiz. Mijozga kredit boʻyicha ' +
      'muddati oʻtgan toʻlovni eslating. Agar u toʻliq toʻlay olmasa, summani uch oyga boʻlib ' +
      'toʻlashni taklif qiling. Toʻlovni bank ilovasi orqali yoki istalgan filialda qilish mumkin.',
  },
};

/*
 * The one login — owner is the highest role (owner > admin > operator > analyst).
 * Its password comes from SEED_ADMIN_PASSWORD in your local .env, so it is
 * never committed; without it nothing is seeded.
 */
const ADMIN_PASSWORD = (process.env.SEED_ADMIN_PASSWORD || '').trim();
const ADMIN = { email: 'admintest@callmind.uz', name: 'Admin', password: ADMIN_PASSWORD, role: 'owner' };

const userExists = (email) => db.prepare('SELECT id FROM users WHERE email=?').get(email);

function insertUser(tenantId, { email, name, password, role }, stamp) {
  const userId = id('usr');
  db.prepare(
    `INSERT INTO users (id, tenant_id, email, name, password_hash, role, avatar_hue, locale,
       status, presence, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'uz', 'active', 'offline', ?, ?)`,
  ).run(userId, tenantId, email, name, hashPassword(password), role, crypto.randomInt(360), stamp, stamp);
  return userId;
}

function ensureDemoTenant() {
  const existing = db.prepare('SELECT id FROM tenants WHERE slug=?').get(DEMO.slug);
  if (existing) return existing.id;

  const tenantId = id('ten');
  const agentId = id('agt');
  const stamp = now();
  const fallback = 'Kechirasiz, bu savolga aniq javob topa olmadim. Mutaxassisga ulab qo‘yaymi?';

  db.exec('BEGIN');
  try {
    // bankAgentSeeded: the Playground's ensureBankAgent() sees it and adds no second copy.
    db.prepare(
      `INSERT INTO tenants (id, name, slug, industry, country, timezone, plan, plan_started,
         trial_ends_at, locale, status, onboarded, settings_json, created_at, updated_at)
       VALUES (?,?,?,?, 'UZ', 'Asia/Tashkent', 'trial', ?, ?, 'uz', 'active', 1, ?, ?, ?)`,
    ).run(tenantId, DEMO.company, DEMO.slug, DEMO.industry, stamp,
      new Date(Date.now() + 365 * 864e5).toISOString(), JSON.stringify({ bankAgentSeeded: stamp }), stamp, stamp);

    const userId = insertUser(tenantId, ADMIN, stamp);

    db.prepare(
      `INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
         languages_json, primary_lang, voice_id, speaking_rate, temperature, max_turns,
         confidence_threshold, escalation_json, hours_json, tools_json, target_json, version,
         created_at, updated_at)
       VALUES (?,?,?, 'live', 'professional', ?, ?, ?, ?, 'uz', 'isomiddin', 1.0, 0.3, 40, 0.45, ?, ?, '[]', ?, 1, ?, ?)`,
    ).run(agentId, tenantId, BANK_AGENT.name, BANK_AGENT.greeting, fallback, BANK_AGENT.instructions,
      JSON.stringify(['uz', 'ru']), JSON.stringify(DEFAULT_ESCALATION),
      JSON.stringify(DEFAULT_HOURS), JSON.stringify(BANK_AGENT.target), stamp, stamp);

    db.prepare(
      `INSERT INTO phone_numbers (id, tenant_id, e164, label, provider, region, agent_id, status,
         capabilities, monthly_cost, created_at)
       VALUES (?,?, '+998787100001', 'Main line', 'simulator', 'Tashkent', ?, 'active', 'voice', 3.0, ?)`,
    ).run(id('num'), tenantId, agentId, stamp);

    db.prepare(
      `INSERT INTO audit_log (id, tenant_id, actor_id, actor_name, action, target, meta_json, created_at)
       VALUES (?,?,?,?, 'tenant.created', ?, ?, ?)`,
    ).run(id('aud'), tenantId, userId, ADMIN.name, tenantId,
      JSON.stringify({ industry: DEMO.industry, source: 'seed' }), stamp);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`created tenant  ${DEMO.company}  (${ADMIN.email})`);
  return tenantId;
}

if (userExists(ADMIN.email)) {
  console.log(`exists          ${ADMIN.email} — nothing to seed`);
} else if (!ADMIN_PASSWORD) {
  console.log(`skipped         set SEED_ADMIN_PASSWORD in .env to create ${ADMIN.email} and the bank company`);
} else {
  ensureDemoTenant();
  console.log(`
Log in at http://localhost:3000/login with ${ADMIN.email} / (SEED_ADMIN_PASSWORD from .env)`);
}
