/**
 * Static catalogues shared by server and client code.
 *
 * Kept free of any server-only import so client components can render the
 * pickers without dragging the persistence layer into the browser bundle.
 */

import type { Locale } from './types';

/**
 * Which spoken languages currently have working voice recognition (speech-to-
 * text). Uzbek runs on our own STT model; Russian and English recognition is
 * not shipped yet and is surfaced as "available soon" in the UI.
 *
 * This is the single switch — add `'ru'` / `'en'` here to light them up
 * everywhere at once. It gates input (recognition) only; the agent can still
 * answer in any language.
 */
export const VOICE_INPUT_LANGS: readonly Locale[] = ['uz'];

export function voiceInputAvailable(lang: Locale): boolean {
  return VOICE_INPUT_LANGS.includes(lang);
}

export const INDUSTRIES = [
  { value: 'clinic', label: 'Clinic / medical centre' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'retail', label: 'Retail / e-commerce' },
  { value: 'logistics', label: 'Logistics & delivery' },
  { value: 'education', label: 'Education' },
  { value: 'hospitality', label: 'Hotel / restaurant' },
  { value: 'beauty', label: 'Beauty & wellness' },
  { value: 'automotive', label: 'Automotive' },
  { value: 'telecom', label: 'Telecom / utilities' },
  { value: 'finance', label: 'Bank / fintech' },
  { value: 'other', label: 'Something else' },
] as const;

// The internal Uzbek TTS server exposes exactly two voice profiles, mapped by
// `gender` in the TTS route: female → uz_female_calm, male → uz_male_news.
export const VOICES = [
  { id: 'nilufar', name: 'Nilufar', gender: 'female', langs: ['uz'], note: 'Warm, unhurried female voice' },
  { id: 'timur', name: 'Timur', gender: 'male', langs: ['uz'], note: 'Formal, low-register male voice' },
] as const;

export const PERSONAS = [
  { value: 'professional', label: 'Professional', hint: 'Composed and efficient' },
  { value: 'friendly', label: 'Friendly', hint: 'Warm, a little conversational' },
  { value: 'concise', label: 'Concise', hint: 'Answers and stops' },
  { value: 'empathetic', label: 'Empathetic', hint: 'Acknowledges the caller first' },
] as const;

// Billing is denominated in MINUTES. Each plan bundles `minutesIncluded`; usage
// above the bundle is billed at OVERAGE_PER_MINUTE. `callsIncluded` is a rounded
// "≈ calls" figure (at ~3.3 min/call) kept only for human-friendly display —
// minutes are the source of truth for metering and billing.
// Prices target the Uzbek market, where a fully-loaded operator is ~$300–500/mo,
// so the entry tier reads as "less than one salary." Bundles are sized so each
// tier is genuinely the cheapest choice within its own volume band (base premium
// < the overage value of the extra included minutes), not just feature-gated.
export const PLANS = [
  {
    id: 'trial',
    name: 'Trial',
    priceUsd: 0,
    minutesIncluded: 500,
    callsIncluded: 150,
    overagePerMinute: 0.04,
    numbers: 1,
    seats: 3,
    storageMb: 100,
    blurb: '14 days to decide.',
  },
  {
    id: 'payg',
    name: 'Pay as you go',
    priceUsd: 0,
    minutesIncluded: 0,
    callsIncluded: 0,
    overagePerMinute: 0.05,
    numbers: 1,
    seats: 2,
    storageMb: 250,
    blurb: 'Metered from the first minute — grow into a plan.',
  },
  {
    id: 'start',
    name: 'Start',
    priceUsd: 199,
    minutesIncluded: 4_000,
    callsIncluded: 1_200,
    overagePerMinute: 0.04,
    numbers: 1,
    seats: 3,
    storageMb: 500,
    blurb: 'One number, one agent.',
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUsd: 890,
    minutesIncluded: 25_000,
    callsIncluded: 7_500,
    overagePerMinute: 0.04,
    numbers: 5,
    seats: 999,
    storageMb: 5000,
    blurb: 'Multi-branch with an operator team.',
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceUsd: 2490,
    minutesIncluded: 80_000,
    callsIncluded: 24_000,
    overagePerMinute: 0.035,
    numbers: 50,
    seats: 999,
    storageMb: 50000,
    blurb: 'Residency, SSO and an SLA.',
  },
] as const;

// Customer-facing overage rate ($/min above the plan bundle). Set below the
// per-minute cost of a human operator (a $300 operator ≈ $0.042/handled-min) so
// the ROI is clearly positive, yet ~2x the true marginal cash cost of a minute
// (telephony + Gemini + electricity on the self-hosted STT/TTS).
export const OVERAGE_PER_MINUTE = 0.04;

// Average call length (minutes) used only to translate minute bundles into a
// friendly "≈ N calls" figure in marketing copy and the ROI calculator.
export const AVG_CALL_MINUTES = 3.3;

// Prepaid per-minute rates in UZS (so'm) — balance model: deposit and spend as used.
export const UZS_RATES = { realTalkPerMin: 1000, ttsPerMin: 800, sttPerMin: 600 } as const;
export const AI_MINUTE_UZS = UZS_RATES.ttsPerMin + UZS_RATES.sttPerMin; // 1400 — AI listens (STT) + speaks (TTS)

// Contact-centre operator productivity, shared by the ROI calculator (client)
// and mirrored by the engine's OPERATOR_ASSUMPTIONS (server). 65% occupancy is a
// healthy after-shrinkage figure (breaks, wrap-up, training, idle time).
export const OPERATOR_OCCUPANCY = 0.65;
export const OPERATOR_MINUTES_PER_MONTH = 22 * 8 * 60 * OPERATOR_OCCUPANCY;

export const ESCALATION_REASON_LABEL: Record<string, string> = {
  low_confidence: 'Not confident enough',
  explicit_request: 'Caller asked for a human',
  negative_sentiment: 'Caller was unhappy',
  repeated_failure: 'Several unanswered questions',
  after_hours: 'Outside business hours',
  max_turns: 'Conversation ran long',
};

export const CALL_STATUS_LABEL: Record<string, string> = {
  ringing: 'Ringing',
  active: 'In progress',
  escalating: 'Handing over',
  with_operator: 'With operator',
  completed: 'Completed',
  abandoned: 'Abandoned',
  failed: 'Failed',
};

export const OUTCOME_LABEL: Record<string, string> = {
  resolved_by_ai: 'Resolved by AI',
  resolved_by_operator: 'Resolved by operator',
  abandoned: 'Abandoned',
  voicemail: 'Voicemail',
};

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  analyst: 'Analyst',
};

export const WEEKDAYS = [
  { key: '1', label: 'Monday', short: 'Mon' },
  { key: '2', label: 'Tuesday', short: 'Tue' },
  { key: '3', label: 'Wednesday', short: 'Wed' },
  { key: '4', label: 'Thursday', short: 'Thu' },
  { key: '5', label: 'Friday', short: 'Fri' },
  { key: '6', label: 'Saturday', short: 'Sat' },
  { key: '0', label: 'Sunday', short: 'Sun' },
] as const;
