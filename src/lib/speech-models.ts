'use client';

/**
 * The speech models, one list for the whole console: the Playground (STT + TTS together), the
 * STT page and the TTS page all offer exactly these, with the same names, the same voices per
 * model and the same remembered choice — so whatever is picked or changed in one behaves the
 * same in the others. Engines this server cannot run are listed but disabled.
 */
import { useEffect, useState } from 'react';
import type { ModelOption } from '@/components/ui/model-menu';

export type SttChoice = 'auto' | 'gapi' | 'local' | 'gemini' | 'gemini_live' | 'scribe' | 'scribe_live' | 'brb';

/** Engines that stream: the caller's words appear while they speak (/api/speech/live). */
export const LIVE_STT: ReadonlySet<string> = new Set(['local', 'gemini_live', 'scribe_live']);

/** How long to wait for a streaming model's last words once the phrase ends (normally 0.1–0.4 s). */
export function liveFinishMs(engine: string): number {
  return engine === 'gemini_live' || engine === 'scribe_live' ? 1200 : 900;
}

export type TtsChoice =
  | 'default'
  | 'brb'
  | 'eleven_v3_conversational'
  | 'eleven_v4_turbo'
  | 'gemini-3.8-flash-tts'
  | 'gemini-3.8-flash-lite-tts';

/** The Gemini TTS models (from Google, Speko the fallback): they speak with Gemini's own voices. */
export const GEMINI_TTS: ReadonlySet<string> = new Set(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);

export const STT_MODELS: Array<{ id: SttChoice; name: string; detail: string; setup: string }> = [
  { id: 'auto', name: 'Own STT', detail: 'CallMind', setup: 'STT_TRANSCRIBE_URL' },
  { id: 'gapi', name: 'GAPI', detail: 'gapi.uz', setup: 'GAPIAPI' },
  { id: 'local', name: 'Zipformer', detail: 'in-app · live', setup: 'models/uzbek-zipformer' },
  { id: 'gemini', name: 'gemini-3.5', detail: 'Google', setup: 'GEMINI_API_KEY' },
  { id: 'gemini_live', name: 'gemini-3.5 live', detail: 'Google · live, word by word', setup: 'GEMINI_API_KEY' },
  { id: 'scribe', name: 'ElevenLabs Scribe', detail: 'ElevenLabs · Speko', setup: 'SPEKO_API_KEY' },
  {
    id: 'scribe_live',
    name: 'ElevenLabs Scribe v3 Live',
    detail: 'ElevenLabs · Speko · live, word by word',
    setup: 'SPEKO_API_KEY',
  },
  // Last, like BRB TTS: reachable only over the VPN.
  { id: 'brb', name: 'BRB Whisper', detail: 'own model · VPN', setup: 'BRB_SPEECH_LOGIN' },
];

export const TTS_MODELS: Array<{ id: TtsChoice; name: string; detail: string; setup: string }> = [
  { id: 'default', name: 'Own TTS', detail: 'CallMind', setup: 'TTS_BASE_URL' },
  { id: 'eleven_v4_turbo', name: 'ElevenLabs v4 Turbo', detail: 'Speko', setup: 'SPEKO_API_KEY' },
  { id: 'eleven_v3_conversational', name: 'ElevenLabs v3', detail: 'Speko', setup: 'SPEKO_API_KEY' },
  { id: 'gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS', detail: 'Google', setup: 'GEMINI_API_KEY' },
  { id: 'gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash-Lite TTS', detail: 'Google', setup: 'GEMINI_API_KEY' },
  // Last, so it is never the starting pick while the proxy is reachable only over the VPN.
  { id: 'brb', name: 'BRB TTS', detail: 'own model · VPN', setup: 'BRB_SPEECH_LOGIN' },
];

/** Whose voices a TTS model speaks with. */
export type VoiceProvider = 'own' | 'eleven' | 'gemini' | 'brb';

export function voiceProviderOf(engine: string): VoiceProvider {
  if (engine === 'default') return 'own';
  if (engine === 'brb') return 'brb';
  return GEMINI_TTS.has(engine) ? 'gemini' : 'eleven';
}

/** The model list for a ModelMenu, with availability on this server. */
export function modelOptions<T extends string>(
  models: Array<{ id: T; name: string; detail: string; setup: string }>,
  available: Record<T, boolean>,
): ModelOption[] {
  return models.map((m) => ({ ...m, ready: Boolean(available[m.id]) }));
}

/** The engine-registry ids behind each STT choice (the model lab and usage log name engines so). */
const STT_REGISTRY_IDS: Record<SttChoice, string[]> = {
  auto: ['kotib', 'whisper'],
  gapi: ['gapi'],
  local: ['local'],
  gemini: ['speko'],
  gemini_live: ['speko_live'],
  scribe: ['scribe'],
  scribe_live: ['scribe_live'],
  brb: ['brb'],
};

/** Which STT choices this server can run, from a list of registry engines with `ready`. */
export function sttReadiness(engines: Array<{ id: string; ready: boolean }>): Record<SttChoice, boolean> {
  const ready = new Set(engines.filter((e) => e.ready).map((e) => e.id));
  return Object.fromEntries(
    STT_MODELS.map((m) => [m.id, STT_REGISTRY_IDS[m.id].some((id) => ready.has(id))]),
  ) as Record<SttChoice, boolean>;
}

/** The STT choice for a registry id (the STT page's starting model). */
export function sttChoiceOf(registryId: string): SttChoice | undefined {
  return STT_MODELS.find((m) => STT_REGISTRY_IDS[m.id].includes(registryId))?.id;
}

const STORAGE_KEY = 'ovoz_pg_models';

function loadSaved(): { stt?: string; tts?: string } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { stt?: string; tts?: string };
  } catch {
    return {};
  }
}

/** Saves one part of the choice, keeping the other (the STT page must not reset the TTS pick). */
function savePart(part: 'stt' | 'tts', id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSaved(), [part]: id }));
  } catch {
    /* storage unavailable */
  }
}

/** The remembered STT choice (shared by the Playground and the STT page), else the first available. */
export function useSttChoice(available: Record<SttChoice, boolean>, preferred?: SttChoice) {
  const first = (
    preferred && available[preferred] ? preferred : (STT_MODELS.find((o) => available[o.id])?.id ?? 'auto')
  ) as SttChoice;
  const [engine, setEngine] = useState<SttChoice>(first);
  useEffect(() => {
    const saved = loadSaved().stt as SttChoice | undefined;
    if (saved && available[saved]) setEngine(saved);
    // Only on mount: availability is fixed for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Saved when the user picks, never on mount (that would overwrite the remembered choice).
  const pick = (id: SttChoice) => {
    setEngine(id);
    savePart('stt', id);
  };
  return [engine, pick] as const;
}

/** The remembered TTS choice (shared by the Playground and the TTS page), else the first available. */
export function useTtsChoice(available: Record<TtsChoice, boolean>) {
  const first = (TTS_MODELS.find((o) => available[o.id])?.id ?? 'default') as TtsChoice;
  const [engine, setEngine] = useState<TtsChoice>(first);
  useEffect(() => {
    const saved = loadSaved().tts as TtsChoice | undefined;
    if (saved && available[saved]) setEngine(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pick = (id: TtsChoice) => {
    setEngine(id);
    savePart('tts', id);
  };
  return [engine, pick] as const;
}

/** Both choices together, as the Playground uses them. */
export function useModelChoice(stt: Record<SttChoice, boolean>, tts: Record<TtsChoice, boolean>) {
  const [sttEngine, setSttEngine] = useSttChoice(stt);
  const [ttsEngine, setTtsEngine] = useTtsChoice(tts);
  return { sttEngine, setSttEngine, ttsEngine, setTtsEngine };
}
