'use client';

/**
 * The Playground's model choice: which STT and TTS engines the next turns use.
 * The lists feed the two model buttons (TTS next to the voice, STT under the
 * call button); the choice is remembered in this browser. Engines this server
 * cannot run are listed but disabled, with what turns them on.
 */
import { useEffect, useRef, useState } from 'react';
import type { ModelOption } from '@/components/ui/model-menu';

export type SttChoice = 'auto' | 'gapi' | 'local' | 'gemini' | 'scribe' | 'brb';
export type TtsChoice = 'default' | 'brb' | 'eleven_v3_conversational' | 'eleven_v4_turbo';

export const STT_MODELS: Array<{ id: SttChoice; name: string; detail: string; setup: string }> = [
  { id: 'auto', name: 'Own STT', detail: 'CallMind', setup: 'STT_TRANSCRIBE_URL' },
  { id: 'gapi', name: 'GAPI', detail: 'gapi.uz', setup: 'GAPIAPI' },
  { id: 'local', name: 'Zipformer', detail: 'in-app · live', setup: 'models/uzbek-zipformer' },
  { id: 'gemini', name: 'gemini-3.5', detail: 'Google · Speko', setup: 'SPEKO_API_KEY' },
  { id: 'scribe', name: 'ElevenLabs Scribe', detail: 'ElevenLabs · Speko', setup: 'SPEKO_API_KEY' },
  // Last, like BRB TTS: reachable only over the VPN.
  { id: 'brb', name: 'BRB Whisper', detail: 'own model · VPN', setup: 'BRB_STT_URL' },
];

export const TTS_MODELS: Array<{ id: TtsChoice; name: string; detail: string; setup: string }> = [
  { id: 'default', name: 'Own TTS', detail: 'CallMind', setup: 'TTS_BASE_URL' },
  { id: 'eleven_v4_turbo', name: 'ElevenLabs v4 Turbo', detail: 'Speko', setup: 'SPEKO_API_KEY' },
  { id: 'eleven_v3_conversational', name: 'ElevenLabs v3', detail: 'Speko', setup: 'SPEKO_API_KEY' },
  // Last, so it is never the starting pick while the proxy is reachable only over the VPN.
  { id: 'brb', name: 'BRB TTS', detail: 'own model · VPN', setup: 'BRB_SPEECH_LOGIN' },
];

/** The model list for a ModelMenu, with availability on this server. */
export function modelOptions<T extends string>(
  models: Array<{ id: T; name: string; detail: string; setup: string }>,
  available: Record<T, boolean>,
): ModelOption[] {
  return models.map((m) => ({ ...m, ready: Boolean(available[m.id]) }));
}

const STORAGE_KEY = 'ovoz_pg_models';

/** The saved choice, falling back to the first available engine. */
export function useModelChoice(stt: Record<SttChoice, boolean>, tts: Record<TtsChoice, boolean>) {
  const firstStt = (STT_MODELS.find((o) => stt[o.id])?.id ?? 'auto') as SttChoice;
  const firstTts = (TTS_MODELS.find((o) => tts[o.id])?.id ?? 'default') as TtsChoice;
  const [sttEngine, setSttState] = useState<SttChoice>(firstStt);
  const [ttsEngine, setTtsState] = useState<TtsChoice>(firstTts);
  const choice = useRef({ stt: firstStt, tts: firstTts });

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { stt?: SttChoice; tts?: TtsChoice };
      if (saved.stt && stt[saved.stt]) {
        choice.current.stt = saved.stt;
        setSttState(saved.stt);
      }
      if (saved.tts && tts[saved.tts]) {
        choice.current.tts = saved.tts;
        setTtsState(saved.tts);
      }
    } catch {
      /* storage unavailable — keep the defaults */
    }
    // Only on mount: availability is fixed for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved when the user picks, never on mount: saving the starting default
  // there overwrote the remembered choice before it had been read back.
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(choice.current));
    } catch {
      /* storage unavailable */
    }
  };
  const setSttEngine = (id: SttChoice) => {
    choice.current.stt = id;
    setSttState(id);
    save();
  };
  const setTtsEngine = (id: TtsChoice) => {
    choice.current.tts = id;
    setTtsState(id);
    save();
  };

  return { sttEngine, setSttEngine, ttsEngine, setTtsEngine };
}
