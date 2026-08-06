'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cn, fmtInt } from '@/lib/utils';
import type { Locale } from '@/lib/types';
import { PERSONAS, VOICES } from '@/lib/catalog';
import { addStarterPackAction, uploadDocumentsAction } from '@/app/actions/knowledge';
import { completeOnboardingAction, playgroundTurnAction, skipOnboardingAction } from '@/app/actions/agent';
import { Badge, Button, Card, Divider, Spinner } from '@/components/ui/primitives';
import { Field, FileDrop, Input, Select, Textarea } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  FlagEN,
  FlagRU,
  FlagUZ,
  IconArrowRight,
  IconCheck,
  IconCheckCircle,
  IconDatabase,
  IconPhone,
  IconSend,
  IconSparkle,
  IconVolume,
  Logo,
} from '@/components/icons';

interface Props {
  company: string;
  userName: string;
  industry: string;
  packTitle: string;
  packDescription: string;
  agent: {
    id: string;
    name: string;
    greeting: string;
    persona: string;
    voiceId: string;
    primaryLang: Locale;
    languages: Locale[];
  } | null;
  documents: Array<{ id: string; title: string; chunks: number; status: string }>;
  phoneNumber: string | null;
}

const STEPS = ['Knowledge', 'Voice & language', 'Test it', 'Go live'] as const;

const LANG_OPTIONS: Array<{ value: Locale; label: string; flag: React.ReactNode }> = [
  { value: 'uz', label: 'O‘zbekcha', flag: <FlagUZ size={18} /> },
  { value: 'ru', label: 'Русский', flag: <FlagRU size={18} /> },
  { value: 'en', label: 'English', flag: <FlagEN size={18} /> },
];

export function OnboardingWizard(props: Props) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [pending, startTransition] = useTransition();

  const [docs, setDocs] = useState(props.documents);
  const [busy, setBusy] = useState(false);

  const [greeting, setGreeting] = useState(props.agent?.greeting ?? '');
  const [primaryLang, setPrimaryLang] = useState<Locale>(props.agent?.primaryLang ?? 'uz');
  const [languages, setLanguages] = useState<Locale[]>(props.agent?.languages ?? ['uz', 'ru', 'en']);
  const [voiceId, setVoiceId] = useState(props.agent?.voiceId ?? 'nilufar');
  const [persona, setPersona] = useState(props.agent?.persona ?? 'professional');

  const readyChunks = docs.filter((d) => d.status === 'ready').reduce((a, d) => a + d.chunks, 0);
  const hasKnowledge = readyChunks > 0;

  const loadStarter = async () => {
    setBusy(true);
    const res = await addStarterPackAction();
    setBusy(false);
    if (res.ok && res.documents) {
      setDocs((d) => [
        ...res.documents!.map((x) => ({ id: x.id, title: x.title, chunks: x.chunks, status: 'ready' })),
        ...d,
      ]);
      toast.success('Starter knowledge loaded', res.message);
    } else {
      toast.error('Could not load the starter pack', res.message);
    }
  };

  const upload = async (files: File[]) => {
    setBusy(true);
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const res = await uploadDocumentsAction(fd);
    setBusy(false);
    if (res.ok && res.documents) {
      setDocs((d) => [
        ...res.documents!.map((x) => ({ id: x.id, title: x.title, chunks: x.chunks, status: 'ready' })),
        ...d,
      ]);
      toast.success('Indexed', res.message);
    } else {
      toast.error('Upload failed', res.message);
    }
  };

  const finish = (goLive: boolean) => {
    startTransition(async () => {
      await completeOnboardingAction({
        greeting,
        primaryLang,
        languages,
        voiceId,
        persona,
        goLive,
      });
    });
  };

  return (
    <div className="relative min-h-screen">
      <div className="pointer-events-none absolute inset-0 grid-bg" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 aurora opacity-50" />

      <header className="relative z-10 flex items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <span className="text-[16px] font-semibold tracking-[-0.02em]">Ovoz</span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => startTransition(() => void skipOnboardingAction())}
          >
            Skip setup
          </Button>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl px-5 pb-20">
        <Stepper step={step} />

        {step === 0 && (
          <StepCard
            title={`Give ${props.company} something to answer from`}
            subtitle="Your agent only says what your documents say. Load a starter pack now and replace it with your real files whenever you like."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <button
                onClick={loadStarter}
                disabled={busy}
                className="group flex flex-col items-start rounded-[14px] bg-brand-soft p-5 text-left transition-all hover:shadow-e2 disabled:opacity-60"
              >
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-[11px] bg-brand text-white">
                  {busy ? <Spinner size={18} /> : <IconSparkle size={19} />}
                </div>
                <div className="text-[14.5px] font-semibold text-brand-ink">{props.packTitle}</div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-brand-ink/75">
                  {props.packDescription}
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-ink">
                  Load it now
                  <IconArrowRight size={13} />
                </span>
              </button>

              <FileDrop
                onFiles={upload}
                busy={busy}
                className="min-h-[196px] py-6"
                hint="PDF, DOCX, TXT, MD, CSV"
              />
            </div>

            {docs.length > 0 && (
              <div className="mt-5 space-y-2">
                <Divider label={`${docs.length} in your knowledge base`} />
                {docs.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center gap-3 rounded-[10px] bg-surface-2 px-3.5 py-2.5"
                  >
                    <IconCheckCircle size={16} className="shrink-0 text-success" />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{d.title}</span>
                    <Badge tone="neutral">{fmtInt(d.chunks)} passages</Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <Button
                variant="primary"
                size="lg"
                disabled={!hasKnowledge}
                onClick={() => setStep(1)}
                iconRight={<IconArrowRight size={16} />}
              >
                {hasKnowledge ? 'Continue' : 'Add knowledge to continue'}
              </Button>
            </div>
          </StepCard>
        )}

        {step === 1 && (
          <StepCard
            title="How should it sound?"
            subtitle="You can change any of this later — nothing here is permanent."
          >
            <div className="space-y-6">
              <div>
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">Languages it answers in</div>
                <div className="flex flex-wrap gap-2">
                  {LANG_OPTIONS.map((l) => {
                    const on = languages.includes(l.value);
                    return (
                      <button
                        key={l.value}
                        onClick={() =>
                          setLanguages((prev) =>
                            on ? prev.filter((x) => x !== l.value) : [...prev, l.value],
                          )
                        }
                        className={cn(
                          'inline-flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-[13.5px] font-medium transition-all',
                          on
                            ? 'bg-brand text-white shadow-e1'
                            : 'bg-surface-3 text-ink-2 hover:text-ink',
                        )}
                      >
                        {l.flag}
                        {l.label}
                        {on && <IconCheck size={14} />}
                      </button>
                    );
                  })}
                </div>
              </div>

              <Field label="Language it greets in first" htmlFor="primary">
                <Select
                  id="primary"
                  value={primaryLang}
                  onChange={(e) => setPrimaryLang(e.target.value as Locale)}
                >
                  {LANG_OPTIONS.filter((l) => languages.includes(l.value)).map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Opening line"
                htmlFor="greeting"
                hint="The first thing a caller hears. Keep it short — it is spoken, not read."
              >
                <Textarea
                  id="greeting"
                  rows={3}
                  value={greeting}
                  onChange={(e) => setGreeting(e.target.value)}
                />
              </Field>

              <div>
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">Voice</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {VOICES.map((v) => (
                    <button
                      key={v.id}
                      onClick={() => setVoiceId(v.id)}
                      className={cn(
                        'flex items-start gap-3 rounded-[11px] p-3.5 text-left transition-all',
                        voiceId === v.id
                          ? 'bg-brand-soft ring-2 ring-[rgb(var(--brand))]'
                          : 'bg-surface-2 hover:bg-surface-3',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                          voiceId === v.id ? 'bg-brand text-white' : 'bg-surface-3 text-ink-3',
                        )}
                      >
                        <IconVolume size={15} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-medium text-ink">{v.name}</span>
                        <span className="block text-[12px] leading-snug text-ink-3">{v.note}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-[12.5px] font-medium text-ink-2">Manner</div>
                <div className="flex flex-wrap gap-2">
                  {PERSONAS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => setPersona(p.value)}
                      className={cn(
                        'rounded-[10px] px-3.5 py-2 text-[13px] font-medium transition-all',
                        persona === p.value
                          ? 'bg-brand text-white'
                          : 'bg-surface-3 text-ink-2 hover:text-ink',
                      )}
                      title={p.hint}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-7 flex justify-between">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button
                variant="primary"
                size="lg"
                onClick={() => setStep(2)}
                iconRight={<IconArrowRight size={16} />}
              >
                Try it
              </Button>
            </div>
          </StepCard>
        )}

        {step === 2 && (
          <StepCard
            title="Ask it something"
            subtitle="This is the real engine running against your real knowledge base — not a canned demo."
          >
            <MiniPlayground industry={props.industry} />
            <div className="mt-7 flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                variant="primary"
                size="lg"
                onClick={() => setStep(3)}
                iconRight={<IconArrowRight size={16} />}
              >
                Looks good
              </Button>
            </div>
          </StepCard>
        )}

        {step === 3 && (
          <StepCard
            title="Ready when you are"
            subtitle="Turning the agent live lets it answer calls on your number. You can pause it at any time."
          >
            <div className="space-y-3">
              <SummaryRow
                icon={<IconDatabase size={17} />}
                label="Knowledge base"
                value={`${docs.length} document${docs.length === 1 ? '' : 's'} · ${fmtInt(readyChunks)} passages`}
              />
              <SummaryRow
                icon={<IconVolume size={17} />}
                label="Voice"
                value={`${VOICES.find((v) => v.id === voiceId)?.name ?? voiceId} · ${
                  PERSONAS.find((p) => p.value === persona)?.label ?? persona
                }`}
              />
              <SummaryRow
                icon={<IconSparkle size={17} />}
                label="Languages"
                value={languages.map((l) => l.toUpperCase()).join(' · ')}
              />
              <SummaryRow
                icon={<IconPhone size={17} />}
                label="Number"
                value={props.phoneNumber ?? 'Assign one in the console'}
              />
            </div>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row-reverse">
              <Button
                variant="primary"
                size="lg"
                loading={pending}
                onClick={() => finish(true)}
                icon={<IconCheck size={16} />}
                className="sm:flex-1"
              >
                Take it live
              </Button>
              <Button variant="secondary" size="lg" onClick={() => finish(false)} disabled={pending}>
                Keep it as a draft
              </Button>
            </div>
          </StepCard>
        )}
      </main>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────── */

function Stepper({ step }: { step: number }) {
  return (
    <div className="mb-8 flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex flex-1 items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div
              className={cn(
                'h-1 rounded-full transition-colors duration-300',
                i <= step ? 'bg-brand' : 'bg-[rgb(var(--text)/0.12)]',
              )}
            />
            <span
              className={cn(
                'truncate text-[11.5px] font-medium transition-colors',
                i === step ? 'text-ink' : 'text-ink-3',
              )}
            >
              {label}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function StepCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="animate-fade-up p-7 shadow-e3">
      <h1 className="text-[23px] leading-tight font-semibold tracking-[-0.026em] text-ink">{title}</h1>
      <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-2">{subtitle}</p>
      <div className="mt-7">{children}</div>
    </Card>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[11px] bg-surface-2 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-3 text-ink-2">
        {icon}
      </span>
      <span className="text-[13px] text-ink-3">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right text-[13.5px] font-medium text-ink">
        {value}
      </span>
    </div>
  );
}

const SUGGESTIONS: Record<string, string[]> = {
  clinic: ['Ish vaqtingiz qanday?', 'Кардиолог сколько стоит?', 'What documents do I need?'],
  insurance: ['Какие документы нужны для выплаты?', 'OSAGO narxi qancha?', 'What is not covered?'],
  retail: ['Yetkazib berish qancha turadi?', 'Как вернуть товар?', 'Do you offer instalments?'],
};

function MiniPlayground({ industry }: { industry: string }) {
  const [callId, setCallId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<
    Array<{ role: 'you' | 'agent'; text: string; meta?: string; cite?: string }>
  >([]);
  const [thinking, setThinking] = useState(false);

  const suggestions = SUGGESTIONS[industry] ?? SUGGESTIONS.clinic;

  const send = async (text: string) => {
    if (!text.trim() || thinking) return;
    setMessages((m) => [...m, { role: 'you', text }]);
    setInput('');
    setThinking(true);
    const res = await playgroundTurnAction({ callId, utterance: text });
    setThinking(false);
    if (!res.ok) {
      setMessages((m) => [...m, { role: 'agent', text: res.message ?? 'Something went wrong.' }]);
      return;
    }
    setCallId(res.callId ?? null);
    setMessages((m) => [
      ...m,
      {
        role: 'agent',
        text: res.reply ?? '',
        meta: `${Math.round(res.timings?.totalMs ?? 0)} ms · confidence ${(res.confidence ?? 0).toFixed(2)}`,
        cite: res.citations?.[0]
          ? `${res.citations[0].documentTitle}${res.citations[0].heading ? ` › ${res.citations[0].heading}` : ''}`
          : undefined,
      },
    ]);
  };

  return (
    <div className="rounded-[14px] bg-surface-2 p-4">
      <div className="min-h-[180px] space-y-3">
        {messages.length === 0 && !thinking && (
          <div className="flex flex-wrap gap-2 pt-2">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="rounded-full bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 shadow-e1 transition-colors hairline hover:text-ink"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'you' ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[85%]', m.role === 'you' && 'text-right')}>
              <div
                className={cn(
                  'inline-block rounded-[13px] px-3.5 py-2.5 text-left text-[13.5px] leading-relaxed',
                  m.role === 'you'
                    ? 'rounded-br-[4px] bg-brand text-white'
                    : 'rounded-bl-[4px] bg-surface text-ink shadow-e1',
                )}
              >
                {m.text}
              </div>
              {(m.meta || m.cite) && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                  {m.meta && <span className="tabular">{m.meta}</span>}
                  {m.cite && (
                    <span className="max-w-[240px] truncate rounded-full bg-brand-soft px-2 py-0.5 text-brand-ink">
                      {m.cite}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Spinner size={14} />
            Retrieving and composing…
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="mt-4 flex gap-2"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask what a caller would ask…"
          className="flex-1"
        />
        <Button type="submit" variant="primary" icon={<IconSend size={15} />} disabled={thinking}>
          Send
        </Button>
      </form>
    </div>
  );
}
