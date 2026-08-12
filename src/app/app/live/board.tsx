'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLive } from '@/components/console/use-live';
import { SimulateButton } from '@/components/console/simulate-button';
import { translator, type Translate } from '@/lib/i18n';
import type { Call, UiLocale } from '@/lib/types';
import { CALL_STATUS_LABEL } from '@/lib/catalog';
import { cn, fmtInt, fmtPct, maskPhone } from '@/lib/utils';
import { Badge, Card, EmptyState, PageHeader, StatusDot } from '@/components/ui/primitives';
import {
  IconAlert,
  IconGlobe,
  IconHeadset,
  IconPhoneIn,
  IconSparkle,
  IconWave,
} from '@/components/icons';

interface Row {
  call: Call;
  recent: Array<{ role: string; text: string; confidence: number | null; created_at: string }>;
}

export function LiveBoard({
  calls,
  locale,
  todayCalls,
  todayDeflection,
  waiting,
  simulated,
  telephony,
}: {
  calls: Row[];
  locale: UiLocale;
  todayCalls: number;
  todayDeflection: number;
  waiting: number;
  simulated: number;
  telephony: { configured: boolean; mode: 'asterisk' | 'twilio' | 'simulator' };
}) {
  const t = translator(locale);
  const { connected } = useLive([
    'call_started',
    'call_ringing',
    'turn',
    'escalation',
    'call_ended',
    'escalation_assigned',
  ]);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title={t('live.title')}
        subtitle={t('live.subtitle')}
        actions={<SimulateButton locale={locale} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[12.5px] shadow-e1 hairline">
          <StatusDot tone={connected ? 'success' : 'danger'} pulse={connected} />
          <span className="text-ink-2">{connected ? t('live.feedConnected', 'Live feed connected') : t('live.reconnecting', 'Reconnecting…')}</span>
        </span>
        <span className="inline-flex items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-[12.5px] shadow-e1 hairline">
          <IconGlobe size={13} className="text-ink-3" />
          <span className="text-ink-2">
            {telephony.mode === 'asterisk'
              ? t('live.asteriskBridge', 'Asterisk / FreePBX bridge')
              : telephony.mode === 'twilio'
                ? t('live.twilioTrunk', 'Twilio SIP trunk')
                : t('live.simulatorTransport', 'Simulator transport')}
          </span>
        </span>
        {simulated > 0 && (
          <Badge tone="brand" dot>
            {t('live.simulatedInFlight', '{n} simulated in flight').replace('{n}', String(simulated))}
          </Badge>
        )}
        {waiting > 0 && (
          <Link href="/app/inbox">
            <Badge tone="danger" dot>
              {t('live.waitingForOperator', '{n} waiting for an operator').replace('{n}', String(waiting))}
            </Badge>
          </Link>
        )}
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Tile label={t('live.onLineNow', 'On the line now')} value={fmtInt(calls.length)} tone={calls.length ? 'success' : 'neutral'} icon={<IconHeadset size={16} />} />
        <Tile label={t('live.callsToday', 'Calls today')} value={fmtInt(todayCalls)} icon={<IconPhoneIn size={16} />} />
        <Tile
          label={t('live.resolvedToday', 'Resolved by AI today')}
          value={todayCalls ? fmtPct(todayDeflection) : '—'}
          icon={<IconSparkle size={16} />}
        />
      </div>

      {calls.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {calls.map((row) => (
            <CallCard key={row.call.id} row={row} t={t} />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<IconWave size={20} />}
            title={t('live.noCalls')}
            description={t('live.emptyHint', 'Start a simulated call, or point a real number at your agent. Everything appears here the moment it rings.')}
            action={<SimulateButton locale={locale} />}
          />
        </Card>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: 'neutral' | 'success';
}) {
  return (
    <div className="flex items-center gap-3 rounded-[12px] bg-surface p-4 shadow-e1 hairline">
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]',
          tone === 'success' ? 'bg-success-soft text-success' : 'bg-surface-3 text-ink-3',
        )}
      >
        {icon}
      </span>
      <div>
        <div className="text-[19px] leading-none font-semibold text-ink tabular">{value}</div>
        <div className="mt-1 text-[12px] text-ink-3">{label}</div>
      </div>
    </div>
  );
}

function CallCard({ row, t }: { row: Row; t: Translate }) {
  const { call, recent } = row;
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(call.started_at).getTime());

  useEffect(() => {
    const iv = setInterval(
      () => setElapsed(Date.now() - new Date(call.started_at).getTime()),
      1000,
    );
    return () => clearInterval(iv);
  }, [call.started_at]);

  const tone =
    call.status === 'escalating'
      ? 'warning'
      : call.status === 'with_operator'
        ? 'info'
        : call.status === 'ringing'
          ? 'neutral'
          : 'success';

  return (
    <Link href={`/app/calls/${call.id}`}>
      <Card
        hover
        padded={false}
        className={cn(
          'h-full overflow-hidden',
          call.status === 'escalating' && 'ring-1 ring-[rgb(var(--warning)/0.4)]',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 hairline-b">
          <div className="flex min-w-0 items-center gap-2.5">
            <StatusDot tone={tone} pulse={call.status === 'active' || call.status === 'ringing'} />
            <span className="truncate text-[13.5px] font-medium text-ink">
              {call.caller_name ?? maskPhone(call.from_e164)}
            </span>
          </div>
          <span className="shrink-0 text-[12px] text-ink-3 tabular">
            {Math.floor(elapsed / 60000)}:{String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
          <Badge tone={tone}>{t(`status.${call.status}`, CALL_STATUS_LABEL[call.status] ?? call.status)}</Badge>
          <Badge tone="neutral">{call.language.toUpperCase()}</Badge>
          {call.intent && <Badge tone="neutral">{call.intent}</Badge>}
          {call.confidence != null && (
            <Badge tone={call.confidence >= 0.55 ? 'success' : 'warning'}>
              {call.confidence.toFixed(2)}
            </Badge>
          )}
        </div>

        <div className="space-y-2 p-4">
          {recent.length ? (
            recent.map((tn, i) => (
              <div key={i} className="flex gap-2">
                <span
                  className={cn(
                    'mt-0.5 shrink-0 text-[10px] font-semibold tracking-wide uppercase',
                    tn.role === 'caller' ? 'text-ink-3' : 'text-brand',
                  )}
                  style={{ width: 42 }}
                >
                  {tn.role === 'caller'
                    ? t('live.roleCaller', 'Caller')
                    : tn.role === 'operator'
                      ? t('live.roleHuman', 'Human')
                      : 'AI'}
                </span>
                <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
                  {tn.text.length > 130 ? `${tn.text.slice(0, 129)}…` : tn.text}
                </p>
              </div>
            ))
          ) : (
            <p className="text-[12.5px] text-ink-3">{t('live.ringing', 'Ringing…')}</p>
          )}
        </div>

        {call.status === 'escalating' && (
          <div className="flex items-center gap-2 bg-warning-soft px-4 py-2.5 text-[12px] text-warning">
            <IconAlert size={14} />
            {t('live.pickupWaiting', 'Waiting for an operator to pick up')}
          </div>
        )}
      </Card>
    </Link>
  );
}
