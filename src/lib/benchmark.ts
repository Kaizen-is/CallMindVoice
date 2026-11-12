/**
 * The deploy benchmark — measures every engine set up on this server once per
 * build, and the Model lab shows the numbers.
 *
 *   • STT: the fixed Uzbek test set in `benchmarks/stt-uz/` (WAV + the words
 *     spoken) through each engine → latency, word and character error rate.
 *   • TTS: three Uzbek sentences in one voice per engine → time to first
 *     sound, total time, and clarity (Zipformer hears it back).
 *   • LLM: three short Uzbek questions to each model → first word and total
 *     time (the median, so one slow or busy answer does not decide it).
 *
 * It starts by itself a little after the server boots (`src/instrumentation.ts`)
 * and runs once per build: the build id (`.next/BUILD_ID`) is written to
 * `benchmark_runs` before anything else, so a restart, or a second pod of the
 * same build, finds it and does nothing. A new deploy is a new build, so it
 * runs again. Engine calls are logged as usage source `bench`, never as real
 * traffic. Development servers skip it unless BENCHMARK_ON_START=1;
 * BENCHMARK_ON_START=0 turns it off everywhere.
 */
import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { all, now, run } from '@/lib/db';
import { VOICES } from '@/lib/catalog';
import { score } from '@/lib/speech/scoring';
import { generateAnswer, isFallbackAnswer, llmProviderReady } from '@/lib/llm/provider';
import { ENGINES, LLM_MODELS } from '@/lib/speech/registry';
import { ELEVEN_VOICES } from '@/lib/speech/speko';
import { sttEngineIds, transcribeOne, type SttEngineId } from '@/lib/speech/stt';
import { pcmToWav, renderTimed, ttsEngines, type TtsEngine } from '@/lib/speech/tts';
import { transcribeWav, zipformerAvailable } from '@/lib/speech/zipformer';
import type { Locale } from '@/lib/types';
import { withUsageSource } from '@/lib/usage-log';

const SET_DIR = path.join(process.cwd(), 'benchmarks', 'stt-uz');
/** Wait after boot, so the benchmark never competes with the server starting up. */
const START_DELAY_MS = 90_000;

const TTS_SENTENCES = [
  'Assalomu alaykum! Buyurtmangiz 25-noyabr kuni soat 14:30 da yetkaziladi.',
  'Shifokor qabuliga yozilish uchun ismingiz va telefon raqamingizni ayting.',
  'Kechirasiz, bu savolga javob bera olmayman, sizni mutaxassisga ulayman.',
];
const LLM_QUESTIONS = [
  'O‘zbekistonning poytaxti qaysi shahar?',
  'Bir haftada necha kun bor?',
  'Suv necha darajada qaynaydi?',
];

export interface BenchmarkResult {
  kind: 'stt' | 'tts' | 'llm';
  engine: string;
  /** How many samples answered (of `samples`). */
  passed: number;
  samples: number;
  latencyMs: number | null;
  firstMs: number | null;
  wer: number | null;
  cer: number | null;
  clarity: number | null;
  measuredAt: string;
}

/** The latest result for every engine and model, from the last benchmark that measured it. */
export function latestBenchmarks(): BenchmarkResult[] {
  return all<{
    kind: BenchmarkResult['kind'];
    engine: string;
    passed: number;
    samples: number;
    latency_ms: number | null;
    first_ms: number | null;
    wer: number | null;
    cer: number | null;
    clarity: number | null;
    created_at: string;
  }>(
    `SELECT kind, engine, passed, samples, latency_ms, first_ms, wer, cer, clarity, created_at
       FROM benchmark_results
      WHERE id IN (SELECT MAX(id) FROM benchmark_results GROUP BY kind, engine)`,
  ).map((r) => ({
    kind: r.kind,
    engine: r.engine,
    passed: r.passed,
    samples: r.samples,
    latencyMs: r.latency_ms,
    firstMs: r.first_ms,
    wer: r.wer,
    cer: r.cer,
    clarity: r.clarity,
    measuredAt: r.created_at,
  }));
}

/** Called once at server start: runs the benchmark later, in the background, if this build has none. */
export function scheduleBenchmark(): void {
  const flag = process.env.BENCHMARK_ON_START;
  if (flag === '0') return;
  if (process.env.NODE_ENV !== 'production' && flag !== '1') return;
  const build = buildId();
  if (!build) return;
  const timer = setTimeout(() => {
    void runBenchmark(build).catch((err) =>
      console.warn('[benchmark] failed:', err instanceof Error ? err.message : err),
    );
  }, START_DELAY_MS);
  timer.unref?.();
}

function buildId(): string | null {
  try {
    return fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || null;
  } catch {
    return process.env.BENCHMARK_ON_START === '1' ? 'dev' : null;
  }
}

/** Measure everything for `build`, unless it was measured already. Returns false when skipped. */
export async function runBenchmark(build: string): Promise<boolean> {
  // The claim comes first: of two servers starting together, one wins.
  const claimed = run(
    `INSERT OR IGNORE INTO benchmark_runs (build, started_at, status) VALUES (?, ?, 'running')`,
    build,
    now(),
  );
  if (!Number(claimed.changes)) return false;
  console.log(`[benchmark] measuring engines for build ${build}`);

  let failed = false;
  await withUsageSource('bench', undefined, async () => {
    for (const [name, step] of [
      ['stt', benchmarkStt],
      ['tts', benchmarkTts],
      ['llm', benchmarkLlm],
    ] as const) {
      try {
        await step(build);
      } catch (err) {
        failed = true;
        console.warn(`[benchmark] ${name} step failed:`, err instanceof Error ? err.message : err);
      }
    }
  });
  run(`UPDATE benchmark_runs SET finished_at = ?, status = ? WHERE build = ?`, now(), failed ? 'partial' : 'done', build);
  console.log(`[benchmark] done for build ${build}`);
  return true;
}

function save(build: string, r: Omit<BenchmarkResult, 'measuredAt'>) {
  const round = (n: number | null) => (n == null ? null : Math.round(n));
  run(
    `INSERT INTO benchmark_results (build, kind, engine, passed, samples, latency_ms, first_ms, wer, cer, clarity, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    build,
    r.kind,
    r.engine,
    r.passed,
    r.samples,
    round(r.latencyMs),
    round(r.firstMs),
    r.wer,
    r.cer,
    r.clarity,
    now(),
  );
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/* ── STT ─────────────────────────────────────────────────────── */

interface Clip {
  file: string;
  text: string;
  language: Locale;
}

function loadSet(): Array<Clip & { audio: ArrayBuffer }> {
  const set = JSON.parse(fs.readFileSync(path.join(SET_DIR, 'set.json'), 'utf8')) as { clips: Clip[] };
  return set.clips.map((c) => {
    const wav = fs.readFileSync(path.join(SET_DIR, c.file));
    return { ...c, audio: new Uint8Array(wav).buffer };
  });
}

async function benchmarkStt(build: string) {
  const clips = loadSet();
  const ready = sttEngineIds() as Record<string, boolean>;
  for (const e of ENGINES.filter((x) => x.kind === 'stt' && ready[x.id])) {
    const times: number[] = [];
    const wers: number[] = [];
    const cers: number[] = [];
    // One clip at a time, one engine at a time: each timing is the engine alone.
    for (const clip of clips) {
      const started = performance.now();
      try {
        const heard = await transcribeOne(e.id as SttEngineId, clip.audio, clip.language);
        times.push(performance.now() - started);
        const s = score(clip.text, heard.text);
        if (s.wer != null) wers.push(s.wer);
        if (s.cer != null) cers.push(s.cer);
      } catch {
        /* counted as not passed */
      }
    }
    save(build, {
      kind: 'stt',
      engine: e.id,
      passed: times.length,
      samples: clips.length,
      latencyMs: mean(times),
      firstMs: null,
      wer: mean(wers),
      cer: mean(cers),
      clarity: null,
    });
  }
}

/* ── TTS ─────────────────────────────────────────────────────── */

async function benchmarkTts(build: string) {
  const ready = ttsEngines() as Record<string, boolean>;
  const hear = zipformerAvailable();
  for (const e of ENGINES.filter((x) => x.kind === 'tts' && ready[x.id])) {
    const engine = e.id as TtsEngine;
    const voiceId =
      engine === 'default' ? (VOICES[0]?.id ?? null) : (ELEVEN_VOICES[0]?.id ?? null);
    if (!voiceId) continue;
    const first: number[] = [];
    const total: number[] = [];
    const clarity: number[] = [];
    for (const sentence of TTS_SENTENCES) {
      try {
        const out = await renderTimed(sentence, { tenantId: 'bench', voiceId, language: 'uz', engine });
        first.push(out.firstMs);
        total.push(out.totalMs);
        if (hear) {
          const s = score(out.spoken, transcribeWav(pcmToWav(out.pcm)));
          if (s.cer != null) clarity.push(Math.max(0, 1 - s.cer));
        }
      } catch {
        /* counted as not passed */
      }
    }
    save(build, {
      kind: 'tts',
      engine,
      passed: total.length,
      samples: TTS_SENTENCES.length,
      latencyMs: mean(total),
      firstMs: mean(first),
      wer: null,
      cer: null,
      clarity: mean(clarity),
    });
  }
}

/* ── LLM ─────────────────────────────────────────────────────── */

async function benchmarkLlm(build: string) {
  for (const m of LLM_MODELS.filter((x) => llmProviderReady(x.provider))) {
    const first: number[] = [];
    const total: number[] = [];
    for (const question of LLM_QUESTIONS) {
      const started = performance.now();
      let firstMs: number | null = null;
      const out = await generateAnswer(
        {
          question,
          hits: [],
          confidence: 0,
          language: 'uz',
          agentName: 'CallMind',
          threshold: 0.45,
          history: [],
          llm: m.id,
        },
        () => {
          if (firstMs === null) firstMs = performance.now() - started;
        },
      ).catch(() => null);
      // The model under test failed if the local engine or the fallback model answered for it.
      if (!out || out.engine === 'local' || isFallbackAnswer(out) || !out.answer.trim()) continue;
      const totalMs = performance.now() - started;
      total.push(totalMs);
      // Models that answer in one piece have no separate first word.
      first.push(firstMs ?? totalMs);
    }
    save(build, {
      kind: 'llm',
      engine: m.id,
      passed: total.length,
      samples: LLM_QUESTIONS.length,
      latencyMs: median(total),
      firstMs: median(first),
      wer: null,
      cer: null,
      clarity: null,
    });
  }
}
