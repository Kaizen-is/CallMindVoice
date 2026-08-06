'use client';

import { useMemo, useState } from 'react';
import { Slider } from '@/components/ui/forms';
import { fmtInt, fmtMoney, fmtPct } from '@/lib/utils';
import { IconTrendUp } from '@/components/icons';

/**
 * Deliberately conservative: it charges the platform for *every* minute
 * (including escalated calls, which the AI also handles up to the hand-off)
 * and credits savings only on the share the AI closes on its own.
 */
export function RoiCalculator({ compact = false }: { compact?: boolean }) {
  const [callsPerMonth, setCalls] = useState(12_000);
  const [avgMinutes, setAvgMinutes] = useState(3.2);
  const [operatorSalary, setSalary] = useState(500);
  const [deflection, setDeflection] = useState(0.72);

  const model = useMemo(() => {
    const totalMinutes = callsPerMonth * avgMinutes;
    const operatorMinutesPerMonth = 22 * 8 * 60 * 0.68; // 68% occupancy is a healthy contact centre
    const operatorsNeeded = totalMinutes / operatorMinutesPerMonth;
    const humanCost = operatorsNeeded * operatorSalary;

    const deflectedMinutes = totalMinutes * deflection;
    const remainingOperators = (totalMinutes - deflectedMinutes) / operatorMinutesPerMonth;
    const remainingHumanCost = remainingOperators * operatorSalary;

    const platformCost =
      callsPerMonth <= 1_000 ? 490 : callsPerMonth <= 10_000 ? 1_890 : 4_490;
    const usageCost = totalMinutes * 0.065;
    const ovozCost = platformCost + usageCost;

    const newTotal = remainingHumanCost + ovozCost;
    const savings = humanCost - newTotal;

    return {
      totalMinutes,
      operatorsNeeded,
      humanCost,
      remainingOperators,
      ovozCost,
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
          label="Calls per month"
          value={callsPerMonth}
          min={500}
          max={100_000}
          step={500}
          onChange={setCalls}
          format={(v) => fmtInt(v)}
        />
        <Slider
          label="Average call length"
          value={avgMinutes}
          min={1}
          max={10}
          step={0.1}
          onChange={setAvgMinutes}
          format={(v) => `${v.toFixed(1)} min`}
        />
        <Slider
          label="Fully-loaded cost per operator"
          value={operatorSalary}
          min={250}
          max={1500}
          step={25}
          onChange={setSalary}
          format={(v) => `${fmtMoney(v, 'USD', 0)} / month`}
        />
        <Slider
          label="Share the AI resolves without a human"
          value={deflection}
          min={0.4}
          max={0.9}
          step={0.01}
          onChange={setDeflection}
          format={(v) => fmtPct(v)}
        />
        {!compact && (
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            Assumes 68% operator occupancy over a 22-day month. Ovoz is charged on every minute,
            including the part of an escalated call the AI handled before the hand-off.
          </p>
        )}
      </div>

      <div className="rounded-[18px] bg-surface-2 p-6 hairline">
        <div className="space-y-4">
          <Row label="Operators needed today" value={`${model.operatorsNeeded.toFixed(1)}`} />
          <Row label="Current monthly cost" value={fmtMoney(model.humanCost, 'USD', 0)} />
          <div className="h-px bg-[rgb(var(--line)/var(--line-alpha))]" />
          <Row label="Operators still needed" value={`${model.remainingOperators.toFixed(1)}`} muted />
          <Row label="Ovoz platform + usage" value={fmtMoney(model.ovozCost, 'USD', 0)} muted />
          <Row label="New monthly cost" value={fmtMoney(model.newTotal, 'USD', 0)} muted />
        </div>

        <div className="mt-6 rounded-[14px] bg-success-soft p-5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-success">
            <IconTrendUp size={15} />
            Monthly saving
          </div>
          <div className="mt-1 text-[34px] leading-none font-semibold tracking-[-0.03em] text-success tabular">
            {model.savings > 0 ? fmtMoney(model.savings, 'USD', 0) : '—'}
          </div>
          <div className="mt-2 text-[12.5px] text-success/80">
            {model.savings > 0
              ? `${fmtPct(model.savingsPct)} lower than running this on people alone · ${fmtMoney(model.savings * 12, 'USD', 0)} a year`
              : 'At this volume a human team is still cheaper — talk to us anyway, we will tell you so.'}
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
