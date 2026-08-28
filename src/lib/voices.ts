/**
 * Voice resolution for the internal Uzbek TTS v2 API.
 *
 * A "voice" everywhere in the product is one string id that can be either a
 * built-in named speaker (laylo / isomiddin), a legacy catalog id, or the id
 * of a tenant-saved custom voice (clone or design) from `custom_voices`.
 * This module turns that id into the generate_v2 form fields.
 */
import fs from 'node:fs';
import path from 'node:path';
import { all, get, UPLOAD_DIR } from '@/lib/db';
import { LEGACY_VOICE_IDS, VOICES } from '@/lib/catalog';

export interface CustomVoiceRow {
  id: string;
  tenant_id: string;
  name: string;
  mode: 'clone' | 'design';
  voice_design: string | null;
  ref_audio_path: string | null;
  ref_text: string | null;
  created_at: string;
}

export type ResolvedVoice =
  | { kind: 'speaker'; speaker: string }
  | { kind: 'design'; design: string }
  | { kind: 'clone'; refAudioPath: string; refText: string; fileName: string };

export function listCustomVoices(tenantId: string, mode?: 'clone' | 'design'): CustomVoiceRow[] {
  return mode
    ? all<CustomVoiceRow>(
        'SELECT * FROM custom_voices WHERE tenant_id=? AND mode=? ORDER BY created_at DESC',
        tenantId,
        mode,
      )
    : all<CustomVoiceRow>(
        'SELECT * FROM custom_voices WHERE tenant_id=? ORDER BY created_at DESC',
        tenantId,
      );
}

/**
 * Built-in speaker overrides: drop `<speaker>.(wav|ogg|mp3)` + `<speaker>.txt`
 * (its exact transcript) into data/voices/ and that speaker synthesises in
 * clone mode with the real recording instead of the server's placeholder.
 */
const VOICES_DIR = path.join(process.cwd(), 'data', 'voices');

function builtinOverride(speaker: string): ResolvedVoice | null {
  for (const ext of ['.wav', '.ogg', '.mp3', '.flac', '.opus']) {
    const audio = path.join(VOICES_DIR, `${speaker}${ext}`);
    const txt = path.join(VOICES_DIR, `${speaker}.txt`);
    if (fs.existsSync(audio) && fs.existsSync(txt)) {
      const refText = fs.readFileSync(txt, 'utf8').trim();
      if (refText) {
        return { kind: 'clone', refAudioPath: audio, refText, fileName: `${speaker}${ext}` };
      }
    }
  }
  return null;
}

export function resolveVoice(tenantId: string, voiceId?: string | null): ResolvedVoice {
  const id = voiceId?.trim();
  if (!id) return builtinOverride('laylo') ?? { kind: 'speaker', speaker: 'laylo' };

  const builtin = LEGACY_VOICE_IDS[id] ?? VOICES.find((v) => v.id === id)?.id;
  if (builtin) return builtinOverride(builtin) ?? { kind: 'speaker', speaker: builtin };

  const custom = get<CustomVoiceRow>(
    'SELECT * FROM custom_voices WHERE tenant_id=? AND id=?',
    tenantId,
    id,
  );
  if (custom?.mode === 'design' && custom.voice_design) {
    return { kind: 'design', design: custom.voice_design };
  }
  if (custom?.mode === 'clone' && custom.ref_audio_path && custom.ref_text) {
    const abs = path.join(UPLOAD_DIR, custom.ref_audio_path);
    if (fs.existsSync(abs)) {
      return { kind: 'clone', refAudioPath: abs, refText: custom.ref_text, fileName: custom.ref_audio_path };
    }
  }
  return builtinOverride('laylo') ?? { kind: 'speaker', speaker: 'laylo' };
}

/** Build the multipart body for POST /api/v1/tts/generate_v2. */
export function buildTtsForm(opts: {
  userId: string;
  text: string;
  voice: ResolvedVoice;
  speed?: number;
}): FormData {
  const form = new FormData();
  form.set('user_id', opts.userId);
  form.set('phone', '+000000000');
  form.set('text', opts.text.slice(0, 2000));
  form.set('normalize_numbers', 'true');
  if (opts.speed) form.set('speed', String(Math.min(2, Math.max(0.5, opts.speed))));

  const v = opts.voice;
  if (v.kind === 'clone') {
    const bytes = fs.readFileSync(v.refAudioPath);
    const mime =
      { '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.flac': 'audio/flac' }[
        path.extname(v.fileName).toLowerCase()
      ] ?? 'application/octet-stream';
    form.set('ref_audio', new Blob([new Uint8Array(bytes)], { type: mime }), path.basename(v.fileName));
    form.set('ref_text', v.refText);
  } else if (v.kind === 'design') {
    form.set('voice_design', v.design);
  } else {
    form.set('speaker', v.speaker);
  }
  return form;
}

/** Options for voice pickers: built-in speakers plus the tenant's saved voices. */
export function voicePickerOptions(tenantId: string) {
  return {
    builtin: VOICES.map((v) => ({ id: v.id, name: v.name })),
    custom: listCustomVoices(tenantId).map((v) => ({ id: v.id, name: v.name, mode: v.mode })),
  };
}
