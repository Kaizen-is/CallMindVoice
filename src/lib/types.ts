/** Content / spoken language — script-agnostic. Drives RAG, voice and calls. */
export type Locale = 'en' | 'ru' | 'uz';

/**
 * Interface language the user reads the console in. Uzbek is still written in
 * two scripts in daily use, so it gets both — Latin (`uz`) and Cyrillic
 * (`uz-Cyrl`). This is a display concern only; the agent always answers a
 * caller in whatever they actually speak, so `contentLocale` folds the script
 * away wherever a spoken `Locale` is needed.
 */
export type UiLocale = 'en' | 'ru' | 'uz' | 'uz-Cyrl';

/** Narrow a UI locale to the spoken language it represents. */
export function contentLocale(ui: UiLocale): Locale {
  return ui === 'uz-Cyrl' ? 'uz' : ui;
}

export type Role = 'owner' | 'admin' | 'operator' | 'analyst';
export type PlanId = 'trial' | 'payg' | 'start' | 'pro' | 'enterprise';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  industry: string;
  country: string;
  timezone: string;
  plan: PlanId;
  plan_started: string | null;
  trial_ends_at: string | null;
  locale: UiLocale;
  status: string;
  onboarded: number;
  settings_json: string;
  /** Prepaid so'm balance. Call usage debits it; owner top-ups credit it. */
  balance_uzs: number;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  avatar_hue: number;
  locale: UiLocale;
  status: string;
  presence: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SafeUser = Omit<User, 'password_hash'>;

export interface Agent {
  id: string;
  tenant_id: string;
  name: string;
  status: 'draft' | 'live' | 'paused';
  persona: string;
  greeting: string;
  fallback_line: string;
  instructions: string;
  languages_json: string;
  primary_lang: Locale;
  voice_id: string;
  speaking_rate: number;
  temperature: number;
  max_turns: number;
  confidence_threshold: number;
  escalation_json: string;
  hours_json: string;
  tools_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface EscalationPolicy {
  onLowConfidence: boolean;
  onExplicitRequest: boolean;
  onNegativeSentiment: boolean;
  onRepeatedFailure: boolean;
  maxFailedTurns: number;
  afterHoursAction: 'voicemail' | 'callback' | 'answer_anyway';
  ringTimeoutSec: number;
  fallbackNumber: string;
}

export interface BusinessHours {
  enabled: boolean;
  timezone: string;
  /** 0 = Sunday … 6 = Saturday */
  days: Record<string, { open: string; close: string; closed: boolean }>;
}

export interface Document {
  id: string;
  tenant_id: string;
  title: string;
  source_type: 'pdf' | 'docx' | 'txt' | 'md' | 'csv' | 'url' | 'faq';
  source_ref: string | null;
  byte_size: number;
  language: string;
  status: 'queued' | 'parsing' | 'chunking' | 'embedding' | 'ready' | 'failed';
  progress: number;
  error: string | null;
  chunk_count: number;
  token_count: number;
  char_count: number;
  content: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Chunk {
  id: string;
  tenant_id: string;
  document_id: string;
  ordinal: number;
  heading: string | null;
  text: string;
  token_count: number;
  embedding: Uint8Array | null;
  terms_json: string;
  created_at: string;
}

export interface PhoneNumber {
  id: string;
  tenant_id: string;
  e164: string;
  label: string;
  provider: 'simulator' | 'twilio' | 'sip';
  region: string;
  agent_id: string | null;
  status: string;
  capabilities: string;
  monthly_cost: number;
  created_at: string;
}

export type CallStatus =
  | 'ringing'
  | 'active'
  | 'escalating'
  | 'with_operator'
  | 'completed'
  | 'abandoned'
  | 'failed';

export interface Call {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  number_id: string | null;
  direction: 'inbound' | 'outbound';
  channel: 'voice' | 'web' | 'chat';
  from_e164: string;
  to_e164: string;
  caller_name: string | null;
  status: CallStatus;
  outcome: string | null;
  language: Locale;
  intent: string | null;
  sentiment: number | null;
  confidence: number | null;
  csat: number | null;
  turns: number;
  duration_ms: number;
  first_response_ms: number | null;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  cost_usd: number;
  escalated: number;
  escalation_reason: string | null;
  operator_id: string | null;
  summary: string | null;
  recording_url: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

export interface Citation {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  heading: string | null;
  snippet: string;
  score: number;
}

export interface Timings {
  sttMs: number;
  retrievalMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}

export interface Turn {
  id: string;
  tenant_id: string;
  call_id: string;
  ordinal: number;
  role: 'caller' | 'agent' | 'operator' | 'system';
  text: string;
  language: string | null;
  confidence: number | null;
  citations_json: string;
  timings_json: string;
  latency_ms: number | null;
  created_at: string;
}

export interface Escalation {
  id: string;
  tenant_id: string;
  call_id: string;
  reason: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'waiting' | 'assigned' | 'resolved' | 'missed';
  summary: string | null;
  operator_id: string | null;
  waited_ms: number | null;
  handled_ms: number | null;
  resolution: string | null;
  notes: string | null;
  created_at: string;
  assigned_at: string | null;
  resolved_at: string | null;
}

export interface UsageDay {
  id: string;
  tenant_id: string;
  day: string;
  calls: number;
  ai_resolved: number;
  escalated: number;
  abandoned: number;
  minutes: number;
  cost_usd: number;
  avg_latency_ms: number;
  csat_sum: number;
  csat_count: number;
}

export interface KnowledgeGap {
  id: string;
  tenant_id: string;
  question: string;
  hits: number;
  best_score: number;
  status: string;
  answer: string | null;
  last_seen: string;
  created_at: string;
}

export interface Invoice {
  id: string;
  tenant_id: string;
  period: string;
  plan: string;
  base_usd: number;
  usage_usd: number;
  total_usd: number;
  minutes: number;
  calls: number;
  status: string;
  issued_at: string;
}

/** One movement of the prepaid so'm wallet — a top-up credit or a call debit. */
export interface WalletLedger {
  id: string;
  tenant_id: string;
  kind: 'topup' | 'debit';
  amount_uzs: number;
  balance_after: number | null;
  note: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string;
  last_used: string | null;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface AuditEntry {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  meta_json: string;
  ip: string | null;
  created_at: string;
}

export interface Webhook {
  id: string;
  tenant_id: string;
  url: string;
  events: string;
  secret: string;
  status: string;
  created_at: string;
}

/** One developer speech-lab run — a transcription (stt) or a synthesis (tts). */
export interface SpeechTest {
  id: string;
  tenant_id: string;
  user_id: string | null;
  kind: 'stt' | 'tts';
  /** For stt: the input note (filename or "recording"). For tts: the source text. */
  input: string | null;
  /** For stt: the transcript. For tts: unused. */
  output: string | null;
  /** For tts: the voice id used. */
  voice: string | null;
  created_at: string;
}
