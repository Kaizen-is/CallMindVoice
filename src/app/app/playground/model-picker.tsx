'use client';

/**
 * The Playground's model choice: which STT and TTS engines the next turns use. The lists, voices
 * and the remembered choice live in `@/lib/speech-models`, shared with the STT and TTS pages so
 * all three behave the same.
 */
export {
  GEMINI_TTS,
  LIVE_STT,
  STT_MODELS,
  TTS_MODELS,
  liveFinishMs,
  modelOptions,
  useModelChoice,
  voiceProviderOf,
  type SttChoice,
  type TtsChoice,
} from '@/lib/speech-models';
