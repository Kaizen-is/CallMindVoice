/**
 * Filler lines — the cheapest realism win in the whole pipeline.
 *
 * Retrieval plus generation takes real time, and during it the line is silent.
 * Silence on a phone call reads as "it broke", and callers start saying
 * "alo? alo?" — which then arrives as the next utterance and derails the turn.
 *
 * A human agent fills that gap without thinking: "bir daqiqa, hozir qarayman".
 * So we do the same. The moment the caller stops speaking, the bridge plays a
 * pre-rendered filler while the real answer is still being computed. Because
 * these lines are fixed, they are rendered once and served from the TTS disk
 * cache — playing one costs a file read, not a synthesis.
 *
 * Keep them short (under ~1.2 s) and non-committal: the filler must never
 * contradict the answer that follows it.
 */
import 'server-only';
import { synthesizePcm } from './tts';
import type { Locale } from '@/lib/types';

const LINES: Record<Locale, string[]> = {
  uz: ['Bir daqiqa.', 'Hozir tekshiraman.', 'Shu zahoti qarayman.', 'Aniqlab beraman.'],
  ru: ['Одну минуту.', 'Сейчас посмотрю.', 'Секунду, проверяю.', 'Уточняю.'],
  en: ['One moment.', 'Let me check that.', 'Just a second.', 'Looking that up now.'],
};

export function fillerLines(language: Locale): string[] {
  return LINES[language] ?? LINES.uz;
}

/**
 * Render one filler line as 8 kHz PCM. `index` selects deterministically so a
 * bridge can prefetch a rotation of distinct lines rather than the same one
 * repeatedly — hearing "bir daqiqa" five times in a call is worse than silence.
 */
export async function fillerPcm(opts: {
  tenantId: string;
  voiceId?: string | null;
  language: Locale;
  index?: number;
}): Promise<Buffer> {
  const lines = fillerLines(opts.language);
  const line = lines[(opts.index ?? 0) % lines.length];
  return synthesizePcm(line, {
    tenantId: opts.tenantId,
    voiceId: opts.voiceId,
    language: opts.language,
    tag: 'filler',
    cache: true, // fixed text — always a cache hit after the first call ever
  });
}
