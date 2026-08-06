'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { saveAgentAction, setAgentStatusAction, type AgentDraft } from '@/app/actions/agent';
import { PERSONAS, VOICES, WEEKDAYS } from '@/lib/catalog';
import { translator } from '@/lib/i18n';
import type { BusinessHours, EscalationPolicy, Locale, UiLocale } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, PageHeader, Tabs } from '@/components/ui/primitives';
import { Checkbox, Field, Input, Select, Slider, Switch, Textarea } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import {
  FlagEN,
  FlagRU,
  FlagUZ,
  IconAlert,
  IconCheck,
  IconClock,
  IconHeadset,
  IconPause,
  IconPlay,
  IconSparkle,
  IconVolume,
} from '@/components/icons';

interface AgentView {
  id: string;
  name: string;
  status: 'draft' | 'live' | 'paused';
  persona: string;
  greeting: string;
  fallbackLine: string;
  instructions: string;
  languages: Locale[];
  primaryLang: Locale;
  voiceId: string;
  speakingRate: number;
  maxTurns: number;
  confidenceThreshold: number;
  version: number;
  escalation: EscalationPolicy;
  hours: BusinessHours;
}

const LANGS: Array<{ value: Locale; label: string; flag: React.ReactNode }> = [
  { value: 'uz', label: 'O‘zbekcha', flag: <FlagUZ size={18} /> },
  { value: 'ru', label: 'Русский', flag: <FlagRU size={18} /> },
  { value: 'en', label: 'English', flag: <FlagEN size={18} /> },
];

type Tab = 'voice' | 'behaviour' | 'escalation' | 'hours';

export function AgentStudio({
  agent,
  locale,
  canEdit,
  knowledgeChunks,
}: {
  agent: AgentView;
  locale: UiLocale;
  canEdit: boolean;
  knowledgeChunks: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(locale);
  const [, start] = useTransition();
  const [tab, setTab] = useState<Tab>('voice');
  const [saving, setSaving] = useState(false);

  const [draft, setDraft] = useState<AgentDraft>({
    name: agent.name,
    persona: agent.persona,
    greeting: agent.greeting,
    fallbackLine: agent.fallbackLine,
    instructions: agent.instructions,
    languages: agent.languages,
    primaryLang: agent.primaryLang,
    voiceId: agent.voiceId,
    speakingRate: agent.speakingRate,
    maxTurns: agent.maxTurns,
    confidenceThreshold: agent.confidenceThreshold,
    status: agent.status,
    escalation: agent.escalation,
    hours: agent.hours,
  });

  const dirty = useMemo(
    () =>
      JSON.stringify(draft) !==
      JSON.stringify({
        name: agent.name,
        persona: agent.persona,
        greeting: agent.greeting,
        fallbackLine: agent.fallbackLine,
        instructions: agent.instructions,
        languages: agent.languages,
        primaryLang: agent.primaryLang,
        voiceId: agent.voiceId,
        speakingRate: agent.speakingRate,
        maxTurns: agent.maxTurns,
        confidenceThreshold: agent.confidenceThreshold,
        status: agent.status,
        escalation: agent.escalation,
        hours: agent.hours,
      }),
    [draft, agent],
  );

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    const res = await saveAgentAction(agent.id, draft);
    setSaving(false);
    if (res.ok) {
      toast.success('Saved', `Version ${res.version} is now the active configuration.`);
      start(() => router.refresh());
    } else toast.error('Could not save', res.message);
  };

  const toggleStatus = async () => {
    const next = agent.status === 'live' ? 'paused' : 'live';
    const res = await setAgentStatusAction(agent.id, next);
    if (res.ok) toast.success(res.message);
    start(() => router.refresh());
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title={t('agent.title')}
        subtitle={t('agent.subtitle')}
        actions={
          canEdit ? (
            <>
              <Button
                variant={agent.status === 'live' ? 'secondary' : 'success'}
                icon={agent.status === 'live' ? <IconPause size={15} /> : <IconPlay size={15} />}
                onClick={() => void toggleStatus()}
              >
                {agent.status === 'live' ? 'Pause agent' : 'Take live'}
              </Button>
              <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
                {dirty ? 'Save changes' : 'Saved'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={agent.status === 'live' ? 'success' : agent.status === 'paused' ? 'warning' : 'neutral'} dot>
          {agent.status === 'live' ? 'Answering calls' : agent.status === 'paused' ? 'Paused' : 'Draft'}
        </Badge>
        <Badge tone="neutral">v{agent.version}</Badge>
        <Badge tone={knowledgeChunks > 0 ? 'neutral' : 'danger'}>
          {knowledgeChunks} passages indexed
        </Badge>
        {knowledgeChunks === 0 && (
          <span className="text-[12.5px] text-danger">
            With an empty knowledge base every call escalates.
          </span>
        )}
      </div>

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'voice', label: 'Voice & language', icon: <IconVolume size={15} /> },
          { value: 'behaviour', label: 'Behaviour', icon: <IconSparkle size={15} /> },
          { value: 'escalation', label: 'Escalation', icon: <IconHeadset size={15} /> },
          { value: 'hours', label: 'Business hours', icon: <IconClock size={15} /> },
        ]}
      />

      <fieldset disabled={!canEdit} className="space-y-4">
        {tab === 'voice' && (
          <>
            <Card>
              <CardHeader title="Identity" subtitle="What the agent is called internally and how it opens a call." />
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label="Agent name">
                  <Input value={draft.name} onChange={(e) => set('name', e.target.value)} />
                </Field>
                <Field label="Voice">
                  <Select value={draft.voiceId} onChange={(e) => set('voiceId', e.target.value)}>
                    {VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} — {v.note}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field
                className="mt-4"
                label="Opening line"
                hint="Spoken before the caller says anything. Keep it under about fifteen words."
              >
                <Textarea rows={2} value={draft.greeting} onChange={(e) => set('greeting', e.target.value)} />
              </Field>
              <Field
                className="mt-4"
                label="When it cannot answer"
                hint="Said just before handing the caller to a person."
              >
                <Textarea
                  rows={2}
                  value={draft.fallbackLine}
                  onChange={(e) => set('fallbackLine', e.target.value)}
                />
              </Field>
            </Card>

            <Card>
              <CardHeader title="Languages" subtitle="The agent answers in whichever of these the caller uses." />
              <div className="mt-4 flex flex-wrap gap-2">
                {LANGS.map((l) => {
                  const on = draft.languages.includes(l.value);
                  return (
                    <button
                      key={l.value}
                      type="button"
                      onClick={() =>
                        set(
                          'languages',
                          on
                            ? draft.languages.filter((x) => x !== l.value)
                            : [...draft.languages, l.value],
                        )
                      }
                      className={cn(
                        'inline-flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-[13.5px] font-medium transition-all',
                        on ? 'bg-brand text-white shadow-e1' : 'bg-surface-3 text-ink-2 hover:text-ink',
                      )}
                    >
                      {l.flag}
                      {l.label}
                      {on && <IconCheck size={14} />}
                    </button>
                  );
                })}
              </div>
              <Field className="mt-4 max-w-xs" label="Greets in">
                <Select
                  value={draft.primaryLang}
                  onChange={(e) => set('primaryLang', e.target.value as Locale)}
                >
                  {LANGS.filter((l) => draft.languages.includes(l.value)).map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Slider
                className="mt-5 max-w-sm"
                label="Speaking rate"
                min={0.7}
                max={1.4}
                step={0.05}
                value={draft.speakingRate}
                onChange={(v) => set('speakingRate', v)}
                format={(v) => `${v.toFixed(2)}×`}
              />
            </Card>
          </>
        )}

        {tab === 'behaviour' && (
          <>
            <Card>
              <CardHeader title="Manner" subtitle="How it carries itself on the phone." />
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {PERSONAS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => set('persona', p.value)}
                    className={cn(
                      'rounded-[11px] p-3.5 text-left transition-all',
                      draft.persona === p.value
                        ? 'bg-brand-soft ring-2 ring-[rgb(var(--brand))]'
                        : 'bg-surface-2 hover:bg-surface-3',
                    )}
                  >
                    <span className="block text-[13.5px] font-medium text-ink">{p.label}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-3">{p.hint}</span>
                  </button>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="House rules"
                subtitle="Extra instructions layered on top of your documents. Say what to do, not what to say."
              />
              <Textarea
                className="mt-4"
                rows={6}
                value={draft.instructions}
                onChange={(e) => set('instructions', e.target.value)}
                placeholder={
                  'Never quote a price for surgery — always pass those to a coordinator.\nIf someone describes chest pain, tell them to call 103 immediately and offer to transfer.'
                }
              />
              <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
                These never override your documents — the agent still only states facts it can find in
                the knowledge base.
              </p>
            </Card>

            <Card>
              <CardHeader title="Limits" subtitle="Guard rails on how long a conversation can run." />
              <div className="mt-5 space-y-5">
                <Slider
                  label="Maximum turns before handing over"
                  min={6}
                  max={40}
                  step={1}
                  value={draft.maxTurns}
                  onChange={(v) => set('maxTurns', v)}
                  format={(v) => `${v} turns`}
                />
              </div>
            </Card>
          </>
        )}

        {tab === 'escalation' && (
          <>
            <Card>
              <CardHeader
                title="Confidence threshold"
                subtitle="The single most important setting. Below this, a person takes the call."
                icon={<IconAlert size={16} />}
              />
              <div className="mt-5">
                <Slider
                  label="Minimum confidence to answer"
                  min={0.2}
                  max={0.9}
                  step={0.01}
                  value={draft.confidenceThreshold}
                  onChange={(v) => set('confidenceThreshold', v)}
                  format={(v) => v.toFixed(2)}
                />
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <ThresholdHint
                    active={draft.confidenceThreshold < 0.45}
                    title="Loose"
                    body="Answers more, hands over less. Raises the risk of a confidently wrong answer."
                  />
                  <ThresholdHint
                    active={draft.confidenceThreshold >= 0.45 && draft.confidenceThreshold <= 0.68}
                    title="Balanced"
                    body="What most contact centres settle on after a week of real calls."
                  />
                  <ThresholdHint
                    active={draft.confidenceThreshold > 0.68}
                    title="Cautious"
                    body="Escalates readily. Right for medical, legal and financial lines."
                  />
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Hand over when…" subtitle="Any of these sends the caller to a person." />
              <div className="mt-4 space-y-4">
                <Switch
                  checked={draft.escalation.onExplicitRequest}
                  onChange={(v) => set('escalation', { ...draft.escalation, onExplicitRequest: v })}
                  label="The caller asks for a human"
                  description="Recognised in all three languages, however it is phrased."
                />
                <Switch
                  checked={draft.escalation.onLowConfidence}
                  onChange={(v) => set('escalation', { ...draft.escalation, onLowConfidence: v })}
                  label="Confidence falls below the threshold"
                  description="The knowledge base does not clearly cover the question."
                />
                <Switch
                  checked={draft.escalation.onNegativeSentiment}
                  onChange={(v) => set('escalation', { ...draft.escalation, onNegativeSentiment: v })}
                  label="The caller sounds unhappy"
                  description="Frustration is detected from wording and emphasis."
                />
                <Switch
                  checked={draft.escalation.onRepeatedFailure}
                  onChange={(v) => set('escalation', { ...draft.escalation, onRepeatedFailure: v })}
                  label="Several questions in a row go unanswered"
                  description="Stops a caller from being stonewalled twice."
                />
              </div>
              {draft.escalation.onRepeatedFailure && (
                <Slider
                  className="mt-5 max-w-sm"
                  label="Unanswered questions before handing over"
                  min={1}
                  max={5}
                  step={1}
                  value={draft.escalation.maxFailedTurns}
                  onChange={(v) => set('escalation', { ...draft.escalation, maxFailedTurns: v })}
                  format={(v) => String(v)}
                />
              )}
            </Card>

            <Card>
              <CardHeader title="Where the call goes" subtitle="Who picks up when the agent steps aside." />
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Fallback number"
                  hint="Left empty, the call is queued in the operator inbox instead of being transferred."
                >
                  <Input
                    value={draft.escalation.fallbackNumber}
                    onChange={(e) =>
                      set('escalation', { ...draft.escalation, fallbackNumber: e.target.value })
                    }
                    placeholder="+998 71 200 00 00"
                  />
                </Field>
                <Field label="Ring timeout">
                  <Input
                    type="number"
                    value={draft.escalation.ringTimeoutSec}
                    onChange={(e) =>
                      set('escalation', {
                        ...draft.escalation,
                        ringTimeoutSec: Number(e.target.value) || 30,
                      })
                    }
                    suffix="sec"
                  />
                </Field>
              </div>
            </Card>
          </>
        )}

        {tab === 'hours' && (
          <Card>
            <CardHeader
              title="Business hours"
              subtitle="Outside these hours the agent can still answer, take a message, or offer a callback."
              action={
                <Switch
                  checked={draft.hours.enabled}
                  onChange={(v) => set('hours', { ...draft.hours, enabled: v })}
                />
              }
            />
            <div className={cn('mt-5 space-y-2.5', !draft.hours.enabled && 'pointer-events-none opacity-45')}>
              {WEEKDAYS.map((d) => {
                const spec = draft.hours.days[d.key] ?? { open: '09:00', close: '18:00', closed: false };
                return (
                  <div key={d.key} className="flex flex-wrap items-center gap-3 rounded-[10px] bg-surface-2 px-3.5 py-2.5">
                    <span className="w-[92px] shrink-0 text-[13px] font-medium text-ink">{d.label}</span>
                    <Checkbox
                      checked={!spec.closed}
                      onChange={(v) =>
                        set('hours', {
                          ...draft.hours,
                          days: { ...draft.hours.days, [d.key]: { ...spec, closed: !v } },
                        })
                      }
                      label="Open"
                    />
                    <div className={cn('flex items-center gap-2', spec.closed && 'opacity-40')}>
                      <Input
                        type="time"
                        value={spec.open}
                        disabled={spec.closed}
                        onChange={(e) =>
                          set('hours', {
                            ...draft.hours,
                            days: { ...draft.hours.days, [d.key]: { ...spec, open: e.target.value } },
                          })
                        }
                        className="w-[112px]"
                      />
                      <span className="text-ink-3">–</span>
                      <Input
                        type="time"
                        value={spec.close}
                        disabled={spec.closed}
                        onChange={(e) =>
                          set('hours', {
                            ...draft.hours,
                            days: { ...draft.hours.days, [d.key]: { ...spec, close: e.target.value } },
                          })
                        }
                        className="w-[112px]"
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <Field className="mt-5 max-w-sm" label="Outside business hours">
              <Select
                value={draft.escalation.afterHoursAction}
                onChange={(e) =>
                  set('escalation', {
                    ...draft.escalation,
                    afterHoursAction: e.target.value as EscalationPolicy['afterHoursAction'],
                  })
                }
              >
                <option value="answer_anyway">Answer normally — the knowledge base is always true</option>
                <option value="voicemail">Take a message</option>
                <option value="callback">Offer a callback next working day</option>
              </Select>
            </Field>
          </Card>
        )}
      </fieldset>

      {dirty && canEdit && (
        <div className="animate-fade-up sticky bottom-4 z-30 mt-5 flex items-center justify-between gap-4 rounded-[13px] bg-overlay px-4 py-3 shadow-e3 hairline">
          <span className="text-[13px] text-ink-2">You have unsaved changes.</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setDraft({
                  name: agent.name,
                  persona: agent.persona,
                  greeting: agent.greeting,
                  fallbackLine: agent.fallbackLine,
                  instructions: agent.instructions,
                  languages: agent.languages,
                  primaryLang: agent.primaryLang,
                  voiceId: agent.voiceId,
                  speakingRate: agent.speakingRate,
                  maxTurns: agent.maxTurns,
                  confidenceThreshold: agent.confidenceThreshold,
                  status: agent.status,
                  escalation: agent.escalation,
                  hours: agent.hours,
                })
              }
            >
              Discard
            </Button>
            <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThresholdHint({ active, title, body }: { active: boolean; title: string; body: string }) {
  return (
    <div
      className={cn(
        'rounded-[10px] p-3 transition-colors',
        active ? 'bg-brand-soft' : 'bg-surface-2',
      )}
    >
      <div className={cn('text-[12.5px] font-semibold', active ? 'text-brand-ink' : 'text-ink-2')}>
        {title}
      </div>
      <p className={cn('mt-0.5 text-[11.5px] leading-snug', active ? 'text-brand-ink/75' : 'text-ink-3')}>
        {body}
      </p>
    </div>
  );
}
