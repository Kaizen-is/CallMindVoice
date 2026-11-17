/**
 * What the Python backend's workspace and dashboard views send (`GET /views/<page>`,
 * backend/app/dashboards.py): the data these pages used to compute from src/lib.
 * Types only — the pages fetch it with `coreGet`.
 */
import type { DailyPoint, Overview } from '@/lib/analytics';
import type { TelephonyMode } from '@/lib/telephony/status';
import type { ApiKey, Call, PhoneNumber, SafeUser, WalletLedger, Webhook } from '@/lib/types';

export interface TelephonyInfo {
  configured: boolean;
  mode: TelephonyMode;
}

/** The answer engine: the account's choice as this server resolves it, and the server default. */
export interface LlmInfo {
  hosted: boolean;
  label: string;
  serverHosted: boolean;
}

export interface KnowledgeStats {
  documents: number;
  ready: number;
  chunks: number;
  tokens: number;
  bytes: number;
}

export interface KnowledgeGap {
  id: string;
  question: string;
  hits: number;
  best_score: number;
  last_seen: string;
}

export interface IntentRow {
  intent: string;
  label: string;
  count: number;
  resolvedRate: number;
}

export interface OverviewData {
  stats: Overview;
  trend: DailyPoint[];
  kb: KnowledgeStats;
  gaps: KnowledgeGap[];
  topIntents: IntentRow[];
  recent: Call[];
  callsDelta: number | null;
  setupDone: { knowledge: boolean; agent: boolean; number: boolean; tested: boolean };
  llm: LlmInfo;
  telephony: TelephonyInfo;
}

export interface AnalyticsData {
  stats: Overview;
  trend: DailyPoint[];
  heat: number[][];
  topIntents: IntentRow[];
  langs: Array<{ language: string; c: number }>;
  reasons: Array<{ reason: string; c: number; avgWait: number | null }>;
  gaps: KnowledgeGap[];
  operators: Array<{
    id: string;
    name: string;
    avatar_hue: number;
    handled: number;
    avgHandle: number | null;
    avgWait: number | null;
  }>;
  latency: { p50: number; p90: number; p95: number; p99: number };
  aiMinutes: number;
  humanEquivalent: number;
  actualSpend: number;
  operatorAssumptions: { loadedMonthlyCost: number; workingDays: number; shiftHours: number; occupancy: number };
  operatorCostPerMinute: number;
}

export interface NumbersData {
  numbers: Array<PhoneNumber & { agent_name: string | null; call_count: number }>;
  telephony: TelephonyInfo;
}

export interface TeamData {
  members: Array<SafeUser & { handled: number }>;
  audit: Array<{
    id: string;
    actor_name: string | null;
    action: string;
    target: string | null;
    created_at: string;
  }>;
}

export interface SettingsData {
  llm: LlmInfo;
  embedding: { id: string; hosted: boolean };
  telephony: TelephonyInfo;
  stats: KnowledgeStats;
}

export interface DevelopersData {
  keys: ApiKey[];
  hooks: Webhook[];
  exampleNumber: string;
}

export interface BillingData {
  balance: number;
  negative: boolean;
  low: boolean;
  ledger: WalletLedger[];
  uzsRates: { realTalkPerMin: number; ttsPerMin: number; sttPerMin: number };
  aiMinuteUzs: number;
}
