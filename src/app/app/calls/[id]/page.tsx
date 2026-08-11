import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { translator } from '@/lib/i18n';
import { get } from '@/lib/db';
import { callWithTurns } from '@/lib/engine/calls';
import { CALL_STATUS_LABEL, ESCALATION_REASON_LABEL, OUTCOME_LABEL } from '@/lib/catalog';
import type { Escalation } from '@/lib/types';
import { cn, fmtDateTime, fmtDuration, fmtLatency, fmtMoney, safeJson } from '@/lib/utils';
import { Badge, Card, KeyValue, PageHeader } from '@/components/ui/primitives';
import {
  IconAlert,
  IconArrowLeft,
  IconBook,
  IconCheckCircle,
  IconHeadset,
  IconSparkle,
  IconZap,
} from '@/components/icons';

export const metadata: Metadata = { title: 'Call detail' };
export const dynamic = 'force-dynamic';

const STAGES = [
  { key: 'sttMs', tkey: 'calls.stage.speech', label: 'Speech', color: 'var(--series-1)' },
  { key: 'retrievalMs', tkey: 'calls.stage.retrieval', label: 'Retrieval', color: 'var(--series-3)' },
  { key: 'llmMs', tkey: 'calls.stage.generation', label: 'Generation', color: 'var(--series-2)' },
  { key: 'ttsMs', tkey: 'calls.stage.synthesis', label: 'Synthesis', color: 'var(--series-4)' },
];

export default async function CallDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { tenant, user } = await requireSession();
  const t = translator(user.locale);
  const { id } = await params;
  const data = callWithTurns(tenant.id, id);
  if (!data) notFound();

  const { call, turns } = data;
  const escalation = get<Escalation>(
    'SELECT * FROM escalations WHERE call_id=? ORDER BY created_at DESC LIMIT 1',
    call.id,
  );
  const operatorMinutes = Math.round((call.duration_ms || 0) / 60000) || 1;

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader
        breadcrumb={
          <Link href="/app/calls" className="inline-flex items-center gap-1 hover:text-ink">
            <IconArrowLeft size={13} />
            {t('nav.calls', 'Call history')}
          </Link>
        }
        title={call.caller_name ?? call.from_e164}
        subtitle={`${call.from_e164} → ${call.to_e164} · ${fmtDateTime(call.started_at, user.locale)}`}
        actions={
          <Badge
            tone={
              call.outcome === 'resolved_by_ai'
                ? 'success'
                : call.outcome === 'abandoned'
                  ? 'danger'
                  : call.escalated
                    ? 'warning'
                    : 'neutral'
            }
            dot
          >
            {call.outcome
              ? t(`outcome.${call.outcome}`, OUTCOME_LABEL[call.outcome] ?? call.outcome)
              : t(`status.${call.status}`, CALL_STATUS_LABEL[call.status] ?? call.status)}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_330px]">
        <div className="space-y-4">
          {call.summary && (
            <Card className="bg-brand-soft">
              <div className="flex items-start gap-2.5">
                <IconSparkle size={17} className="mt-0.5 shrink-0 text-brand-ink" />
                <div>
                  <h3 className="text-[13.5px] font-semibold text-brand-ink">
                    {t('calls.detail.summary', 'Summary')}
                  </h3>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-brand-ink/85">{call.summary}</p>
                </div>
              </div>
            </Card>
          )}

          <Card padded={false} className="overflow-hidden">
            <div className="px-5 py-3.5 text-[13.5px] font-semibold text-ink hairline-b">
              {t('inbox.transcript', 'Transcript')}
            </div>
            <div className="space-y-4 p-5">
              {turns.length ? (
                turns.map((turn) => {
                  const citations = turn.citations as Array<{
                    documentTitle: string;
                    heading: string | null;
                    snippet: string;
                    score: number;
                  }>;
                  const timings = turn.timings as Record<string, number>;
                  const isCaller = turn.role === 'caller';
                  return (
                    <div key={turn.id}>
                      <div className={cn('flex', isCaller ? 'justify-start' : 'justify-end')}>
                        <div className={cn('max-w-[82%]', !isCaller && 'text-right')}>
                          <div
                            className={cn(
                              'inline-block rounded-[14px] px-3.5 py-2.5 text-left text-[13.5px] leading-relaxed',
                              isCaller
                                ? 'rounded-bl-[5px] bg-surface-3 text-ink'
                                : turn.role === 'operator'
                                  ? 'rounded-br-[5px] bg-success text-white'
                                  : 'rounded-br-[5px] bg-brand text-white',
                            )}
                          >
                            {turn.text}
                          </div>
                          <div
                            className={cn(
                              'mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-3',
                              isCaller ? 'justify-start' : 'justify-end',
                            )}
                          >
                            <span>
                              {isCaller
                                ? t('calls.role.caller', 'Caller')
                                : turn.role === 'operator'
                                  ? t('calls.role.operator', 'Operator')
                                  : t('calls.role.ai', 'AI')}
                            </span>
                            {turn.latency_ms != null && (
                              <span className="tabular">{fmtLatency(turn.latency_ms)}</span>
                            )}
                            {turn.confidence != null && (
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5',
                                  turn.confidence >= 0.55
                                    ? 'bg-success-soft text-success'
                                    : 'bg-warning-soft text-warning',
                                )}
                              >
                                {t('calls.conf', 'conf')} {turn.confidence.toFixed(2)}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {citations.length > 0 && (
                        <div className="mt-2 ml-auto max-w-[82%] space-y-1.5">
                          {citations.map((c, i) => (
                            <div
                              key={i}
                              className="rounded-[9px] bg-surface-2 px-3 py-2 text-[11.5px]"
                            >
                              <div className="flex items-center gap-1.5 font-medium text-ink-2">
                                <IconBook size={12} />
                                {c.documentTitle}
                                {c.heading && <span className="text-ink-3">› {c.heading}</span>}
                                <span className="ml-auto text-ink-3 tabular">
                                  {c.score.toFixed(2)}
                                </span>
                              </div>
                              <p className="mt-1 leading-relaxed text-ink-3">{c.snippet}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {Object.keys(timings).length > 0 && (
                        <div className="mt-2 ml-auto flex max-w-[82%] gap-px overflow-hidden rounded-full">
                          {STAGES.map((s) => {
                            const v = timings[s.key] ?? 0;
                            const total = STAGES.reduce((a, x) => a + (timings[x.key] ?? 0), 0) || 1;
                            if (!v) return null;
                            return (
                              <div
                                key={s.key}
                                className="h-1"
                                style={{ width: `${(v / total) * 100}%`, background: s.color }}
                                title={`${t(s.tkey, s.label)} ${Math.round(v)} ms`}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="py-8 text-center text-[13px] text-ink-3">
                  {t('calls.detail.noTranscript', 'This call ended before anything was said.')}
                </p>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h3 className="mb-4 text-[13.5px] font-semibold text-ink">
              {t('calls.detail.facts', 'Call facts')}
            </h3>
            <KeyValue
              items={[
                {
                  label: t('calls.fact.status', 'Status'),
                  value: t(`status.${call.status}`, CALL_STATUS_LABEL[call.status] ?? call.status),
                },
                { label: t('calls.fact.direction', 'Direction'), value: call.direction },
                { label: t('calls.fact.channel', 'Channel'), value: call.channel },
                { label: t('calls.fact.language', 'Language'), value: call.language.toUpperCase() },
                { label: t('calls.fact.intent', 'Intent'), value: call.intent ? t(`intent.${call.intent}`, call.intent) : '—' },
                { label: t('calls.fact.turns', 'Turns'), value: String(call.turns) },
                {
                  label: t('calls.fact.duration', 'Duration'),
                  value: call.duration_ms ? fmtDuration(call.duration_ms) : '—',
                },
                { label: t('calls.fact.started', 'Started'), value: fmtDateTime(call.started_at, user.locale) },
                {
                  label: t('calls.fact.ended', 'Ended'),
                  value: call.ended_at ? fmtDateTime(call.ended_at, user.locale) : '—',
                },
                { label: t('calls.fact.cost', 'Cost'), value: fmtMoney(call.cost_usd, 'USD', 3) },
                {
                  label: t('calls.fact.csat', 'CSAT'),
                  value: call.csat ? `${call.csat} / 5` : '—',
                },
              ]}
            />
          </Card>

          <Card>
            <div className="mb-3 flex items-center gap-2">
              <IconZap size={15} className="text-ink-3" />
              <h3 className="text-[13.5px] font-semibold text-ink">
                {t('calls.detail.responseTimes', 'Response times')}
              </h3>
            </div>
            <KeyValue
              items={[
                {
                  label: t('calls.rt.first', 'First response'),
                  value: fmtLatency(call.first_response_ms),
                },
                { label: t('calls.rt.average', 'Average'), value: fmtLatency(call.avg_latency_ms) },
                { label: 'p95', value: fmtLatency(call.p95_latency_ms) },
              ]}
            />
            {(call.avg_latency_ms ?? 0) > 1000 && (
              <p className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warning">
                <IconAlert size={13} className="mt-px shrink-0" />
                {t(
                  'calls.rt.warning',
                  'Above the one-second target — callers notice pauses this long.',
                )}
              </p>
            )}
          </Card>

          {escalation && (
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <IconHeadset size={15} className="text-warning" />
                <h3 className="text-[13.5px] font-semibold text-ink">
                  {t('calls.detail.handoff', 'Hand-off')}
                </h3>
              </div>
              <KeyValue
                items={[
                  {
                    label: t('calls.handoff.reason', 'Reason'),
                    value: t(`reason.${escalation.reason}`, ESCALATION_REASON_LABEL[escalation.reason] ?? escalation.reason),
                  },
                  { label: t('calls.handoff.priority', 'Priority'), value: t(`priority.${escalation.priority}`, escalation.priority) },
                  { label: t('calls.fact.status', 'Status'), value: t(`escstatus.${escalation.status}`, escalation.status) },
                  {
                    label: t('calls.handoff.wait', 'Wait'),
                    value: escalation.waited_ms ? fmtDuration(escalation.waited_ms) : '—',
                  },
                  {
                    label: t('calls.handoff.handling', 'Handling time'),
                    value: escalation.handled_ms ? fmtDuration(escalation.handled_ms) : '—',
                  },
                  { label: t('calls.handoff.resolution', 'Resolution'), value: escalation.resolution ?? '—' },
                ]}
              />
              {escalation.notes && (
                <p className="mt-3 rounded-[9px] bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-2">
                  {escalation.notes}
                </p>
              )}
            </Card>
          )}

          {!call.escalated && call.outcome === 'resolved_by_ai' && (
            <Card className="bg-success-soft">
              <div className="flex items-start gap-2.5">
                <IconCheckCircle size={17} className="mt-0.5 shrink-0 text-success" />
                <p className="text-[12.5px] leading-relaxed text-success">
                  {operatorMinutes === 1
                    ? t(
                        'calls.saved.one',
                        'Handled end to end without a person. That is roughly 1 operator minute you did not pay for.',
                      )
                    : t(
                        'calls.saved.many',
                        'Handled end to end without a person. That is roughly {n} operator minutes you did not pay for.',
                      ).replace('{n}', String(operatorMinutes))}
                </p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
