'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  acceptEscalationAction,
  operatorReplyAction,
  refreshSummaryAction,
  resolveEscalationAction,
} from '@/app/actions/ops';
import { useLive } from '@/components/console/use-live';
import { translator } from '@/lib/i18n';
import { ESCALATION_REASON_LABEL } from '@/lib/catalog';
import type { UiLocale } from '@/lib/types';
import { cn, fmtDuration, maskPhone, relativeTime, safeJson } from '@/lib/utils';
import { Avatar, Badge, Button, Card, EmptyState, PageHeader, StatusDot } from '@/components/ui/primitives';
import { Input, Select, Textarea } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import {
  IconAlert,
  IconBook,
  IconCheckCircle,
  IconHeadset,
  IconRefresh,
  IconSend,
  IconSparkle,
} from '@/components/icons';

interface TurnRow {
  ordinal: number;
  role: string;
  text: string;
  confidence: number | null;
  citations_json: string;
  timings_json: string;
  created_at: string;
}

export interface InboxItem {
  id: string;
  call_id: string;
  reason: string;
  priority: string;
  status: string;
  summary: string | null;
  operator_id: string | null;
  operator_name: string | null;
  created_at: string;
  from_e164: string;
  caller_name: string | null;
  language: string;
  started_at: string;
  intent: string | null;
  sentiment: number | null;
  turns: number;
  transcript: TurnRow[];
}

const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'neutral',
};

export function OperatorInbox({
  items,
  locale,
  operatorId,
}: {
  items: InboxItem[];
  locale: UiLocale;
  operatorId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(locale);
  const [, start] = useTransition();
  useLive(['escalation', 'escalation_assigned', 'escalation_resolved', 'turn']);

  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  useEffect(() => {
    if (!selected && items.length) setSelectedId(items[0].id);
  }, [items, selected]);

  const refresh = () => start(() => router.refresh());

  if (!items.length) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} />
        <Card>
          <EmptyState
            icon={<IconCheckCircle size={20} />}
            title={t('inbox.empty')}
            description={t('inbox.emptyHint')}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title={t('inbox.title')}
        subtitle={t('inbox.subtitle')}
        actions={
          <Badge tone={items.some((i) => i.status === 'waiting') ? 'danger' : 'neutral'} dot>
            {items.filter((i) => i.status === 'waiting').length} {t('inbox.waiting')}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[330px_1fr]">
        <Card padded={false} className="h-fit overflow-hidden">
          <div className="px-4 py-3 text-[12px] font-semibold tracking-wide text-ink-3 uppercase hairline-b">
            {t('inbox.queue')}
          </div>
          <div className="max-h-[70vh] divide-y divide-[rgb(var(--line)/var(--line-alpha))] overflow-y-auto">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  'block w-full px-4 py-3 text-left transition-colors',
                  selected?.id === item.id ? 'bg-brand-soft' : 'hover:bg-surface-2',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusDot
                      tone={item.status === 'waiting' ? 'danger' : 'info'}
                      pulse={item.status === 'waiting'}
                    />
                    <span className="truncate text-[13px] font-medium text-ink">
                      {item.caller_name ?? maskPhone(item.from_e164)}
                    </span>
                  </span>
                  <Badge tone={PRIORITY_TONE[item.priority] ?? 'neutral'}>
                    {t(`inbox.priority.${item.priority}`, item.priority)}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-[12px] text-ink-3">
                  {t(`reason.${item.reason}`, ESCALATION_REASON_LABEL[item.reason] ?? item.reason)}
                </p>
                <p className="mt-0.5 text-[11.5px] text-ink-3">
                  {item.language.toUpperCase()} · {t('inbox.waiting')}{' '}
                  {fmtDuration(Date.now() - new Date(item.created_at).getTime())}
                  {item.operator_name ? ` · ${item.operator_name}` : ''}
                </p>
              </button>
            ))}
          </div>
        </Card>

        {selected && (
          <CallWorkspace
            key={selected.id}
            item={selected}
            operatorId={operatorId}
            onChanged={refresh}
            toast={toast}
            t={t}
            locale={locale}
          />
        )}
      </div>
    </div>
  );
}

/* ── workspace ───────────────────────────────────────────────── */

function CallWorkspace({
  item,
  operatorId,
  onChanged,
  toast,
  t,
  locale,
}: {
  item: InboxItem;
  operatorId: string;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
  t: (k: string, f?: string) => string;
  locale: UiLocale;
}) {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [resolution, setResolution] = useState('answered');
  const [notes, setNotes] = useState('');
  const mine = item.operator_id === operatorId;

  const citations = useMemo(() => {
    const seen = new Map<string, { title: string; heading: string | null; snippet: string; score: number }>();
    for (const turn of item.transcript) {
      for (const c of safeJson<
        Array<{ documentTitle: string; heading: string | null; snippet: string; score: number }>
      >(turn.citations_json, [])) {
        const key = `${c.documentTitle}|${c.heading ?? ''}`;
        if (!seen.has(key)) {
          seen.set(key, { title: c.documentTitle, heading: c.heading, snippet: c.snippet, score: c.score });
        }
      }
    }
    return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  }, [item.transcript]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Avatar name={item.caller_name ?? t('inbox.caller', 'Caller')} hue={200} size={44} />
            <div>
              <h2 className="text-[16px] font-semibold text-ink">
                {item.caller_name ?? maskPhone(item.from_e164)}
              </h2>
              <p className="text-[12.5px] text-ink-3">
                {item.from_e164} · {item.language.toUpperCase()} ·{' '}
                {t('inbox.turnsCount', '{n} turns').replace('{n}', String(item.turns))} ·{' '}
                {relativeTime(item.started_at, locale)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {item.status === 'waiting' ? (
              <Button
                variant="primary"
                loading={busy}
                icon={<IconHeadset size={15} />}
                onClick={async () => {
                  setBusy(true);
                  const res = await acceptEscalationAction(item.id);
                  setBusy(false);
                  if (res.ok) toast.success(t('inbox.toast.connected', 'Connected'), res.message);
                  else toast.error(t('inbox.toast.tooLate', 'Too late'), res.message);
                  onChanged();
                }}
              >
                {t('inbox.accept')}
              </Button>
            ) : (
              <Badge tone="info" dot>
                {mine
                  ? t('inbox.handlingYou', 'You are handling this')
                  : t('inbox.handlingOther', '{name} is handling this').replace(
                      '{name}',
                      item.operator_name ?? t('inbox.someone', 'Someone'),
                    )}
              </Badge>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone={PRIORITY_TONE[item.priority] ?? 'neutral'}>
                    {t(`inbox.priority.${item.priority}`, item.priority)}
                  </Badge>
          <Badge tone="warning">
            {t(`reason.${item.reason}`, ESCALATION_REASON_LABEL[item.reason] ?? item.reason)}
          </Badge>
          {item.intent && <Badge tone="neutral">{t(`intent.${item.intent}`, item.intent)}</Badge>}
          {item.sentiment != null && item.sentiment < -0.2 && (
            <Badge tone="danger" icon={<IconAlert size={12} />}>
              {t('inbox.unhappy', 'Caller sounds unhappy')}
            </Badge>
          )}
        </div>
      </Card>

      <Card className="bg-brand-soft">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <IconSparkle size={17} className="mt-0.5 shrink-0 text-brand-ink" />
            <div>
              <h3 className="text-[13.5px] font-semibold text-brand-ink">{t('inbox.summary')}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-brand-ink/85">
                {item.summary ?? t('inbox.generating', 'Generating…')}
              </p>
            </div>
          </div>
          <Button
            size="xs"
            variant="ghost"
            icon={<IconRefresh size={13} />}
            onClick={async () => {
              const res = await refreshSummaryAction(item.id);
              if (res.ok) toast.success(t('inbox.toast.summaryRefreshed', 'Summary refreshed'));
              onChanged();
            }}
          >
            {t('inbox.redo', 'Redo')}
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card padded={false} className="overflow-hidden">
          <div className="px-5 py-3.5 text-[13px] font-semibold text-ink hairline-b">
            {t('inbox.transcript')}
          </div>
          <div className="max-h-[420px] space-y-3 overflow-y-auto p-5">
            {item.transcript.map((turn) => (
              <div
                key={turn.ordinal}
                className={cn('flex', turn.role === 'caller' ? 'justify-start' : 'justify-end')}
              >
                <div className={cn('max-w-[80%]', turn.role !== 'caller' && 'text-right')}>
                  <div
                    className={cn(
                      'inline-block rounded-[13px] px-3.5 py-2.5 text-left text-[13px] leading-relaxed',
                      turn.role === 'caller'
                        ? 'rounded-bl-[4px] bg-surface-3 text-ink'
                        : turn.role === 'operator'
                          ? 'rounded-br-[4px] bg-success text-white'
                          : 'rounded-br-[4px] bg-brand text-white',
                    )}
                  >
                    {turn.text}
                  </div>
                  <div
                    className={cn(
                      'mt-1 text-[11px] text-ink-3',
                      turn.role !== 'caller' ? 'text-right' : 'text-left',
                    )}
                  >
                    {turn.role === 'caller'
                      ? t('inbox.caller', 'Caller')
                      : turn.role === 'operator'
                        ? t('inbox.operator', 'Operator')
                        : 'AI'}
                    {turn.confidence != null &&
                      ` · ${t('inbox.conf', 'conf')} ${turn.confidence.toFixed(2)}`}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {item.status === 'assigned' && mine && (
            <div className="px-5 py-4 hairline-t">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!reply.trim()) return;
                  await operatorReplyAction(item.call_id, reply.trim());
                  setReply('');
                  onChanged();
                }}
                className="flex gap-2"
              >
                <Input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={t('inbox.replyPlaceholder', 'Type what you told the caller…')}
                  className="flex-1"
                />
                <Button type="submit" variant="primary" icon={<IconSend size={15} />}>
                  {t('inbox.log', 'Log')}
                </Button>
              </form>
              <p className="mt-2 text-[11.5px] text-ink-3">
                {t(
                  'inbox.logHint',
                  'Logging what you said keeps the transcript complete for quality review.',
                )}
              </p>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="flex items-center gap-2">
              <IconBook size={15} className="text-ink-3" />
              <h3 className="text-[13.5px] font-semibold text-ink">{t('inbox.sources')}</h3>
            </div>
            {citations.length ? (
              <div className="mt-3 space-y-2.5">
                {citations.map((c, i) => (
                  <div key={i} className="rounded-[10px] bg-surface-2 p-3">
                    <div className="text-[12px] font-medium text-ink">
                      {c.title}
                      {c.heading && <span className="text-ink-3"> › {c.heading}</span>}
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{c.snippet}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2.5 text-[12.5px] text-ink-3">
                {t(
                  'inbox.noSources',
                  'The AI found nothing relevant — which is exactly why this reached you.',
                )}
              </p>
            )}
          </Card>

          {item.status === 'assigned' && mine && (
            <Card>
              <h3 className="text-[13.5px] font-semibold text-ink">{t('inbox.close', 'Close the call')}</h3>
              <div className="mt-3 space-y-3">
                <Select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  <option value="answered">{t('inbox.resolution.answered', 'Answered the caller')}</option>
                  <option value="booked">{t('inbox.resolution.booked', 'Booked an appointment')}</option>
                  <option value="escalated_internally">
                    {t('inbox.resolution.escalated', 'Passed to a colleague')}
                  </option>
                  <option value="complaint_logged">
                    {t('inbox.resolution.complaint', 'Logged a complaint')}
                  </option>
                  <option value="no_action">{t('inbox.resolution.noAction', 'No action needed')}</option>
                </Select>
                <Textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('inbox.notesPlaceholder', 'Anything worth recording…')}
                />
                <Button
                  variant="success"
                  full
                  loading={busy}
                  icon={<IconCheckCircle size={15} />}
                  onClick={async () => {
                    setBusy(true);
                    const res = await resolveEscalationAction(item.id, resolution, notes, 5);
                    setBusy(false);
                    if (res.ok) toast.success(t('inbox.toast.closed', 'Closed'), res.message);
                    else toast.error(t('inbox.toast.closeFailed', 'Could not close'), res.message);
                    onChanged();
                  }}
                >
                  {t('inbox.resolve')}
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
