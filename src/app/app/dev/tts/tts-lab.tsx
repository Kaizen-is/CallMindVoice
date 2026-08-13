'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { saveSpeechTestAction } from '@/app/actions/ops';
import { translator } from '@/lib/i18n';
import type { SpeechTest, UiLocale } from '@/lib/types';
import { relativeTime } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Segmented,
} from '@/components/ui/primitives';
import { Field, Select, Textarea } from '@/components/ui/forms';
import { Modal, useToast } from '@/components/ui/overlays';
import { IconAlert, IconCode, IconDownload, IconSparkle, IconVolume } from '@/components/icons';

const CLONE = '__clone__';

interface VoiceOpt {
  id: string;
  name: string;
}
interface AgentOpt {
  id: string;
  name: string;
  voiceId: string;
}

export function TtsLab({
  locale,
  agents,
  voices,
  history: initialHistory,
  speech,
}: {
  locale: UiLocale;
  agents: AgentOpt[];
  voices: VoiceOpt[];
  history: SpeechTest[];
  speech: { tts: boolean };
}) {
  const t = translator(locale);
  const toast = useToast();

  const [history, setHistory] = useState<SpeechTest[]>(initialHistory);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<string>(agents[0]?.voiceId ?? voices[0]?.id ?? 'nilufar');
  const [busy, setBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);

  const urlRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  // Friendly label for a stored voice id — a base voice name, else the raw id.
  const voiceName = useCallback(
    (id: string | null) => (id ? (voices.find((v) => v.id === id)?.name ?? id) : '—'),
    [voices],
  );

  const onVoiceChange = (v: string) => {
    if (v === CLONE) {
      setCloneOpen(true);
      return; // purely informational — the real selection is left unchanged
    }
    setVoice(v);
  };

  const setAudio = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setAudioUrl(url);
  };

  const generate = async () => {
    if (!speech.tts || busy) return;
    const value = text.trim();
    if (!value) {
      toast.toast({ tone: 'info', title: t('dev.tts.emptyText') });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/speech/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: value, voice }),
      });
      if (!res.ok) {
        toast.error(t('dev.tts.failTitle'), t('dev.tts.failBody'));
        return;
      }
      setAudio(URL.createObjectURL(await res.blob()));
      const saved = await saveSpeechTestAction({ kind: 'tts', input: value, voice });
      if (saved.ok) setHistory((h) => [saved.test, ...h].slice(0, 20));
    } catch (e) {
      toast.error(t('dev.tts.failTitle'), e instanceof Error ? e.message : t('dev.tts.failBody'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title={t('dev.tts.title')} subtitle={t('dev.tts.subtitle')} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* ── MAIN: text + voice + audio ── */}
        <div className="space-y-4">
          <Card padded={false}>
            <div className="flex items-center gap-2 px-5 py-4 hairline-b">
              <IconVolume size={16} className="text-ink-3" />
              <h3 className="text-[14px] font-semibold text-ink">{t('dev.tts.title')}</h3>
            </div>

            {!speech.tts ? (
              <EmptyState
                icon={<IconAlert size={20} />}
                title={t('dev.tts.notConfiguredTitle')}
                description={t('dev.tts.notConfiguredBody')}
              />
            ) : (
              <div className="space-y-4 p-5">
                <Field label={t('dev.tts.textLabel')}>
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t('dev.tts.textPlaceholder')}
                    rows={5}
                    maxLength={2000}
                  />
                </Field>

                <Field label={t('dev.tts.voiceLabel')}>
                  <Select value={voice} onChange={(e) => onVoiceChange(e.target.value)}>
                    {agents.length > 0 && (
                      <optgroup label={t('dev.tts.voiceAgentsGroup')}>
                        {agents.map((a) => (
                          <option key={a.id} value={a.voiceId}>
                            {a.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label={t('dev.tts.voiceBaseGroup')}>
                      {voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </optgroup>
                    <option value={CLONE}>{t('dev.tts.voiceClone')} · {t('dev.clone.soon')}</option>
                  </Select>
                </Field>

                <Button
                  variant="primary"
                  full
                  loading={busy}
                  disabled={!text.trim()}
                  icon={!busy ? <IconVolume size={15} /> : undefined}
                  onClick={() => void generate()}
                >
                  {busy ? t('dev.tts.generating') : t('dev.tts.generate')}
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold text-ink">{t('dev.tts.resultTitle')}</h3>
              {audioUrl && (
                <a
                  href={audioUrl}
                  download="speech.wav"
                  className="inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  <IconDownload size={13} />
                  {t('dev.tts.download')}
                </a>
              )}
            </div>
            {audioUrl ? (
              <audio controls src={audioUrl} className="mt-3 w-full">
                <track kind="captions" />
              </audio>
            ) : (
              <p className="mt-3 text-[13px] text-ink-3">{t('dev.tts.resultEmpty')}</p>
            )}
          </Card>
        </div>

        {/* ── RIGHT: history ── */}
        <Card padded={false} className="lg:sticky lg:top-20 h-max">
          <div className="px-5 py-4 hairline-b">
            <h3 className="text-[14px] font-semibold text-ink">{t('dev.tts.historyTitle')}</h3>
          </div>
          {history.length ? (
            <div className="max-h-[560px] divide-y divide-[rgb(var(--line)/var(--line-alpha))] overflow-y-auto">
              {history.map((h) => (
                <div key={h.id} className="px-5 py-3">
                  <p className="line-clamp-2 text-[12.5px] leading-relaxed text-ink">{h.input}</p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <Badge tone="brand">{voiceName(h.voice)}</Badge>
                    <span className="shrink-0 text-[11px] text-ink-3">{relativeTime(h.created_at, locale)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-[13px] text-ink-3">{t('dev.tts.historyEmpty')}</div>
          )}
        </Card>
      </div>

      <TtsDocsCard locale={locale} />

      {/* ── Voice Clone — informational placeholder (no backend) ── */}
      <Modal
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        title={t('dev.tts.voiceClone')}
        description={t('dev.clone.intro')}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setCloneOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            {/* Intentionally disabled — voice cloning is not shipped yet. */}
            <Button size="sm" variant="primary" disabled>
              {t('dev.clone.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge tone="violet" icon={<IconSparkle size={12} />}>
              {t('dev.clone.soon')}
            </Badge>
          </div>

          <ol className="space-y-2.5">
            {[t('dev.clone.step1'), t('dev.clone.step2'), t('dev.clone.step3')].map((step, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-semibold text-brand-ink">
                  {i + 1}
                </span>
                <span className="text-[13px] leading-relaxed text-ink-2">{step}</span>
              </li>
            ))}
          </ol>

          <Field label={t('dev.clone.nameLabel')}>
            <input
              disabled
              placeholder={t('dev.clone.namePlaceholder')}
              className="h-9.5 w-full rounded-[10px] bg-surface-3 px-3 text-[13.5px] text-ink-3 hairline placeholder:text-ink-3"
            />
          </Field>

          <Field label={t('dev.clone.sample')} hint={t('dev.clone.sampleHint')}>
            <div className="flex flex-col items-center justify-center rounded-[12px] border-2 border-dashed border-[rgb(var(--line)/0.2)] bg-surface-2 px-6 py-8 text-center opacity-60">
              <IconVolume size={20} className="text-ink-3" />
              <p className="mt-2 text-[12.5px] text-ink-3">{t('dev.clone.sampleHint')}</p>
            </div>
          </Field>

          <p className="rounded-[10px] bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-3">
            {t('dev.clone.disabledNote')}
          </p>
        </div>
      </Modal>
    </div>
  );
}

/* ── API docs — POST /api/speech/tts (mirrors the developers panel style) ── */

function TtsDocsCard({ locale }: { locale: UiLocale }) {
  const t = translator(locale);
  const [lang, setLang] = useState<'curl' | 'node' | 'python'>('curl');

  const body = `{ "text": "Assalomu alaykum", "voice": "nilufar" }`;
  const snippet =
    lang === 'curl'
      ? `curl -X POST http://localhost:3001/api/speech/tts \\
  -H "Content-Type: application/json" \\
  --cookie "$OVOZ_SESSION" \\
  -d '${body}' \\
  --output speech.wav`
      : lang === 'node'
        ? `const res = await fetch("/api/speech/tts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(${body}),
});
const wav = new Uint8Array(await res.arrayBuffer());`
        : `import requests

res = requests.post(
    "http://localhost:3001/api/speech/tts",
    json=${body},
    cookies={"ovoz_session": "..."},
)
open("speech.wav", "wb").write(res.content)`;

  return (
    <Card className="mt-4" padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hairline-b">
        <div className="flex items-center gap-2">
          <IconCode size={16} className="text-ink-3" />
          <h3 className="text-[14px] font-semibold text-ink">{t('dev.docsTitle')}</h3>
          <Badge tone="success">POST</Badge>
          <span className="font-mono text-[12px] text-ink">/api/speech/tts</span>
        </div>
        <Segmented
          size="sm"
          value={lang}
          onChange={setLang}
          options={[
            { value: 'curl', label: 'cURL' },
            { value: 'node', label: 'Node' },
            { value: 'python', label: 'Python' },
          ]}
        />
      </div>
      <div className="space-y-4 p-5">
        <p className="text-[13px] text-ink-2">{t('dev.tts.docsDesc')}</p>
        <p className="text-[12.5px] text-ink-3">{t('dev.docsSessionNote')}</p>
        <div>
          <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
            {t('dev.docsRequest')}
          </div>
          <pre className="overflow-x-auto rounded-[10px] bg-surface-3 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
            {snippet}
          </pre>
        </div>
        <div>
          <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
            {t('dev.docsResponse')}
          </div>
          <pre className="overflow-x-auto rounded-[10px] bg-surface-3 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
            {`audio/wav — 8 kHz PCM WAV stream`}
          </pre>
        </div>
      </div>
    </Card>
  );
}
