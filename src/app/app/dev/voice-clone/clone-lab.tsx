'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createCloneVoiceAction } from '@/app/actions/voices';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { Button, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { Field, Input } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import { IconAlert, IconCheck, IconMic, IconMicOff, IconUpload } from '@/components/icons';
import { micSupported, startRecording, type Recording } from '@/lib/audio';
import { ensureSupportedAudio, SavedVoiceList, usePreview, type SavedVoice } from '../voices/voice-shared';

export function CloneLab({
  locale,
  voices,
  speech,
}: {
  locale: UiLocale;
  voices: SavedVoice[];
  speech: { tts: boolean };
}) {
  const t = translator(locale);
  const toast = useToast();
  const router = useRouter();
  const { prefetch } = usePreview(locale);

  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /* ── mic recording (12 s target, hard auto-stop at 13 s) ── */
  const MAX_REC_SECONDS = 13;
  const [micReady, setMicReady] = useState(false);
  const [listening, setListening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<Recording | null>(null);
  const timersRef = useRef<{ tick?: ReturnType<typeof setInterval>; stop?: ReturnType<typeof setTimeout> }>({});

  useEffect(() => setMicReady(micSupported()), []);
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      clearInterval(timersRef.current.tick);
      clearTimeout(timersRef.current.stop);
    },
    [],
  );

  const stopRec = useCallback(async () => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    clearInterval(timersRef.current.tick);
    clearTimeout(timersRef.current.stop);
    if (!rec) return;
    setListening(false);
    try {
      const { wav, durationSec, rms } = await rec.stop();
      if (durationSec < 1 || rms < 0.0015) {
        toast.toast({
          tone: 'info',
          title: t('dev.voiceClone.tooShortTitle', 'Too short or too quiet'),
          description: t('dev.voiceClone.tooShortBody', 'Speak clearly for a few seconds and try again.'),
        });
        return;
      }
      setFile(new File([wav], 'recording.wav', { type: 'audio/wav' }));
      if (fileInput.current) fileInput.current.value = '';
    } catch (e) {
      toast.error(t('dev.voiceClone.micProblem', 'Microphone problem'), e instanceof Error ? e.message : '');
    }
  }, [toast, t]);

  const startRec = useCallback(async () => {
    try {
      recorderRef.current = await startRecording();
      setFile(null);
      setElapsed(0);
      setListening(true);
      timersRef.current.tick = setInterval(() => setElapsed((v) => v + 1), 1000);
      // Hard cap — the recording stops itself at 13 s.
      timersRef.current.stop = setTimeout(() => void stopRec(), MAX_REC_SECONDS * 1000);
    } catch {
      toast.error(
        t('dev.voiceClone.micProblem', 'Microphone problem'),
        t('dev.voiceClone.micNoAccess', 'Allow microphone access and try again.'),
      );
    }
  }, [stopRec, toast, t]);

  const submit = async () => {
    if (busy || !file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set('name', name);
      form.set('refAudio', file);
      const res = await createCloneVoiceAction(form);
      if (!res.ok) {
        toast.error(t('dev.voices.saveFail', 'Could not save the voice'), res.message);
        return;
      }
      toast.toast({ tone: 'success', title: t('dev.voices.cloneSaved', 'Voice cloned and saved') });
      setName('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      router.refresh();
      // Warm the preview in the background so the Preview button plays instantly.
      prefetch(res.voiceId);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = Boolean(name.trim() && file);

  return (
    <div className="w-full">
      <PageHeader
        title={t('dev.voiceClone.title', 'Voice cloning')}
        subtitle={t('dev.voiceClone.subtitle', 'Upload a short clean sample of a voice — we transcribe it automatically and the model speaks any text with that voice.')}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card padded={false}>
          <div className="flex items-center gap-2 px-5 py-4 hairline-b">
            <IconMic size={16} className="text-ink-3" />
            <h3 className="text-[14px] font-semibold text-ink">{t('dev.voiceClone.formTitle', 'New cloned voice')}</h3>
          </div>

          {!speech.tts ? (
            <EmptyState
              icon={<IconAlert size={20} />}
              title={t('dev.tts.notConfiguredTitle')}
              description={t('dev.tts.notConfiguredBody')}
            />
          ) : (
            <div className="space-y-4 p-5">
              <Field label={t('dev.voices.nameLabel', 'Voice name')}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('dev.voiceClone.namePlaceholder', 'e.g. Our brand voice')}
                  maxLength={60}
                />
              </Field>

              <Field
                label={t('dev.voiceClone.sampleLabel', 'Voice sample')}
                hint={t('dev.voiceClone.sampleHint', 'WAV recommended — 3–15 seconds of clean, single-speaker, noise-free speech. Max 20 MB.')}
              >
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className={`flex w-full flex-col items-center justify-center rounded-[12px] border-2 border-dashed px-6 py-8 text-center transition-colors ${
                    file
                      ? 'border-success bg-success-soft'
                      : 'border-[rgb(var(--line)/0.25)] bg-surface-2 hover:border-brand/40 hover:bg-surface-3'
                  }`}
                >
                  {file ? (
                    <IconCheck size={20} className="text-success" />
                  ) : (
                    <IconUpload size={20} className="text-ink-3" />
                  )}
                  <p className={`mt-2 text-[13px] font-semibold ${file ? 'text-success' : 'font-medium text-ink-2'}`}>
                    {file ? file.name : t('dev.voiceClone.pickFile', 'Choose an audio file')}
                  </p>
                  {file && (
                    <p className="mt-0.5 text-[11.5px] text-success/80">
                      {(file.size / 1024 / 1024).toFixed(1)} MB · {t('dev.voiceClone.fileReady', 'ready')}
                    </p>
                  )}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const picked = e.target.files?.[0] ?? null;
                    if (!picked) {
                      setFile(null);
                      return;
                    }
                    // m4a/aac/webm etc. are converted to WAV in the browser —
                    // the speech services only accept flac/mp3/ogg/opus/wav.
                    void ensureSupportedAudio(picked, { clean: true })
                      .then(setFile)
                      .catch(() =>
                        toast.error(
                          t('dev.voiceClone.badFileTitle', 'Unsupported audio file'),
                          t('dev.voiceClone.badFileBody', 'Could not read this file — use WAV, MP3, OGG or M4A.'),
                        ),
                      );
                  }}
                />
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-[rgb(var(--line)/var(--line-alpha))]" />
                  <span className="text-[11.5px] tracking-wide text-ink-3 uppercase">{t('dev.stt.or')}</span>
                  <span className="h-px flex-1 bg-[rgb(var(--line)/var(--line-alpha))]" />
                </div>

                <div className="flex flex-col items-center gap-2">
                  <Button
                    variant={listening ? 'danger' : 'secondary'}
                    icon={listening ? <IconMicOff size={15} /> : <IconMic size={15} />}
                    onClick={() => void (listening ? stopRec() : startRec())}
                    disabled={!micReady}
                    className={listening ? 'animate-pulse' : undefined}
                  >
                    {listening ? t('dev.stt.stop') : t('dev.stt.record')}
                  </Button>
                  {listening && (
                    <p className="text-[12px] text-ink-3 tabular">
                      {t('dev.stt.recording')} · {Math.min(elapsed, MAX_REC_SECONDS)}s / {MAX_REC_SECONDS}s
                    </p>
                  )}
                </div>
              </Field>

              <Button
                variant="primary"
                full
                loading={busy}
                disabled={!canSubmit}
                icon={!busy ? <IconMic size={15} /> : undefined}
                onClick={() => void submit()}
              >
                {busy
                  ? t('dev.voiceClone.saving', 'Cloning…')
                  : t('dev.voiceClone.save', 'Clone and save voice')}
              </Button>
            </div>
          )}
        </Card>

        <SavedVoiceList
          locale={locale}
          voices={voices}
          emptyTitle={t('dev.voiceClone.emptyTitle', 'No cloned voices yet')}
          emptyBody={t('dev.voiceClone.emptyBody', 'Cloned voices appear here and in every voice picker.')}
        />
      </div>
    </div>
  );
}
