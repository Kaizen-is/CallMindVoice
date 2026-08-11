import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { translator } from '@/lib/i18n';
import { all } from '@/lib/db';
import { daily, overview } from '@/lib/analytics';
import { OVERAGE_PER_MINUTE, PLANS } from '@/lib/catalog';
import { COST_PER_MINUTE, RATE_CARD } from '@/lib/engine/calls';
import type { Invoice } from '@/lib/types';
import { fmtDate, fmtInt, fmtMoney, fmtPct } from '@/lib/utils';
import { ChartFrame, TrendChart } from '@/components/charts';
import { Badge, Card, PageHeader, Progress } from '@/components/ui/primitives';
import { PlanPicker } from './plan-picker';
import { IconCheck, IconCreditCard } from '@/components/icons';

export const metadata: Metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const { tenant, user } = await requireSession();
  const t = translator(user.locale);
  const stats = overview(tenant.id, 30);
  const trend = daily(tenant.id, 30);
  const invoices = all<Invoice>(
    'SELECT * FROM invoices WHERE tenant_id=? ORDER BY period DESC LIMIT 12',
    tenant.id,
  );

  const plan = PLANS.find((p) => p.id === tenant.plan) ?? PLANS[0];
  // Bill only the minutes beyond the plan's included bundle — not every minute.
  const minutesUsed = stats.minutes;
  const usedPct = plan.minutesIncluded ? minutesUsed / plan.minutesIncluded : 0;
  const overageMinutes = Math.max(0, minutesUsed - plan.minutesIncluded);
  const overageRate = plan.overagePerMinute ?? OVERAGE_PER_MINUTE;
  const usageCost = overageMinutes * overageRate;
  const trialLeft = tenant.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(tenant.trial_ends_at).getTime() - Date.now()) / 864e5))
    : 0;

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title={t('nav.billing', 'Billing')}
        subtitle={t(
          'billing.subtitle',
          'What you are on, what you have used, and what it would have cost in wages.',
        )}
      />

      {tenant.plan === 'trial' && (
        <Card className="mb-4 bg-brand-soft">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-semibold text-brand-ink">
                {(trialLeft === 1
                  ? t('billing.trialLeftOne', '1 day left in your trial')
                  : t('billing.trialLeftMany', '{n} days left in your trial')
                ).replace('{n}', String(trialLeft))}
              </h3>
              <p className="mt-0.5 text-[12.5px] text-brand-ink/75">
                {t('billing.trialNote', 'Everything works during the trial — no feature is held back.')}
              </p>
            </div>
            <Badge tone="brand">
              {t('billing.trialEnds', 'Trial ends {date}').replace('{date}', fmtDate(tenant.trial_ends_at, user.locale))}
            </Badge>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-semibold text-ink">{t('billing.thisPeriod', 'This period')}</h3>
              <p className="mt-0.5 text-[12.5px] text-ink-3">
                {t('billing.planLine', '{name} plan · {min} minutes included')
                  .replace('{name}', t(`plan.${plan.id}.name`, plan.name))
                  .replace('{min}', fmtInt(plan.minutesIncluded))}
              </p>
            </div>
            <div className="text-right">
              <div className="text-[26px] leading-none font-semibold text-ink tabular">
                {fmtMoney(plan.priceUsd + usageCost, 'USD', 2)}
              </div>
              <div className="mt-1 text-[12px] text-ink-3">{t('billing.estimated', 'estimated for this month')}</div>
            </div>
          </div>

          <div className="mt-5">
            <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
              <span className="text-ink-2">{t('billing.minutesUsed', 'Minutes used')}</span>
              <span className="text-ink tabular">
                {fmtInt(minutesUsed)} / {fmtInt(plan.minutesIncluded)}
              </span>
            </div>
            <Progress value={usedPct} tone={usedPct > 0.9 ? 'danger' : usedPct > 0.7 ? 'warning' : 'brand'} />
            {overageMinutes > 0 && (
              <p className="mt-2 text-[12px] text-warning">
                {t('billing.overage', '{min} minutes beyond the plan — billed at {rate}/minute.')
                  .replace('{min}', fmtInt(overageMinutes))
                  .replace('{rate}', fmtMoney(overageRate, 'USD', 3))}
              </p>
            )}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Meter label={t('billing.planFee', 'Plan fee')} value={fmtMoney(plan.priceUsd, 'USD', 0)} />
            <Meter
              label={t('billing.usage', 'Usage')}
              value={fmtMoney(usageCost, 'USD', 2)}
              sub={t('billing.overBundle', '{n} min over bundle').replace('{n}', overageMinutes.toFixed(0))}
            />
            <Meter
              label={t('billing.avoidedWages', 'Avoided wages')}
              value={fmtMoney(stats.savingsUsd, 'USD', 0)}
              sub={t('billing.deflected', '{pct} deflected').replace('{pct}', fmtPct(stats.deflectionRate))}
              tone="success"
            />
          </div>
        </Card>

        <Card>
          <h3 className="text-[15px] font-semibold text-ink">{t('billing.minuteBreakdown', 'Where a minute goes')}</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            {t('billing.minuteCost', 'Our own cost per AI-handled minute, at {cost}.').replace(
              '{cost}',
              fmtMoney(COST_PER_MINUTE, 'USD', 3),
            )}
          </p>
          <div className="mt-4 space-y-2.5">
            {(
              [
                [t('billing.rate.telephony', 'Telephony'), RATE_CARD.telephonyPerMin],
                [t('billing.rate.stt', 'Speech recognition'), RATE_CARD.sttPerMin],
                [t('billing.rate.llm', 'Answer generation'), RATE_CARD.llmPerMin],
                [t('billing.rate.tts', 'Speech synthesis'), RATE_CARD.ttsPerMin],
                [t('billing.rate.platform', 'Platform'), RATE_CARD.platformPerMin],
              ] as const
            ).map(([label, v]) => (
              <div key={label}>
                <div className="mb-1 flex items-baseline justify-between text-[12.5px]">
                  <span className="text-ink-2">{label}</span>
                  <span className="text-ink tabular">{fmtMoney(v, 'USD', 3)}</span>
                </div>
                <Progress value={v / COST_PER_MINUTE} height={4} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <ChartFrame
        className="mt-4"
        title={t('billing.spendTitle', 'Spend over time')}
        subtitle={t('billing.spendSub', 'Daily platform cost against calls handled.')}
        legend={[{ label: t('billing.costUsd', 'Cost (USD)'), color: 'var(--series-1)' }]}
      >
        <TrendChart
          labels={trend.map((d) => d.day)}
          series={[{ label: t('billing.costUsd', 'Cost (USD)'), values: trend.map((d) => d.cost), slot: 0 }]}
          valueFormat="usd"
        />
      </ChartFrame>

      <div className="mt-4">
        <h2 className="mb-3 text-[16px] font-semibold text-ink">{t('billing.plans', 'Plans')}</h2>
        <PlanPicker current={tenant.plan} canChange={user.role === 'owner'} locale={user.locale} />
      </div>

      {invoices.length > 0 && (
        <Card className="mt-4" padded={false}>
          <div className="flex items-center gap-2 px-5 py-4 hairline-b">
            <IconCreditCard size={16} className="text-ink-3" />
            <h3 className="text-[14px] font-semibold text-ink">{t('billing.invoices', 'Invoices')}</h3>
          </div>
          <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-5 py-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success-soft text-success">
                  <IconCheck size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">{inv.period}</div>
                  <div className="text-[12px] text-ink-3">
                    {t('billing.invoiceLine', '{plan} · {calls} calls · {min} min')
                      .replace('{plan}', inv.plan)
                      .replace('{calls}', fmtInt(inv.calls))
                      .replace('{min}', inv.minutes.toFixed(0))}
                  </div>
                </div>
                <span className="text-[13.5px] font-medium text-ink tabular">
                  {fmtMoney(inv.total_usd, 'USD', 2)}
                </span>
                <Badge tone={inv.status === 'paid' ? 'success' : 'warning'}>{t(`invstatus.${inv.status}`, inv.status)}</Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Meter({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'success';
}) {
  return (
    <div className="rounded-[11px] bg-surface-2 p-3.5">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div
        className={`mt-1 text-[19px] leading-none font-semibold tabular ${
          tone === 'success' ? 'text-success' : 'text-ink'
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}
