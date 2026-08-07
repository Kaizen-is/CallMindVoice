import type { Metadata } from 'next';
import Link from 'next/link';
import { requireSession } from '@/lib/auth';
import { all } from '@/lib/db';
import { daily, intents, knowledgeGaps, knowledgeStats, overview } from '@/lib/analytics';
import { liveAgent } from '@/lib/engine/calls';
import { engineIsHosted, engineLabel } from '@/lib/llm/provider';
import * as twilio from '@/lib/telephony/twilio';
import type { Call } from '@/lib/types';
import { fmtInt, fmtLatency, fmtMoney, fmtPct, relativeTime } from '@/lib/utils';
import { translator } from '@/lib/i18n';
import { StatCard } from '@/components/console/stat-card';
import { ChartFrame, RankBars, TrendChart } from '@/components/charts';
import { Badge, Card, EmptyState, LinkButton, PageHeader } from '@/components/ui/primitives';
import { SimulateButton } from '@/components/console/simulate-button';
import { GapList } from '@/components/console/gap-list';
import {
  IconAlert,
  IconArrowRight,
  IconBook,
  IconChart,
  IconCheckCircle,
  IconClock,
  IconHeadset,
  IconPhone,
  IconSparkle,
  IconWave,
  IconZap,
} from '@/components/icons';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const { tenant, user } = await requireSession();
  const t = translator(user.locale);

  const stats = overview(tenant.id, 30);
  const prev = overview(tenant.id, 60);
  const trend = daily(tenant.id, 30);
  const kb = knowledgeStats(tenant.id);
  const gaps = knowledgeGaps(tenant.id, 5);
  const topIntents = intents(tenant.id, 30, 5);
  const agent = liveAgent(tenant.id);

  const recent = all<Call>(
    `SELECT * FROM calls WHERE tenant_id=? ORDER BY started_at DESC LIMIT 8`,
    tenant.id,
  );

  // Second 30-day window, derived by subtracting the recent window from 60 days.
  const priorCalls = Math.max(0, prev.totalCalls - stats.totalCalls);
  const callsDelta = priorCalls > 0 ? ((stats.totalCalls - priorCalls) / priorCalls) * 100 : null;

  const setupDone = {
    knowledge: kb.ready > 0,
    agent: agent?.status === 'live',
    number: true,
    tested: stats.totalCalls > 0,
  };
  const setupRemaining = Object.values(setupDone).filter((v) => !v).length;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title={t('dash.title')}
        subtitle={t('dash.subtitle')}
        actions={
          <>
            <LinkButton href="/app/playground" variant="secondary" size="md" icon={<IconWave size={15} />}>
              {t('nav.playground')}
            </LinkButton>
            <SimulateButton />
          </>
        }
      />

      {setupRemaining > 0 && <SetupChecklist done={setupDone} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('kpi.calls')}
          value={fmtInt(stats.totalCalls)}
          sub="Last 30 days"
          delta={callsDelta}
          icon={<IconPhone size={16} />}
          spark={trend.map((d) => d.calls)}
        />
        <StatCard
          label={t('kpi.deflection')}
          value={stats.totalCalls ? fmtPct(stats.deflectionRate) : '—'}
          sub={`${fmtInt(stats.aiResolved)} of ${fmtInt(stats.totalCalls)} calls`}
          icon={<IconSparkle size={16} />}
        />
        <StatCard
          label={t('kpi.latency')}
          value={stats.avgLatencyMs ? fmtLatency(stats.avgLatencyMs) : '—'}
          sub={stats.p95LatencyMs ? `p95 ${fmtLatency(stats.p95LatencyMs)}` : 'No calls yet'}
          icon={<IconZap size={16} />}
        />
        <StatCard
          label={t('kpi.savings')}
          value={stats.savingsUsd > 0 ? fmtMoney(stats.savingsUsd, 'USD', 0) : '—'}
          sub={`${stats.operatorHoursSaved.toFixed(1)} operator hours avoided`}
          icon={<IconChart size={16} />}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ChartFrame
          className="lg:col-span-2"
          title="Call volume"
          subtitle="Handled entirely by the AI versus handed to a person."
          legend={[
            { label: 'Resolved by AI', color: 'var(--series-1)' },
            { label: 'Escalated', color: 'var(--series-2)' },
          ]}
          footnote="Escalation is not failure — it is the agent deciding a person should take this one."
        >
          {stats.totalCalls ? (
            <TrendChart
              labels={trend.map((d) => d.day)}
              series={[
                { label: 'Resolved by AI', values: trend.map((d) => d.aiResolved), slot: 0 },
                { label: 'Escalated', values: trend.map((d) => d.escalated), slot: 1 },
              ]}
            />
          ) : (
            <EmptyState
              icon={<IconPhone size={20} />}
              title="No calls yet"
              description="Run a simulated call, or point a number at your agent to see real traffic here."
              action={<SimulateButton />}
            />
          )}
        </ChartFrame>

        <div className="space-y-4">
          <Card>
            <h3 className="text-[14.5px] font-semibold text-ink">Right now</h3>
            <div className="mt-4 space-y-3">
              <LiveRow
                icon={<IconHeadset size={16} />}
                label={t('kpi.active')}
                value={fmtInt(stats.activeNow)}
                tone={stats.activeNow > 0 ? 'success' : 'neutral'}
              />
              <LiveRow
                icon={<IconAlert size={16} />}
                label={t('kpi.waiting')}
                value={fmtInt(stats.waitingEscalations)}
                tone={stats.waitingEscalations > 0 ? 'danger' : 'neutral'}
                href={stats.waitingEscalations > 0 ? '/app/inbox' : undefined}
              />
              <LiveRow
                icon={<IconBook size={16} />}
                label="Indexed passages"
                value={fmtInt(kb.chunks)}
                tone="neutral"
                href="/app/knowledge"
              />
              <LiveRow
                icon={<IconClock size={16} />}
                label="Avg call length"
                value={stats.avgHandleSec ? `${Math.round(stats.avgHandleSec)}s` : '—'}
                tone="neutral"
              />
            </div>
          </Card>

          <Card>
            <h3 className="text-[14.5px] font-semibold text-ink">Engines</h3>
            <div className="mt-3.5 space-y-2.5 text-[12.5px]">
              <EngineRow
                label="Answer generation"
                value={engineIsHosted() ? engineLabel() : 'Local synthesiser'}
                hosted={engineIsHosted()}
              />
              <EngineRow
                label="Telephony"
                value={twilio.isConfigured() ? 'Twilio SIP' : 'Built-in simulator'}
                hosted={twilio.isConfigured()}
              />
              <EngineRow
                label="Retrieval"
                value="Hybrid BM25 + dense"
                hosted
              />
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
              Local engines need no API keys and never leave this machine. Add credentials in
              settings to switch any row to a hosted provider.
            </p>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" padded={false}>
          <div className="flex items-center justify-between gap-3 px-5 py-4 hairline-b">
            <h3 className="text-[14.5px] font-semibold text-ink">{t('dash.recentCalls')}</h3>
            <Link
              href="/app/calls"
              className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand hover:underline"
            >
              {t('common.viewAll')}
              <IconArrowRight size={13} />
            </Link>
          </div>
          {recent.length ? (
            <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
              {recent.map((c) => (
                <Link
                  key={c.id}
                  href={`/app/calls/${c.id}`}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      c.escalated ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success'
                    }`}
                  >
                    {c.escalated ? <IconHeadset size={15} /> : <IconCheckCircle size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">
                      {c.caller_name ?? c.from_e164}
                    </div>
                    <div className="truncate text-[12px] text-ink-3">
                      {c.intent ?? 'General enquiry'} · {c.language.toUpperCase()} ·{' '}
                      {relativeTime(c.started_at)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[12.5px] text-ink-2 tabular">
                      {c.duration_ms ? `${Math.round(c.duration_ms / 1000)}s` : '—'}
                    </div>
                    {c.avg_latency_ms ? (
                      <div className="text-[11px] text-ink-3 tabular">{fmtLatency(c.avg_latency_ms)}</div>
                    ) : null}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<IconPhone size={20} />}
              title="Nothing has come in yet"
              description="Every call will show up here with its transcript and the passages the AI used."
            />
          )}
        </Card>

        <ChartFrame
          title="What people ask about"
          subtitle="Top intents in the last 30 days."
        >
          <RankBars
            rows={topIntents.map((i) => ({
              label: i.label,
              value: i.count,
              sub: `${fmtPct(i.resolvedRate)} solved`,
            }))}
            emptyLabel="Intents appear once calls come in."
          />
        </ChartFrame>
      </div>

      <Card className="mt-4" padded={false}>
        <div className="px-5 py-4 hairline-b">
          <h3 className="text-[14.5px] font-semibold text-ink">{t('dash.gaps')}</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">{t('dash.gapsHint')}</p>
        </div>
        <GapList gaps={gaps} />
      </Card>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────── */

function SetupChecklist({ done }: { done: Record<string, boolean> }) {
  const items = [
    { key: 'knowledge', label: 'Add knowledge', href: '/app/knowledge', hint: 'Upload documents your agent can answer from' },
    { key: 'agent', label: 'Take the agent live', href: '/app/agent', hint: 'Set the voice, languages and escalation rules' },
    { key: 'number', label: 'Connect a number', href: '/app/numbers', hint: 'A simulator line is already assigned' },
    { key: 'tested', label: 'Handle a first call', href: '/app/playground', hint: 'Talk to it yourself before your callers do' },
  ];
  return (
    <Card className="mb-4 bg-brand-soft" padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold text-brand-ink">Finish setting up</h3>
          <p className="text-[12.5px] text-brand-ink/70">
            {Object.values(done).filter(Boolean).length} of {items.length} done
          </p>
        </div>
      </div>
      <div className="grid gap-px bg-[rgb(var(--line)/var(--line-alpha))] sm:grid-cols-2 lg:grid-cols-4">
        {items.map((i) => (
          <Link
            key={i.key}
            href={i.href}
            className="group flex items-start gap-2.5 bg-brand-soft p-4 transition-colors hover:bg-surface"
          >
            <span
              className={`mt-px flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full ${
                done[i.key] ? 'bg-success text-white' : 'border border-brand-ink/30'
              }`}
              style={{ width: 18, height: 18 }}
            >
              {done[i.key] && <IconCheckCircle size={12} />}
            </span>
            <span className="min-w-0">
              <span
                className={`block text-[13px] font-medium ${
                  done[i.key] ? 'text-brand-ink/50 line-through' : 'text-brand-ink'
                }`}
              >
                {i.label}
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-brand-ink/60">{i.hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function LiveRow({
  icon,
  label,
  value,
  tone,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'neutral' | 'success' | 'danger';
  href?: string;
}) {
  const body = (
    <div className="flex items-center gap-3">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] ${
          tone === 'success'
            ? 'bg-success-soft text-success'
            : tone === 'danger'
              ? 'bg-danger-soft text-danger'
              : 'bg-surface-3 text-ink-3'
        }`}
      >
        {icon}
      </span>
      <span className="flex-1 text-[13px] text-ink-2">{label}</span>
      <span className="text-[15px] font-semibold text-ink tabular">{value}</span>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-[9px] transition-colors hover:bg-surface-2">
      {body}
    </Link>
  ) : (
    body
  );
}

function EngineRow({ label, value, hosted }: { label: string; value: string; hosted: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-3">{label}</span>
      <Badge tone={hosted ? 'success' : 'neutral'} dot>
        {value}
      </Badge>
    </div>
  );
}
