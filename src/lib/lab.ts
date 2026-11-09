/**
 * The model lab — one statistics page for every engine CallMind can use:
 * whether it is set up here, how fast it is, what it costs and how accurate
 * it is on Uzbek. Testing by hand happens on the For developers pages and the
 * Voices page; the numbers here come from the deploy benchmark
 * (`@/lib/benchmark`), measured once per build.
 */
import 'server-only';
import { latestBenchmarks, type BenchmarkResult } from '@/lib/benchmark';
import { llmProviderReady } from '@/lib/llm/provider';
import { ENGINES, LLM_MODELS, type LlmProvider } from '@/lib/speech/registry';
import { sttEngineIds } from '@/lib/speech/stt';
import { ttsEngines } from '@/lib/speech/tts';

interface StatBase {
  id: string;
  name: string;
  vendor: string;
  via?: string;
  ready: boolean;
  /** What has to be set for it to work. */
  setup: string;
  /** Runs on our own server, so it has no per-use price. */
  own: boolean;
}

export interface SttStat extends StatBase {
  pricePerMin: number | null;
  latencyMs: number | null;
  wer: number | null;
  cer: number | null;
}

export interface TtsStat extends StatBase {
  pricePerMin: number | null;
  firstMs: number | null;
  latencyMs: number | null;
  /** 1 − character error rate of what Zipformer heard back. */
  clarity: number | null;
}

export interface LlmStat extends StatBase {
  provider: LlmProvider;
  priceIn: number | null;
  priceOut: number | null;
  firstMs: number | null;
  latencyMs: number | null;
}

export interface ModelStats {
  stt: SttStat[];
  tts: TtsStat[];
  llm: LlmStat[];
}

export function modelStats(): ModelStats {
  const result = new Map(latestBenchmarks().map((b) => [`${b.kind}:${b.engine}`, b]));
  // A result only counts when at least one sample answered.
  const ok = (key: string): BenchmarkResult | undefined => {
    const r = result.get(key);
    return r && r.passed > 0 ? r : undefined;
  };
  const sttReady = sttEngineIds() as Record<string, boolean>;
  const ttsReady = ttsEngines() as Record<string, boolean>;

  const stt = ENGINES.filter((e) => e.kind === 'stt').map((e): SttStat => {
    const r = ok(`stt:${e.id}`);
    return {
      id: e.id,
      name: e.name,
      vendor: e.vendor,
      via: e.via,
      ready: Boolean(sttReady[e.id]),
      setup: e.setup,
      own: e.runs === 'server',
      pricePerMin: e.pricePerMin,
      latencyMs: r?.latencyMs ?? null,
      wer: r?.wer ?? null,
      cer: r?.cer ?? null,
    };
  });

  const tts = ENGINES.filter((e) => e.kind === 'tts').map((e): TtsStat => {
    const r = ok(`tts:${e.id}`);
    return {
      id: e.id,
      name: e.name,
      vendor: e.vendor,
      via: e.via,
      ready: Boolean(ttsReady[e.id]),
      setup: e.setup,
      own: e.runs === 'server',
      pricePerMin: e.pricePerMin,
      firstMs: r?.firstMs ?? null,
      latencyMs: r?.latencyMs ?? null,
      clarity: r?.clarity ?? null,
    };
  });

  const llm = LLM_MODELS.map((m): LlmStat => {
    const r = ok(`llm:${m.id}`);
    return {
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      ready: llmProviderReady(m.provider),
      setup: m.setup,
      own: m.runs === 'server',
      provider: m.provider,
      priceIn: m.priceIn,
      priceOut: m.priceOut,
      firstMs: r?.firstMs ?? null,
      latencyMs: r?.latencyMs ?? null,
    };
  });

  return { stt, tts, llm };
}
