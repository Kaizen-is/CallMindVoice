'use client';

import { useMemo, useState } from 'react';
import { Slider } from '@/components/ui/forms';
import { fmtInt, fmtPct, fmtUzs } from '@/lib/utils';
import { IconTrendUp } from '@/components/icons';
import { AI_MINUTE_UZS } from '@/lib/catalog';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';

/**
 * Prepaid balance model: you deposit so'm and spend only on the AI minutes you
 * actually use (the AI listens with STT and speaks with TTS), set against what
 * the same work would cost you in operator wages.
 */
export function RoiCalculator({ compact = false, locale = 'en' }: { compact?: boolean; locale?: UiLocale }) {
  const t = translator(locale);
  const [salary, setSalary] = useState(3_000_000);
  const [operators, setOperators] = useState(10);
  const [minutes, setMinutes] = useState(14_000);

  const model = useMemo(() => {
    const humanCost = salary * operators;
    const aiCost = minutes * AI_MINUTE_UZS;
    const savings = humanCost - aiCost;
    return {
      humanCost,
      aiCost,
      savings,
      savingsPct: humanCost > 0 ? savings / humanCost : 0,
    };
  }, [salary, operators, minutes]);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1fr] lg:gap-12">
      <div className="space-y-6">
        <Slider
          label={t('lp.roicalc.salary')}
          value={salary}
          min={1_000_000}
          max={10_000_000}
          step={250_000}
          onChange={setSalary}
          format={(v) => fmtUzs(v)}
        />
        <Slider
          label={t('lp.roicalc.operators')}
          value={operators}
          min={1}
          max={50}
          step={1}
          onChange={setOperators}
          format={(v) => fmtInt(v)}
        />
        <Slider
          label={t('lp.roicalc.minutes')}
          value={minutes}
          min={1_000}
          max={200_000}
          step={1_000}
          onChange={setMinutes}
          format={(v) => fmtInt(v)}
        />
        {!compact && (
          <p className="text-[12.5px] leading-relaxed text-ink-3">{t('lp.roicalc.assumes')}</p>
        )}
      </div>

      <div className="rounded-[18px] bg-surface-2 p-6 hairline">
        <div className="space-y-4">
          <Row label={t('lp.roicalc.humanCost')} value={fmtUzs(model.humanCost)} />
          <Row
            label={t('lp.roicalc.aiCost')}
            value={fmtUzs(model.aiCost)}
            sub={'{n} × 1 400 so‘m'.replace('{n}', fmtInt(minutes))}
            muted
          />
        </div>

        <div className="mt-6 rounded-[14px] bg-success-soft p-5">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-success">
            <IconTrendUp size={15} />
            {t('lp.roicalc.saving')}
          </div>
          <div className="mt-1 text-[34px] leading-none font-semibold tracking-[-0.03em] text-success tabular">
            {model.savings > 0 ? fmtUzs(model.savings) : '—'}
          </div>
          <div className="mt-2 text-[12.5px] text-success/80">
            {model.savings > 0
              ? t('lp.roicalc.lowerYear')
                  .replace('{pct}', fmtPct(model.savingsPct))
                  .replace('{year}', fmtUzs(model.savings * 12))
              : t('lp.roicalc.negative')}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  muted,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[13px] text-ink-3">{label}</span>
      <div className="text-right">
        <span className={`text-[15px] font-semibold tabular ${muted ? 'text-ink-2' : 'text-ink'}`}>
          {value}
        </span>
        {sub && <div className="mt-0.5 text-[11.5px] text-ink-3 tabular">{sub}</div>}
      </div>
    </div>
  );
}
