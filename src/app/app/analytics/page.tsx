import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { translator } from '@/lib/i18n';
import {
  daily,
  escalationReasons,
  hourlyHeat,
  intents,
  knowledgeGaps,
  languageSplit,
  operatorLeaderboard,
  overview,
} from '@/lib/analytics';
import { ESCALATION_REASON_LABEL } from '@/lib/catalog';
import {
  COST_PER_MINUTE,
  OPERATOR_ASSUMPTIONS,
  OPERATOR_COST_PER_MINUTE,
  RATE_CARD,
} from '@/lib/engine/calls';
import { fmtInt, fmtLatency, fmtMoney, fmtPct, percentile } from '@/lib/utils';
import { all } from '@/lib/db';
import { StatCard } from '@/components/console/stat-card';
import { GapList } from '@/components/console/gap-list';
import {
  ChartFrame,
  Donut,
  Heatmap,
  LatencyBars,
  RankBars,
  StackedBars,
  TrendChart,
} from '@/components/charts';
import { Avatar, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import {
  IconChart,
  IconClock,
  IconHeadset,
  IconPhone,
  IconSparkle,
  IconUsers,
  IconZap,
} from '@/components/icons';

export const metadata: Metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const { tenant, user } = await requireSession();
  const t = translator(user.locale);
  const LANG_NAME: Record<string, string> = {
    uz: t('analytics.lang.uz', 'Uzbek'),
    ru: t('analytics.lang.ru', 'Russian'),
    en: t('analytics.lang.en', 'English'),
  };

  const stats = overview(tenant.id, 30);
  const trend = daily(tenant.id, 30);
  const heat = hourlyHeat(tenant.id, 30);
  const topIntents = intents(tenant.id, 30, 8);
  const langs = languageSplit(tenant.id, 30);
  const reasons = escalationReasons(tenant.id, 30);
  const gaps = knowledgeGaps(tenant.id, 8);
  const operators = operatorLeaderboard(tenant.id, 30);

  const latencies = all<{ v: number }>(
    `SELECT avg_latency_ms AS v FROM calls WHERE tenant_id=? AND avg_latency_ms IS NOT NULL
     ORDER BY avg_latency_ms ASC`,
    tenant.id,
  ).map((r) => r.v);

  const buckets = [
    { label: t('analytics.p50', 'p50 — the typical caller'), ms: percentile(latencies, 50) },
    { label: 'p90', ms: percentile(latencies, 90) },
    { label: 'p95', ms: percentile(latencies, 95) },
    { label: t('analytics.p99', 'p99 — the worst experience'), ms: percentile(latencies, 99) },
  ];

  // Like-for-like: the same deflected minutes priced as wages versus priced as
  // AI handling. Telephony sits on both sides, so it cancels and is excluded.
  const aiMinutes = stats.totalCalls ? stats.minutes * stats.deflectionRate : 0;
  const humanEquivalent = aiMinutes * OPERATOR_COST_PER_MINUTE;
  const actualSpend = aiMinutes * (COST_PER_MINUTE - RATE_CARD.telephonyPerMin);

  if (!stats.totalCalls) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <PageHeader
          title={t('nav.analytics', 'Analytics')}
          subtitle={t('analytics.emptySubtitle', 'Where the calls go, and what they cost.')}
        />
        <Card>
          <EmptyState
            icon={<IconChart size={20} />}
            title={t('analytics.emptyTitle', 'Nothing to measure yet')}
            description={t(
              'analytics.emptyDesc',
              'Run a few simulated calls or connect a number. Every chart here is built from real call records — none of it is sample data.',
            )}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title={t('nav.analytics', 'Analytics')}
        subtitle={t(
          'analytics.subtitle',
          'Last 30 days. Every number here comes from real call records.',
        )}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('kpi.calls', 'Calls handled')}
          value={fmtInt(stats.totalCalls)}
          sub={t('analytics.talkTime', '{n} minutes of talk time').replace(
            '{n}',
            stats.minutes.toFixed(0),
          )}
          icon={<IconPhone size={16} />}
          spark={trend.map((d) => d.calls)}
        />
        <StatCard
          label={t('analytics.resolvedNoHuman', 'Resolved without a human')}
          value={fmtPct(stats.deflectionRate)}
          sub={t('analytics.escalatedAbandoned', '{esc} escalated · {aband} abandoned')
            .replace('{esc}', fmtInt(stats.escalated))
            .replace('{aband}', fmtInt(stats.abandoned))}
          icon={<IconSparkle size={16} />}
        />
        <StatCard
          label={t('kpi.latency', 'Median response')}
          value={fmtLatency(percentile(latencies, 50))}
          sub={`p95 ${fmtLatency(percentile(latencies, 95))}`}
          icon={<IconZap size={16} />}
        />
        <StatCard
          label={t('kpi.csat', 'Caller satisfaction')}
          value={stats.csat ? `${stats.csat.toFixed(1)} / 5` : '—'}
          sub={t('analytics.ratings', '{n} ratings').replace('{n}', fmtInt(stats.csatResponses))}
          icon={<IconUsers size={16} />}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ChartFrame
          className="lg:col-span-2"
          title={t('analytics.outcomesTitle', 'Where every call ended up')}
          subtitle={t('analytics.outcomesSubtitle', 'Daily mix of outcomes.')}
          legend={[
            { label: t('kpi.deflection', 'Resolved by AI'), color: 'var(--series-1)' },
            { label: t('analytics.escalated', 'Escalated'), color: 'var(--series-2)' },
            { label: t('analytics.abandoned', 'Abandoned'), color: 'var(--series-3)' },
          ]}
        >
          <StackedBars
            labels={trend.map((d) => d.day)}
            series={[
              {
                label: t('kpi.deflection', 'Resolved by AI'),
                values: trend.map((d) => d.aiResolved),
                slot: 0,
              },
              {
                label: t('analytics.escalated', 'Escalated'),
                values: trend.map((d) => d.escalated),
                slot: 1,
              },
              {
                label: t('analytics.abandoned', 'Abandoned'),
                values: trend.map((d) => d.abandoned),
                slot: 2,
              },
            ]}
            locale={user.locale}
          />
        </ChartFrame>

        <ChartFrame
          title={t('analytics.langMixTitle', 'Language mix')}
          subtitle={t('analytics.langMixSubtitle', 'What callers actually speak.')}
        >
          <Donut
            segments={langs.map((l) => ({ label: LANG_NAME[l.language] ?? l.language, value: l.c }))}
            centerValue={fmtInt(stats.totalCalls)}
            centerLabel={t('analytics.callsCenter', 'calls')}
          />
        </ChartFrame>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title={t('analytics.latencyDistTitle', 'Response time distribution')}
          subtitle={t(
            'analytics.latencyDistSubtitle',
            'Averages hide the calls that felt slow — percentiles do not.',
          )}
        >
          <LatencyBars buckets={buckets} target={1000} locale={user.locale} />
        </ChartFrame>

        <ChartFrame
          title={t('analytics.latencyTrendTitle', 'Response time trend')}
          subtitle={t(
            'analytics.latencyTrendSubtitle',
            'Daily average, end of speech to start of the reply.',
          )}
          legend={[{ label: t('analytics.avgLatency', 'Average latency'), color: 'var(--series-1)' }]}
        >
          <TrendChart
            labels={trend.map((d) => d.day)}
            series={[
              {
                label: t('analytics.avgLatency', 'Average latency'),
                values: trend.map((d) => d.avgLatencyMs),
                slot: 0,
              },
            ]}
            valueFormat="ms"
            yLabel={t('analytics.milliseconds', 'milliseconds')}
            locale={user.locale}
          />
        </ChartFrame>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title={t('analytics.intentsTitle', 'What people call about')}
          subtitle={t('analytics.intentsSubtitle', 'Top intents and how often the AI closed them.')}
        >
          <RankBars
            rows={topIntents.map((i) => ({
              label: t(`intent.${i.intent}`, i.label),
              value: i.count,
              sub: t('analytics.solved', '{n} solved').replace('{n}', fmtPct(i.resolvedRate)),
            }))}
          />
        </ChartFrame>

        <ChartFrame
          title={t('analytics.escReasonsTitle', 'Why calls reach a person')}
          subtitle={t(
            'analytics.escReasonsSubtitle',
            'Each reason is a different fix — a missing document, a threshold, an angry caller.',
          )}
        >
          <RankBars
            slot={1}
            rows={reasons.map((r) => ({
              label: t(`reason.${r.reason}`, ESCALATION_REASON_LABEL[r.reason] ?? r.reason),
              value: r.c,
              sub: r.avgWait
                ? t('analytics.wait', '{n}s wait').replace('{n}', String(Math.round(r.avgWait / 1000)))
                : undefined,
            }))}
            emptyLabel={t('analytics.noEscalations', 'No escalations — the AI handled everything.')}
          />
        </ChartFrame>
      </div>

      <ChartFrame
        className="mt-4"
        title={t('analytics.heatTitle', 'When the phone rings')}
        subtitle={t(
          'analytics.heatSubtitle',
          'Call volume by hour and weekday — useful for staffing the operators you keep.',
        )}
      >
        <Heatmap grid={heat} locale={user.locale} />
      </ChartFrame>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" padded={false}>
          <div className="px-5 py-4 hairline-b">
            <h3 className="text-[14.5px] font-semibold text-ink">
              {t('analytics.gapsTitle', 'Questions with no answer')}
            </h3>
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              {t(
                'analytics.gapsHint',
                'Ranked by how often they came up. Answering one here closes it for every future caller.',
              )}
            </p>
          </div>
          <GapList gaps={gaps} locale={user.locale} />
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <IconChart size={16} className="text-ink-3" />
            <h3 className="text-[14.5px] font-semibold text-ink">
              {t('analytics.moneyTitle', 'The money')}
            </h3>
          </div>
          <div className="space-y-3">
            <MoneyRow
              label={t('analytics.moneyMinutes', 'Minutes the AI carried alone')}
              value={`${aiMinutes.toFixed(0)} min`}
            />
            <MoneyRow
              label={t('analytics.moneyWages', 'Those minutes as operator wages')}
              value={fmtMoney(humanEquivalent, 'USD', 2)}
            />
            <MoneyRow
              label={t('analytics.moneyAI', 'Those minutes as AI handling')}
              value={fmtMoney(actualSpend, 'USD', 2)}
            />
            <div className="border-t border-[rgb(var(--line)/var(--line-alpha))] pt-3">
              <MoneyRow
                label={t('analytics.moneyNet', 'Net avoided')}
                value={fmtMoney(Math.max(0, humanEquivalent - actualSpend), 'USD', 2)}
                bold
              />
            </div>
          </div>
          <p className="mt-4 text-[11.5px] leading-relaxed text-ink-3">
            {t(
              'analytics.moneyFootnote',
              'Escalated calls are excluded — you paid for those twice, so they are not a saving. Wages assume a fully-loaded seat at ${cost}/month, {days} days, {hours}-hour shifts at {occ}% occupancy — {perMin} a minute. Telephony is charged on both sides, so it is left out of both.',
            )
              .replace('{cost}', String(OPERATOR_ASSUMPTIONS.loadedMonthlyCost))
              .replace('{days}', String(OPERATOR_ASSUMPTIONS.workingDays))
              .replace('{hours}', String(OPERATOR_ASSUMPTIONS.shiftHours))
              .replace('{occ}', String(Math.round(OPERATOR_ASSUMPTIONS.occupancy * 100)))
              .replace('{perMin}', () => fmtMoney(OPERATOR_COST_PER_MINUTE, 'USD', 3))}
          </p>
        </Card>
      </div>

      {operators.some((o) => o.handled > 0) && (
        <Card className="mt-4" padded={false}>
          <div className="px-5 py-4 hairline-b">
            <div className="flex items-center gap-2">
              <IconHeadset size={16} className="text-ink-3" />
              <h3 className="text-[14.5px] font-semibold text-ink">
                {t('analytics.operators', 'Operators')}
              </h3>
            </div>
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              {t('analytics.operatorsHint', 'How the escalated calls were handled.')}
            </p>
          </div>
          <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
            {operators.map((o) => (
              <div key={o.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar name={o.name} hue={o.avatar_hue} size={32} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{o.name}</span>
                <div className="flex shrink-0 items-center gap-5 text-[12.5px] text-ink-2 tabular">
                  <span title={t('kpi.calls', 'Calls handled')}>
                    {t('analytics.callsCount', '{n} calls').replace('{n}', String(o.handled))}
                  </span>
                  <span
                    className="inline-flex items-center gap-1"
                    title={t('analytics.avgAnswerTip', 'Average time to answer')}
                  >
                    <IconClock size={13} className="text-ink-3" />
                    {o.avgWait ? `${Math.round(o.avgWait / 1000)}s` : '—'}
                  </span>
                  <span title={t('analytics.avgHandleTip', 'Average handling time')}>
                    {o.avgHandle
                      ? t('analytics.handleSuffix', '{n}s handle').replace(
                          '{n}',
                          String(Math.round(o.avgHandle / 1000)),
                        )
                      : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function MoneyRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] text-ink-3">{label}</span>
      <span
        className={
          bold
            ? 'text-[18px] font-semibold text-success tabular'
            : 'text-[13.5px] font-medium text-ink tabular'
        }
      >
        {value}
      </span>
    </div>
  );
}
