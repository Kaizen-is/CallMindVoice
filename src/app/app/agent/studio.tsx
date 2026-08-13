'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { createAgentAction, saveAgentAction, setAgentStatusAction, type AgentDraft } from '@/app/actions/agent';
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
  IconPlus,
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
  agents,
  locale,
  canEdit,
  knowledgeChunks,
}: {
  agent: AgentView;
  agents: Array<{ id: string; name: string; status: 'draft' | 'live' | 'paused' }>;
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
  const [creating, setCreating] = useState(false);

  // Switching agents re-navigates with ?agent=<id>; the page keys the studio on
  // the id so React remounts it with the selected agent's configuration.
  const switchAgent = (agentId: string) => {
    if (agentId === agent.id) return;
    start(() => router.push(`/app/agent?agent=${agentId}`));
  };

  const createNew = async () => {
    const fallback = t('agent.newAgentDefault', 'New agent');
    const name = window.prompt(t('agent.newAgentPrompt', 'Name for the new agent'), fallback);
    if (name === null) return;
    setCreating(true);
    const res = await createAgentAction(name.trim() || fallback);
    setCreating(false);
    if (res.ok && res.agentId) {
      toast.success(t('agent.createdToast', 'Agent created'));
      start(() => router.push(`/app/agent?agent=${res.agentId}`));
    } else {
      toast.error(t('agent.createError', 'Could not create agent'));
    }
  };

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
      toast.success(
        t('common.saved', 'Saved'),
        t('agent.saveToast.body', 'Version {n} is now the active configuration.').replace(
          '{n}',
          String(res.version),
        ),
      );
      start(() => router.refresh());
    } else toast.error(t('agent.saveError', 'Could not save'), res.message);
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
                {agent.status === 'live'
                  ? t('agent.pause', 'Pause agent')
                  : t('agent.takeLive', 'Take live')}
              </Button>
              <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
                {dirty ? t('agent.saveChanges', 'Save changes') : t('common.saved', 'Saved')}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-3">{t('agent.editing', 'Editing')}</span>
        <Select
          value={agent.id}
          onChange={(e) => switchAgent(e.target.value)}
          className="w-auto min-w-[200px]"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        {canEdit && (
          <Button
            variant="secondary"
            size="sm"
            icon={<IconPlus size={14} />}
            loading={creating}
            onClick={() => void createNew()}
          >
            {t('agent.newAgent', 'New agent')}
          </Button>
        )}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={agent.status === 'live' ? 'success' : agent.status === 'paused' ? 'warning' : 'neutral'} dot>
          {agent.status === 'live'
            ? t('agent.status.answering', 'Answering calls')
            : agent.status === 'paused'
              ? t('agent.status.paused', 'Paused')
              : t('agent.status.draft', 'Draft')}
        </Badge>
        <Badge tone="neutral">v{agent.version}</Badge>
        <Badge tone={knowledgeChunks > 0 ? 'neutral' : 'danger'}>
          {t('agent.passagesIndexed', '{n} passages indexed').replace('{n}', String(knowledgeChunks))}
        </Badge>
        {knowledgeChunks === 0 && (
          <span className="text-[12.5px] text-danger">
            {t('agent.emptyKbWarning', 'With an empty knowledge base every call escalates.')}
          </span>
        )}
      </div>

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'voice', label: t('agent.tab.voice', 'Voice & language'), icon: <IconVolume size={15} /> },
          { value: 'behaviour', label: t('agent.tab.behaviour', 'Behaviour'), icon: <IconSparkle size={15} /> },
          { value: 'escalation', label: t('agent.tab.escalation', 'Escalation'), icon: <IconHeadset size={15} /> },
          { value: 'hours', label: t('agent.tab.hours', 'Business hours'), icon: <IconClock size={15} /> },
        ]}
      />

      <fieldset disabled={!canEdit} className="space-y-4">
        {tab === 'voice' && (
          <>
            <Card>
              <CardHeader
                title={t('agent.identity.title', 'Identity')}
                subtitle={t('agent.identity.subtitle', 'What the agent is called internally and how it opens a call.')}
              />
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label={t('agent.field.name', 'Agent name')}>
                  <Input value={draft.name} onChange={(e) => set('name', e.target.value)} />
                </Field>
                <Field label={t('agent.field.voice', 'Voice')}>
                  <Select value={draft.voiceId} onChange={(e) => set('voiceId', e.target.value)}>
                    {VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} — {t(`voice.${v.id}.note`, v.note)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field
                className="mt-4"
                label={t('agent.field.opening', 'Opening line')}
                hint={t('agent.field.openingHint', 'Spoken before the caller says anything. Keep it under about fifteen words.')}
              >
                <Textarea rows={2} value={draft.greeting} onChange={(e) => set('greeting', e.target.value)} />
              </Field>
              <Field
                className="mt-4"
                label={t('agent.field.fallback', 'When it cannot answer')}
                hint={t('agent.field.fallbackHint', 'Said just before handing the caller to a person.')}
              >
                <Textarea
                  rows={2}
                  value={draft.fallbackLine}
                  onChange={(e) => set('fallbackLine', e.target.value)}
                />
              </Field>
            </Card>

            <Card>
              <CardHeader
                title={t('agent.languages.title', 'Languages')}
                subtitle={t('agent.languages.subtitle', 'The agent answers in whichever of these the caller uses.')}
              />
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
              <Field className="mt-4 max-w-xs" label={t('agent.field.greetsIn', 'Greets in')}>
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
                label={t('agent.field.speakingRate', 'Speaking rate')}
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
              <CardHeader
                title={t('agent.manner.title', 'Manner')}
                subtitle={t('agent.manner.subtitle', 'How it carries itself on the phone.')}
              />
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
                    <span className="block text-[13.5px] font-medium text-ink">{t(`persona.${p.value}.label`, p.label)}</span>
                    <span className="mt-0.5 block text-[12px] text-ink-3">{t(`persona.${p.value}.hint`, p.hint)}</span>
                  </button>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader
                title={t('agent.houseRules.title', 'House rules')}
                subtitle={t('agent.houseRules.subtitle', 'Extra instructions layered on top of your documents. Say what to do, not what to say.')}
              />
              <Textarea
                className="mt-4"
                rows={6}
                value={draft.instructions}
                onChange={(e) => set('instructions', e.target.value)}
                placeholder={t(
                  'agent.houseRules.placeholder',
                  'Never quote a price for surgery — always pass those to a coordinator.\nIf someone describes chest pain, tell them to call 103 immediately and offer to transfer.',
                )}
              />
              <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
                {t(
                  'agent.houseRules.note',
                  'These never override your documents — the agent still only states facts it can find in the knowledge base.',
                )}
              </p>
            </Card>

            <Card>
              <CardHeader
                title={t('agent.limits.title', 'Limits')}
                subtitle={t('agent.limits.subtitle', 'Guard rails on how long a conversation can run.')}
              />
              <div className="mt-5 space-y-5">
                <Slider
                  label={t('agent.field.maxTurns', 'Maximum turns before handing over')}
                  min={6}
                  max={40}
                  step={1}
                  value={draft.maxTurns}
                  onChange={(v) => set('maxTurns', v)}
                  format={(v) => t('agent.turnsFmt', '{n} turns').replace('{n}', String(v))}
                />
              </div>
            </Card>
          </>
        )}

        {tab === 'escalation' && (
          <>
            <Card>
              <CardHeader
                title={t('agent.confidence.title', 'Confidence threshold')}
                subtitle={t('agent.confidence.subtitle', 'The single most important setting. Below this, a person takes the call.')}
                icon={<IconAlert size={16} />}
              />
              <div className="mt-5">
                <Slider
                  label={t('agent.field.minConfidence', 'Minimum confidence to answer')}
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
                    title={t('agent.threshold.loose.title', 'Loose')}
                    body={t('agent.threshold.loose.body', 'Answers more, hands over less. Raises the risk of a confidently wrong answer.')}
                  />
                  <ThresholdHint
                    active={draft.confidenceThreshold >= 0.45 && draft.confidenceThreshold <= 0.68}
                    title={t('agent.threshold.balanced.title', 'Balanced')}
                    body={t('agent.threshold.balanced.body', 'What most contact centres settle on after a week of real calls.')}
                  />
                  <ThresholdHint
                    active={draft.confidenceThreshold > 0.68}
                    title={t('agent.threshold.cautious.title', 'Cautious')}
                    body={t('agent.threshold.cautious.body', 'Escalates readily. Right for medical, legal and financial lines.')}
                  />
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader
                title={t('agent.handover.title', 'Hand over when…')}
                subtitle={t('agent.handover.subtitle', 'Any of these sends the caller to a person.')}
              />
              <div className="mt-4 space-y-4">
                <Switch
                  checked={draft.escalation.onExplicitRequest}
                  onChange={(v) => set('escalation', { ...draft.escalation, onExplicitRequest: v })}
                  label={t('agent.esc.explicit.label', 'The caller asks for a human')}
                  description={t('agent.esc.explicit.desc', 'Recognised in all three languages, however it is phrased.')}
                />
                <Switch
                  checked={draft.escalation.onLowConfidence}
                  onChange={(v) => set('escalation', { ...draft.escalation, onLowConfidence: v })}
                  label={t('agent.esc.lowConf.label', 'Confidence falls below the threshold')}
                  description={t('agent.esc.lowConf.desc', 'The knowledge base does not clearly cover the question.')}
                />
                <Switch
                  checked={draft.escalation.onNegativeSentiment}
                  onChange={(v) => set('escalation', { ...draft.escalation, onNegativeSentiment: v })}
                  label={t('agent.esc.negative.label', 'The caller sounds unhappy')}
                  description={t('agent.esc.negative.desc', 'Frustration is detected from wording and emphasis.')}
                />
                <Switch
                  checked={draft.escalation.onRepeatedFailure}
                  onChange={(v) => set('escalation', { ...draft.escalation, onRepeatedFailure: v })}
                  label={t('agent.esc.repeated.label', 'Several questions in a row go unanswered')}
                  description={t('agent.esc.repeated.desc', 'Stops a caller from being stonewalled twice.')}
                />
              </div>
              {draft.escalation.onRepeatedFailure && (
                <Slider
                  className="mt-5 max-w-sm"
                  label={t('agent.field.failedTurns', 'Unanswered questions before handing over')}
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
              <CardHeader
                title={t('agent.destination.title', 'Where the call goes')}
                subtitle={t('agent.destination.subtitle', 'Who picks up when the agent steps aside.')}
              />
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label={t('agent.field.fallbackNumber', 'Fallback number')}
                  hint={t('agent.field.fallbackNumberHint', 'Left empty, the call is queued in the operator inbox instead of being transferred.')}
                >
                  <Input
                    value={draft.escalation.fallbackNumber}
                    onChange={(e) =>
                      set('escalation', { ...draft.escalation, fallbackNumber: e.target.value })
                    }
                    placeholder="+998 71 200 00 00"
                  />
                </Field>
                <Field label={t('agent.field.ringTimeout', 'Ring timeout')}>
                  <Input
                    type="number"
                    value={draft.escalation.ringTimeoutSec}
                    onChange={(e) =>
                      set('escalation', {
                        ...draft.escalation,
                        ringTimeoutSec: Number(e.target.value) || 30,
                      })
                    }
                    suffix={t('agent.unit.sec', 'sec')}
                  />
                </Field>
              </div>
            </Card>
          </>
        )}

        {tab === 'hours' && (
          <Card>
            <CardHeader
              title={t('agent.tab.hours', 'Business hours')}
              subtitle={t('agent.hours.subtitle', 'Outside these hours the agent can still answer, take a message, or offer a callback.')}
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
                    <span className="w-[92px] shrink-0 text-[13px] font-medium text-ink">{t(`dow.long.${d.key}`, d.label)}</span>
                    <Checkbox
                      checked={!spec.closed}
                      onChange={(v) =>
                        set('hours', {
                          ...draft.hours,
                          days: { ...draft.hours.days, [d.key]: { ...spec, closed: !v } },
                        })
                      }
                      label={t('agent.day.open', 'Open')}
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

            <Field className="mt-5 max-w-sm" label={t('reason.after_hours', 'Outside business hours')}>
              <Select
                value={draft.escalation.afterHoursAction}
                onChange={(e) =>
                  set('escalation', {
                    ...draft.escalation,
                    afterHoursAction: e.target.value as EscalationPolicy['afterHoursAction'],
                  })
                }
              >
                <option value="answer_anyway">
                  {t('agent.afterHours.answer', 'Answer normally — the knowledge base is always true')}
                </option>
                <option value="voicemail">{t('agent.afterHours.voicemail', 'Take a message')}</option>
                <option value="callback">{t('agent.afterHours.callback', 'Offer a callback next working day')}</option>
              </Select>
            </Field>
          </Card>
        )}
      </fieldset>

      {dirty && canEdit && (
        <div className="animate-fade-up sticky bottom-4 z-30 mt-5 flex items-center justify-between gap-4 rounded-[13px] bg-overlay px-4 py-3 shadow-e3 hairline">
          <span className="text-[13px] text-ink-2">{t('agent.unsaved', 'You have unsaved changes.')}</span>
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
              {t('agent.discard', 'Discard')}
            </Button>
            <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
              {t('common.save', 'Save')}
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
