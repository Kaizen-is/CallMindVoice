'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { saveSpeechTestAction } from '@/app/actions/ops';
import { translator } from '@/lib/i18n';
import type { SpeechTest, UiLocale } from '@/lib/types';
import { Badge, Button, Card, EmptyState, PageHeader, Segmented } from '@/components/ui/primitives';
import { Field, Select, Textarea } from '@/components/ui/forms';
import { ModelMenu } from '@/components/ui/model-menu';
import { useToast } from '@/components/ui/overlays';
import { IconAlert, IconCode, IconDownload, IconSparkle, IconVolume } from '@/components/icons';
import { TimeAgo } from '@/components/ui/time-ago';
import { modelOptions, TTS_MODELS, useTtsChoice, voiceProviderOf, type TtsChoice } from '@/lib/speech-models';
import { pcmToWav, playTtsStream } from '@/lib/tts-stream';

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
  customVoices,
  elevenVoices,
  geminiVoices = [],
  history: initialHistory,
  speech,
}: {
  locale: UiLocale;
  agents: AgentOpt[];
  voices: VoiceOpt[];
  customVoices: VoiceOpt[];
  elevenVoices: VoiceOpt[];
  /** Gemini's voices (the Gemini TTS models, through Speko — the same key as ElevenLabs). */
  geminiVoices?: VoiceOpt[];
  history: SpeechTest[];
  speech: { tts: boolean; eleven: boolean; brb: boolean };
}) {
  const t = translator(locale);
  const toast = useToast();
  const router = useRouter();

  const [history, setHistory] = useState<SpeechTest[]>(initialHistory);
  const [text, setText] = useState('');
  // The same models, voices and remembered choice as the Playground (@/lib/speech-models).
  const readiness = useMemo(
    () =>
      Object.fromEntries(
        TTS_MODELS.map((m) => [m.id, m.id === 'default' ? speech.tts : m.id === 'brb' ? speech.brb : speech.eleven]),
      ) as Record<TtsChoice, boolean>,
    [speech.tts, speech.brb, speech.eleven],
  );
  const [engine, setEngine] = useTtsChoice(readiness);
  const provider = voiceProviderOf(engine);
  const providerReady = readiness[engine];
  const [voice, setVoice] = useState<string>(agents[0]?.voiceId ?? voices[0]?.id ?? 'laylo');
  const [elevenVoice, setElevenVoice] = useState<string>(elevenVoices[0]?.id ?? '');
  const [geminiVoice, setGeminiVoice] = useState<string>(geminiVoices[0]?.id ?? '');
  const spokenBy = provider === 'eleven' ? elevenVoice : provider === 'gemini' ? geminiVoice : provider === 'brb' ? '' : voice;
  const [busy, setBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const urlRef = useRef<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  /** Stop the voice that is playing (a new synthesis, leaving the page). */
  const stopPlayback = () => {
    for (const s of sourcesRef.current) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    sourcesRef.current = [];
  };
  useEffect(
    () => () => {
      stopPlayback();
      void ctxRef.current?.close().catch(() => {});
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  // Friendly label for a stored voice id — a base voice name, else the raw id.
  const voiceName = useCallback(
    (id: string | null) =>
      id
        ? (voices.find((v) => v.id === id)?.name ??
           customVoices.find((v) => v.id === id)?.name ??
           elevenVoices.find((v) => v.id === id)?.name ??
           geminiVoices.find((v) => v.id === id)?.name ??
           id)
        : '—',
    [voices, customVoices, elevenVoices, geminiVoices],
  );

  const onVoiceChange = (v: string) => {
    if (v === CLONE) {
      router.push('/app/dev/voice-clone');
      return;
    }
    setVoice(v);
  };

  const setAudio = (url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
    setAudioUrl(url);
  };

  /**
   * Speak the text as the Playground does: streamed, so the first sentence plays while the rest
   * still renders. When it is all in, the player below gets the whole recording to replay or save.
   */
  const generate = async () => {
    if (!providerReady || busy) return;
    const value = text.trim();
    if (!value) {
      toast.toast({ tone: 'info', title: t('dev.tts.emptyText') });
      return;
    }
    setBusy(true);
    stopPlayback();
    setAudio(null);
    try {
      const ctx = (ctxRef.current ??= new AudioContext());
      const played = await playTtsStream(
        ctx,
        { text: value, voice: spokenBy || undefined, language: 'uz', engine },
        { onSource: (source) => sourcesRef.current.push(source) },
      );
      if (!played) {
        toast.error(t('dev.tts.failTitle'), t('dev.tts.failBody'));
        return;
      }
      setAudio(URL.createObjectURL(pcmToWav(played.pcm, played.rate)));
      // History is nice-to-have — never let a failed save (e.g. a stale tab
      // after a redeploy) report the already-successful synthesis as an error.
      try {
        const saved = await saveSpeechTestAction({ kind: 'tts', input: value, voice: spokenBy || 'brb' });
        if (saved.ok) setHistory((h) => [saved.test, ...h].slice(0, 20));
      } catch {
        /* audio already delivered */
      }
    } catch (e) {
      toast.error(t('dev.tts.failTitle'), e instanceof Error ? e.message : t('dev.tts.failBody'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <PageHeader title={t('dev.tts.title')} subtitle={t('dev.tts.subtitle')} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* ── MAIN: text + voice + audio ── */}
        <div className="space-y-4">
          <Card padded={false}>
            <div className="flex items-center gap-2 px-5 py-4 hairline-b">
              <IconVolume size={16} className="text-ink-3" />
              <h3 className="text-[14px] font-semibold text-ink">{t('dev.tts.title')}</h3>
            </div>

            {!speech.tts && !speech.eleven && !speech.brb ? (
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
                  <div className="mb-2">
                    <ModelMenu
                      options={modelOptions(TTS_MODELS, readiness)}
                      value={engine}
                      onChange={(id) => setEngine(id as TtsChoice)}
                      needsLabel={t('lab.missing', 'Needs {setup}')}
                    />
                  </div>
                  {!providerReady && (
                    <p className="mb-2 text-[12px] text-warning">
                      {provider === 'own'
                        ? t('dev.tts.notConfiguredBody')
                        : provider === 'brb'
                          ? t('dev.tts.brbNotConfigured', 'Set BRB_SPEECH_URL, BRB_SPEECH_LOGIN and BRB_SPEECH_PASSWORD in .env to use the BRB model.')
                          : provider === 'gemini'
                            ? t('dev.tts.geminiNotConfigured', 'Set SPEKO_API_KEY in .env to use Gemini voices.')
                            : t('dev.tts.elevenNotConfigured', 'Set SPEKO_API_KEY in .env to use ElevenLabs.')}
                    </p>
                  )}
                  {provider === 'brb' ? (
                    <Select value="" disabled onChange={() => {}}>
                      <option value="">BRB TTS</option>
                    </Select>
                  ) : provider === 'gemini' ? (
                    <Select value={geminiVoice} onChange={(e) => setGeminiVoice(e.target.value)}>
                      {geminiVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </Select>
                  ) : provider === 'eleven' ? (
                    <Select value={elevenVoice} onChange={(e) => setElevenVoice(e.target.value)}>
                      {elevenVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
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
                    {customVoices.length > 0 && (
                      <optgroup label={t('dev.tts.voiceCustomGroup', 'Your voices')}>
                        {customVoices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value={CLONE}>{t('dev.tts.voiceClone')} →</option>
                  </Select>
                  )}
                </Field>

                <Button
                  variant="primary"
                  full
                  loading={busy}
                  disabled={!text.trim() || !providerReady}
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
                    <span className="shrink-0 text-[11px] text-ink-3"><TimeAgo iso={h.created_at} locale={locale} /></span>
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

    </div>
  );
}

/* ── API docs — POST /api/speech/tts (mirrors the developers panel style) ── */

function TtsDocsCard({ locale }: { locale: UiLocale }) {
  // The API is same-origin — show the address this console is actually served
  // from (the production domain in prod, localhost in dev).
  const [origin, setOrigin] = useState('https://your-domain');
  useEffect(() => setOrigin(window.location.origin), []);

  const t = translator(locale);
  const [lang, setLang] = useState<'curl' | 'node' | 'python'>('curl');

  const body = `{ "text": "Assalomu alaykum", "voice": "laylo" }`;
  const snippet =
    lang === 'curl'
      ? `curl -X POST ${origin}/api/speech/tts \\
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
    "${origin}/api/speech/tts",
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
