'use client';

import { useMemo, useState } from 'react';
import { Slider } from '@/components/ui/forms';
import { fmtInt, fmtMoney, fmtPct } from '@/lib/utils';
import { IconTrendUp } from '@/components/icons';
import { PLANS, OVERAGE_PER_MINUTE, OPERATOR_MINUTES_PER_MONTH } from '@/lib/catalog';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';

/**
 * Deliberately conservative: it charges the platform for *every* minute
 * (including escalated calls, which the AI also handles up to the hand-off)
 * and credits savings only on the share the AI closes on its own.
 */
export function RoiCalculator({ compact = false, locale = 'en' }: { compact?: boolean; locale?: UiLocale }) {
  const t = translator(locale);
  const [callsPerMonth, setCalls] = useState(12_000);
  const [avgMinutes, setAvgMinutes] = useState(3.3);
  const [operatorSalary, setSalary] = useState(450);
  const [deflection, setDeflection] = useState(0.75);

  const model = useMemo(() => {
    const totalMinutes = callsPerMonth * avgMinutes;
    const operatorsNeeded = totalMinutes / OPERATOR_MINUTES_PER_MONTH;
    const humanCost = operatorsNeeded * operatorSalary;

    const deflectedMinutes = totalMinutes * deflection;
    const remainingOperators = (totalMinutes - deflectedMinutes) / OPERATOR_MINUTES_PER_MONTH;
    const remainingHumanCost = remainingOperators * operatorSalary;

    // Bill only the minutes beyond the plan bundle, and put the customer on the
    // plan that MINIMISES their Ovoz cost (base + overage) — the honest, best-for-
    // them tier rather than the first bundle that happens to fit.
    const chosen = PLANS.filter((p) => p.id !== 'trial')
      .map((p) => ({
        plan: p,
        cost:
          p.priceUsd +
          Math.max(0, totalMinutes - p.minutesIncluded) * (p.overagePerMinute ?? OVERAGE_PER_MINUTE),
      }))
      .reduce((a, b) => (b.cost < a.cost ? b : a));
    const ovozCost = chosen.cost;

    const newTotal = remainingHumanCost + ovozCost;
    const savings = humanCost - newTotal;

    return {
      totalMinutes,
      operatorsNeeded,
      humanCost,
      remainingOperators,
      ovozCost,
      planName: chosen.plan.name,
      newTotal,
      savings,
      savingsPct: humanCost > 0 ? savings / humanCost : 0,
      paybackDays: savings > 0 ? Math.max(1, Math.round((ovozCost / savings) * 30)) : null,
    };
  }, [callsPerMonth, avgMinutes, operatorSalary, deflection]);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1fr] lg:gap-12">
      <div className="space-y-6">
        <Slider
          label={t('lp.roicalc.calls')}
          value={callsPerMonth}
          min={500}
          max={100_000}
          step={500}
          onChange={setCalls}
          format={(v) => fmtInt(v)}
        />
        <Slider
          label={t('lp.roicalc.avg')}
          value={avgMinutes}
          min={1}
          max={10}
          step={0.1}
          onChange={setAvgMinutes}
          format={(v) => `${v.toFixed(1)} ${t('lp.roicalc.min')}`}
        />
        <Slider
          label={t('lp.roicalc.salary')}
          value={operatorSalary}
          min={250}
          max={1500}
          step={25}
          onChange={setSalary}
          format={(v) => `${fmtMoney(v, 'USD', 0)} ${t('lp.roicalc.perMonth')}`}
        />
        <Slider
          label={t('lp.roicalc.deflection')}
          value={deflection}
          min={0.4}
          max={0.9}
          step={0.01}
          onChange={setDeflection}
          format={(v) => fmtPct(v)}
        />
        {!compact && (
          <p className="text-[12.5px] leading-relaxed text-ink-3">{t('lp.roicalc.assumes')}</p>
        )}
      </div>

      <div className="rounded-[18px] bg-surface-2 p-6 hairline">
        <div className="space-y-4">
          <Row label={t('lp.roicalc.opNeeded')} value={`${model.operatorsNeeded.toFixed(1)}`} />
          <Row label={t('lp.roicalc.curCost')} value={fmtMoney(model.humanCost, 'USD', 0)} />
          <div className="h-px bg-[rgb(var(--line)/var(--line-alpha))]" />
          <Row label={t('lp.roicalc.opStill')} value={`${model.remainingOperators.toFixed(1)}`} muted />
          <Row
            label={t('lp.roicalc.ovozCost')}
            value={`${fmtMoney(model.ovozCost, 'USD', 0)} · ${model.planName}`}
            muted
          />
          <Row label={t('lp.roicalc.newCost')} value={fmtMoney(model.newTotal, 'USD', 0)} muted />
        </div>

        <div className="mt-6 rounded-[14px] bg-success-soft p-5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-success">
            <IconTrendUp size={15} />
            {t('lp.roicalc.saving')}
          </div>
          <div className="mt-1 text-[34px] leading-none font-semibold tracking-[-0.03em] text-success tabular">
            {model.savings > 0 ? fmtMoney(model.savings, 'USD', 0) : '—'}
          </div>
          <div className="mt-2 text-[12.5px] text-success/80">
            {model.savings > 0
              ? t('lp.roicalc.lowerYear')
                  .replace('{pct}', fmtPct(model.savingsPct))
                  .replace('{year}', fmtMoney(model.savings * 12, 'USD', 0))
              : t('lp.roicalc.negative')}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[13px] text-ink-3">{label}</span>
      <span
        className={`text-[15px] font-semibold tabular ${muted ? 'text-ink-2' : 'text-ink'}`}
      >
        {value}
      </span>
    </div>
  );
}
